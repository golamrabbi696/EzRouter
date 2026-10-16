import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

it('persists an acknowledged sql.js configuration write before immediate process exit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-durable-')), file = path.join(dir, 'state.sqlite');
  try {
    const root = new URL('../../', import.meta.url);
    const code = `
      import { createSqlJsAdapter } from ${JSON.stringify(new URL('src/lib/db/adapters/sqljsAdapter.js', root).href)};
      import { TABLES, buildCreateTableSql } from ${JSON.stringify(new URL('src/lib/db/schema.js', root).href)};
      import { attachHaStore } from ${JSON.stringify(new URL('src/lib/ha/store.js', root).href)};
      const raw = await createSqlJsAdapter(process.argv[1]);
      for (const [name, def] of Object.entries(TABLES)) raw.exec(buildCreateTableSql(name, def));
      const db = attachHaStore(raw);
      db.run('INSERT INTO settings(id,data) VALUES(1,?)', ['{"comboStrategy":"round-robin"}']);
      process.exit(0);
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, file], { encoding: 'utf8' });
    expect(child.status, child.stderr).toBe(0);
    expect(fs.existsSync(file)).toBe(true);
    const persisted = new DatabaseSync(file);
    try {
      expect(JSON.parse(persisted.prepare('SELECT data FROM settings').get().data).comboStrategy).toBe('round-robin');
      expect(persisted.prepare('SELECT COUNT(*) AS n FROM haEvents').get().n).toBe(1);
    } finally { persisted.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
