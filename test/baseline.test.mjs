import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http2 from 'node:http2';
import { startSource } from '../src/source.mjs';
import { inspectSource } from '../src/inspect.mjs';

const scenarios = JSON.parse(await readFile(new URL('../fixtures/cases.json', import.meta.url)));
for (const scenario of scenarios) {
  test('来源契约：' + scenario.name, async () => {
    const source = await startSource(scenario);
    try {
      if (scenario.kind === 'h2') {
        const client = http2.connect(source.url);
        try {
          const stream = client.request({ ':path': '/about' });
          const chunks = [];
          for await (const chunk of stream) chunks.push(chunk);
          assert.equal(JSON.parse(Buffer.concat(chunks)).kind, 'h2');
        } finally { client.destroy(); }
      } else {
        assert.equal((await inspectSource(source.url)).name, scenario.name);
        const missing = await fetch(source.url + '/not-a-resource');
        assert.equal(missing.status, 404);
        for (const route of scenario.routes) {
          const path = route.path;
          const response = await fetch(source.url + path, { method: route.method ?? 'GET', redirect: 'manual' });
          assert.equal(response.status, route.status ?? 200);
          const text = await response.text();
          const expected = typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
          if (route.path === '/policy') {
            const actual = JSON.parse(text); assert.ok(actual.outlets.A); assert.ok(actual.outlets.B); delete actual.outlets;
            assert.deepEqual(actual, route.body);
          } else assert.equal(text, expected);
        }
      }
      assert.ok(source.history.length > 0);
    } finally { await source.close(); }
  });
}
