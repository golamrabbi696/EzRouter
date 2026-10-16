import { expect, it, vi } from 'vitest';
vi.mock('@/lib/db/repos/apiKeysRepo.js', () => ({ getApiKeyByKey: async () => ({ id: 'k', access: { restricted: false, allow: [] } }) }));
vi.mock('@/lib/db/driver.js', () => ({ getAdapter: async () => ({ ha: { policies: () => [
  { restricted: true, allow: ['openai/coding', 'openai/images'] },
  { restricted: true, allow: ['oa/coding'] },
] } }) }));
vi.mock('@/lib/db/repos/combosRepo.js', () => ({ getCombos: async () => [] }));
vi.mock('../../src/sse/services/model.js', () => ({ getComboModels: async () => null, getModelInfo: async s => ({ provider: 'openai', model: s.split('/').at(-1) }) }));
import { getKeyAccessContext, enforceKeyAccess, enforceKeyAccessResolved, filterModelsListForKey } from '../../src/sse/services/keyAccess.js';

it('enforces the intersection using resolved aliases across all key access gates', async () => {
  vi.stubEnv('NINEROUTER_HA_CONFIG', 'test-config');
  const ctx = await getKeyAccessContext(new Request('http://localhost/v1/chat/completions', { headers: { authorization: 'Bearer key' } }));
  expect(ctx).not.toBeNull();
  expect(await enforceKeyAccess(ctx, 'openai/coding')).toBeNull();
  expect((await enforceKeyAccess(ctx, 'openai/images')).status).toBe(403);
  expect((await enforceKeyAccessResolved(ctx, 'openai/images', 'openai', 'images')).status).toBe(403);
  expect(await filterModelsListForKey(ctx, [{ id: 'openai/coding' }, { id: 'openai/images' }])).toEqual([{ id: 'openai/coding' }]);
  vi.unstubAllEnvs();
});
