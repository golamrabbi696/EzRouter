import { canonical } from './replica.js';

export const CONFIG_TABLES = ['settings', 'combos', 'apiKeys', 'providerNodes', 'providerConnections', 'proxyPools', 'kv'];
const SCOPES = new Set(['modelAliases', 'customModels', 'mitmAlias', 'pricing']);
const SETTINGS = new Set(['stickyRoundRobinLimit', 'providerStrategies', 'providerThinking', 'quotaVisibility', 'comboStrategy', 'comboStickyRoundRobinLimit', 'comboStrategies', 'capacityAdapter', 'rtkEnabled', 'cavemanEnabled', 'cavemanLevel', 'ponytailEnabled', 'ponytailLevel']);
const FIELDS = {
  combos: ['name', 'kind', 'models', 'createdAt'],
  apiKeys: ['key', 'name', 'isActive', 'createdAt', 'access'],
  providerNodes: ['name', 'createdAt', 'binding'],
  providerConnections: ['name', 'email', 'priority', 'isActive', 'createdAt', 'binding'],
  proxyPools: ['isActive', 'createdAt', 'binding'],
  kv: ['value'],
};
const parse = (value, fallback = {}) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };
const pick = (value, names) => Object.fromEntries(names.filter(k => value[k] !== undefined).map(k => [k, value[k]]));
const split = entity => { const i = entity.indexOf(':'); return [entity.slice(0, i), entity.slice(i + 1)]; };
const forbidden = key => ['__proto__', 'constructor', 'prototype'].includes(key);
const PROVIDER_OPTIONS = ['projectId', 'location', 'region', 'apiVersion', 'baseUrl', 'endpoint', 'resourceName'];
function portableUrl(value, proxy = false) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;
  try { return (proxy ? ['http:', 'https:', 'socks:', 'socks4:', 'socks5:'] : ['http:', 'https:']).includes(new URL(value).protocol) && !localUrl(value); }
  catch { return false; }
}
function validateBinding(table, value) {
  const fail = () => { throw new Error('Invalid HA binding'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const allowed = table === 'providerNodes' ? ['type', 'prefix', 'apiType', 'baseUrl', 'local']
    : table === 'proxyPools' ? ['name', 'type', 'noProxy', 'strictProxy', 'proxyUrl', 'local']
      : ['provider', 'authType', 'endpoint', 'apiKey', 'projectId', 'providerSpecificData'];
  if (Object.keys(value).some(k => !allowed.includes(k))) fail();
  for (const [key, entry] of Object.entries(value)) {
    if (['local', 'strictProxy'].includes(key)) { if (typeof entry !== 'boolean') fail(); }
    else if (key !== 'providerSpecificData' && entry !== null && typeof entry !== 'string') fail();
  }
  if (table === 'providerConnections') {
    if (!value.provider || !['apikey', 'oauth', 'access_token'].includes(value.authType)) fail();
    if (value.authType !== 'apikey' && ['apiKey', 'providerSpecificData'].some(k => Object.hasOwn(value, k))) fail();
    if (value.endpoint !== 'local' && !portableUrl(value.endpoint)) fail();
    if (value.providerSpecificData !== undefined) {
      const extra = value.providerSpecificData;
      if (!extra || typeof extra !== 'object' || Array.isArray(extra) || Object.keys(extra).some(k => !PROVIDER_OPTIONS.includes(k))) fail();
      if (Object.values(extra).some(v => v !== null && typeof v !== 'string')) fail();
      if (!portableUrl(extra.baseUrl) || !portableUrl(extra.endpoint)) fail();
    }
  } else {
    if (typeof value.local !== 'boolean') fail();
    const url = table === 'providerNodes' ? value.baseUrl : value.proxyUrl;
    if (value.local ? url !== null : !portableUrl(url, table === 'proxyPools')) fail();
  }
}
export function localUrl(value) {
  if (!value) return false;
  try { const h = new URL(value).hostname; return h === 'localhost' || h === '[::1]' || /^127\./.test(h); }
  catch { return false; }
}
function flatten(value, path, out) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (forbidden(key)) throw new Error('Invalid HA settings key');
      flatten(child, [...path, key], out);
    }
  } else out[JSON.stringify(path)] = value;
}
function setPath(target, path, value) {
  let cursor = target;
  for (const key of path.slice(0, -1)) {
    if (!cursor[key] || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }
  if (value !== null) cursor[path.at(-1)] = value;
  else delete cursor[path.at(-1)];
}

export function validateChange({ entity, field, value }) {
  const [table, id] = split(entity);
  if (!CONFIG_TABLES.includes(table) || !id || forbidden(id)) throw new Error('Invalid HA entity');
  if (field === '$deleted') {
    if (table === 'settings') throw new Error('Invalid HA settings deletion');
    if (table !== 'kv') return;
  }
  if (table === 'settings') {
    let path; try { path = JSON.parse(field); } catch { throw new Error('Invalid HA settings path'); }
    if (id !== 'global' || !Array.isArray(path) || !path.length || path.length > 20 || !SETTINGS.has(path[0]) || path.some(k => typeof k !== 'string' || forbidden(k))) throw new Error('Invalid HA settings path');
  } else if (field !== '$deleted' && !FIELDS[table].includes(field)) throw new Error('Invalid HA portable field');
  if (table === 'kv') {
    let pair; try { pair = JSON.parse(id); } catch { throw new Error('Invalid HA kv identity'); }
    if (!Array.isArray(pair) || pair.length !== 2 || !SCOPES.has(pair[0]) || typeof pair[1] !== 'string') throw new Error('Invalid HA kv identity');
  }
  if (field === 'access' && (!value || typeof value.restricted !== 'boolean' || !Array.isArray(value.allow) || value.allow.some(x => typeof x !== 'string'))) throw new Error('Invalid HA access policy');
  if (field === 'isActive' && value !== 0 && value !== 1) throw new Error('Invalid HA activation');
  if (field === 'binding') validateBinding(table, value);
}

export function readPortable(db) {
  const out = Object.create(null);
  const settings = parse(db.get('SELECT data FROM settings WHERE id=1')?.data);
  const portableSettings = {};
  for (const key of SETTINGS) if (settings[key] !== undefined) flatten(settings[key], [key], portableSettings);
  if (Object.keys(portableSettings).length) out['settings:global'] = portableSettings;
  const localProviders = new Set(), endpoints = new Map();
  for (const r of db.all('SELECT * FROM providerNodes')) {
    const data = parse(r.data), isLocal = localUrl(data.baseUrl) || data.haLocalBinding === true;
    if (isLocal) localProviders.add(r.id);
    endpoints.set(r.id, isLocal ? 'local' : data.baseUrl ?? null);
    out[`providerNodes:${r.id}`] = { name: r.name, createdAt: r.createdAt,
      binding: { type: r.type, ...pick(data, ['prefix', 'apiType']), baseUrl: isLocal ? null : data.baseUrl ?? null, local: isLocal } };
  }
  for (const r of db.all('SELECT * FROM providerConnections')) {
    const data = parse(r.data), portable = pick(r, FIELDS.providerConnections);
    const binding = { provider: r.provider, authType: r.authType, endpoint: endpoints.get(r.provider) ?? null };
    if (r.authType === 'apikey' && !localProviders.has(r.provider)) {
      Object.assign(binding, pick(data, ['apiKey', 'projectId']));
      binding.providerSpecificData = pick(data.providerSpecificData || {}, PROVIDER_OPTIONS);
    }
    out[`providerConnections:${r.id}`] = { ...portable, binding };
  }
  for (const r of db.all('SELECT * FROM combos')) out[`combos:${r.id}`] = { ...pick(r, FIELDS.combos), models: parse(r.models, []) };
  for (const r of db.all('SELECT * FROM apiKeys')) out[`apiKeys:${r.id}`] = {
    ...pick(r, FIELDS.apiKeys), access: { restricted: r.accessRestricted === 1, allow: r.accessRestricted === 1 ? parse(r.accessAllow, []) : [] },
  };
  for (const r of db.all('SELECT * FROM proxyPools')) {
    const data = parse(r.data), isLocal = localUrl(data.proxyUrl) || data.haLocalBinding === true;
    out[`proxyPools:${r.id}`] = { isActive: r.isActive, createdAt: r.createdAt,
      binding: { ...pick(data, ['name', 'type', 'noProxy', 'strictProxy']), proxyUrl: isLocal ? null : data.proxyUrl ?? null, local: isLocal } };
  }
  for (const r of db.all('SELECT * FROM kv')) if (SCOPES.has(r.scope)) out[`kv:${JSON.stringify([r.scope, r.key])}`] = { value: parse(r.value, null) };
  return out;
}

export function diffPortable(before, after) {
  const changes = [];
  for (const entity of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!after[entity] && entity !== 'settings:global') { changes.push({ entity, field: '$deleted', value: true }); continue; }
    for (const field of new Set([...Object.keys(before[entity] || {}), ...Object.keys(after[entity] || {})])) {
      const value = after[entity]?.[field] ?? null;
      if (canonical(before[entity]?.[field] ?? null) !== canonical(value)) changes.push({ entity, field, value });
    }
  }
  return changes;
}

