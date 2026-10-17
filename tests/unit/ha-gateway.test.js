import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import selfsigned from 'selfsigned';
import { afterEach, expect, it } from 'vitest';
import * as gateway from '../../src/lib/ha/gateway.js';
const servers = [];
async function upstream(handler) {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/health') { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); }
    else handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
async function start(origins) {
  const instance = gateway.createGateway({ origins, port: 0, intervalMs: 0 });
  servers.push({ closeAllConnections() {}, close: fn => instance.close().then(fn) });
  await instance.ready;
  for (let i = 0; i < 3; i++) {
    const health = await (await fetch(`http://127.0.0.1:${instance.server.address().port}/health`)).json();
    if (health.origins.every(origin => origin.healthy)) break;
    await instance.probeNow();
  }
  return { ...instance, url: `http://127.0.0.1:${instance.server.address().port}` };
}
afterEach(async () => {
  for (const s of servers.splice(0).reverse()) { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); }
});
it('provides a client gateway', () => expect(gateway.createGateway).toBeTypeOf('function'));
it('keeps authorization, model, tools and effort unchanged through a fresh failover', async () => {
  let received;
  const a = await upstream((req, res) => res.end('primary'));
  const b = await upstream(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received = { headers: req.headers, body: JSON.parse(body) };
    res.setHeader('content-type', 'text/event-stream'); res.end('data: {"result":"azure"}\n\ndata: [DONE]\n\n');
  });
  const g = await start([{ url: a.url, name: 'primary' }, { url: b.url, name: 'azure' }]);
  expect(await (await fetch(`${g.url}/v1/chat/completions`, { method: 'POST', body: '{}' })).text()).toBe('primary');
  await new Promise(resolve => a.server.close(resolve));
  await g.probeNow();
  const body = { model: 'coding', messages: [{ role: 'user', content: 'test' }], tools: [{ type: 'function', function: { name: 'test' } }], reasoning_effort: 'xhigh', stream: true };
  const response = await fetch(`${g.url}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer client-key' }, body: JSON.stringify(body) });
  expect(await response.text()).toContain('azure');
  expect(received.headers.authorization).toBe('Bearer client-key');
  expect(received.body).toEqual(body);
  expect(response.headers.get('x-9router-ha-origin')).toBe('azure');
});
it('never replays an accepted request after a socket failure', async () => {
  let alternateCalls = 0, primaryCalls = 0;
  const a = await upstream((req) => { primaryCalls++; req.socket.destroy(); });
  const b = await upstream((req, res) => { alternateCalls++; res.end('duplicate'); });
  const g = await start([{ url: a.url }, { url: b.url }]);
  const response = await fetch(`${g.url}/v1/chat/completions`, { method: 'POST', body: '{}' });
  expect(response.status, JSON.stringify({ primaryCalls, alternateCalls, health: await (await fetch(`${g.url}/health`)).json() })).toBe(502);
  expect(alternateCalls).toBe(0);
});
it('never retries an upstream error status or exposes dashboard paths', async () => {
  let alternateCalls = 0;
  const a = await upstream((req, res) => { res.writeHead(429); res.end('limited'); });
  const b = await upstream((req, res) => { alternateCalls++; res.end('duplicate'); });
  const g = await start([{ url: a.url }, { url: b.url }]);
  expect((await fetch(`${g.url}/v1/chat/completions`, { method: 'POST', body: '{}' })).status).toBe(429);
  expect((await fetch(`${g.url}/api/settings`)).status).toBe(404);
  expect(alternateCalls).toBe(0);
});
it('never replays a POST accepted on a reused TLS connection', async () => {
  const cert = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { keyType: 'ec', algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-tls-'));
  const caFile = path.join(dir, 'ca.pem'); fs.writeFileSync(caFile, cert.cert);
  let calls = 0, alternateCalls = 0; const sockets = new Set();
  const primary = https.createServer({ key: cert.private, cert: cert.cert }, (req, res) => {
    if (req.url === '/api/health') return res.end('{"ok":true}');
    sockets.add(req.socket); calls++;
    if (calls === 1) res.end('first'); else req.socket.destroy();
  });
  await new Promise(resolve => primary.listen(0, '127.0.0.1', resolve)); servers.push(primary);
  const alternate = await upstream((req, res) => { alternateCalls++; res.end('duplicate'); });
  try {
    const g = await start([{ url: `https://127.0.0.1:${primary.address().port}`, caFile }, { url: alternate.url }]);
    await (await fetch(`${g.url}/v1/chat/completions`, { method: 'POST', body: '{}' })).text();
    const response = await fetch(`${g.url}/v1/chat/completions`, { method: 'POST', body: '{}' });
    expect(sockets.size).toBe(1);
    expect(response.status).toBe(502);
    expect(alternateCalls).toBe(0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
