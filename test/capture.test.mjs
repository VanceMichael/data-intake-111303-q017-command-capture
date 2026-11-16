import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  captureCommand,
  splitFrames,
  resolveDeviceCommand,
  DIAGNOSTICS_LIMIT_BYTES,
} from '../src/capture.mjs';
import { run } from '../src/workflow.mjs';

const deviceCommand = path.resolve('fixtures/device.mjs');
const helperCommand = path.resolve('test/helper-device.mjs');

async function freshDir() {
  return mkdtemp(path.join(tmpdir(), 'cap-test-'));
}

// 白名单外的测试设备通过与 captureCommand 相同的受控参数启动
function captureHelper(mode, options = {}) {
  const runDir = options.runDir;
  return captureCommand({
    runId: randomUUID(),
    device: options.device ?? 'helper',
    mode,
    deviceCommand: helperCommand,
    timeoutMs: options.timeoutMs ?? 5000,
    runDir,
  });
}

test('splitFrames 按字节切帧并保留残余', () => {
  const full = Buffer.from('{"a":1}\n{"b":2}\n');
  const first = splitFrames(full.subarray(0, 10));
  assert.equal(first.lines.length, 1);
  assert.ok(first.rest.length > 0);
  const merged = Buffer.concat([first.rest, full.subarray(10)]);
  const second = splitFrames(merged, true);
  assert.equal(second.lines.length, 1);
  assert.equal(second.lines[0].toString('utf8'), '{"b":2}\n');
});

test('白名单：非 fixtures/device.mjs 的路径一律拒绝', () => {
  assert.throws(() => resolveDeviceCommand('/tmp/evil.mjs'), /非白名单/);
  assert.throws(() => resolveDeviceCommand('fixtures/device.mjs/../../etc/passwd'), /非白名单/);
  assert.equal(resolveDeviceCommand(undefined), deviceCommand);
  assert.equal(resolveDeviceCommand(deviceCommand), deviceCommand);
});

