import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function startSource(scenario, options = {}) {
  if (scenario.kind === 'h2') return (await import('./transport.mjs')).createH2Source(scenario);
  const history = [];
  const counters = new Map();
  const portal = scenario.kind === 'browser' ? (await import('./portal.mjs')).createPortal(scenario, history) : null;
  const outlets = {};
  const gateways = [];
  let origin;
  const server = http.createServer(async (request, response) => {
    try {
      const address = new URL(request.url, 'http://localhost');
      const parts = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 8 * 1024 * 1024) {
          response.writeHead(413).end('请求超出本地演练范围');
          return;
        }
        parts.push(chunk);
      }
      const raw = Buffer.concat(parts).toString('utf8');
      history.push({ method: request.method, path: request.url, headers: request.headers, body: raw });
      if (scenario.kind === 'browser' && await portal.handle(request, response, raw, origin)) return;
      if (address.pathname === '/about') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ name: scenario.name, product: options.product ?? '资料接收源', kind: scenario.kind ?? 'http' }));
        return;
      }
      if (address.pathname === '/send' && scenario.kind === 'multipart') {
        let input;
        try { input = JSON.parse(raw); } catch { response.writeHead(400).end('无效 JSON'); return; }
        const result = await (await import('./upload-source.mjs')).sendMultipart(input.target, scenario.mode);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(result));
        return;
      }
      const outlet = address.pathname.match(/^\/outlets\/([^/]+)(\/.*)$/);
      const logical = outlet ? outlet[2] + address.search : address.pathname + address.search;
      if (outlet && request.headers['x-tenant'] !== outlet[1]) {
        response.writeHead(403).end('出口租户不匹配'); return;
      }
      const entry = scenario.routes.find(candidate => candidate.path === logical && (candidate.method ?? 'GET') === request.method);
      if (!entry) { response.writeHead(404).end('本地来源无此资源'); return; }
      const count = counters.get(logical) ?? 0;
      counters.set(logical, count + 1);
      const reply = entry.replies ? entry.replies[Math.min(count, entry.replies.length - 1)] : entry;
      if (reply.delay) await new Promise(resolve => setTimeout(resolve, reply.delay));
      if (response.destroyed) return;
      const body = logical === '/policy' ? { ...reply.body, outlets } : reply.body;
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      response.writeHead(reply.status ?? 200, { 'content-type': reply.contentType ?? 'application/json; charset=utf-8', ...reply.headers });
      if (reply.chunks) {
        for (const part of reply.chunks) { response.write(part); await new Promise(resolve => setTimeout(resolve, 2)); }
        response.end();
      } else response.end(payload);
    } catch (error) {
      if (!response.headersSent) response.writeHead(500);
      response.end('本地来源处理失败：' + error.message);
    }
  });
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  if (scenario.routes.some(entry => entry.path === '/policy')) {
    for (const tenant of ['A', 'B']) {
      const gateway = http.createServer((request, response) => {
        const upstream = http.request(origin + '/outlets/' + tenant + request.url, { method: request.method, headers: request.headers }, reply => {
          response.writeHead(reply.statusCode, reply.headers); reply.pipe(response);
        });
        upstream.on('error', () => { response.writeHead(502).end('出口上游不可用'); });
        request.pipe(upstream);
      });
      await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
      outlets[tenant] = `http://127.0.0.1:${gateway.address().port}`;
      gateways.push(gateway);
    }
  }
  return { url: origin, history, portal, outlets, async close() {
    for (const gateway of gateways) { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cases = JSON.parse(await readFile(new URL('../fixtures/cases.json', import.meta.url)));
  const selected = Number(process.env.SOURCE_CASE ?? 0);
  const instance = await startSource(cases[selected]);
  console.log(JSON.stringify({ source: instance.url, name: cases[selected].name }));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await instance.close(); process.exit(0); });
}
