import { randomBytes } from 'node:crypto';

export const MAX_EVENTS = 500;
export const MAX_BYTES = 4 * 1024 * 1024;
const ORIGIN = /^[a-f0-9]{32}$/;
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function validateVector(vector) {
  if (!object(vector) || Object.keys(vector).length > 10000) throw new Error('Invalid HA vector');
  for (const [origin, seq] of Object.entries(vector)) {
    if (!ORIGIN.test(origin) || !Number.isSafeInteger(seq) || seq < 0) throw new Error('Invalid HA vector');
  }
}

function validateEvent(event) {
  if (!object(event) || event.version !== 1 || !ORIGIN.test(event.origin) ||
      !Number.isSafeInteger(event.seq) || event.seq < 1 || event.id !== `${event.origin}:${event.seq}`)
    throw new Error('Invalid HA event');
  validateVector(event.context);
  if ((event.context[event.origin] || 0) !== event.seq - 1) throw new Error('Invalid HA origin sequence');
  if (!Array.isArray(event.changes) || !event.changes.length || event.changes.length > 10000)
    throw new Error('Invalid HA changes');
  const seen = new Set();
  for (const c of event.changes) {
    if (!object(c) || typeof c.entity !== 'string' || c.entity.length > 1024 || !c.entity.includes(':') ||
        typeof c.field !== 'string' || !c.field || c.field.length > 1024 || BAD_KEYS.has(c.field) ||
        BAD_KEYS.has(c.entity) || !Object.hasOwn(c, 'value') || (c.field === '$deleted' && c.value !== true))
      throw new Error('Invalid HA change');
    const key = JSON.stringify([c.entity, c.field]);
    if (seen.has(key)) throw new Error('Invalid duplicate HA field');
    seen.add(key);
  }
  if (Buffer.byteLength(canonical(event)) > MAX_BYTES) throw new Error('HA event size limit');
}

