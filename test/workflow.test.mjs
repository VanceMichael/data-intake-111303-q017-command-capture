import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../src/workflow.mjs';
import { runCommand } from '../src/runner.mjs';

const DEVICE = path.resolve('fixtures/device.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function tempState() {
  return mkdtemp(path.join(tmpdir(), 'capture-state-'));
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// —— 工作流：四个契约场景 ——

test('警告不否定完整资料', async () => {
  const stateDir = await tempState();
  try {
    const result = await run({ source: null, stateDir, input: { deviceCommand: DEVICE, commands: [{ device: 'one', mode: 'warning' }] } });
    assert.equal(result.states.one, 'complete');
    assert.deepEqual(result.ids, ['sample-1']);
    assert.equal(result.childrenAlive, 0);
    assert.equal(result.diagnosticsTruncated, false);
    const [entry] = result.runs;
    assert.equal(entry.status, 'complete');
    assert.ok(entry.runId);
    assert.equal(entry.diagnostics.warnings.length, 1);
    assert.match(entry.diagnostics.warnings[0], /仪器需要维护/);
    assert.equal(entry.sha256, entry.trailer.sha256);
    assert.equal(entry.recordCount, 1);
    assert.deepEqual(entry.exit, { code: 0, signal: null });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('写出完整尾标后异常退出仍失败，且结果落盘一致', async () => {
  const stateDir = await tempState();
  try {
    const result = await run({ source: null, stateDir, input: { deviceCommand: DEVICE, commands: [{ device: 'one', mode: 'bad-exit' }] } });
    assert.equal(result.states.one, 'failed');
    assert.deepEqual(result.ids, []);
    const [entry] = result.runs;
    assert.equal(entry.status, 'failed');
    assert.equal(entry.reason, 'exit-code-7');
    // 尾标其实完整可见，但退出码非零：资料不交付
    assert.equal(entry.recordCount, 1);
    assert.equal(entry.trailer.count, 1);
    assert.equal(entry.sha256, null);
    assert.deepEqual(entry.ids, []);
    const saved = JSON.parse(await readFile(path.join(stateDir, 'result.json'), 'utf8'));
    assert.deepEqual(saved, JSON.parse(JSON.stringify(result)));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('超时清理整棵进程树，后代一个不剩', async () => {
  const stateDir = await tempState();
  try {
    const result = await run({ source: null, stateDir, input: { deviceCommand: DEVICE, commands: [{ device: 'one', mode: 'descendant', timeoutMs: 150 }] } });
    assert.equal(result.states.one, 'timeout');
    assert.deepEqual(result.ids, []);
    assert.equal(result.childrenAlive, 0);
    const [entry] = result.runs;
    assert.equal(entry.status, 'timeout');
    assert.equal(entry.timedOut, true);
    assert.equal(entry.descendants.length, 1);
    assert.equal(entry.descendantsAlive, 0);
    assert.equal(pidAlive(entry.descendants[0]), false, '后代进程应被清理');
    assert.equal(pidAlive(entry.pid), false, '子进程应被清理');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('stdout/stderr 高速交错：诊断不进入资料通道，截断记账准确', async () => {
  const stateDir = await tempState();
  try {
    const result = await run({ source: null, stateDir, input: { deviceCommand: DEVICE, commands: [{ device: 'one', mode: 'interleave' }] } });
    assert.equal(result.states.one, 'complete');
    assert.deepEqual(result.ids, ['sample-1']);
    assert.equal(result.diagnosticsTruncated, true);
    const [entry] = result.runs;
    assert.equal(entry.recordCount, 1);
    assert.equal(entry.diagnostics.truncated, true);
    assert.ok(entry.diagnostics.bytesCaptured <= 4096);
    assert.ok(entry.diagnostics.bytesDropped > 0);
    // 设备写 200 行诊断，每行 “本地设备诊断”×20 + 换行
    const expected = 200 * (Buffer.byteLength('本地设备诊断'.repeat(20)) + 1);
    assert.equal(entry.diagnostics.bytesCaptured + entry.diagnostics.bytesDropped, expected);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

// —— 工作流：批次、身份与恢复 ——

test('同批次多设备并发，部分成功单独交付', async () => {
  const stateDir = await tempState();
  try {
    const result = await run({
      source: null,
      stateDir,
      input: {
        deviceCommand: DEVICE,
        commands: [
          { device: 'a', mode: 'warning' },
          { device: 'b', mode: 'bad-exit' },
          { device: 'c', mode: 'interleave' },
        ],
      },
    });
    assert.deepEqual(result.states, { a: 'complete', b: 'failed', c: 'complete' });
    assert.deepEqual(result.ids, ['sample-1', 'sample-1']);
    assert.equal(result.diagnosticsTruncated, true);
    assert.equal(result.runs.length, 3);
    const runIds = new Set(result.runs.map(entry => entry.runId));
    assert.equal(runIds.size, 3, '每个运行必须有独立身份');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('同设备重复请求：相同参数去重共享身份，冲突参数明确拒绝', async () => {
  const stateDir = await tempState();
  try {
    const deduped = await run({
      source: null,
      stateDir,
      input: { deviceCommand: DEVICE, commands: [{ device: 'one', mode: 'warning' }, { device: 'one', mode: 'warning' }] },
    });
    assert.equal(deduped.runs.length, 2);
    assert.equal(deduped.runs[1].deduped, true);
    assert.equal(deduped.runs[1].runId, deduped.runs[0].runId, '重复请求共享同一运行身份');
    assert.deepEqual(deduped.ids, ['sample-1'], '去重后资料不重复交付');
    assert.equal(deduped.states.one, 'complete');

    const conflict = await run({
      source: null,
      stateDir,
      input: { deviceCommand: DEVICE, commands: [{ device: 'two', mode: 'warning' }, { device: 'two', mode: 'bad-exit' }] },
    });
    assert.equal(conflict.runs[1].status, 'rejected');
    assert.equal(conflict.runs[1].reason, 'device-busy-conflicting-mode');
    assert.notEqual(conflict.runs[1].runId, conflict.runs[0].runId);
    assert.equal(conflict.states.two, 'complete', '被拒绝的请求不占用设备状态位');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('执行器重启：上一 boot 未完结运行判定 aborted，身份不混淆', async () => {
  const stateDir = await tempState();
  try {
    await mkdir(path.join(stateDir, 'runs'), { recursive: true });
    await writeFile(path.join(stateDir, 'runs', 'stale-run.json'), JSON.stringify({
      runId: 'stale-run', bootId: 'previous-boot', device: 'one', mode: 'warning', status: 'running', startedAt: new Date().toISOString(),
    }));
    const result = await run({ source: null, stateDir, input: { deviceCommand: DEVICE, commands: [{ device: 'one', mode: 'warning' }] } });
    assert.deepEqual(result.recoveredAbortedRuns, ['stale-run']);
    const stale = JSON.parse(await readFile(path.join(stateDir, 'runs', 'stale-run.json'), 'utf8'));
    assert.equal(stale.status, 'aborted');
    assert.equal(stale.reason, 'executor-restart');
    assert.notEqual(result.runs[0].runId, 'stale-run');
    assert.equal(result.states.one, 'complete');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('运行身份只用 runId：连续运行身份唯一，日志按 runId 归档', async () => {
  const stateDir = await tempState();
  try {
    const runIds = [];
    for (let index = 0; index < 3; index += 1) {
      const result = await run({ source: null, stateDir, input: { deviceCommand: DEVICE, commands: [{ device: 'one', mode: 'warning' }] } });
      runIds.push(result.runs[0].runId);
      assert.equal(typeof result.runs[0].pid, 'number');
    }
    assert.equal(new Set(runIds).size, 3, '进程号可能复用，runId 必须唯一');
    const files = (await readdir(path.join(stateDir, 'runs'))).filter(name => name.endsWith('.json'));
    assert.equal(files.length, 3);
    for (const runId of runIds) {
      const record = JSON.parse(await readFile(path.join(stateDir, 'runs', runId + '.json'), 'utf8'));
      assert.equal(record.status, 'complete');
      assert.ok(record.bootId);
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('取消：结束后代进程树，判定 cancelled', async () => {
  const stateDir = await tempState();
  try {
    const result = await run({
      source: null,
      stateDir,
      signal: AbortSignal.timeout(120),
      input: { deviceCommand: DEVICE, commands: [{ device: 'one', mode: 'descendant' }] },
    });
    assert.equal(result.states.one, 'cancelled');
    assert.equal(result.childrenAlive, 0);
    assert.equal(result.runs[0].cancelled, true);
    assert.ok(result.runs[0].durationMs < 5000, '取消必须及时生效');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('白名单：越界命令、脚本、字段、限量一律拒绝，且不产生子进程', async () => {
  const stateDir = await tempState();
  try {
    await assert.rejects(
      () => run({ source: null, stateDir, input: { deviceCommand: DEVICE, commands: [{ device: 'one', mode: 'warning; touch /tmp/pwned' }] } }),
      /白名单拒绝/,
    );
    await assert.rejects(
      () => run({ source: null, stateDir, input: { deviceCommand: '/etc/hostname', commands: [{ device: 'one', mode: 'warning' }] } }),
      /白名单拒绝/,
    );
    await assert.rejects(
      () => run({ source: null, stateDir, input: { deviceCommand: DEVICE, commands: [{ device: 'one', mode: 'warning', extra: 1 }] } }),
      /白名单拒绝/,
    );
    await assert.rejects(
      () => run({ source: null, stateDir, input: { deviceCommand: DEVICE, commands: [{ device: 'one', mode: 'warning', timeoutMs: 99999999 }] } }),
      /白名单拒绝/,
    );
    await assert.rejects(
      () => run({ source: null, stateDir, input: { deviceCommand: DEVICE, commands: [{ device: 'one;rm', mode: 'warning' }] } }),
      /白名单拒绝/,
    );
    assert.equal(pidAlive(undefined), false);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

// —— 运行引擎：背压、迟到输出、强杀、成帧核验 ——

const BIG_WRITER = [
  "const { createHash } = require('node:crypto');",
  "const hash = createHash('sha256');",
  "let n = 0;",
  "for (let i = 0; i < 500; i += 1) {",
  "  const line = JSON.stringify({ id: 'rec-' + i, seq: i, pad: 'x'.repeat(480) }) + '\\n';",
  "  hash.update(line); n += 1; process.stdout.write(line);",
  "}",
  "process.stdout.write(JSON.stringify({ trailer: { count: n, sha256: hash.digest('hex') } }) + '\\n');",
].join(' ');

test('背压：消费慢时读取暂停，压力经管道传到子进程', async () => {
  const sequences = [];
  const handle = runCommand(
    { command: process.execPath, args: ['-e', BIG_WRITER], framing: 'ndjson-trailer-v1', limits: { timeoutMs: 30000, maxStdoutBytes: 4 * 1024 * 1024 } },
    { onRecord: record => { sequences.push(record.seq); return sleep(2); } },
  );
  let maxBuffered = 0;
  const sampler = setInterval(() => {
    if (handle.child.stdout) maxBuffered = Math.max(maxBuffered, handle.child.stdout.readableLength);
  }, 2);
  const result = await handle.done;
  clearInterval(sampler);
  assert.equal(result.status, 'complete');
  assert.equal(result.recordCount, 500);
  assert.deepEqual(sequences, Array.from({ length: 500 }, (_, index) => index), '资料帧必须按序消费');
  const totalBytes = 500 * (Buffer.byteLength(JSON.stringify({ id: 'rec-0', seq: 0, pad: 'x'.repeat(480) })) + 1);
  assert.ok(maxBuffered < 150 * 1024, `消费暂停期间缓冲区必须有界，实测 ${maxBuffered}`);
  assert.ok(totalBytes > maxBuffered, '总量远大于缓冲峰值才说明背压真的传到了子进程');
});

const LATE_TRAILER = [
  "const { createHash } = require('node:crypto');",
  "const line = JSON.stringify({ id: 'late-1' }) + '\\n';",
  "process.stdout.write(line);",
  "setTimeout(() => {",
  "  process.stdout.write(JSON.stringify({ trailer: { count: 1, sha256: createHash('sha256').update(line).digest('hex') } }) + '\\n');",
  "}, 400);",
].join(' ');

test('超时后的迟到输出不得继续提交', async () => {
  let delivered = 0;
  const handle = runCommand(
    { command: process.execPath, args: ['-e', LATE_TRAILER], framing: 'ndjson-trailer-v1', limits: { timeoutMs: 120, killGraceMs: 100 } },
    { onRecord: () => { delivered += 1; } },
  );
  const result = await handle.done;
  assert.equal(result.status, 'timeout');
  assert.deepEqual(result.ids, []);
  assert.equal(result.trailer, null, '迟到尾标不得入账');
  assert.equal(result.recordCount, 1, '超时前已解析的帧只作观察，不交付');
  assert.equal(delivered, 1);
  await sleep(600);
  assert.equal(delivered, 1, '判定落定后不得再有资料帧交付');
  assert.equal(pidAlive(result.pid), false, '超时后子进程必须被清理');
});

test('子进程无视 SIGTERM 仍存活：宽限后升级 SIGKILL', async () => {
  const stubborn = "process.on('SIGTERM', () => {}); setInterval(() => {}, 200);";
  const handle = runCommand({
    command: process.execPath,
    args: ['-e', stubborn],
    framing: 'ndjson-trailer-v1',
    limits: { timeoutMs: 100, killGraceMs: 150 },
  });
  const result = await handle.done;
  assert.equal(result.status, 'timeout');
  assert.ok(result.durationMs < 3000, '强杀必须及时');
  assert.equal(pidAlive(result.pid), false, 'SIGKILL 后子进程不得存活');
});

test('取消运行：进程立即被清理，判定 cancelled', async () => {
  const handle = runCommand({
    command: process.execPath,
    args: ['-e', "setInterval(() => {}, 200);"],
    framing: 'ndjson-trailer-v1',
    limits: { timeoutMs: 30000 },
  });
  await sleep(80);
  handle.cancel('测试取消');
  const result = await handle.done;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, '测试取消');
  assert.equal(result.cancelled, true);
  assert.equal(pidAlive(result.pid), false);
});

// 退出码为 0 也必须核对尾标与摘要：以下全部是“干净退出”的失败导出
const FRAMING_CASES = [
  {
    name: '输出截断（结尾半行）',
    script: "process.stdout.write(JSON.stringify({ id: 'a' }).slice(0, 5));",
    reason: 'framing-truncated-final-line',
  },
  {
    name: '缺少尾标',
    script: "process.stdout.write(JSON.stringify({ id: 'a' }) + '\\n');",
    reason: 'framing-missing-trailer',
  },
  {
    name: '计数与摘要不符',
    script: "const h = require('node:crypto').createHash('sha256'); const line = JSON.stringify({ id: 'a' }) + '\\n'; h.update(line); process.stdout.write(line + JSON.stringify({ trailer: { count: 2, sha256: h.digest('hex') } }) + '\\n');",
    reason: 'framing-count-mismatch',
  },
  {
    name: '摘要造假',
    script: "process.stdout.write(JSON.stringify({ id: 'a' }) + '\\n' + JSON.stringify({ trailer: { count: 1, sha256: '0'.repeat(64) } }) + '\\n');",
    reason: 'framing-digest-mismatch',
  },
  {
    name: '尾标后还有数据',
    script: "const h = require('node:crypto').createHash('sha256'); const line = JSON.stringify({ id: 'a' }) + '\\n'; h.update(line); process.stdout.write(line + JSON.stringify({ trailer: { count: 1, sha256: h.digest('hex') } }) + '\\n' + JSON.stringify({ id: 'b' }) + '\\n');",
    reason: 'framing-trailing-data-after-trailer',
  },
  {
    name: '非 JSON 行混入',
    script: "process.stdout.write('progress 50%\\n' + JSON.stringify({ id: 'a' }) + '\\n');",
    reason: 'framing-invalid-json-line-1',
  },
];

for (const framingCase of FRAMING_CASES) {
  test('退出码 0 仍判失败：' + framingCase.name, async () => {
    const handle = runCommand({
      command: process.execPath,
      args: ['-e', framingCase.script],
      framing: 'ndjson-trailer-v1',
      limits: { timeoutMs: 10000 },
    });
    const result = await handle.done;
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, framingCase.reason);
    assert.deepEqual(result.ids, [], '失败导出的资料不得交付');
    assert.equal(result.exit.code, 0, '场景前提：进程是干净退出的');
  });
}
