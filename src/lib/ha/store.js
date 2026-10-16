import { randomBytes, createHash } from 'node:crypto';
import { createReplica, canonical } from './replica.js';
import { CONFIG_TABLES, readPortable, diffPortable, materialize, validateChange } from './configuration.js';

export function attachHaStore(raw, { bindings = {}, ...options } = {}) {
  raw.exec('PRAGMA synchronous = FULL');
  const replica = createReplica(raw, { ...options, validateChange });
  const getMeta = key => { const row = raw.get('SELECT value FROM haMeta WHERE key=?', [key]); return row ? JSON.parse(row.value) : null; };
  const setMeta = (key, value) => raw.run('INSERT INTO haMeta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, canonical(value)]);
  if (!getMeta('nodeId')) setMeta('nodeId', randomBytes(16).toString('hex'));
  let depth = 0;
  const checksum = value => createHash('sha256').update(canonical(value)).digest('hex');
  function checkpoint() {
    const value = { state: readPortable(raw), vector: replica.vector() };
    setMeta('checkpoint', { ...value, checksum: checksum(value) });
  }
  function project() {
    const conflicts = materialize(raw, replica, bindings);
    setMeta('nameConflicts', conflicts);
    checkpoint();
  }
  raw.transaction(() => {
    const saved = getMeta('checkpoint');
    if (!saved && replica.status().eventCount > 0) throw new Error('Missing HA checkpoint; recovery review required');
    if (saved && (!saved.state || typeof saved.state !== 'object' || Array.isArray(saved.state) ||
        saved.checksum !== checksum({ state: saved.state, vector: saved.vector }) || canonical(saved.vector) !== canonical(replica.vector())))
      throw new Error('Inconsistent HA checkpoint; recovery review required');
    const changes = diffPortable(saved?.state || {}, readPortable(raw));
    if (changes.length) replica.commit(changes, saved?.vector || replica.vector());
    if (changes.length || saved) project();
    else checkpoint();
  });
  raw.flushDurable?.();
  function transaction(fn) {
    let journaled = false;
    const result = raw.transaction(() => {
      const outer = depth === 0;
      const before = outer ? readPortable(raw) : null;
      depth++;
      try {
        const result = fn();
        if (result?.then) throw new Error('HA database transaction must be synchronous');
        if (outer) {
          const changes = diffPortable(before, readPortable(raw));
          if (changes.some(c => c.field === 'access' && replica.conflicts().some(x => x.entity === c.entity && x.field === 'access')))
            throw new Error('Resolve the HA access conflict before changing this policy');
          if (changes.length) { replica.commit(changes); project(); journaled = true; }
        }
        return result;
      } finally { depth--; }
    });
    if (journaled) raw.flushDurable?.();
    return result;
  }
  function durable(fn) { const result = raw.transaction(fn); raw.flushDurable?.(); return result; }
  const pattern = new RegExp(`\\b(?:${CONFIG_TABLES.join('|')})\\b`, 'i');
  const db = {
    ...raw,
    transaction,
    run(sql, args = []) {
      if (depth || !pattern.test(sql) || !/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)/i.test(sql)) return raw.run(sql, args);
      return transaction(() => raw.run(sql, args));
    },
    exec(sql) {
      if (pattern.test(sql) && /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) return transaction(() => raw.exec(sql));
      return raw.exec(sql);
    },
  };
  db.ha = {
    ...replica, raw,
    receive(events) { return durable(() => { const n = replica.receive(events); if (n) project(); return n; }); },
    resolve(...args) { return durable(() => { const event = replica.resolve(...args); project(); return event; }); },
    authorizeClient(key) { return raw.get('SELECT isActive FROM apiKeys WHERE key=?', [key])?.isActive === 1; },
    policies(id) { return replica.registers()[`apiKeys:${id}`]?.access?.map(v => v.value) || []; },
    canUseConnection(connection) {
      if (connection.haEndpointMismatch) return false;
      const node = raw.get('SELECT data FROM providerNodes WHERE id=?', [connection.provider]);
      if (node && JSON.parse(node.data).haRemoteOnly) return false;
      return connection.authType === 'apikey' ? Boolean(connection.apiKey) : Boolean(connection.accessToken);
    },
    rename(entity, name, expectedName) {
      if (!entity?.startsWith('combos:') || typeof name !== 'string' || !name.trim() || name.length > 256) throw new Error('Invalid name');
      return durable(() => {
        const records = replica.records();
        if (records[entity]?.name !== expectedName || Object.entries(records).some(([key, value]) => key.startsWith('combos:') && key !== entity && value.name === name.trim())) throw new Error('Name changed or already exists');
        const event = replica.commit([{ entity, field: 'name', value: name.trim() }]); project(); return event;
      });
    },
    status() { return { ...replica.status(), nodeId: getMeta('nodeId'), nameConflicts: getMeta('nameConflicts') || [] }; },
  };
  return db;
}
