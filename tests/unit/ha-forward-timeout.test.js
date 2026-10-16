import { afterEach, expect, it, vi } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { forwardChat } from '../../src/lib/ha/forward.js';

const runtime = { config: { allowLoopbackHttp: true, peer: { url: 'http://127.0.0.1:1', token: 'a'.repeat(64) } } };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('bounds a stalled peer connection before allowing local fallback', async () => {
  vi.useFakeTimers();
  const req = new EventEmitter();
  req.end = () => {}; req.setTimeout = () => req;
  req.destroy = error => { req.emit('error', error); req.emit('close'); };
  vi.spyOn(http, 'request').mockReturnValue(req);
  let failure;
  const pending = forwardChat(runtime, new Request('http://localhost/v1/chat/completions', { headers: { authorization: 'Bearer key' } }), { model: 'test' }).catch(error => { failure = error; });
  try {
    await vi.advanceTimersByTimeAsync(1600);
    expect(failure).toMatchObject({ haAccepted: false });
    expect(failure.message).toMatch(/connect.*timeout/i);
  } finally { if (!failure) req.destroy(new Error('test cleanup')); await pending; }
});

it('rejects a pre-aborted request without an unhandled socket error', () => {
  const url = new URL('../../src/lib/ha/forward.js', import.meta.url).href;
  const code = `
    import { forwardChat } from ${JSON.stringify(url)};
    const controller = new AbortController(); controller.abort();
    try { await forwardChat(${JSON.stringify(runtime)}, new Request('http://localhost/v1/chat/completions', { signal: controller.signal, headers: { authorization: 'Bearer key' } }), {model:'test'}); }
    catch (error) { if (!/cancel/i.test(error.message)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  expect(child.status, child.stderr).toBe(0);
});
