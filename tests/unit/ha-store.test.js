import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNodeSqliteAdapter } from '../../src/lib/db/adapters/nodeSqliteAdapter.js';
import { TABLES, buildCreateTableSql } from '../../src/lib/db/schema.js';
import * as store from '../../src/lib/ha/store.js';
const active = vi.hoisted(() => ({ db: null }));
vi.mock('../../src/lib/db/driver.js', () => ({ getAdapter: async () => active.db }));
import { updateSettings, getSettings } from '../../src/lib/db/repos/settingsRepo.js';
import { createCombo, updateCombo } from '../../src/lib/db/repos/combosRepo.js';
import { createProviderConnection, updateProviderConnection, getProviderConnections } from '../../src/lib/db/repos/connectionsRepo.js';
import { createProviderNode, updateProviderNode } from '../../src/lib/db/repos/nodesRepo.js';
import { DefaultExecutor } from '../../open-sse/executors/default.js';

const databases = [];
const listeners = [];
async function fresh(options = {}) {
  const before = Object.fromEntries(['beforeExit', 'SIGINT', 'SIGTERM'].map(event => [event, new Set(process.listeners(event))]));
  const raw = await createNodeSqliteAdapter(':memory:'); databases.push(raw);
  for (const event of Object.keys(before)) for (const listener of process.listeners(event)) if (!before[event].has(listener)) listeners.push([event, listener]);
  for (const [table, definition] of Object.entries(TABLES)) raw.exec(buildCreateTableSql(table, definition));
  const db = store.attachHaStore(raw, options); active.db = db; return db;
}
function exchange(a, b) {
  b.ha.receive(a.ha.eventsSince(b.ha.vector()));
  a.ha.receive(b.ha.eventsSince(a.ha.vector()));
}
afterEach(() => { databases.splice(0).forEach(db => db.close()); for (const [event, listener] of listeners.splice(0)) process.removeListener(event, listener); });

