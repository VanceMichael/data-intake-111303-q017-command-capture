import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { open, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

/**
 * 生产级本地设备命令采集器。
 *
 * 安全与身份边界：
 * - 只允许通过白名单路径启动合成设备进程，参数结构固定（仅 mode），
 *   以 process.execPath + argv 数组启动，shell 永久禁用，不做任何远程登录
 *   或命令探测；
 * - stdout/stderr 是两条独立通道，诊断永远不进入资料通道；
 * - 每个运行在启动前分配 uuid，进程号 (pid) 只作为内核资源句柄用于回收，
 *   不作为运行身份，因此进程号复用、执行器重启、同设备重复请求都不会混淆。
 */

export const ALLOWED_MODES = Object.freeze(['warning', 'bad-exit', 'descendant', 'interleave']);

/**
 * 校验业务白名单 mode。工作流层在入站时调用；采集器本身不内置 mode 策略，
 * 只保证按固定 argv 结构、禁用 shell 启动白名单设备。
 */
export function assertAllowedMode(mode) {
  if (!ALLOWED_MODES.includes(mode)) {
    throw Object.assign(new Error('mode 不在白名单内：' + String(mode)), { code: 'MODE_NOT_WHITELISTED' });
  }
  return mode;
}

/** stderr 诊断保留上限（字节），与 docs/source-contract.md 一致。 */
export const DIAGNOSTICS_LIMIT_BYTES = 4096;

/** 默认运行超时；可由 input.timeoutMs 覆盖（单次运行级别）。 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** 超时/取消后给进程树优雅退出的宽限时间，随后 SIGKILL。 */
const KILL_GRACE_MS = 200;

/** 等待进程真正消失的最长时间。 */
const CLOSE_WAIT_MS = 5_000;

/** 单行（含尾换行）允许的最大长度，防止异常设备撑爆内存。 */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

export const DEFAULT_DEVICE_COMMAND = path.resolve('fixtures/device.mjs');

/** 白名单解析：未声明 deviceCommand 时只接受仓库内的合成设备。 */
export function resolveDeviceCommand(deviceCommand) {
  const candidate = path.resolve(deviceCommand ?? DEFAULT_DEVICE_COMMAND);
  if (candidate !== DEFAULT_DEVICE_COMMAND) {
    throw Object.assign(new Error('拒绝执行非白名单设备命令：' + candidate), { code: 'COMMAND_NOT_WHITELISTED' });
  }
  return candidate;
}

/**
 * 按字节切分文本帧。保留每行原始字节（含 \n），避免多字节字符被截断。
 * 返回 { lines, rest }；flush=true 时把残余字节作为最后一行返回。
 */
export function splitFrames(buffer, flush = false) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0x0a) {
      lines.push(buffer.subarray(start, index + 1));
      start = index + 1;
    }
  }
  const rest = buffer.subarray(start);
  if (flush && rest.length > 0) lines.push(Buffer.from(rest));
  return { lines, rest: Buffer.from(rest) };
}

/** 等可写流排空，把读取侧背压传导到写入侧（最终传导到子进程）。 */
async function drainWritable(stream) {
  if (stream.writableNeedDrain) {
    await once(stream, 'drain');
  }
}

/** 进程是否仍存活；ESRCH 表示已退出。 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'EPERM') return true;
    if (error.code === 'ESRCH') return false;
    return true;
  }
}

/**
 * 结束整个子进程树。设备以 detached 启动，进程组 id 等于其 pid，
 * 负号 pid 表示向整个进程组发信号，从而一并回收后代。
 */
