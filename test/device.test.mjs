import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

for (const mode of ['warning', 'bad-exit', 'interleave']) {
  test('合成设备输出：' + mode, async () => {
    const child = spawn(process.execPath, ['fixtures/device.mjs', mode]);
    const stdout = []; const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    const code = await new Promise(resolve => child.on('close', resolve));
    assert.equal(code, mode === 'bad-exit' ? 7 : 0);
    const lines = Buffer.concat(stdout).toString().trimEnd().split('\n');
    const trailer = JSON.parse(lines.pop()).trailer;
    assert.equal(trailer.sha256, createHash('sha256').update(lines.join('\n') + '\n').digest('hex'));
    assert.equal(trailer.count, 1);
    assert.ok(Buffer.concat(stderr).length > 0 || mode === 'bad-exit');
  });
}
test('后代进程场景确实跨越父进程寿命', { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, ['fixtures/device.mjs', 'descendant'], { detached: true });
  try {
    const chunk = await new Promise(resolve => child.stderr.once('data', resolve));
    const descendant = JSON.parse(chunk.toString().trim()).childPid;
    assert.doesNotThrow(() => process.kill(descendant, 0));
  } finally {
    process.kill(-child.pid, 'SIGKILL');
    await new Promise(resolve => child.on('close', resolve));
  }
});
