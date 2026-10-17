import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isIP } from 'node:net';
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
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [section, keys] of [[config.listen, ['keyFile', 'certFile']], [config.peer, ['caFile']]]) {
    for (const key of keys) if (section?.[key]) section[key] = path.resolve(path.dirname(file), section[key]);
  }
  return config;
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
export function peerJson(peer, path, value, timeout = 5000, onResponse) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > MAX_BYTES) return reject(new Error('HA request size limit'));
    const client = peer.url.protocol === 'https:' ? https : http;
    const req = client.request(new URL(path, peer.url), {
      // Periodic sync must not borrow a stale socket from a previously closed peer.
      method: 'POST', agent: false, ca: peer.ca, rejectUnauthorized: true,
      headers: { authorization: `Bearer ${peer.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, async res => {
      try {
        const address = res.socket?.remoteAddress || null;
        // Never follow a redirect with the pairing credential.
        if (res.statusCode !== 200) { res.resume(); throw new Error(`HA peer HTTP ${res.statusCode}`); }
        const result = await readJson(res);
        onResponse?.(address);
        resolve(result);
      } catch (error) { reject(error); }
    });
    const timer = setTimeout(() => req.destroy(new Error('HA peer timeout')), timeout);
    req.once('close', () => clearTimeout(timer)); req.once('error', reject); req.end(body);
  });
}

function nodeInfo(value) {
  if (!value || typeof value !== 'object') return null;
  const text = (s, max) => typeof s === 'string' && s.length <= max && !/[\x00-\x1f\x7f]/.test(s) ? s : null;
  return { nodeId: text(value.nodeId, 128), name: text(value.name, 80), hostname: text(value.hostname, 253),
    addresses: Array.isArray(value.addresses) ? value.addresses.filter(a => typeof a === 'string' && isIP(a)).slice(0, 16) : [] };
}

export function startHaRuntime(store, config) {
  const forwardSecret = randomBytes(32).toString('hex');
  const nodeId = store.status().nodeId;
  strongToken(config.token);
  const peer = peerOptions(config);
  const listen = config.listen || { host: '127.0.0.1', port: 20130 };
  const tls = listen.keyFile && listen.certFile ? { key: fs.readFileSync(listen.keyFile), cert: fs.readFileSync(listen.certFile) } : null;
  if (!tls && !(config.allowLoopbackHttp === true && loopback(listen.host))) throw new Error('HA listener requires TLS');
  const state = { healthy: false, lastSyncAt: null, lastAttemptAt: null, latencyMs: null, error: null, peerVector: {}, fenced: false };
  let peerInfo = null, transportAddress = null;
  const localInfo = () => nodeInfo({ nodeId, name: config.name || os.hostname(), hostname: os.hostname(),
    addresses: Object.values(os.networkInterfaces()).flat().filter(a => a && !a.internal && !a.scopeid).map(a => a.address) });
  let inflight = null, timer = null, closed = false;
  const json = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value));
  };
  const handler = async (req, res) => {
    if (!authenticated(req.headers.authorization, config.token)) return json(res, 401, { error: 'Unauthorized HA peer' });
    if (req.method === 'POST' && req.url === '/forward') {
      try { await receiveForward(req, res, config, nodeId, store.authorizeClient, forwardSecret); }
      catch { json(res, 400, { error: 'Invalid forwarded inference request' }); }
      return;
    }
    if (req.method !== 'POST' || req.url !== '/sync') return json(res, 404, { error: 'Not found' });
    if (state.fenced) return json(res, 409, { error: 'HA history requires recovery' });
    try {
      const body = await readJson(req);
      if (body.version !== 1 || !Array.isArray(body.events)) throw new Error('Invalid HA protocol');
      validateVector(body.vector);
      if (body.nodeId && body.nodeId === nodeId) throw new Error('Duplicate HA node identity');
      store.receive(body.events);
      json(res, 200, { version: 1, node: localInfo(), vector: store.vector(), events: store.eventsSince(body.vector, 250) });
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
    state.lastAttemptAt = new Date().toISOString();
    const started = performance.now();
    try {
      const body = await peerJson(peer, '/sync', { version: 1, nodeId,
        vector: store.vector(), events: store.eventsSince(state.peerVector, 250) }, 5000, address => { transportAddress = address; });
      if (body.version !== 1 || !Array.isArray(body.events)) throw new Error('Invalid HA peer response');
      const info = nodeInfo(body.node);
      if (info?.nodeId && info.nodeId === nodeId) throw new Error('Duplicate HA node identity');
      validateVector(body.vector);
      store.receive(body.events);
      peerInfo = info; state.latencyMs = Math.round(performance.now() - started);
      state.peerVector = body.vector; state.lastSyncAt = new Date().toISOString(); state.healthy = true; state.error = null;
    } catch (error) {
      state.healthy = false; state.latencyMs = null;
      const reason = error.code === 'ECONNREFUSED' ? 'Connection refused — check the peer listener or tunnel'
        : ['ENOTFOUND', 'EAI_AGAIN'].includes(error.code) ? 'Peer hostname could not be resolved'
          : /timeout/i.test(error.message) ? 'Peer timed out — check network connectivity'
            : /certificate|TLS|SSL/.test(`${error.code || ''} ${error.message}`) ? 'TLS verification failed — check peer certificate and hostname'
              : /HTTP 401/.test(error.message) ? 'Peer rejected the pairing token'
                : /Duplicate HA node/.test(error.message) ? 'Duplicate HA node identity' : 'Peer synchronization failed';
      state.error = reason;
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
    status: () => ({ ...store.status(), ...state, configuredPeer: Boolean(peer),
      local: { ...localInfo(), listen: { host: listen.host || '127.0.0.1', port: server.address()?.port ?? listen.port ?? 20130 }, tls: Boolean(tls) },
      peer: peer ? { ...peerInfo, name: peerInfo?.name || config.peer.name || peer.url.hostname,
        url: peer.url.origin, hostname: peerInfo?.hostname || null, addresses: peerInfo?.addresses || [],
        transportAddress, tls: peer.url.protocol === 'https:' } : null }),
    async close() { closed = true; clearInterval(timer); await inflight?.catch(() => {}); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
