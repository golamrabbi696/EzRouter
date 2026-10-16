import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { HA_CONNECT_TIMEOUT_MS } from '../../../open-sse/config/ha.js';

const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer']);
function headersFor(headers) {
  const skip = new Set([...HOP_HEADERS, ...String(headers.connection || '').split(',').map(s => s.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !skip.has(key.toLowerCase()) && !/^x-(?:9r-|forwarded-|real-ip)/i.test(key)));
}
function probe(origin) {
  return new Promise(resolve => {
    const client = origin.url.protocol === 'https:' ? https : http;
    const req = client.get(new URL('/api/health', origin.url), { ca: origin.ca, rejectUnauthorized: true }, res => {
      let body = '', size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 16384) req.destroy(); else body += chunk; });
      res.on('end', () => { try { resolve(res.statusCode === 200 && JSON.parse(body).ok === true); } catch { resolve(false); } });
      res.on('error', () => resolve(false));
    });
    const timer = setTimeout(() => req.destroy(), 1000);
    req.once('close', () => clearTimeout(timer)); req.once('error', () => resolve(false));
  });
}

export function createGateway({ origins, host = '127.0.0.1', port = 20127, intervalMs = 2000, strategy = 'local-first' }) {
  if (!['127.0.0.1', '::1'].includes(host)) throw new Error('HA client gateway must listen on loopback');
  if (!Array.isArray(origins) || origins.length < 2 || origins.length > 8) throw new Error('Configure two to eight HA origins');
  const targets = origins.map((entry, i) => {
    const url = new URL(entry.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid HA origin');
    return { url, name: String(entry.name || `node-${i + 1}`).replace(/[^a-zA-Z0-9_.-]/g, '-'), ca: entry.caFile ? fs.readFileSync(entry.caFile) : undefined, healthy: false, successes: 0 };
  });
  let probing = null, timer = null, rotation = 0;
  function probeNow() {
    if (!probing) probing = Promise.all(targets.map(async t => {
      if (await probe(t)) { t.successes++; t.healthy = t.successes >= 2; }
      else { t.successes = 0; t.healthy = false; }
    })).finally(() => { probing = null; });
    return probing;
  }
  const error = (res, status, message) => {
    if (res.destroyed) return;
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: { message, type: 'ha_gateway_error' } }));
  };
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(targets.some(t => t.healthy) ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ origins: targets.map(({ name, healthy }) => ({ name, healthy })) })); return;
    }
    if (!/^\/(?:v1(?:\/|$)|v1beta(?:\/|$)|responses(?:\/|$)|codex(?:\/|$))/.test(req.url) || !['GET', 'POST', 'OPTIONS'].includes(req.method)) {
      error(res, 404, 'Inference API path required'); return;
    }
    let body;
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 32 * 1024 * 1024) throw new Error('size'); chunks.push(chunk); }
      body = Buffer.concat(chunks);
    } catch { error(res, 413, 'Request exceeds gateway limit'); return; }
    let candidates = targets.filter(t => t.healthy);
    if (strategy === 'round-robin' && candidates.length) {
      const offset = rotation++ % candidates.length; candidates = [...candidates.slice(offset), ...candidates.slice(0, offset)];
    }
    if (!candidates.length) { error(res, 503, 'No ready HA origin'); return; }
    function dispatch(index) {
      const target = candidates[index];
      if (!target) { error(res, 503, 'No reachable HA origin'); return; }
      const client = target.url.protocol === 'https:' ? https : http;
      let connected = false, finished = false;
      const upstream = client.request(new URL(req.url, target.url), {
        method: req.method, ca: target.ca, rejectUnauthorized: true,
        headers: { ...headersFor(req.headers), 'content-length': body.length },
      }, response => {
        finished = true;
        res.writeHead(response.statusCode, { ...headersFor(response.headers), 'x-9router-ha-origin': target.name });
        response.on('error', () => res.destroy()); response.pipe(res);
      });
      const connectTimer = setTimeout(() => { if (!connected) upstream.destroy(new Error('connect timeout')); }, HA_CONNECT_TIMEOUT_MS);
      upstream.on('socket', socket => {
        socket.once(target.url.protocol === 'https:' ? 'secureConnect' : 'connect', () => { connected = true; clearTimeout(connectTimer); });
        // A reused TLS socket has already emitted secureConnect. Treat it as
        // accepted before sending another POST; a reset must never trigger replay.
        if (!socket.connecting && (target.url.protocol === 'http:' || socket.encrypted && !socket.secureConnecting)) connected = true;
      });
      upstream.setTimeout(900000, () => upstream.destroy(new Error('upstream timeout')));
      const cancel = () => { if (!res.writableEnded) upstream.destroy(); };
      res.once('close', cancel);
      upstream.once('close', () => { clearTimeout(connectTimer); res.off('close', cancel); });
      upstream.once('error', () => {
        clearTimeout(connectTimer); res.off('close', cancel);
        target.healthy = false; target.successes = 0;
        if (res.destroyed) return;
        if (!connected && !finished) dispatch(index + 1);
        else error(res, 502, 'Origin connection interrupted; request was not replayed');
      });
      upstream.end(body);
    }
    dispatch(0);
  });
  server.headersTimeout = 10000; server.requestTimeout = 60000;
  const ready = (async () => {
    await probeNow(); await probeNow();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    if (intervalMs) { timer = setInterval(() => probeNow(), Math.max(1000, intervalMs)); timer.unref(); }
  })();
  return { server, ready, probeNow, async close() { clearInterval(timer); await probing; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
