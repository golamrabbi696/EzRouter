import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { forwardChat } from '../../src/lib/ha/forward.js';
import { createReplica } from '../../src/lib/ha/replica.js';
import * as transport from '../../src/lib/ha/runtime.js';
const cleanup = [];
const token = 'a'.repeat(64);
function replica() {
  const db = new DatabaseSync(':memory:'); cleanup.push(() => db.close());
  const store = createReplica({ exec: s => db.exec(s), get: (s, p = []) => db.prepare(s).get(...p), all: (s, p = []) => db.prepare(s).all(...p), run: (s, p = []) => db.prepare(s).run(...p), transaction: fn => {
    db.exec('SAVEPOINT test'); try { const r = fn(); db.exec('RELEASE test'); return r; } catch (e) { db.exec('ROLLBACK TO test; RELEASE test'); throw e; }
  } });
  const status = store.status, nodeId = randomUUID();
  store.status = () => ({ ...status(), nodeId });
  return store;
}
async function server(store, extra = {}) {
  const config = { token, allowLoopbackHttp: true, intervalMs: 0, listen: { host: '127.0.0.1', port: 0 }, ...extra };
  const runtime = transport.startHaRuntime(store, config); cleanup.push(() => runtime.close());
  await runtime.ready;
  return { runtime, config, url: `http://127.0.0.1:${runtime.server.address().port}` };
}
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
it('provides authenticated peer transport', () => expect(transport.startHaRuntime).toBeTypeOf('function'));
it('shows named peers, host IPs and sync diagnostics without exposing credentials', async () => {
  const remote = await server(replica(), { name: 'Azure VM1' });
  const local = await server(replica(), { name: 'agents01', peer: { name: 'Azure', url: remote.url, token } });
  await local.runtime.syncOnce();
  const status = local.runtime.status();
  expect(status.local).toMatchObject({ name: 'agents01', hostname: os.hostname(), listen: { host: '127.0.0.1' } });
  expect(status.peer).toMatchObject({ name: 'Azure VM1', hostname: os.hostname(), url: remote.url, transportAddress: '127.0.0.1' });
  expect(status.peer.nodeId).toBe(remote.runtime.status().nodeId);
  expect(Array.isArray(status.peer.addresses)).toBe(true);
  expect(status.lastAttemptAt).toBeTruthy();
  expect(status.latencyMs).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(status)).not.toContain(token);
});
it('resolves portable setup certificate paths relative to the configuration file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-paths-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ha.json');
  fs.writeFileSync(file, JSON.stringify({ listen: { keyFile: 'node.key', certFile: 'node.crt' }, peer: { caFile: 'peer.crt' } }), { mode: 0o600 });
  expect(transport.loadHaConfig(file)).toMatchObject({ listen: { keyFile: path.join(dir, 'node.key'), certFile: path.join(dir, 'node.crt') }, peer: { caFile: path.join(dir, 'peer.crt') } });
});
it('synchronizes offline edits over real HTTP, including reconnect and retry', async () => {
  const a = replica(), b = replica();
  a.commit([{ entity: 'combos:x', field: 'name', value: 'left' }]);
  b.commit([{ entity: 'combos:x', field: 'models', value: ['right'] }]);
  const remote = await server(b);
  const local = await server(a, { peer: { url: remote.url, token } });
  await local.runtime.syncOnce();
  expect(a.records()).toEqual(b.records());
  a.commit([{ entity: 'combos:x', field: 'kind', value: 'chat' }]);
  b.commit([{ entity: 'combos:x', field: 'models', value: ['changed'] }]);
  await local.runtime.syncOnce(); await local.runtime.syncOnce();
  expect(a.records()).toEqual(b.records());
  expect(a.status().eventCount).toBe(4);
  expect(local.runtime.status().lastSyncAt).toBeTruthy();
});
it('rejects missing authentication and unsupported protocol without changes', async () => {
  const a = replica(), remote = await server(a);
  expect((await fetch(`${remote.url}/sync`, { method: 'POST', body: '{}' })).status).toBe(401);
  expect((await fetch(`${remote.url}/sync`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ version: 2 }) })).status).toBe(400);
  expect(a.status().eventCount).toBe(0);
});
it('requires TLS for non-loopback peers and strong pairing credentials', async () => {
  expect(() => transport.startHaRuntime(replica(), { token, allowLoopbackHttp: true, listen: { host: '0.0.0.0', port: 0 } })).toThrow(/TLS/);
  expect(() => transport.startHaRuntime(replica(), { token: 'short', listen: { host: '127.0.0.1', port: 0 }, allowLoopbackHttp: true })).toThrow(/token/i);
  expect(() => transport.startHaRuntime(replica(), { token, allowLoopbackHttp: true, listen: { host: '127.0.0.1', port: 0 }, peer: { url: 'http://example.com', token } })).toThrow(/TLS/);
});
it('reports peer unavailability without blocking local writes', async () => {
  const a = replica(), local = await server(a, { peer: { url: 'http://127.0.0.1:1', token } });
  await expect(local.runtime.syncOnce()).rejects.toThrow();
  a.commit([{ entity: 'combos:x', field: 'name', value: 'still writable' }]);
  expect(a.records()['combos:x'].name).toBe('still writable');
  expect(local.runtime.status().healthy).toBe(false);
  expect(local.runtime.status().error).toMatch(/refused/i);
  expect(local.runtime.status().lastAttemptAt).toBeTruthy();
  expect(local.runtime.status().latencyMs).toBeNull();
  expect(JSON.stringify(local.runtime.status())).not.toContain(token);
});
it('keeps synchronization compatible with peers that do not report node metadata', async () => {
  const app = http.createServer((req, res) => { req.resume(); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: 1, vector: {}, events: [] })); });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise(resolve => { app.closeAllConnections(); app.close(resolve); }));
  const local = await server(replica(), { peer: { name: 'Legacy peer', url: `http://127.0.0.1:${app.address().port}`, token } });
  await local.runtime.syncOnce();
  expect(local.runtime.status()).toMatchObject({ healthy: true, peer: { name: 'Legacy peer', hostname: null, addresses: [] } });
});
it('ignores arbitrary peer metadata and never includes it in administrator status', async () => {
  const app = http.createServer((req, res) => { req.resume(); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: 1, vector: {}, events: [], node: { name: 'bad\nname', hostname: 'x'.repeat(254), addresses: ['not-an-ip', '10.1.2.3'], token: 'must-stay-private' } })); });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise(resolve => { app.closeAllConnections(); app.close(resolve); }));
  const local = await server(replica(), { peer: { name: 'Configured label', url: `http://127.0.0.1:${app.address().port}`, token } });
  await local.runtime.syncOnce();
  expect(local.runtime.status().peer).toMatchObject({ name: 'Configured label', hostname: null, addresses: ['10.1.2.3'] });
  expect(JSON.stringify(local.runtime.status())).not.toContain('must-stay-private');
});
it('streams peer inference through normal client auth and marks a single hop', async () => {
  let received;
  const app = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    received = { path: req.url, headers: req.headers, body: JSON.parse(body) };
    res.setHeader('content-type', 'text/event-stream'); res.end('data: {"text":"ok"}\n\n');
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise(resolve => { app.closeAllConnections(); app.close(resolve); }));
  const store = replica(); store.authorizeClient = key => key === 'client-key';
  const remote = await server(store, { localApiUrl: `http://127.0.0.1:${app.address().port}` });
  const body = { model: 'cos/latest', reasoning_effort: 'xhigh', tools: [{ type: 'function' }] };
  const response = await forwardChat({ config: { allowLoopbackHttp: true, peer: { url: remote.url, token } } },
    new Request('http://localhost/api/v1/messages', { headers: { 'x-api-key': 'client-key' } }), body);
  expect(await response.text()).toContain('ok');
  expect(received.body).toEqual(body);
  expect(received.path).toBe('/api/v1/messages');
  expect(received.headers.authorization).toBe('Bearer client-key');
  expect(received.headers['x-9router-ha-hop']).toBe('1');
  received = null;
  const denied = await forwardChat({ config: { allowLoopbackHttp: true, peer: { url: remote.url, token } } },
    new Request('http://localhost/api/v1/messages', { headers: { 'x-api-key': 'revoked-key' } }), body);
  expect(denied.status).toBe(401);
  expect(received).toBeNull();
});
