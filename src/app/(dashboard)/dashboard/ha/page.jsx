"use client";

import { useCallback, useEffect, useState } from 'react';

export default function HighAvailabilityPage() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [names, setNames] = useState({});
  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/ha/status');
      if (!response.ok) throw new Error('Sign in as an administrator to view HA status.');
      setStatus(await response.json());
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => {
    const initial = setTimeout(refresh, 0), timer = setInterval(refresh, 5000);
    return () => { clearTimeout(initial); clearInterval(timer); };
  }, [refresh]);
  async function action(path, body) {
    setBusy(true); setError('');
    try {
      const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Operation failed');
      await refresh();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <main className="space-y-6 max-w-5xl">
    <h1 className="text-2xl font-semibold">High availability</h1>
    {error && <p role="alert" className="text-red-500">{error}</p>}
    {!status ? <p>Loading status…</p> : !status.enabled ? <section className="space-y-3">
      <p>Pair two independent 9Router installations to synchronize configuration and keep serving during a disconnection.</p>
      <p>Configure a private HA configuration file on each host and set <code>NINEROUTER_HA_CONFIG</code> to its path. See <code>docs/HA.md</code> for pairing and client failover setup.</p>
    </section> : <>
      <section className="rounded-xl border border-border p-5 space-y-2">
        <p><strong>Peer:</strong> {status.fenced ? 'Recovery required' : status.healthy ? 'Connected' : 'Disconnected — local service remains available'}</p>
        <p><strong>Node:</strong> <code>{status.nodeId}</code></p>
        <p><strong>Last synchronization:</strong> {status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : 'Not yet synchronized'}</p>
        <p><strong>Retained changes:</strong> {status.eventCount}</p>
        <button disabled={busy} onClick={() => action('/api/ha/status')} className="rounded border border-border px-4 py-2 disabled:opacity-50">Synchronize now</button>
      </section>
      <p>OAuth logins and local services belong to each node. Changes made while disconnected synchronize after reconnection. Revocations are not immediate on an unreachable peer.</p>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Conflicting edits</h2>
        {!status.conflicts?.length && !status.nameConflicts?.length && <p>No unresolved conflicts.</p>}
        {status.conflicts?.map(conflict => <fieldset key={`${conflict.entity}:${conflict.field}`} className="rounded border border-border p-4 space-y-2">
          <legend className="px-2">{conflict.entity} / {conflict.field}</legend>
          {conflict.field === 'access' && <p>The current policy permits only access allowed by every conflicting version. Choosing one version can broaden access.</p>}
          {conflict.versions.map(version => <div key={version.id} className="flex flex-wrap gap-3 items-center">
            <code className="break-all text-sm">{version.id}</code>
            <pre className="whitespace-pre-wrap break-all text-sm">{JSON.stringify(version.preview)}</pre>
            <button disabled={busy} className="rounded border border-border px-3 py-1 disabled:opacity-50" onClick={() => action('/api/ha/resolve', { entity: conflict.entity, field: conflict.field, version: version.id, expected: conflict.versions.map(v => v.id) })}>Use this version</button>
          </div>)}
        </fieldset>)}
        {status.nameConflicts?.map(conflict => <div key={conflict.entity} className="rounded border border-border p-4 space-y-2">
          <p>{conflict.entity}: {conflict.field === 'key' ? 'Duplicate key secret; rotate this key before enabling it.' : `Name “${conflict.name}” belongs to another record. This record is preserved but cannot route requests.`}</p>
          {conflict.entity.startsWith('combos:') && <div className="flex gap-2">
            <input aria-label={`New name for ${conflict.entity}`} className="rounded border border-border bg-transparent p-2" value={names[conflict.entity] || ''} onChange={e => setNames({ ...names, [conflict.entity]: e.target.value })} />
            <button disabled={busy || !names[conflict.entity]?.trim()} className="rounded border border-border px-3 disabled:opacity-50" onClick={() => action('/api/ha/resolve', { action: 'rename', entity: conflict.entity, expectedName: conflict.name, name: names[conflict.entity] })}>Rename</button>
          </div>}
        </div>)}
      </section>
    </>}
  </main>;
}
