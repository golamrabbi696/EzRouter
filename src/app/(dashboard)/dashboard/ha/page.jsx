"use client";

import { useCallback, useEffect, useState } from 'react';

function PairingSetup({ enabled }) {
  const [values, setValues] = useState({ first: '', second: '', firstName: 'Node A', secondName: 'Node B' });
  const [command, setCommand] = useState('');
  const [error, setError] = useState('');
  function prepare(event) {
    event.preventDefault(); setError(''); setCommand('');
    try {
      for (const value of [values.first, values.second]) {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Enter a private HTTPS origin, for example https://10.0.0.10:20130.');
      }
      if (new URL(values.first).origin === new URL(values.second).origin) throw new Error('The two peer endpoints must be different.');
      const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
      setCommand(`node scripts/ha-setup.mjs --first ${quote(values.first)} --second ${quote(values.second)} --first-name ${quote(values.firstName)} --second-name ${quote(values.secondName)}`);
    } catch (e) { setError(e.message); }
  }
  return <details open={!enabled} className="rounded-xl border border-border p-5 space-y-4">
    <summary className="cursor-pointer font-semibold">{enabled ? 'Set up another pair' : 'Set up two peers'}</summary>
    <p>Use private IPs or VPN hostnames reachable from the other VM. This prepares a Bash command to run on a trusted machine with the 9Router source and dependencies installed.</p>
    <form onSubmit={prepare} className="grid gap-3 sm:grid-cols-2">
      {[['firstName', 'First node name', 'agents01'], ['secondName', 'Second node name', 'Azure VM1'], ['first', 'First node HTTPS address', 'https://10.0.0.10:20130'], ['second', 'Second node HTTPS address', 'https://10.0.0.20:20130']].map(([key, label, placeholder]) => <label key={key} className="space-y-1">
        <span className="block text-sm">{label}</span>
        <input required maxLength={key.endsWith('Name') ? 80 : 1024} type={key.endsWith('Name') ? 'text' : 'url'} className="w-full rounded border border-border bg-transparent p-2" placeholder={placeholder} value={values[key]} onChange={e => { setValues({ ...values, [key]: e.target.value }); setCommand(''); }} />
      </label>)}
      <button className="rounded border border-border px-4 py-2 sm:col-span-2">Prepare setup command</button>
    </form>
    {error && <p role="alert" className="text-red-500">{error}</p>}
    {command && <pre aria-label="Pairing setup command" className="whitespace-pre-wrap break-all rounded bg-black/10 p-3 text-sm">{command}</pre>}
    <ol className="list-decimal pl-5 space-y-2">
      <li>Run the command. It creates a new private folder with matching tokens and TLS certificates. Existing configurations are never overwritten.</li>
      <li>Securely copy <code>node-a/</code> to the first VM and <code>node-b/</code> to the second. Set <code>NINEROUTER_HA_CONFIG</code> to each host’s absolute <code>ha.json</code> path in its service environment.</li>
      <li>Check the local API port in each file, allow the peer listener through your private firewall, and restart both services. Verify the peer details and Connected status here.</li>
    </ol>
    <p className="text-sm text-text-muted">Back up the existing database and start a new peer with an empty data directory. Keep these files private. Certificates last one year. SSH tunnels, client failover and local provider bindings are documented in docs/HA.md.</p>
  </details>;
}

export default function HighAvailabilityPage() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [names, setNames] = useState({});
  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/ha/status');
      if (!response.ok) throw new Error('Sign in as an administrator to view HA status.');
      setStatus(await response.json()); setError('');
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
    </section> : <>
      <section className="rounded-xl border border-border p-5 space-y-2">
        <p><strong>Peer:</strong> {status.fenced ? 'Recovery required' : status.healthy ? 'Connected' : 'Disconnected — local service remains available'}</p>
        <p><strong>Node:</strong> <code>{status.nodeId}</code></p>
        <p><strong>Last synchronization:</strong> {status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : 'Not yet synchronized'}</p>
        <p><strong>Retained changes:</strong> {status.eventCount}</p>
        <p><strong>Last attempt:</strong> {status.lastAttemptAt ? new Date(status.lastAttemptAt).toLocaleString() : 'Not yet attempted'}</p>
        <p><strong>Synchronization round trip:</strong> {status.latencyMs == null ? 'Unavailable' : `${status.latencyMs} ms`}</p>
        {status.error && <p role="status" className="text-amber-600">{status.error}</p>}
        <button disabled={busy} onClick={() => action('/api/ha/status')} className="rounded border border-border px-4 py-2 disabled:opacity-50">Synchronize now</button>
      </section>
      <section aria-label="Peer details" className="grid gap-4 sm:grid-cols-2">
        {[['This node', status.local], ['Remote peer', status.peer]].map(([label, node]) => <article key={label} className="rounded-xl border border-border p-5 space-y-2 break-words">
          <h2 className="text-lg font-semibold">{label}: {node?.name || 'Not configured'}</h2>
          <p><strong>Hostname:</strong> {node?.hostname || 'Not yet reported'}</p>
          <p><strong>Node ID:</strong> <code className="break-all">{node?.nodeId || 'Not yet reported'}</code></p>
          <p><strong>Host IP addresses:</strong> {node?.addresses?.join(', ') || 'Not yet reported'}</p>
          {node?.url && <p><strong>Configured endpoint:</strong> <code>{node.url}</code></p>}
          {node?.listen && <p><strong>Listening on:</strong> <code>{node.listen.host}:{node.listen.port}</code></p>}
          {label === 'Remote peer' && <p><strong>Transport IP:</strong> {node?.transportAddress || 'Not yet connected'}</p>}
          {node && <p><strong>Transport:</strong> {node.tls ? label === 'Remote peer' ? status.healthy ? 'TLS verified' : 'TLS required; currently disconnected' : 'TLS enabled' : 'Loopback HTTP (test only)'}</p>}
        </article>)}
      </section>
      <p className="text-sm text-text-muted">Remote host details are from the last successful synchronization and may be stale while disconnected. With SSH tunnels, the transport IP can be loopback even when the peer runs on another VM.</p>
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
    {status && <PairingSetup enabled={status.enabled} />}
  </main>;
}
