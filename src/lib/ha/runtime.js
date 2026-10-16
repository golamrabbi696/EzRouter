import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { MAX_BYTES, validateVector } from './replica.js';
import { receiveForward } from './forward.js';

const loopback = host => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
function strongToken(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64,128}$/i.test(token)) throw new Error('HA token must contain at least 32 random bytes as hex');
}
export function authenticated(header, token) {
  const supplied = Buffer.from(String(header || '')), expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
export function loadHaConfig(file) {
  const stat = fs.statSync(file);
  if (process.platform !== 'win32' && (stat.mode & 0o077)) throw new Error('HA configuration must be private (chmod 600)');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
export function peerOptions(config) {
  if (!config.peer) return null;
  strongToken(config.peer.token);
  const url = new URL(config.peer.url);
  if (url.username || url.password || url.search || url.hash || !['/', ''].includes(url.pathname)) throw new Error('HA peer URL must be an origin');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && config.allowLoopbackHttp === true && loopback(url.hostname))) throw new Error('HA peers require verified TLS');
  return { url, ca: config.peer.caFile ? fs.readFileSync(config.peer.caFile) : undefined, token: config.peer.token };
}

export async function readJson(stream, limit = MAX_BYTES) {
  let size = 0; const chunks = [];
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new Error('HA request size limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function peerJson(peer, path, value, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > MAX_BYTES) return reject(new Error('HA request size limit'));
    const client = peer.url.protocol === 'https:' ? https : http;
    const req = client.request(new URL(path, peer.url), {
      method: 'POST', ca: peer.ca, rejectUnauthorized: true,
      headers: { authorization: `Bearer ${peer.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, async res => {
      try {
        // Never follow a redirect with the pairing credential.
        if (res.statusCode !== 200) { res.resume(); throw new Error(`HA peer HTTP ${res.statusCode}`); }
        resolve(await readJson(res));
      } catch (error) { reject(error); }
    });
    const timer = setTimeout(() => req.destroy(new Error('HA peer timeout')), timeout);
    req.once('close', () => clearTimeout(timer)); req.once('error', reject); req.end(body);
  });
}

export function startHaRuntime(store, config) {
  const forwardSecret = randomBytes(32).toString('hex');
  strongToken(config.token);
  const peer = peerOptions(config);
  const listen = config.listen || { host: '127.0.0.1', port: 20130 };
  const tls = listen.keyFile && listen.certFile ? { key: fs.readFileSync(listen.keyFile), cert: fs.readFileSync(listen.certFile) } : null;
  if (!tls && !(config.allowLoopbackHttp === true && loopback(listen.host))) throw new Error('HA listener requires TLS');
  const state = { healthy: false, lastSyncAt: null, error: null, peerVector: {}, fenced: false };
  let inflight = null, timer = null, closed = false;
  const json = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value));
  };
  const handler = async (req, res) => {
    if (!authenticated(req.headers.authorization, config.token)) return json(res, 401, { error: 'Unauthorized HA peer' });
    if (req.method === 'POST' && req.url === '/forward') {
      try { await receiveForward(req, res, config, store.status().nodeId, store.authorizeClient, forwardSecret); }
      catch { json(res, 400, { error: 'Invalid forwarded inference request' }); }
      return;
    }
    if (req.method !== 'POST' || req.url !== '/sync') return json(res, 404, { error: 'Not found' });
    if (state.fenced) return json(res, 409, { error: 'HA history requires recovery' });
    try {
      const body = await readJson(req);
      if (body.version !== 1 || !Array.isArray(body.events)) throw new Error('Invalid HA protocol');
      validateVector(body.vector);
      if (body.nodeId && body.nodeId === store.status().nodeId) throw new Error('Duplicate HA node identity');
      store.receive(body.events);
      json(res, 200, { version: 1, vector: store.vector(), events: store.eventsSince(body.vector, 250) });
    } catch (error) {
      if (/history fork/.test(error.message)) state.fenced = true;
      // Error payloads never include a received value, SQL binding or secret.
      json(res, 400, { error: 'Invalid HA batch; no changes committed' });
    }
  };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  server.requestTimeout = 10000; server.headersTimeout = 5000;
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listen.port ?? 20130, listen.host || '127.0.0.1', () => { server.unref(); resolve(); });
  });
  async function exchange() {
    if (!peer || closed) return;
    if (state.fenced) throw new Error('HA history requires recovery');
    try {
      const body = await peerJson(peer, '/sync', { version: 1, nodeId: store.status().nodeId,
        vector: store.vector(), events: store.eventsSince(state.peerVector, 250) });
      if (body.version !== 1 || !Array.isArray(body.events)) throw new Error('Invalid HA peer response');
      validateVector(body.vector);
      store.receive(body.events);
      state.peerVector = body.vector; state.lastSyncAt = new Date().toISOString(); state.healthy = true; state.error = null;
    } catch (error) {
      state.healthy = false; state.error = 'Peer synchronization failed';
      if (/history fork/.test(error.message)) state.fenced = true;
      throw error;
    }
  }
  function syncOnce() {
    if (!inflight) inflight = exchange().finally(() => { inflight = null; });
    return inflight;
  }
  const interval = config.intervalMs === 0 ? 0 : Math.max(1000, config.intervalMs || 3000);
  if (interval) ready.then(() => {
    timer = setInterval(() => { syncOnce().catch(() => {}); }, interval); timer.unref();
    syncOnce().catch(() => {});
  }).catch(() => {});
  return {
    server, ready, syncOnce, config, forwardSecret,
    status: () => ({ ...store.status(), ...state, configuredPeer: Boolean(peer) }),
    async close() { closed = true; clearInterval(timer); await inflight?.catch(() => {}); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
