import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startSource } from './source.mjs';

export async function inspectSource(source) {
  const response = await fetch(source + '/about', { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error('来源不可用：' + response.status);
  return response.json();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cases = JSON.parse(await readFile(new URL('../fixtures/cases.json', import.meta.url)));
  const scenario = cases.find(item => item.kind !== 'h2');
  if (!scenario) { console.log('资料网关使用 HTTP2；请运行 npm test 检查来源'); process.exit(0); }
  const source = await startSource(scenario);
  try { console.log(JSON.stringify(await inspectSource(source.url), null, 2)); }
  finally { await source.close(); }
}
