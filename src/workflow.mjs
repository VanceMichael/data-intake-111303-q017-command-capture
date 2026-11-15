import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildSpawnSpec, loadManifest } from './manifest.mjs';
import { RunJournal } from './journal.mjs';
import { runCommand } from './runner.mjs';

// 本执行器进程的诞生标识：运行记录都带 bootId，
// 重启后上一 boot 的未完结运行在扫描阶段判定 aborted，绝不与新运行混淆。
const BOOT_ID = randomUUID();
const COMMAND_ID = 'device.export';
const DEVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COMMAND_KEYS = new Set(['device', 'mode', 'timeoutMs']);
const CHILD_PID = /"childPid"\s*:\s*(\d+)/g;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 同设备在飞去重表：键 = stateDir + 设备。进程号会复用、执行器会重启，
// 运行身份只靠 runId；这张表只负责“同一设备同一时刻至多一个真实运行”。
const inflight = new Map();

export async function run({ source, stateDir, input, signal } = {}) {
  if (!stateDir) throw new TypeError('缺少 stateDir');
  if (!input || !Array.isArray(input.commands)) throw new TypeError('input.commands 必须是数组');
  const manifest = await loadManifest();
  const entry = manifest.commands.get(COMMAND_ID);
  const stateDirAbs = path.resolve(stateDir);

  const deviceCommand = input.deviceCommand != null ? path.resolve(input.deviceCommand) : entry.scriptPath;
  if (deviceCommand !== entry.scriptPath) throw new Error(`白名单拒绝：只能启动 ${entry.scriptPath}`);

  // 第一阶段：纯校验。任何一条命令越界都直接抛错，此时还没有产生任何子进程。
  const plans = input.commands.map((command, index) => validateCommand(command, index, entry));

  await mkdir(stateDirAbs, { recursive: true });
  const journal = new RunJournal(stateDirAbs);
  await journal.ready();
  // 执行器重启恢复：只依据落盘记录，不依赖调用方内存
  const recoveredAbortedRuns = await journal.sweep(BOOT_ID);
  const sourceAbout = await probeSource(source);

  // 第二阶段：启动。同一批次内多个设备命令并发运行，部分成功单独交付。
  const runs = await Promise.all(plans.map(plan => startPlan(plan, { entry, journal, stateDirAbs, signal })));

  // 后代进程清点：以诊断中声明的 childPid 为准逐个探测，确认进程树已清理干净
  const announced = new Set();
  for (const runResult of runs) {
    if (runResult.deduped || runResult.status === 'rejected') continue;
    runResult.descendants = [...runResult.diagnostics.text.matchAll(CHILD_PID)].map(match => Number(match[1]));
    for (const pid of runResult.descendants) announced.add(pid);
  }
  const alive = await probeAlive([...announced], 1500);
  const aliveSet = new Set(alive);
  for (const runResult of runs) {
    if (runResult.descendants) runResult.descendantsAlive = runResult.descendants.filter(pid => aliveSet.has(pid)).length;
  }

  const states = {};
  const ids = [];
  for (const runResult of runs) {
    if (runResult.deduped || runResult.status === 'rejected') continue;
    states[runResult.device] = runResult.status;
    if (runResult.status === 'complete') ids.push(...runResult.ids);
  }
  const result = {
    states,
    ids,
    childrenAlive: alive.length,
    diagnosticsTruncated: runs.some(runResult => !runResult.deduped && runResult.status !== 'rejected' && runResult.diagnostics.truncated),
    runs,
    recoveredAbortedRuns,
    sourceAbout,
  };
  // 返回结果与落盘结果一致；写临时文件后改名，避免半截文件
  const temporary = path.join(stateDirAbs, 'result.json.tmp');
  await writeFile(temporary, JSON.stringify(result, null, 2));
  await rename(temporary, path.join(stateDirAbs, 'result.json'));
  return result;
}

function validateCommand(command, index, entry) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new TypeError(`commands[${index}] 必须是对象`);
  }
  for (const key of Object.keys(command)) {
    if (!COMMAND_KEYS.has(key)) throw new Error(`白名单拒绝：commands[${index}] 含未声明字段 ${key}`);
  }
  if (!DEVICE_NAME.test(command.device ?? '')) throw new Error(`白名单拒绝：commands[${index}].device 无效`);
  if (typeof command.mode !== 'string') throw new Error(`白名单拒绝：commands[${index}].mode 必须是字符串`);
  const spec = buildSpawnSpec(entry, { mode: command.mode });
  let timeoutMs = entry.limits.defaultTimeoutMs;
  if (command.timeoutMs !== undefined) {
    if (!Number.isInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > entry.limits.maxTimeoutMs) {
      throw new Error(`白名单拒绝：commands[${index}].timeoutMs 超出 1..${entry.limits.maxTimeoutMs}`);
    }
    timeoutMs = command.timeoutMs;
  }
  return { index, device: command.device, mode: command.mode, spec, timeoutMs };
}

async function startPlan(plan, { journal, stateDirAbs, signal }) {
  const key = stateDirAbs + ' ' + plan.device;
  const existing = inflight.get(key);
  if (existing) {
    if (existing.mode === plan.mode) {
      // 同设备重复请求：共享同一运行身份，不另起进程，不重复交付
      const shared = await existing.done;
      return { runId: existing.runId, device: plan.device, mode: plan.mode, commandIndex: plan.index, deduped: true, status: shared.status, reason: shared.reason };
    }
    // 同设备冲突请求：明确拒绝，不占用设备状态位，不混淆运行身份
    return { runId: randomUUID(), device: plan.device, mode: plan.mode, commandIndex: plan.index, status: 'rejected', reason: 'device-busy-conflicting-mode', ids: [], records: [] };
  }
  const handle = runCommand(
    { ...plan.spec, limits: { ...plan.spec.limits, timeoutMs: plan.timeoutMs } },
    { signal },
  );
  inflight.set(key, { runId: handle.runId, mode: plan.mode, done: handle.done });
  await journal.start({
    runId: handle.runId,
    bootId: BOOT_ID,
    device: plan.device,
    mode: plan.mode,
    pid: handle.pid,
    status: 'running',
    startedAt: new Date().toISOString(),
  });
  try {
    const runResult = await handle.done;
    await journal.finish(handle.runId, {
      status: runResult.status,
      reason: runResult.reason,
      exit: runResult.exit,
      endedAt: runResult.endedAt,
      diagnosticsTruncated: runResult.diagnostics.truncated,
    });
    return { ...runResult, device: plan.device, mode: plan.mode, commandIndex: plan.index };
  } finally {
    inflight.delete(key);
  }
}

async function probeAlive(pids, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let alive = pids.filter(pidAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    await sleep(50);
    alive = alive.filter(pidAlive);
  }
  return alive;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// 来源存证（尽力而为）：读取本地来源 /about，失败不否定命令采集结果
async function probeSource(source) {
  if (!source) return null;
  try {
    const response = await fetch(source + '/about', { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
