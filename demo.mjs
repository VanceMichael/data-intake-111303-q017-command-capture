import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startSource } from './src/source.mjs';

const { run } = await import('./src/workflow.mjs');
setTimeout(() => { console.error('运行超过 75 秒，停止并保留失败状态'); process.exit(124); }, 75000).unref();
const scenarios = JSON.parse(await readFile(new URL('./fixtures/cases.json', import.meta.url)));
for (const scenario of scenarios.slice(0, 3)) {
  const source = await startSource(scenario);
  const stateDir = await mkdtemp(path.join(tmpdir(), 'material-demo-'));
  try {
    console.log('正在执行：' + scenario.name);
    const result = await run({ source: source.url, stateDir, input: { ...scenario.input, deviceCommand: path.resolve('fixtures/device.mjs') } });
    console.log(JSON.stringify(result, null, 2));
    console.log('实际来源访问：' + JSON.stringify(source.history.map(entry => ({ method: entry.method, path: entry.path }))));
  } finally { await source.close(); await rm(stateDir, { recursive: true, force: true }); }
}
