import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startSource } from '../src/source.mjs';

const { run } = await import('../src/workflow.mjs');
const scenarios = JSON.parse(await readFile(new URL('../fixtures/cases.json', import.meta.url)));

function includes(actual, expected, location = 'result') {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), location + ' 应为数组');
    if (expected.every(value => typeof value !== 'object')) assert.deepEqual([...actual].sort(), [...expected].sort(), location);
    else for (const item of expected) {
      const found = actual.find(candidate => item.id !== undefined && candidate.id === item.id);
      assert.ok(found, location + ' 缺少实体 ' + item.id);
      includes(found, item, location);
    }
  } else if (expected !== null && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object', location + ' 应为对象');
    for (const [key, value] of Object.entries(expected)) includes(actual[key], value, location + '.' + key);
  } else assert.equal(actual, expected, location);
}

for (const scenario of scenarios) {
  test('业务接收：' + scenario.name, { timeout: 15000 }, async () => {
    const source = await startSource(scenario);
    const stateDir = await mkdtemp(path.join(tmpdir(), 'material-state-'));
    try {
      const input = { ...scenario.input, deviceCommand: path.resolve('fixtures/device.mjs') };
      const actual = await run({ source: source.url, stateDir, input });
      includes(actual, scenario.expected);
      for (const required of scenario.required) assert.ok(source.history.some(entry => entry.path === required || entry.path.split('?')[0] === required), '没有实际读取 ' + required);
      for (const forbidden of scenario.forbidden ?? []) assert.ok(!source.history.some(entry => entry.path === forbidden), '错误访问禁止来源 ' + forbidden);
      for (const [resource, maximum] of Object.entries(scenario.limits ?? {})) assert.ok(source.history.filter(entry => entry.path.split('?')[0] === resource).length <= maximum, '超出请求额度 ' + resource);
      if (scenario.kind === 'browser') {
        for (const action of scenario.actions) assert.ok(source.portal.actions.some(entry => entry.action === action), '没有通过页面完成动作 ' + action);
        assert.ok(source.history.some(entry => entry.path === '/portal'), '没有打开真实门户');
      }
      const saved = JSON.parse(await readFile(path.join(stateDir, 'result.json')));
      includes(saved, scenario.expected);
    } finally {
      await source.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });
}