export function materialize(db, replica, bindings = {}) {
  const records = replica.records(), registers = replica.registers(), nameConflicts = [];
  const previous = Object.fromEntries(CONFIG_TABLES.filter(t => !['settings', 'kv'].includes(t)).map(t => [t, new Map(db.all(`SELECT * FROM ${t}`).map(r => [r.id, r]))]));
  const active = (entity, value) => registers[entity]?.isActive?.some(v => v.value === 0) ? 0 : value ?? 1;
  const now = new Date().toISOString();
  const upsert = (table, row) => {
    const keys = Object.keys(row);
    const old = previous[table]?.get(row.id);
    if (old && keys.includes('updatedAt') && keys.filter(k => k !== 'updatedAt').every(k =>
      ['data', 'models'].includes(k) ? canonical(parse(old[k], null)) === canonical(parse(row[k], null)) : (old[k] ?? null) === (row[k] ?? null))) row.updatedAt = old.updatedAt;
    db.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${keys.filter(k => k !== 'id').map(k => `${k}=excluded.${k}`).join(',')}`, keys.map(k => row[k] ?? null));
  };
  // Remove only managed entities, and release unique names before rematerializing.
  for (const [entity] of Object.entries(registers)) {
    const [table, id] = split(entity);
    if (['settings', 'kv'].includes(table)) continue;
    if (!records[entity] || table === 'combos' || table === 'apiKeys') db.run(`DELETE FROM ${table} WHERE id=?`, [id]);
  }
  const settings = parse(db.get('SELECT data FROM settings WHERE id=1')?.data);
  for (const key of SETTINGS) delete settings[key];
  for (const [field, value] of Object.entries(records['settings:global'] || {})) {
    // Portable roots were cleared above. Tombstones and legacy empty-parent
    // registers must not erase independently added child fields.
    if (value === null || typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) continue;
    setPath(settings, JSON.parse(field), value);
  }
  if (Object.keys(settings).length || registers['settings:global']) db.run('INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', [JSON.stringify(settings)]);
  const usedNames = new Set(), keyCounts = new Map();
  for (const [entity, r] of Object.entries(records)) if (entity.startsWith('apiKeys:')) keyCounts.set(r.key, (keyCounts.get(r.key) || 0) + 1);
  const entries = Object.entries(records).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  for (const [entity, r] of entries.filter(([e]) => e.startsWith('providerNodes:'))) {
    const [, id] = split(entity), old = previous.providerNodes.get(id), data = parse(old?.data), b = r.binding;
    if (!b) continue;
    const baseUrl = b.local ? bindings[entity]?.baseUrl || (localUrl(data.baseUrl) ? data.baseUrl : null) : b.baseUrl;
    upsert('providerNodes', { id, name: r.name, type: b.type, createdAt: r.createdAt || now, updatedAt: now,
      data: JSON.stringify({ ...data, prefix: b.prefix, apiType: b.apiType, baseUrl, haLocalBinding: b.local, haRemoteOnly: b.local && !baseUrl }) });
  }
  for (const [entity, r] of entries) {
    const [table, id] = split(entity), old = previous[table]?.get(id), data = parse(old?.data);
    if (table === 'combos') {
      if (!r.name || !Array.isArray(r.models)) continue;
      if (usedNames.has(r.name)) { nameConflicts.push({ entity, field: 'name', name: r.name }); continue; }
      usedNames.add(r.name);
      upsert(table, { id, name: r.name, kind: r.kind, models: JSON.stringify(r.models), createdAt: r.createdAt || now, updatedAt: now });
    } else if (table === 'apiKeys') {
      if (!r.key || keyCounts.get(r.key) !== 1) { nameConflicts.push({ entity, field: 'key' }); continue; }
      const policies = registers[entity]?.access?.map(v => v.value).filter(p => p?.restricted) || [];
      const access = policies.length > 1 ? { restricted: true, allow: [] } : policies[0] || r.access || { restricted: false, allow: [] };
      upsert(table, { id, key: r.key, name: r.name, machineId: old?.machineId, isActive: active(entity, r.isActive), createdAt: r.createdAt || now,
        accessRestricted: access.restricted ? 1 : 0, accessAllow: JSON.stringify(access.allow) });
    } else if (table === 'providerConnections') {
      const b = r.binding; if (!b?.provider || !b.authType) continue;
      const node = db.get('SELECT data FROM providerNodes WHERE id=?', [b.provider]);
      const nodeData = parse(node?.data), local = bindings[entity] || {};
      const identity = canonical([b.provider, b.authType, b.endpoint]);
      const localData = { ...data };
      if (localData.haCredentialIdentity && localData.haCredentialIdentity !== identity) {
        for (const key of ['apiKey', 'accessToken', 'refreshToken', 'idToken', 'expiresAt', 'expiresIn', 'tokenType', 'scope', 'projectId', 'providerSpecificData']) delete localData[key];
      }
      let credentials = {};
      if (b.authType === 'apikey' && b.endpoint !== 'local') {
        const providerSpecificData = { ...localData.providerSpecificData };
        for (const key of PROVIDER_OPTIONS) delete providerSpecificData[key];
        Object.assign(providerSpecificData, b.providerSpecificData || {});
        credentials = { apiKey: b.apiKey ?? null, projectId: b.projectId ?? null, providerSpecificData };
      }
      const next = { ...localData, ...credentials, ...local, haCredentialIdentity: identity };
      const missing = b.authType === 'apikey' ? !next.apiKey : !next.accessToken;
      next.haEndpointMismatch = Boolean(b.endpoint && b.endpoint !== (nodeData.haLocalBinding ? 'local' : nodeData.baseUrl));
      next.haRemoteOnly = Boolean(missing || nodeData.haRemoteOnly || next.haEndpointMismatch);
      upsert(table, { id, provider: b.provider, authType: b.authType, name: r.name, email: r.email, priority: r.priority,
        isActive: active(entity, r.isActive), data: JSON.stringify(next), createdAt: r.createdAt || now, updatedAt: now });
    } else if (table === 'proxyPools') {
      const b = r.binding; if (!b) continue;
      const proxyUrl = b.local ? bindings[entity]?.proxyUrl || (localUrl(data.proxyUrl) ? data.proxyUrl : null) : b.proxyUrl;
      upsert(table, { id, isActive: active(entity, r.isActive), testStatus: old?.testStatus || 'unknown', createdAt: r.createdAt || now, updatedAt: now,
        data: JSON.stringify({ ...data, ...b, proxyUrl, haLocalBinding: b.local }) });
    } else if (table === 'kv') {
      const [scope, key] = JSON.parse(id);
      db.run('INSERT INTO kv(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value', [scope, key, JSON.stringify(r.value)]);
    }
  }
  for (const entity of Object.keys(registers)) if (entity.startsWith('kv:') && !records[entity]) {
    const [scope, key] = JSON.parse(split(entity)[1]); db.run('DELETE FROM kv WHERE scope=? AND key=?', [scope, key]);
  }
  return nameConflicts;
}
