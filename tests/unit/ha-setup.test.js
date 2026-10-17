import { expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadHaConfig, startHaRuntime } from '../../src/lib/ha/runtime.js';
import { createReplica } from '../../src/lib/ha/replica.js';
import { DatabaseSync } from 'node:sqlite';
const script = path.resolve(import.meta.dirname, '../../scripts/ha-setup.mjs');
const cleanup = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

it('creates matching private configurations that synchronize over verified TLS', async () => {
  expect(fs.existsSync(script)).toBe(true);
  const { createPair } = await import(pathToFileURL(script).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-pair-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'pair');
  await createPair({ first: 'https://127.0.0.1:20130', second: 'https://localhost:20131', output, firstName: 'Proxmox', secondName: 'Azure' });
  const a = loadHaConfig(path.join(output, 'node-a', 'ha.json'));
  const b = loadHaConfig(path.join(output, 'node-b', 'ha.json'));
  expect(a.name).toBe('Proxmox'); expect(b.name).toBe('Azure');
  expect(a.token).toMatch(/^[a-f0-9]{64}$/); expect(a.token).not.toBe(b.token);
  expect(a.peer.token).toBe(b.token); expect(b.peer.token).toBe(a.token);
  expect(a.peer.url).toBe('https://localhost:20131');
  expect(a.listen.keyFile).toBe(path.join(output, 'node-a', 'node.key'));
  if (process.platform !== 'win32') expect(fs.statSync(path.join(output, 'node-a', 'ha.json')).mode & 0o077).toBe(0);
  const runtimes = [];
  for (const config of [a, b]) {
    const db = new DatabaseSync(':memory:'); cleanup.push(() => db.close());
    const store = createReplica({ exec: s => db.exec(s), get: (s, p = []) => db.prepare(s).get(...p), all: (s, p = []) => db.prepare(s).all(...p), run: (s, p = []) => db.prepare(s).run(...p), transaction: fn => fn() });
    config.listen.host = '127.0.0.1'; config.listen.port = 0; config.intervalMs = 0;
    const runtime = startHaRuntime(store, config); cleanup.push(() => runtime.close()); await runtime.ready;
    runtimes.push({ runtime, store });
  }
  // Create a fresh client for the receiver's actual ephemeral port, retaining generated trust and token.
  const { peerJson, peerOptions } = await import('../../src/lib/ha/runtime.js');
  a.peer.url = `https://localhost:${runtimes[1].runtime.server.address().port}`;
  runtimes[0].store.commit([{ entity: 'combos:test', field: 'name', value: 'paired' }]);
  const response = await peerJson(peerOptions(a), '/sync', { version: 1, vector: {}, events: runtimes[0].store.eventsSince({}, 250) });
  expect(response.version).toBe(1);
  expect(runtimes[1].store.records()['combos:test'].name).toBe('paired');
  await expect(createPair({ first: 'https://localhost:20130', second: 'https://localhost:20131', output })).rejects.toThrow(/exist/i);
});

it('rejects insecure, credential-bearing and duplicate endpoints before creating files', async () => {
  expect(fs.existsSync(script)).toBe(true);
  const { createPair } = await import(pathToFileURL(script).href);
  for (const first of ['http://host:20130', 'https://user:pass@host:20130', 'https://host/path', 'https://host:20130']) {
    await expect(createPair({ first, second: 'https://host:20130', output: path.join(os.tmpdir(), 'must-not-create-ha') })).rejects.toThrow();
  }
});