describe('HA configuration transactions', () => {
  it('derives compatible-provider transport from the receiving node before using its local key', async () => {
    const a = await fresh();
    const provider = 'openai-compatible-chat-local';
    await createProviderNode({ id: provider, type: 'openai-compatible', name: 'Local CoS', prefix: 'cos', apiType: 'chat', baseUrl: 'http://127.0.0.1:20129/v1' });
    const c = await createProviderConnection({ provider, authType: 'apikey', name: 'Local key', apiKey: 'source-key', providerSpecificData: { baseUrl: 'http://127.0.0.1:20129/v1', apiType: 'chat', prefix: 'cos' } });
    const b = await fresh({ bindings: { [`providerNodes:${provider}`]: { baseUrl: 'http://127.0.0.1:20229/v1' }, [`providerConnections:${c.id}`]: { apiKey: 'receiver-key' } } });
    exchange(a, b);
    const connection = JSON.parse(b.get('SELECT data FROM providerConnections WHERE id=?', [c.id]).data);
    expect(connection.providerSpecificData).toMatchObject({ baseUrl: 'http://127.0.0.1:20229/v1', apiType: 'chat', prefix: 'cos' });
    expect(new DefaultExecutor(provider).buildUrl('latest', true, 0, connection)).toBe('http://127.0.0.1:20229/v1/chat/completions');
    expect(connection.apiKey).toBe('receiver-key');
    expect(JSON.stringify(b.ha.eventsSince({}))).not.toContain('receiver-key');
  });
  it('provides an opt-in store', () => expect(store.attachHaStore).toBeTypeOf('function'));
  it('captures repository settings and merges separate nested fields', async () => {
    const a = await fresh();
    await updateSettings({ comboStrategies: { coding: { fallbackStrategy: 'fallback', count: 1 } }, password: 'local-secret' });
    const b = await fresh(); exchange(a, b);
    active.db = a; await updateSettings({ comboStrategies: { coding: { fallbackStrategy: 'round-robin', count: 1 } } });
    active.db = b; await updateSettings({ comboStrategies: { coding: { fallbackStrategy: 'fallback', count: 2 } } });
    exchange(a, b);
    expect((await getSettings()).comboStrategies.coding).toEqual({ fallbackStrategy: 'round-robin', count: 2 });
    expect(JSON.stringify(b.ha.eventsSince({}))).not.toContain('local-secret');
  });
  it('rolls back the journal together with a failed outer transaction', async () => {
    const db = await fresh(); const before = db.ha.status().eventCount;
    expect(() => db.transaction(() => {
      db.run('INSERT INTO settings(id,data) VALUES(1,?)', [JSON.stringify({ comboStrategy: 'round-robin' })]);
      throw new Error('rollback');
    })).toThrow('rollback');
    expect(db.ha.status().eventCount).toBe(before);
    expect(db.get('SELECT * FROM settings')).toBeUndefined();
  });
  it('preserves both duplicate combo names without violating unique constraints', async () => {
    const a = await fresh(); const left = await createCombo({ name: 'same', models: ['a/model'] });
    const b = await fresh(); const right = await createCombo({ name: 'same', models: ['b/model'] });
    exchange(a, b);
    expect(a.all('SELECT id,name,models FROM combos')).toEqual(b.all('SELECT id,name,models FROM combos'));
    expect(a.all('SELECT * FROM combos')).toHaveLength(1);
    expect(Object.keys(a.ha.records())).toHaveLength(2);
    expect(a.get('SELECT id FROM combos').id).toBe([left.id, right.id].sort()[0]);
    expect(a.ha.status().nameConflicts).toHaveLength(1);
  });
  it('keeps OAuth tokens local and excludes runtime health updates', async () => {
    const a = await fresh();
    const c = await createProviderConnection({ provider: 'codex', authType: 'oauth', accessToken: 'secret-access', refreshToken: 'secret-refresh', name: 'Codex' });
    const count = a.ha.status().eventCount;
    await updateProviderConnection(c.id, { accessToken: 'new-secret', lastError: '429', consecutiveUseCount: 3 });
    expect(a.ha.status().eventCount).toBe(count);
    const b = await fresh(); exchange(a, b);
    expect(JSON.stringify(b.ha.eventsSince({}))).not.toContain('secret');
    expect((await getProviderConnections({ isActive: true }))).toHaveLength(0);
    expect(JSON.parse(a.get('SELECT data FROM providerConnections').data).accessToken).toBe('new-secret');
  });
  it('preserves restrictive policy versions when a key is renamed', async () => {
    const a = await fresh();
    a.run('INSERT INTO apiKeys(id,key,isActive,accessRestricted,accessAllow,createdAt) VALUES(?,?,?,?,?,?)', ['key', 'secret', 1, 1, '["coding","images"]', '2026-10-16']);
    const b = await fresh(); exchange(a, b);
    a.run('UPDATE apiKeys SET accessAllow=? WHERE id=?', ['["coding"]', 'key']);
    b.run('UPDATE apiKeys SET accessRestricted=0 WHERE id=?', ['key']); exchange(a, b);
    expect(a.ha.policies('key')).toEqual(expect.arrayContaining([{ restricted: true, allow: ['coding'] }]));
    a.run('UPDATE apiKeys SET name=? WHERE id=?', ['renamed', 'key']); exchange(a, b);
    expect(a.ha.policies('key')).toHaveLength(2);
    expect(b.ha.policies('key')).toEqual(a.ha.policies('key'));
  });
  it('recovers edits made by an older binary without dropping remote work', async () => {
    const a = await fresh(); await createCombo({ name: 'test', models: ['a/model'] });
    const b = await fresh(); exchange(a, b);
    const id = b.get('SELECT id FROM combos').id;
    // B writes while A is offline; simulate old software bypassing the wrapper.
    active.db = b; await updateCombo(id, { models: ['b/model'] });
    a.ha.raw.run('UPDATE combos SET name=? WHERE id=?', ['old-binary-edit', id]);
    const restarted = store.attachHaStore(a.ha.raw);
    exchange(restarted, b);
    expect(b.get('SELECT name,models FROM combos')).toEqual({ name: 'old-binary-edit', models: '["b/model"]' });
  });
  it('makes a separately authenticated OAuth binding available without replicating its token', async () => {
    const a = await fresh();
    const c = await createProviderConnection({ provider: 'codex', authType: 'oauth', accessToken: 'a-token', name: 'Codex' });
    const b = await fresh(); exchange(a, b);
    expect(await getProviderConnections({ isActive: true })).toHaveLength(0);
    await updateProviderConnection(c.id, { accessToken: 'new-local-session' });
    expect(await getProviderConnections({ isActive: true })).toHaveLength(1);
    expect(JSON.stringify(b.ha.eventsSince({}))).not.toContain('new-local-session');
  });
  it('quarantines a nonempty journal whose recovery checkpoint is missing', async () => {
    const db = await fresh(); await createCombo({ name: 'test', models: ['a/model'] });
    db.ha.raw.run("DELETE FROM haMeta WHERE key='checkpoint'");
    expect(() => store.attachHaStore(db.ha.raw)).toThrow(/checkpoint.*recovery/i);
  });
  it('never combines a concurrent credential change with a different endpoint', async () => {
    const a = await fresh({ origin: 'a'.repeat(32) });
    await createProviderNode({ id: 'custom', type: 'openai-compatible', name: 'Custom', prefix: 'custom', apiType: 'chat', baseUrl: 'https://old.example/v1' });
    const connection = await createProviderConnection({ provider: 'custom', authType: 'apikey', name: 'Key', apiKey: 'old-key' });
    const b = await fresh({ origin: 'b'.repeat(32) }); exchange(a, b);
    active.db = a; await updateProviderNode('custom', { baseUrl: 'https://new.example/v1' });
    active.db = b; await updateProviderConnection(connection.id, { apiKey: 'new-key' });
    exchange(a, b);
    expect(await getProviderConnections({ isActive: true })).toHaveLength(0);
    expect(JSON.parse(b.get('SELECT data FROM providerConnections').data).haEndpointMismatch).toBe(true);
  });
  it('removes the final portable setting on both peers', async () => {
    const a = await fresh(); await updateSettings({ comboStrategy: 'round-robin' });
    const b = await fresh(); exchange(a, b);
    a.run('UPDATE settings SET data=? WHERE id=1', ['{}']); exchange(a, b);
    expect(JSON.parse(b.get('SELECT data FROM settings WHERE id=1').data)).toEqual({});
  });
  it('quarantines a checkpoint whose contents or frontier were altered', async () => {
    const db = await fresh(); await createCombo({ name: 'test', models: ['a/model'] });
    db.ha.raw.run("UPDATE haMeta SET value=? WHERE key='checkpoint'", [JSON.stringify({ state: {}, vector: {} })]);
    expect(() => store.attachHaStore(db.ha.raw)).toThrow(/checkpoint.*recovery/i);
  });
  it('rejects inbound bindings that smuggle a loopback destination or undeclared session field', async () => {
    const a = await fresh({ origin: 'a'.repeat(32) });
    await createProviderNode({ id: 'custom', type: 'openai-compatible', name: 'Custom', baseUrl: 'https://api.example/v1' });
    const b = await fresh();
    const event = structuredClone(a.ha.eventsSince({})[0]);
    event.changes.find(c => c.field === 'binding').value.baseUrl = 'http://127.0.0.1:1234';
    expect(() => b.ha.receive([event])).toThrow(/binding/i);
    expect(b.ha.status().eventCount).toBe(0);
    event.changes.find(c => c.field === 'binding').value.baseUrl = 'https://api.example/v1';
    event.changes.find(c => c.field === 'binding').value.refreshToken = 'smuggled-session';
    expect(() => b.ha.receive([event])).toThrow(/binding/i);
  });
  it('can add a nested setting after an empty map and after clearing that map', async () => {
    const a = await fresh(); await updateSettings({ providerStrategies: {} });
    const b = await fresh(); exchange(a, b);
    active.db = a; await updateSettings({ providerStrategies: { codex: 'round-robin' } }); exchange(a, b);
    active.db = b; expect((await getSettings()).providerStrategies).toEqual({ codex: 'round-robin' });
    await updateSettings({ providerStrategies: {} }); exchange(a, b);
    await updateSettings({ providerStrategies: { vertex: 'fallback' } }); exchange(a, b);
    expect((await getSettings()).providerStrategies).toEqual({ vertex: 'fallback' });
  });
  it('does not let an older empty-parent register hide a newly added child', async () => {
    const db = await fresh(); const origin = 'c'.repeat(32);
    db.ha.receive([{ version: 1, id: `${origin}:1`, origin, seq: 1, context: { [origin]: 0 }, changes: [{ entity: 'settings:global', field: '["providerStrategies"]', value: {} }] }]);
    await updateSettings({ providerStrategies: { codex: 'fallback' } });
    expect((await getSettings()).providerStrategies).toEqual({ codex: 'fallback' });
  });
  it('preserves node-local provider options while replicating portable options', async () => {
    const a = await fresh();
    const c = await createProviderConnection({ provider: 'vertex', authType: 'apikey', apiKey: 'key', name: 'Vertex', providerSpecificData: { location: 'global', connectionProxyUrl: 'http://127.0.0.1:8888' } });
    expect(JSON.parse(a.get('SELECT data FROM providerConnections WHERE id=?', [c.id]).data).providerSpecificData.connectionProxyUrl).toBe('http://127.0.0.1:8888');
    const b = await fresh(); exchange(a, b);
    const remote = JSON.parse(b.get('SELECT data FROM providerConnections WHERE id=?', [c.id]).data).providerSpecificData;
    expect(remote.location).toBe('global'); expect(remote.connectionProxyUrl).toBeUndefined();
  });
  it('does not change combo timestamps when an unrelated setting changes', async () => {
    const db = await fresh(); const c = await createCombo({ name: 'unchanged', models: ['a/model'] });
    db.ha.raw.run('UPDATE combos SET updatedAt=? WHERE id=?', ['2020-01-01', c.id]);
    await updateSettings({ comboStrategy: 'round-robin' });
    expect(db.get('SELECT updatedAt FROM combos WHERE id=?', [c.id]).updatedAt).toBe('2020-01-01');
  });
  it('does not reuse a local OAuth session after the logical provider changes', async () => {
    const db = await fresh();
    const c = await createProviderConnection({ provider: 'codex', authType: 'oauth', name: 'Session', accessToken: 'old-token', refreshToken: 'old-refresh' });
    await updateProviderConnection(c.id, { provider: 'claude' });
    const data = JSON.parse(db.get('SELECT data FROM providerConnections WHERE id=?', [c.id]).data);
    expect(data.accessToken).toBeUndefined(); expect(data.refreshToken).toBeUndefined();
  });
  it('restores legacy connection selection when HA is disabled', async () => {
    const a = await fresh(); const c = await createProviderConnection({ provider: 'codex', authType: 'oauth', name: 'Session', accessToken: 'primary-session' });
    const b = await fresh(); exchange(a, b);
    active.db = b.ha.raw; // Same database opened by the normal, non-HA driver.
    await updateProviderConnection(c.id, { accessToken: 'local-login-after-disabling-ha' });
    expect(await getProviderConnections({ isActive: true })).toHaveLength(1);
  });
});
