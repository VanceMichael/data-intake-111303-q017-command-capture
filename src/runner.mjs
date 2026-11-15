import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { TrailerParser } from './framing.mjs';
import { Diagnostics } from './diagnostics.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const WARNING_LINE = /^warning\b/i;

// 单次命令运行引擎。spec 必须来自白名单清单（见 manifest.mjs）：
//   { command, args, framing, limits }
// options:
//   onRecord(record)  流式观察资料帧，可返回 Promise；返回慢时通过暂停读取把背压传给子进程
//   signal            AbortSignal，触发即取消并清理整棵进程树
// 返回句柄 { runId, pid, child, done, cancel }。done 永远解决为运行结果，绝不拒绝。
// 运行身份只用 runId（uuid）；pid 与 child 仅是观察信息，进程号复用不会影响身份。
export function runCommand(spec, options = {}) {
  if (spec.framing !== 'ndjson-trailer-v1') throw new Error(`未实现的成帧方式：${spec.framing}`);
  const limits = {
    stderrMaxBytes: 4096,
    maxStdoutBytes: 1024 * 1024,
    maxRecords: 10000,
    timeoutMs: 10000,
    killGraceMs: 250,
    closeWaitMs: 2000,
    ...(spec.limits ?? {}),
  };
  const runId = randomUUID();
  const startedAt = new Date();
  const parser = new TrailerParser({ maxRecords: limits.maxRecords });
  const diagnostics = new Diagnostics(limits.stderrMaxBytes);
  const state = {
    settled: false,        // 判定已落定：之后的迟到输出一律不再提交
    closed: false,
    exitCode: null,
    exitSignal: null,
    timedOut: false,
    cancelled: false,
    verdict: null,
    reason: null,
    stdoutBroken: false,   // 成帧已破坏：继续排空 stdout 但不再解析
    stdioHeldOpen: false,  // 子进程退出后 stdio 被后代持有
  };
  let received = 0;

  let child;
  try {
    child = spawn(spec.command, spec.args, {
      shell: false,        // 白名单命令 + 参数数组，绝不拼接 shell
      detached: true,      // 独立进程组：取消/超时时按组清理整棵进程树
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: spec.cwd,
      env: spec.env ?? process.env,
    });
  } catch (error) {
    return immediateFailure(runId, startedAt, 'spawn-failed:' + error.message);
  }

  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const timers = new Set();
  const later = (ms, fn) => {
    const timer = setTimeout(fn, ms);
    timers.add(timer);
    return timer;
  };
  const clearTimers = () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };

  const killGroup = signal => {
    if (child.pid == null) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') {
        try { child.kill(signal); } catch { /* 进程已退出 */ }
      }
    }
  };

  // stderr：独立诊断通道，限量保存，超量丢弃但持续排空（防止子进程阻塞在写管道上）
  child.stderr.on('data', chunk => diagnostics.push(chunk));

  // stdout：按声明成帧解析。for-await 是拉取式消费——onRecord 未返回前不再读取，
  // 管道缓冲区填满后子进程自然阻塞在写操作上，背压由此传到子进程。
  const pump = (async () => {
    try {
      for await (const chunk of child.stdout) {
        if (state.settled) break;                 // 已判定：迟到输出不再进入解析
        if (state.stdoutBroken) continue;         // 成帧已破坏：只排空，不解析
        received += chunk.length;
        if (received > limits.maxStdoutBytes) {
          parser.fail('stdout-limit-exceeded');
          state.stdoutBroken = true;
          continue;
        }
        parser.feed(chunk);
        if (parser.error) { state.stdoutBroken = true; continue; }
        if (options.onRecord) {
          for (const record of parser.takeRecords()) {
            if (state.settled) break;
            await options.onRecord(record);
          }
        } else {
          parser.takeRecords();
        }
      }
    } catch { /* 判定后流被销毁属正常 */ } finally {
      parser.endOfStream();
    }
  })();

  // 判定落定（幂等，先到先生效）。kill 路径：先 SIGTERM 整组，宽限后升级 SIGKILL。
  function settle(verdict, reason, { kill = false, timedOut = false, cancelled = false } = {}) {
    if (state.settled) return;
    state.settled = true;
    state.verdict = verdict;
    state.reason = reason;
    state.timedOut = timedOut;
    state.cancelled = cancelled;
    if (kill) {
      killGroup('SIGTERM');
      later(limits.killGraceMs, () => { if (!state.closed) killGroup('SIGKILL'); });
    }
  }

  const onAbort = () => settle('cancelled', 'aborted-by-caller', { kill: true, cancelled: true });
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }

  later(limits.timeoutMs, () => settle('timeout', `timeout-after-${limits.timeoutMs}ms`, { kill: true, timedOut: true }));

  const noteExit = (code, signal) => {
    if (code !== null) state.exitCode = code;
    if (signal !== null) state.exitSignal = signal;
  };
  child.on('error', error => {
    // 启动失败：没有进程可等，直接按已关闭处理
    state.closed = true;
    settle('failed', 'spawn-failed:' + error.message);
  });
  child.on('exit', (code, signal) => {
    noteExit(code, signal);
    // 子进程已退出但 stdio 未关：有后代持有管道 → 强杀整组，绝不悬挂
    later(limits.closeWaitMs, () => {
      if (!state.closed) {
        state.stdioHeldOpen = true;
        killGroup('SIGKILL');
      }
    });
  });
  child.on('close', (code, signal) => {
    noteExit(code, signal);
    state.closed = true;
  });

  // 收尾：等子进程真正结束（有硬上限），再做最终判定。判定需要两者同时成立：
  //   1. 成帧核验通过（尾标存在、计数与摘要相符、无截断、尾标后无数据）
  //   2. 退出码为 0 且无信号
  // 缺任何一条都是 failed——退出成功不能代替尾标与摘要核验。
  const finalize = async () => {
    try {
      const deadline = Date.now() + limits.timeoutMs + limits.killGraceMs + 3 * limits.closeWaitMs + 1000;
      while (!state.closed && Date.now() < deadline) await sleep(10);
      await Promise.race([pump, sleep(limits.closeWaitMs)]);
      if (!state.settled) {
        const framing = parser.result();
        if (!framing.ok) settle('failed', 'framing-' + framing.error);
        else if (state.exitCode !== 0 || state.exitSignal !== null) {
          settle('failed', state.exitSignal ? `signal-${state.exitSignal}` : `exit-code-${state.exitCode}`);
        } else {
          settle('complete', null);
        }
      }
    } catch (error) {
      settle('failed', 'internal-' + error.message);
    } finally {
      clearTimers();
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      const framing = parser.result();
      const summary = diagnostics.summary();
      const endedAt = new Date();
      resolveDone({
        runId,
        status: state.verdict,
        reason: state.reason,
        // 资料只在 complete 时交付；其余判定一律不提交
        ids: state.verdict === 'complete' ? framing.ids : [],
        records: state.verdict === 'complete' ? framing.records : [],
        recordCount: framing.recordCount,
        sha256: state.verdict === 'complete' ? framing.sha256 : null,
        trailer: framing.trailer ?? null,
        exit: { code: state.exitCode, signal: state.exitSignal },
        diagnostics: {
          ...summary,
          warnings: summary.text.split('\n').map(line => line.trim()).filter(line => WARNING_LINE.test(line)),
        },
        pid: child.pid ?? null,
        timedOut: state.timedOut,
        cancelled: state.cancelled,
        stdioHeldOpen: state.stdioHeldOpen,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - startedAt.getTime(),
      });
    }
  };
  void finalize();

  return {
    runId,
    get pid() { return child.pid ?? null; },
    child,                  // 仅观察用途（测试与运维探针），不作运行身份
    done,
    cancel(reason = 'cancelled-by-caller') {
      settle('cancelled', reason, { kill: true, cancelled: true });
    },
  };
}

function immediateFailure(runId, startedAt, reason) {
  const endedAt = new Date();
  const result = {
    runId,
    status: 'failed',
    reason,
    ids: [],
    records: [],
    recordCount: 0,
    sha256: null,
    trailer: null,
    exit: { code: null, signal: null },
    diagnostics: { text: '', truncated: false, bytesCaptured: 0, bytesDropped: 0, warnings: [] },
    pid: null,
    timedOut: false,
    cancelled: false,
    stdioHeldOpen: false,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
  };
  return { runId, pid: null, child: null, done: Promise.resolve(result), cancel() {} };
}
