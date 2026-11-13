import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const mode = process.argv[2];
if (!['warning', 'bad-exit', 'descendant', 'interleave'].includes(mode)) process.exit(64);
if (mode === 'descendant') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => process.stdout.write("child\\n"), 30)'], { stdio: ['ignore', 'inherit', 'inherit'] });
  process.stderr.write(JSON.stringify({ childPid: child.pid }) + '\n');
  setInterval(() => {}, 1000);
} else {
  const record = JSON.stringify({ id: 'sample-1', raw: 12 }) + '\n';
  if (mode === 'warning') process.stderr.write('warning: 仪器需要维护，但本次资料完整\n');
  if (mode === 'interleave') for (let index = 0; index < 200; index += 1) process.stderr.write('本地设备诊断'.repeat(20) + '\n');
  process.stdout.write(record.slice(0, 8));
  await new Promise(resolve => setTimeout(resolve, 5));
  process.stdout.write(record.slice(8));
  process.stdout.write(JSON.stringify({ trailer: { count: 1, sha256: createHash('sha256').update(record).digest('hex') } }) + '\n');
  process.exitCode = mode === 'bad-exit' ? 7 : 0;
}
