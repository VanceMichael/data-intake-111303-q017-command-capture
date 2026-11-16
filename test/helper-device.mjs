// 测试专用合成设备：仅被 test/capture.test.mjs 以白名单外路径的受控方式驱动，
// 不属于生产白名单（生产白名单只有 fixtures/device.mjs）。
import { createHash } from 'node:crypto';

const mode = process.argv[2];

if (mode === 'many') {
  const count = Number(process.argv[3] ?? 50);
  const lines = [];
  const hash = createHash('sha256');
  for (let index = 0; index < count; index += 1) {
    const line = JSON.stringify({ id: 'rec-' + index, index }) + '\n';
    hash.update(line);
    lines.push(line);
  }
  for (const line of lines) process.stdout.write(line);
  process.stdout.write(JSON.stringify({ trailer: { count, sha256: hash.digest('hex') } }) + '\n');
} else if (mode === 'slow') {
  // 高速持续输出：用于背压测试，无尾标，靠超时回收
  const line = JSON.stringify({ id: 'x'.repeat(256) }) + '\n';
  setInterval(() => {
    for (let index = 0; index < 50; index += 1) process.stdout.write(line);
  }, 5);
} else if (mode === 'late') {
  // 尾标完整后，在进程退出前再吐迟到字节
  const line = JSON.stringify({ id: 'late-1' }) + '\n';
  process.stdout.write(line);
  process.stdout.write(JSON.stringify({ trailer: { count: 1, sha256: createHash('sha256').update(line).digest('hex') } }) + '\n');
  setTimeout(() => {
    process.stdout.write('迟到输出\n');
    process.exit(0);
  }, 30);
} else if (mode === 'bad-json') {
  process.stdout.write('{不是 json\n');
  process.exit(0);
} else if (mode === 'digest-mismatch') {
  const line = JSON.stringify({ id: 'm-1' }) + '\n';
  process.stdout.write(line);
  process.stdout.write(JSON.stringify({ trailer: { count: 1, sha256: '0'.repeat(64) } }) + '\n');
  process.exit(0);
} else {
  process.exit(64);
}
