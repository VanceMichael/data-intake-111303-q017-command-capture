import { mkdir, readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  captureCommand,
  resolveDeviceCommand,
  writeJsonAtomic,
  assertAllowedMode,
  DEFAULT_TIMEOUT_MS,
} from './capture.mjs';

/**
 * 资料接收业务工作流：在同一批次内并发执行多个受控设备命令，
 * 部分成功可单独交付。运行身份由启动前分配的 uuid 决定，与 pid 无关，
 * 因此进程号复用、执行器重启、同一设备重复请求都不会混淆运行。
 *
 * 持久化布局（stateDir）：
 *   result.json                 最终结构化结果（原子写）
 *   runs/<runId>/run.json       单次运行完整记录（完成即落盘，可追溯）
 *   runs/<runId>/records.ndjson 资料行原始字节（仅 complete 可交付）
 *   runs/<runId>/diagnostics.log 限量诊断
 *   runs/<runId>/records.ndjson.incomplete 不交付标记
 */
export async function run({ source, stateDir, input }) {
  const batchId = randomUUID();
  const startedAt = new Date().toISOString();
  const runsRoot = path.join(stateDir, 'runs');
  await mkdir(runsRoot, { recursive: true });

  const commands = Array.isArray(input?.commands) ? input.commands : [];
  const previousRuns = await loadPreviousRuns(runsRoot);

  // 白名单只在批次开始时解析一次；非白名单路径不启动任何进程
  let deviceCommand;
  let whitelistError = null;
  try {
    deviceCommand = resolveDeviceCommand(input.deviceCommand);
  } catch (error) {
    whitelistError = error.message;
  }

  const runs = await Promise.all(commands.map(async entry => {
    const runId = randomUUID();
    const device = typeof entry?.device === 'string' && entry.device.length > 0 ? entry.device : 'unknown';
    const mode = entry?.mode;
    const timeoutMs = Number.isFinite(entry.timeoutMs) ? entry.timeoutMs
      : Number.isFinite(input.timeoutMs) ? input.timeoutMs : DEFAULT_TIMEOUT_MS;
    const runDir = path.join(runsRoot, runId);
    await mkdir(runDir, { recursive: true });

    // 入站白名单校验：路径或 mode 非法都不启动进程
    let modeError = whitelistError;
    if (!modeError) {
      try { assertAllowedMode(mode); } catch (error) { modeError = error.message; }
    }
    if (modeError) {
      const rejected = {
        runId, device, state: 'rejected', pid: null, mode,
        reason: modeError,
        startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
        ids: [], records: [], recordsDelivered: false, childrenAlive: null,
        diagnostics: { truncated: false, totalBytes: 0, keptBytes: 0, note: '未启动进程，无诊断' },
        digest: { match: null }, timedOut: false,
      };
      await writeJsonAtomic(path.join(runDir, 'run.json'), rejected);
      return rejected;
    }

    const detail = await captureCommand({ runId, device, mode, deviceCommand, timeoutMs, runDir });
    // 完成即落盘：即使批次后续步骤失败，本次运行仍可追溯、可恢复
    await writeJsonAtomic(path.join(runDir, 'run.json'), detail);
    return detail;
  }));

  // ---- 汇总契约要求的批次级字段 ----
  const states = {};
  const stateCollisions = [];
  for (const detail of runs) {
    if (Object.hasOwn(states, detail.device)) {
      stateCollisions.push(detail.device);
      if (!Array.isArray(states[detail.device])) states[detail.device] = [states[detail.device]];
      states[detail.device].push(detail.state);
    } else {
      states[detail.device] = detail.state;
    }
  }

  const result = {
    batchId,
    source: source ?? null,
    startedAt,
    endedAt: new Date().toISOString(),
    states,
    // 仅交付通过尾标+摘要核对的完整运行的资料 id
    ids: runs.filter(detail => detail.recordsDelivered).flatMap(detail => detail.ids),
    childrenAlive: runs.reduce((sum, detail) => sum + (detail.childrenAlive ?? 0), 0),
    diagnosticsTruncated: runs.some(detail => detail.diagnostics?.truncated === true),
    runs: runs.map(detail => summarizeRun(detail, stateCollisions.includes(detail.device))),
    previousRunIds: previousRuns.map(detail => ({ runId: detail.runId, device: detail.device, state: detail.state })),
  };

  await writeJsonAtomic(path.join(stateDir, 'result.json'), result);
  return result;
}

/** 每个运行给出资料、诊断截断说明与最终判定。 */
function summarizeRun(detail, duplicatedDevice) {
  return {
    runId: detail.runId,
    device: detail.device,
    duplicatedDevice: duplicatedDevice || false,
    state: detail.state,
    reason: detail.reason ?? null,
    pid: detail.pid,
    command: detail.command ?? null,
    exitCode: detail.exitCode ?? null,
    signal: detail.signal ?? null,
    timedOut: detail.timedOut === true,
    ids: detail.ids ?? [],
    recordCount: detail.recordCount ?? 0,
    digest: detail.digest,
    diagnostics: detail.diagnostics,
    recordsPath: detail.recordsPath ?? null,
    recordsDelivered: detail.recordsDelivered === true,
    childrenAlive: detail.childrenAlive ?? null,
    kill: detail.kill ?? null,
  };
}

/** 重启恢复：只信任已落盘且可追溯的运行记录，不依赖调用方内存。 */
async function loadPreviousRuns(runsRoot) {
  let entries;
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const loaded = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const parsed = JSON.parse(await readFile(path.join(runsRoot, entry.name, 'run.json'), 'utf8'));
      if (parsed && typeof parsed.runId === 'string') loaded.push(parsed);
    } catch {
      // 没有 run.json 或内容损坏：忽略，绝不凭空补进度
    }
  }
  loaded.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  return loaded;
}
