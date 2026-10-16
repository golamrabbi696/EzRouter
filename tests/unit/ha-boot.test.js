import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dirs = [];
afterEach(async () => {
  await global._dbAdapter?.instance?.ha?.runtime?.close();
  global._dbAdapter?.instance?.close(); delete global._dbAdapter;
  vi.unstubAllEnvs(); vi.resetModules();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
it('boots the opt-in journal and peer listener through the real driver', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-boot-')); dirs.push(dir);
  const config = path.join(dir, 'ha.json');
  fs.writeFileSync(config, JSON.stringify({ token: 'a'.repeat(64), allowLoopbackHttp: true, listen: { host: '127.0.0.1', port: 0 }, intervalMs: 0 }), { mode: 0o600 });
  vi.stubEnv('DATA_DIR', dir); vi.stubEnv('NINEROUTER_HA_CONFIG', config); vi.resetModules();
  const { getAdapter } = await import('../../src/lib/db/driver.js');
  const db = await getAdapter();
  expect(db.ha).toBeDefined();
  await db.ha.runtime.ready;
  expect(db.ha.runtime.server.address().port).toBeGreaterThan(0);
});
