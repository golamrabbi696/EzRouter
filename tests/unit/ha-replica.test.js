import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as ha from '../../src/lib/ha/replica.js';

const databases = [];
function adapter() {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  let n = 0;
  return {
    exec: sql => db.exec(sql),
    run: (sql, args = []) => db.prepare(sql).run(...args),
    get: (sql, args = []) => db.prepare(sql).get(...args),
    all: (sql, args = []) => db.prepare(sql).all(...args),
    transaction(fn) {
      const s = `s${++n}`;
      db.exec(`SAVEPOINT ${s}`);
      try { const result = fn(); db.exec(`RELEASE ${s}`); return result; }
      catch (error) { db.exec(`ROLLBACK TO ${s}; RELEASE ${s}`); throw error; }
    },
  };
}
const change = (field, value, entity = 'combos:test') => ({ entity, field, value });
const make = (origin = undefined, db = adapter()) => ha.createReplica(db, { origin });
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe('HA causal journal', () => {
  it('provides a durable replica', () => expect(ha.createReplica).toBeTypeOf('function'));

  it('merges independent fields and retains both concurrent field values', () => {
    const a = make('a'.repeat(32)), b = make('b'.repeat(32));
    const first = a.commit([change('name', 'initial')]); b.receive([first]);
    const left = a.commit([change('name', 'left'), change('models', ['a'])]);
    const right = b.commit([change('name', 'right')]);
    a.receive([right]); b.receive([left]);
    expect(a.records()).toEqual(b.records());
    expect(a.records()['combos:test'].name).toBe('right');
    expect(a.records()['combos:test'].models).toEqual(['a']);
    expect(a.conflicts()[0].versions).toHaveLength(2);
    expect(a.conflicts()[0].versions.map(v => v.preview)).toContain('right');
  });

  it('keeps a concurrent loser needed when a later edit observes only the winner', () => {
    const a = make('a'.repeat(32)), b = make('b'.repeat(32)), c = make();
    const x = a.commit([change('name', 'a')]);
    const y = b.commit([change('name', 'b')]);
    const z = a.commit([change('name', 'a2')]);
    c.receive([x, y, z]); b.receive([x, z]); a.receive([y]);
    expect(c.records()).toEqual(a.records());
    expect(b.records()).toEqual(a.records());
    expect(c.conflicts()[0].versions).toHaveLength(2);
    const resolution = c.resolve('combos:test', 'name', z.id, c.conflicts()[0].versions.map(v => v.id));
    a.receive([resolution]); b.receive([resolution]);
    expect(a.records()['combos:test'].name).toBe('a2');
    expect(a.conflicts()).toHaveLength(0);
  });

  it('deduplicates retries and refuses causal gaps without partial acknowledgement', () => {
    const a = make(), b = make();
    const x = a.commit([change('name', 'a')]), y = a.commit([change('name', 'b')]);
    expect(() => b.receive([y])).toThrow(/predecessor/);
    expect(b.status().eventCount).toBe(0);
    b.receive([x, y, x]);
    expect(b.status().eventCount).toBe(2);
    expect(b.eventsSince(a.vector())).toEqual([]);
  });

  it('rejects conflicting event identity and rolls back the whole batch', () => {
    const a = make(), b = make();
    const event = a.commit([change('name', 'a')]);
    const fork = structuredClone(event); fork.changes[0].value = 'different';
    expect(() => b.receive([event, fork])).toThrow(/history fork/);
    expect(b.status().eventCount).toBe(0);
  });

  it('does not resurrect deleted entities with concurrent or later ordinary edits', () => {
    const a = make(), b = make();
    b.receive([a.commit([change('name', 'original')])]);
    const deletion = a.commit([change('$deleted', true)]);
    const edit = b.commit([change('name', 'updated')]);
    a.receive([edit]); b.receive([deletion]);
    expect(a.records()['combos:test']).toBeUndefined();
    expect(() => a.commit([change('name', 'resurrect')])).toThrow(/deleted entity/);
  });

  it('uses a fresh writer incarnation after reopening a restored database', () => {
    const db = adapter(), a = make(undefined, db);
    const first = a.commit([change('name', 'a')]);
    const reopened = make(undefined, db);
    const second = reopened.commit([change('name', 'b')]);
    expect(second.origin).not.toBe(first.origin);
    expect(second.seq).toBe(1);
    expect(second.context[first.origin]).toBe(1);
  });

  it('rejects malformed fields, forged vectors and oversized batches', () => {
    const a = make(), b = make();
    const event = a.commit([change('name', 'a')]);
    const invalid = structuredClone(event); invalid.changes[0].field = '__proto__';
    expect(() => b.receive([invalid])).toThrow(/invalid/i);
    const invalidClock = structuredClone(event); invalidClock.context[event.origin] = 5;
    expect(() => b.receive([invalidClock])).toThrow(/invalid/i);
    expect(() => b.receive(Array(501).fill(event))).toThrow(/limit/i);
  });

  it('does not clear a conflict with a stale resolution', () => {
    const a = make(), b = make();
    const x = a.commit([change('name', 'a')]), y = b.commit([change('name', 'b')]);
    a.receive([y]);
    expect(() => a.resolve('combos:test', 'name', x.id, [x.id])).toThrow(/changed/);
  });
});