async function killProcessTree(pid, descendants, reason) {
  const signalTargets = [-pid, ...descendants];
  for (const target of signalTargets) {
    try { process.kill(target, 'SIGTERM'); } catch (error) {
      if (!['ESRCH', 'EINVAL'].includes(error.code)) throw error;
    }
  }
  await new Promise(resolve => setTimeout(resolve, KILL_GRACE_MS));
  for (const target of signalTargets) {
    try { process.kill(target, 'SIGKILL'); } catch (error) {
      if (!['ESRCH', 'EINVAL'].includes(error.code)) throw error;
    }
  }
  const deadline = Date.now() + CLOSE_WAIT_MS;
  while (Date.now() < deadline) {
    if (!isAlive(pid) && descendants.every(descendant => !isAlive(descendant))) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return {
    reason,
    parentAlive: isAlive(pid),
    descendantsAlive: descendants.filter(descendant => isAlive(descendant)),
  };
}

/**
 * 执行一次受控设备命令并完成资料采集与判定。
 *
 * @param {object} spec
 * @param {string} spec.runId        本次运行的稳定身份（uuid），与 pid 无关
 * @param {string} spec.device       逻辑设备名
 * @param {string} spec.mode         白名单 mode
 * @param {string} spec.deviceCommand 白名单设备脚本绝对路径
 * @param {number} spec.timeoutMs    超时毫秒
 * @param {string} spec.runDir       本次运行的落盘目录
 * @returns 完整运行记录（资料、诊断截断说明、最终判定与回收证据）
 */
export async function captureCommand({ runId, device, mode, deviceCommand, timeoutMs, runDir }) {
  const recordPath = path.join(runDir, 'records.ndjson');
  const diagnosticsPath = path.join(runDir, 'diagnostics.log');

  const run = {
    runId,
    device,
    state: 'error',
    pid: null,
    command: { executable: process.execPath, argv: [deviceCommand, mode], shell: false },
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    signal: null,
    timedOut: false,
    reason: null,
    ids: [],
    recordCount: 0,
    expectedCount: null,
    digest: { algorithm: 'sha256', expected: null, actual: null, match: null },
    diagnostics: {
      path: diagnosticsPath,
      keptBytes: 0,
      totalBytes: 0,
      truncated: false,
      limitBytes: DIAGNOSTICS_LIMIT_BYTES,
      note: null,
    },
    recordsPath: recordPath,
    recordsDelivered: false,
    kill: null,
    childrenAlive: null,
  };

  let child;
  try {
    child = spawn(process.execPath, [deviceCommand, mode], {
      shell: false,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    run.state = 'failed';
    run.reason = '进程启动失败：' + error.message;
    run.endedAt = new Date().toISOString();
    return run;
  }
  run.pid = child.pid;

  // committable：超时/取消/致命成帧错误后关闭闸门，迟到输出一律不再提交。
  let committable = true;
  let timer = null;
  const descendants = new Set();

  const hash = createHash('sha256');
  const records = [];
  const diagnostics = [];
  let stdoutBuffer = Buffer.alloc(0);
  let trailer = null;
  let framingError = null;
  let recordHandle = null;
  let recordStream = null;

  const setTerminal = (state, reason) => {
    run.state = state;
    run.reason = reason;
    if (!run.endedAt) run.endedAt = new Date().toISOString();
  };

  try {
    recordHandle = await open(recordPath, 'w');
    recordStream = recordHandle.createWriteStream();
  } catch (error) {
    setTerminal('failed', '资料落盘打开失败：' + error.message);
    run.kill = await killProcessTree(child.pid, [...descendants], 'record-open-failed');
    await once(child, 'close').catch(() => {});
    return finalize();
  }

  // 三个相互独立的终态事件，谁先发生谁赢得判定，另一个永不覆盖。
  // 注意：超时窗口内的成帧错误不得抢占 timeout 判定，因此 fatal 承诺
  // 最早只在 timeoutMs 兑现（窗口内进程先退出则由 close 赢得）。
  const deadline = Date.now() + timeoutMs;
  const closed = once(child, 'close').then(([code, signal]) => ({ kind: 'close', code, signal }));
  // 致命成帧错误：流循环发现问题时通过 fatalGate 上报，仅在进程仍存活时提前失败
  const fatalTimers = [];
  let reportFatal;
  const fatal = new Promise(resolve => {
    reportFatal = reason => resolve({ kind: 'fatal', reason });
  });
  const timedOut = new Promise(resolve => {
    timer = setTimeout(() => {
      committable = false;
      run.timedOut = true;
      resolve({ kind: 'timeout', reason: timeoutMs + 'ms 内未完成，回收进程树' });
    }, timeoutMs);
  });
  const markFramingError = reason => {
    if (framingError) return;
    framingError = reason;
    committable = false;
    if (child.exitCode === null && child.signalCode === null) {
      // 让 timeout 先于 fatal 结算：窗口内挂起的坏帧按超时回收处理
      fatalTimers.push(setTimeout(() => reportFatal(reason), Math.max(0, deadline - Date.now() + 1)));
    }
  };

  // ---- stdout：按声明的逐行 JSON 成帧方式解析资料。
  //      循环只负责解析/落盘与标记错误，绝不做终态判定，避免抢占超时。 ----
  const stdoutLoop = (async () => {
    for await (const chunk of child.stdout) {
      if (!committable) continue; // 超时后的迟到输出不得继续提交
      stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
      if (stdoutBuffer.length > MAX_LINE_BYTES) {
        markFramingError('单行超过 ' + MAX_LINE_BYTES + ' 字节，疑似成帧损坏');
        continue;
      }
      const { lines, rest } = splitFrames(stdoutBuffer);
      stdoutBuffer = rest;
      for (const line of lines) {
        if (!committable) break;
        if (trailer !== null) {
          markFramingError('尾标之后仍出现资料行');
          break;
        }
        let parsed;
        try {
          parsed = JSON.parse(line.toString('utf8'));
        } catch (error) {
          markFramingError('资料行不是合法 JSON：' + error.message);
          break;
        }
        if (parsed && typeof parsed === 'object' && parsed.trailer) {
          trailer = parsed.trailer;
          break;
        }
        // 资料行：摘要按原始字节（含换行）累计，并流式落盘形成背压
        hash.update(line);
        try {
          if (!recordStream.write(line)) await drainWritable(recordStream);
        } catch (error) {
          markFramingError('资料落盘失败：' + error.message);
          break;
        }
        records.push(parsed);
        if (parsed && typeof parsed.id === 'string') run.ids.push(parsed.id);
      }
    }
  })();

  // ---- stderr：独立诊断通道，限量保留，绝不解析为资料 ----
  const stderrLoop = (async () => {
    for await (const chunk of child.stderr) {
      run.diagnostics.totalBytes += chunk.length;
      const remaining = DIAGNOSTICS_LIMIT_BYTES - run.diagnostics.keptBytes;
      if (remaining > 0) {
        const kept = chunk.subarray(0, Math.min(remaining, chunk.length));
        diagnostics.push(Buffer.from(kept));
        run.diagnostics.keptBytes += kept.length;
      }
      if (run.diagnostics.totalBytes > DIAGNOSTICS_LIMIT_BYTES) {
        run.diagnostics.truncated = true;
      }
      // 记录设备主动申报的后代 pid，用于回收后的存活核对
      const match = chunk.toString('utf8').match(/"childPid"\s*:\s*(\d+)/);
      if (match) descendants.add(Number(match[1]));
    }
  })();

  const event = await Promise.race([closed, fatal, timedOut]);

  if (event.kind === 'timeout' || event.kind === 'fatal') {
    // 超时或进程仍存活的致命成帧错误：回收整棵进程树，并等待真正退出
    run.kill = await killProcessTree(child.pid, [...descendants], event.kind);
    const exit = await Promise.race([
      closed,
      new Promise(resolve => setTimeout(() => resolve(null), CLOSE_WAIT_MS)),
    ]);
    if (exit) { run.exitCode = exit.code; run.signal = exit.signal; }
  } else {
    const exit = await closed;
    run.exitCode = exit.code;
    run.signal = exit.signal;
  }
  await Promise.allSettled([stdoutLoop, stderrLoop]);

  // ---- 单一判定点：退出成功也必须核对尾标与摘要；warning 不参与资料判定 ----
  if (event.kind === 'timeout') {
    setTerminal('timeout', event.reason);
  } else if (event.kind === 'fatal') {
    setTerminal('failed', framingError);
  } else if (run.exitCode !== 0) {
    setTerminal('failed', '退出码异常：' + (run.signal ? 'signal=' + run.signal : 'code=' + run.exitCode));
  } else if (framingError) {
    setTerminal('failed', framingError);
  } else if (trailer === null) {
    setTerminal('failed', '缺少记录尾标');
  } else if (stdoutBuffer.length > 0) {
    setTerminal('failed', '尾标后存在不完整字节：' + stdoutBuffer.length + ' 字节');
  } else if (typeof trailer.count !== 'number' || trailer.count < 0) {
    setTerminal('failed', '尾标 count 非法');
  } else if (trailer.count !== records.length) {
    setTerminal('failed', `尾标 count=${trailer.count} 与实际资料行数 ${records.length} 不一致`);
  } else if (typeof trailer.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(trailer.sha256)) {
    setTerminal('failed', '尾标 sha256 非法');
  } else {
    const actual = hash.digest('hex');
    run.digest.expected = trailer.sha256;
    run.digest.actual = actual;
    const expectedBuffer = Buffer.from(trailer.sha256, 'hex');
    const actualBuffer = Buffer.from(actual, 'hex');
    run.digest.match = timingSafeEqual(expectedBuffer, actualBuffer);
    if (!run.digest.match) {
      setTerminal('failed', '资料摘要 sha256 与尾标不一致');
    } else {
      run.recordCount = records.length;
      run.expectedCount = trailer.count;
      run.recordsDelivered = true;
      setTerminal('complete', null);
    }
  }

  return finalize();

  async function finalize() {
    // 诊断独立限量落盘（按字节截断，保留前段）
    try {
      const kept = Buffer.concat(diagnostics).subarray(0, DIAGNOSTICS_LIMIT_BYTES);
      await writeFile(diagnosticsPath, kept);
    } catch (error) {
      run.reason = run.reason ?? '诊断落盘失败：' + error.message;
    }
    if (run.diagnostics.truncated) {
      run.diagnostics.note =
        `诊断共 ${run.diagnostics.totalBytes} 字节，仅保留前 ${run.diagnostics.keptBytes} 字节（上限 ${DIAGNOSTICS_LIMIT_BYTES}）`;
    } else {
      run.diagnostics.note = `诊断完整保留 ${run.diagnostics.keptBytes} 字节，未截断`;
    }
    // 失败/超时的资料不交付：关闭并标记 ndjson，防止被误当完整资料消费
    if (recordStream) {
      try {
        await new Promise(resolve => recordStream.end(resolve));
        await recordHandle?.sync();
        await recordHandle?.close();
      } catch { /* 忽略关闭异常，判定已由其他原因给出 */ }
      recordStream = null;
      recordHandle = null;
      if (!run.recordsDelivered) {
        await writeFile(recordPath + '.incomplete', '').catch(() => {});
      }
    }
    // 回收后核对：父进程与后代是否仍存活
    if (run.kill) {
      run.childrenAlive =
        (run.kill.parentAlive ? 1 : 0) + run.kill.descendantsAlive.length;
    } else {
      run.childrenAlive = descendants.size === 0 ? 0 : null;
    }
    if (timer) { clearTimeout(timer); timer = null; }
    for (const pending of fatalTimers) clearTimeout(pending);
    return run;
  }
}

/** 原子写入 JSON（临时文件 + rename），避免重启读到半成品状态。 */
export async function writeJsonAtomic(target, value) {
  const temporary = target + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2);
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, target);
}
