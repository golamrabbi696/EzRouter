import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ local: [], runtime: { config: { peer: {} }, forwardSecret: 'local-proof' }, forwarded: 0 }));
vi.mock('@/lib/db/driver.js', () => ({ getAdapter: async () => ({ ha: { runtime: state.runtime } }) }));
vi.mock('@/lib/db/repos/connectionsRepo.js', () => ({ getProviderConnections: async () => state.local }));
vi.mock('../../src/sse/services/model.js', () => ({ getComboModels: async m => m === 'coding' ? ['cos/latest'] : null, getModelInfo: async m => ({ provider: 'cos', model: m.split('/').at(-1) }) }));
vi.mock('../../src/lib/ha/forward.js', () => ({ forwardChat: async (runtime, request, body) => { if (state.failure) throw state.failure; state.forwarded++; return Response.json(body); } }));
import * as routing from '../../src/lib/ha/routing.js';
it('forwards an unavailable local binding once, preserving tools and effort', async () => {
  vi.stubEnv('NINEROUTER_HA_CONFIG', 'test');
  const body = { model: 'coding', tools: [{ name: 'test' }], reasoning_effort: 'xhigh' };
  const req = new Request('http://localhost/v1/chat/completions', { headers: { authorization: 'Bearer key' } });
  expect(routing.maybeForwardChat).toBeTypeOf('function');
  const result = await routing.maybeForwardChat(req, body);
  expect(await result.json()).toEqual(body);
  state.local = [{ id: 'local' }];
  expect(await routing.maybeForwardChat(req, body)).toBeNull();
  state.local = [];
  expect(await routing.maybeForwardChat(new Request(req.url, { headers: { authorization: 'Bearer key', 'x-9router-ha-hop': '1' } }), body)).toBeNull();
  expect(state.forwarded).toBe(1);
  vi.unstubAllEnvs();
});
it('forwards the selected preferred member when local credentials are exhausted, even with a local fallback', async () => {
  vi.stubEnv('NINEROUTER_HA_CONFIG', 'test');
  state.local = [{ id: 'cooldown-account' }];
  const response = await routing.maybeForwardChat(new Request('http://localhost/v1/chat/completions', { headers: { authorization: 'Bearer key' } }), { model: 'coding' }, 'cos/latest', true);
  expect(response).not.toBeNull();
  vi.unstubAllEnvs();
});
it('accepts a member override only from the receiving runtime and only inside the authorized combo', async () => {
  const req = new Request('http://localhost/v1/chat/completions', { headers: { 'x-9router-ha-target': 'cos/latest', 'x-9router-ha-proof': 'local-proof' } });
  expect(routing.forwardedTarget).toBeTypeOf('function');
  expect(await routing.forwardedTarget(req, { model: 'coding' })).toBe('cos/latest');
  expect(await routing.forwardedTarget(new Request(req.url, { headers: { 'x-9router-ha-target': 'cos/latest' } }), { model: 'coding' })).toBeNull();
  await expect(routing.forwardedTarget(new Request(req.url, { headers: { 'x-9router-ha-target': 'cos/other', 'x-9router-ha-proof': 'local-proof' } }), { model: 'coding' })).rejects.toThrow(/member/);
});
it('permits local combo fallback only when the peer definitely did not accept the request', async () => {
  vi.stubEnv('NINEROUTER_HA_CONFIG', 'test');
  const req = new Request('http://localhost/v1/chat/completions');
  state.failure = Object.assign(new Error('connection refused'), { haAccepted: false });
  expect((await routing.maybeForwardChat(req, { model: 'coding' }, 'cos/latest', true)).headers.has('x-9router-no-replay')).toBe(false);
  state.failure.haAccepted = true;
  expect((await routing.maybeForwardChat(req, { model: 'coding' }, 'cos/latest', true)).headers.get('x-9router-no-replay')).toBe('1');
  state.failure = null; vi.unstubAllEnvs();
});
