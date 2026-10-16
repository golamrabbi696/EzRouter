import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { peerOptions, readJson } from './runtime.js';
import { NO_REPLAY_HEADER, HA_CONNECT_TIMEOUT_MS } from '../../../open-sse/config/ha.js';

const PATHS = new Set(['/v1/chat/completions', '/v1/messages', '/v1/responses', '/api/v1/chat/completions', '/api/v1/messages', '/api/v1/responses', '/responses', '/codex/responses']);
const PASSTHROUGH = ['content-type', 'anthropic-version', 'anthropic-beta', 'openai-beta', 'user-agent'];
export function clientKey(request) {
  return request.headers.get('authorization')?.replace(/^Bearer /, '') || request.headers.get('x-api-key') || request.headers.get('x-goog-api-key');
}
export function forwardChat(runtime, request, body, target = null) {
  if (request.signal.aborted) return Promise.reject(Object.assign(new Error('Client cancelled'), { haAccepted: false, haCancelled: true }));
  const peer = peerOptions(runtime.config), path = new URL(request.url).pathname;
  const key = clientKey(request);
  if (!peer || !key || !PATHS.has(path)) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let accepted = false;
    const headers = Object.fromEntries(PASSTHROUGH.flatMap(name => request.headers.has(name) ? [[name, request.headers.get(name)]] : []));
    const payload = JSON.stringify({ path, headers, body, target });
    if (Buffer.byteLength(payload) > 32 * 1024 * 1024) return reject(new Error('HA inference size limit'));
    const client = peer.url.protocol === 'https:' ? https : http;
    const req = client.request(new URL('/forward', peer.url), {
      method: 'POST', ca: peer.ca, rejectUnauthorized: true,
      headers: { authorization: `Bearer ${peer.token}`, 'x-ha-client-key': key, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, res => {
      accepted = true;
      clearTimeout(connectTimer);
      const responseHeaders = new Headers();
      responseHeaders.set(NO_REPLAY_HEADER, '1');
      for (const name of ['content-type', 'retry-after', 'x-request-id', 'x-9router-ha-node']) if (res.headers[name]) responseHeaders.set(name, String(res.headers[name]));
      resolve(new Response(res.statusCode === 204 ? null : Readable.toWeb(res), { status: res.statusCode, headers: responseHeaders }));
    });
    const connectTimer = setTimeout(() => req.destroy(new Error('HA peer connect timeout')), HA_CONNECT_TIMEOUT_MS);
    req.on('socket', socket => {
      if (!socket.connecting && (peer.url.protocol === 'http:' || socket.encrypted && !socket.secureConnecting)) { accepted = true; clearTimeout(connectTimer); }
      socket.once(peer.url.protocol === 'https:' ? 'secureConnect' : 'connect', () => { accepted = true; clearTimeout(connectTimer); });
    });
    const abort = () => req.destroy(Object.assign(new Error('Client cancelled'), { haCancelled: true }));
    req.once('error', error => { error.haAccepted = accepted; reject(error); });
    req.once('close', () => { clearTimeout(connectTimer); request.signal.removeEventListener('abort', abort); });
    if (request.signal.aborted) { abort(); return; }
    request.signal.addEventListener('abort', abort, { once: true });
    req.setTimeout(900000, () => req.destroy(new Error('HA inference timeout')));
    req.end(payload);
  });
}

export async function receiveForward(req, res, config, nodeId, authorizeClient, forwardSecret) {
  const key = req.headers['x-ha-client-key'];
  if (typeof key !== 'string' || !key || key.length > 4096) throw new Error('Missing client key');
  if (!authorizeClient?.(key)) {
    req.resume(); res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"Invalid or revoked client key"}'); return;
  }
  const payload = await readJson(req, 32 * 1024 * 1024);
  if (!PATHS.has(payload.path) || !payload.body || typeof payload.body !== 'object') throw new Error('Invalid forwarded request');
  const target = new URL(config.localApiUrl || 'http://127.0.0.1:20128');
  if (target.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(target.hostname) || target.username || target.password || target.pathname !== '/') throw new Error('Forwarding requires a local API origin');
  const body = JSON.stringify(payload.body);
  const headers = Object.fromEntries(PASSTHROUGH.filter(k => typeof payload.headers?.[k] === 'string').map(k => [k, payload.headers[k]]));
  const upstream = http.request(new URL(payload.path, target), {
    method: 'POST', headers: { ...headers, authorization: `Bearer ${key}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-9router-ha-hop': '1',
      ...(typeof payload.target === 'string' ? { 'x-9router-ha-target': payload.target, 'x-9router-ha-proof': forwardSecret } : {}) },
  }, response => {
    const responseHeaders = { 'x-9router-ha-node': nodeId || 'peer' };
    for (const name of ['content-type', 'retry-after', 'x-request-id']) if (response.headers[name]) responseHeaders[name] = response.headers[name];
    res.writeHead(response.statusCode, responseHeaders);
    response.on('error', () => res.destroy()); response.pipe(res);
  });
  upstream.setTimeout(900000, () => upstream.destroy());
  upstream.once('error', () => {
    if (res.headersSent) res.destroy();
    else { res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":"Peer inference interrupted; request not replayed"}'); }
  });
  res.once('close', () => { if (!res.writableEnded) upstream.destroy(); });
  upstream.end(body);
}