test('warning 不否定资料；诊断独立保留且不混入资料', async () => {
  const dir = await freshDir();
  try {
    const result = await captureCommand({
      runId: randomUUID(), device: 'one', mode: 'warning',
      deviceCommand, timeoutMs: 5000, runDir: dir,
    });
    assert.equal(result.state, 'complete');
    assert.deepEqual(result.ids, ['sample-1']);
    assert.equal(result.digest.match, true);
    assert.equal(result.diagnostics.truncated, false);
    const diagnostics = await readFile(path.join(dir, 'diagnostics.log'), 'utf8');
    assert.match(diagnostics, /warning/);
    const records = await readFile(path.join(dir, 'records.ndjson'), 'utf8');
    assert.doesNotMatch(records, /warning|维护/);
    assert.equal(result.childrenAlive, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('bad-exit：完整尾标后异常退出仍判定失败且不交付', async () => {
  const dir = await freshDir();
  try {
    const result = await captureCommand({
      runId: randomUUID(), device: 'one', mode: 'bad-exit',
      deviceCommand, timeoutMs: 5000, runDir: dir,
    });
    assert.equal(result.state, 'failed');
    assert.equal(result.recordsDelivered, false);
    // 采集到的 id 仍如实记录在运行详情中，但因失败不参与批次交付
    assert.deepEqual(result.ids, ['sample-1']);
    assert.equal(result.exitCode, 7);
    await stat(path.join(dir, 'records.ndjson.incomplete'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('interleave：高速 stdout/stderr 交错，诊断截断但资料完整', async () => {
  const dir = await freshDir();
  try {
    const result = await captureCommand({
      runId: randomUUID(), device: 'one', mode: 'interleave',
      deviceCommand, timeoutMs: 5000, runDir: dir,
    });
    assert.equal(result.state, 'complete');
    assert.deepEqual(result.ids, ['sample-1']);
    assert.equal(result.diagnostics.truncated, true);
    assert.ok(result.diagnostics.totalBytes > DIAGNOSTICS_LIMIT_BYTES);
    assert.equal(result.diagnostics.keptBytes, DIAGNOSTICS_LIMIT_BYTES);
    assert.match(result.diagnostics.note, /仅保留前 4096 字节/);
    const kept = await readFile(path.join(dir, 'diagnostics.log'));
    assert.equal(kept.length, DIAGNOSTICS_LIMIT_BYTES);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('descendant：超时回收整个进程树，迟到输出不提交', async () => {
  const dir = await freshDir();
  try {
    const result = await captureCommand({
      runId: randomUUID(), device: 'one', mode: 'descendant',
      deviceCommand, timeoutMs: 100, runDir: dir,
    });
    assert.equal(result.state, 'timeout');
    assert.equal(result.timedOut, true);
    assert.equal(result.recordsDelivered, false);
    assert.equal(result.childrenAlive, 0);
    assert.equal(result.kill.parentAlive, false);
    // 孙进程也在进程组信号范围内被回收
    assert.deepEqual(result.kill.descendantsAlive, []);
    await stat(path.join(dir, 'records.ndjson.incomplete'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('批次并发：多个设备部分成功可单独交付，运行身份互不相同', async () => {
  const dir = await freshDir();
  try {
    const result = await run({
      source: 'http://127.0.0.1/local',
      stateDir: dir,
      input: {
        commands: [
          { device: 'a', mode: 'warning' },
          { device: 'b', mode: 'bad-exit' },
          { device: 'c', mode: 'interleave' },
          { device: 'a', mode: 'warning' }, // 同一设备重复请求
        ],
        deviceCommand,
      },
    });
    assert.equal(result.states.a.length, 2); // 同设备两次运行都保留
    assert.deepEqual([...new Set(result.states.a)], ['complete']);
    assert.equal(result.states.b, 'failed');
    assert.equal(result.states.c, 'complete');
    // 两个 a 与一个 c 交付，共 3 条；b 失败不交付
    assert.deepEqual(result.ids, ['sample-1', 'sample-1', 'sample-1']);
    const runIds = result.runs.map(entry => entry.runId);
    assert.equal(new Set(runIds).size, 4);
    const pids = result.runs.map(entry => entry.pid);
    assert.ok(pids.every(pid => typeof pid === 'number'));
    const duplicated = result.runs.filter(entry => entry.device === 'a');
    assert.ok(duplicated.every(entry => entry.duplicatedDevice === true));
    // 落盘的 run.json 数量与运行数一致，可逐个追溯
    const dirs = await readdir(path.join(dir, 'runs'));
    assert.equal(dirs.length, 4);
    for (const runId of dirs) {
      const saved = JSON.parse(await readFile(path.join(dir, 'runs', runId, 'run.json'), 'utf8'));
      assert.equal(saved.runId, runId);
    }
    const persisted = JSON.parse(await readFile(path.join(dir, 'result.json'), 'utf8'));
    assert.equal(persisted.batchId, result.batchId);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('重启恢复：只复用已落盘可追溯的运行记录，不凭空补进度', async () => {
  const dir = await freshDir();
  try {
    await run({
      source: 'http://127.0.0.1/local',
      stateDir: dir,
      input: { commands: [{ device: 'a', mode: 'warning' }], deviceCommand },
    });
    const second = await run({
      source: 'http://127.0.0.1/local',
      stateDir: dir,
      input: { commands: [{ device: 'b', mode: 'bad-exit' }], deviceCommand },
    });
    assert.equal(second.previousRunIds.length, 1);
    assert.equal(second.previousRunIds[0].device, 'a');
    assert.equal(second.previousRunIds[0].state, 'complete');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('成帧损坏：非 JSON 资料行判失败', async () => {
  const dir = await freshDir();
  try {
    const result = await captureHelper('bad-json', { runDir: dir });
    assert.equal(result.state, 'failed');
    assert.match(result.reason, /不是合法 JSON/);
    assert.equal(result.recordsDelivered, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('摘要不匹配：sha256 与尾标不一致判失败', async () => {
  const dir = await freshDir();
  try {
    const result = await captureHelper('digest-mismatch', { runDir: dir });
    assert.equal(result.state, 'failed');
    assert.match(result.reason, /摘要/);
    assert.equal(result.digest.match, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('尾标后的迟到输出使运行失败，迟到字节不进资料', async () => {
  const dir = await freshDir();
  try {
    const result = await captureHelper('late', { runDir: dir });
    assert.equal(result.state, 'failed');
    assert.equal(result.recordsDelivered, false);
    const records = await readFile(path.join(dir, 'records.ndjson'), 'utf8');
    assert.doesNotMatch(records, /迟到/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('背压：高速设备被超时回收，采集器不丢判定、不留存活进程', { timeout: 15000 }, async () => {
  const dir = await freshDir();
  try {
    const result = await captureHelper('slow', { runDir: dir, timeoutMs: 500 });
    assert.equal(result.state, 'timeout');
    assert.equal(result.childrenAlive, 0);
    assert.ok(result.recordCount >= 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('多行资料：count 与 sha256 按原始字节逐行核对', async () => {
  const dir = await freshDir();
  try {
    const result = await captureHelper('many', { runDir: dir });
    assert.equal(result.state, 'complete');
    assert.equal(result.recordCount, 50);
    assert.equal(result.digest.match, true);
    assert.deepEqual(result.ids[0], 'rec-0');
    assert.deepEqual(result.ids.at(-1), 'rec-49');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('工作流白名单：非法 mode 与非白名单路径都不启动进程', async () => {
  const dir = await freshDir();
  const dir2 = await freshDir();
  try {
    const result = await run({
      source: 'http://127.0.0.1/local',
      stateDir: dir,
      input: {
        commands: [
          { device: 'a', mode: 'rm -rf /' },
          { device: 'b', mode: 'warning' },
        ],
        deviceCommand,
      },
    });
    assert.equal(result.states.a, 'rejected');
    assert.equal(result.states.b, 'complete');
    const rejected = result.runs.find(entry => entry.device === 'a');
    assert.equal(rejected.pid, null);
    assert.match(rejected.reason, /白名单/);
    assert.deepEqual(result.ids, ['sample-1']);

    const blocked = await run({
      source: 'http://127.0.0.1/local',
      stateDir: dir2,
      input: {
        commands: [{ device: 'a', mode: 'warning' }],
        deviceCommand: helperCommand,
      },
    });
    assert.equal(blocked.states.a, 'rejected');
    assert.match(blocked.runs[0].reason, /非白名单设备命令/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(dir2, { recursive: true, force: true });
  }
});