// Synchronous adapter contract shared by bun:sqlite, better-sqlite3, node:sqlite
// and sql.js. Callers can nest these writes in their configuration transaction.
export function createReplica(db, { origin = randomBytes(16).toString('hex'), validateChange = () => {} } = {}) {
  if (!ORIGIN.test(origin)) throw new Error('Invalid writer incarnation');
  db.exec(`
    CREATE TABLE IF NOT EXISTS haEvents (position INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, origin TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(origin,seq));
    CREATE TABLE IF NOT EXISTS haVersions (entity TEXT NOT NULL, field TEXT NOT NULL, eventId TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(entity,field,eventId));
    CREATE TABLE IF NOT EXISTS haMeta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  function vector() {
    return Object.fromEntries(db.all('SELECT origin, MAX(seq) AS seq FROM haEvents GROUP BY origin').map(r => [r.origin, r.seq]));
  }
  function versions(entity, field) {
    return db.all('SELECT data FROM haVersions WHERE entity=? AND field=?', [entity, field]).map(r => JSON.parse(r.data));
  }
  function receive(events) {
    if (!Array.isArray(events) || events.length > MAX_EVENTS || Buffer.byteLength(JSON.stringify(events)) > MAX_BYTES)
      throw new Error('HA batch limit');
    return db.transaction(() => {
      const clock = vector();
      let applied = 0;
      for (const event of events) {
        validateEvent(event);
        event.changes.forEach(validateChange);
        const data = canonical(event);
        const existing = db.get('SELECT data FROM haEvents WHERE id=?', [event.id]);
        if (existing) {
          if (existing.data !== data) throw new Error('HA history fork');
          continue;
        }
        if (Object.entries(event.context).some(([id, seq]) => (clock[id] || 0) < seq) ||
            (clock[event.origin] || 0) !== event.seq - 1) throw new Error('Missing HA predecessor');
        db.run('INSERT INTO haEvents(id,origin,seq,data) VALUES(?,?,?,?)', [event.id, event.origin, event.seq, data]);
        for (const change of event.changes) {
          let superseded = false;
          for (const old of versions(change.entity, change.field)) {
            if ((old.context[event.origin] || 0) >= event.seq) superseded = true;
            if ((event.context[old.origin] || 0) >= old.seq)
              db.run('DELETE FROM haVersions WHERE entity=? AND field=? AND eventId=?', [change.entity, change.field, old.id]);
          }
          if (!superseded) {
            const version = { id: event.id, origin: event.origin, seq: event.seq, context: event.context, value: change.value };
            db.run('INSERT INTO haVersions(entity,field,eventId,data) VALUES(?,?,?,?)', [change.entity, change.field, event.id, canonical(version)]);
          }
        }
        clock[event.origin] = event.seq;
        applied++;
      }
      return applied;
    });
  }
  function commit(changes, context = vector()) {
    return db.transaction(() => {
      for (const c of changes) {
        if (c.field !== '$deleted' && versions(c.entity, '$deleted').length) throw new Error('Cannot update deleted entity');
      }
      const seq = (vector()[origin] || 0) + 1;
      const event = { version: 1, id: `${origin}:${seq}`, origin, seq, context: { ...context, [origin]: seq - 1 }, changes };
      receive([event]);
      return event;
    });
  }
  function registers() {
    const out = Object.create(null);
    for (const row of db.all('SELECT entity,field,data FROM haVersions ORDER BY entity,field')) {
      out[row.entity] ??= Object.create(null);
      out[row.entity][row.field] ??= [];
      out[row.entity][row.field].push(JSON.parse(row.data));
    }
    for (const fields of Object.values(out)) for (const values of Object.values(fields))
      values.sort((a, b) => a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : a.seq - b.seq);
    return out;
  }
  function records() {
    const out = Object.create(null);
    for (const [entity, fields] of Object.entries(registers())) {
      if (fields.$deleted?.length) continue;
      out[entity] = Object.fromEntries(Object.entries(fields).map(([field, values]) => [field, values.at(-1).value]));
    }
    return out;
  }
  function conflicts() {
    return Object.entries(registers()).flatMap(([entity, fields]) => Object.entries(fields)
      .filter(([, values]) => values.length > 1 && new Set(values.map(v => canonical(v.value))).size > 1)
      .map(([field, values]) => ({ entity, field, versions: values.map(v => ({ id: v.id,
        preview: ['name', 'models', 'access', 'isActive'].includes(field) ? v.value : '[redacted]' })) })));
  }
  function resolve(entity, field, versionId, expected) {
    return db.transaction(() => {
      const values = versions(entity, field);
      if (!Array.isArray(expected) || canonical(values.map(v => v.id).sort()) !== canonical([...expected].sort()))
        throw new Error('Conflict changed; reload before resolving');
      const selected = values.find(v => v.id === versionId);
      if (!selected) throw new Error('Unknown conflict version');
      return commit([{ entity, field, value: selected.value }]);
    });
  }
  function eventsSince(frontier = {}, limit = MAX_EVENTS) {
    validateVector(frontier);
    const out = []; let bytes = 2;
    // Journal is retained for disconnected recovery. Scan in durable causal order.
    // ponytail: linear history scan; add per-origin SQL cursors at 100k config events.
    for (const row of db.all('SELECT origin,seq,data FROM haEvents ORDER BY position')) {
      if (row.seq <= (frontier[row.origin] || 0)) continue;
      const size = Buffer.byteLength(row.data) + 1;
      if (out.length && (out.length >= Math.min(limit, MAX_EVENTS) || bytes + size > MAX_BYTES)) break;
      out.push(JSON.parse(row.data)); bytes += size;
    }
    return out;
  }
  function status() {
    return { origin, vector: vector(), eventCount: db.get('SELECT COUNT(*) AS count FROM haEvents').count, conflicts: conflicts() };
  }
  return { commit, receive, vector, eventsSince, registers, records, conflicts, resolve, status };
}
