# Two-node high availability

HA is opt-in. Each node keeps its own SQLite database, serves requests and accepts
configuration edits while disconnected. A private authenticated peer listener
exchanges a durable configuration journal. The dashboard's **High Availability**
page shows connectivity and conflicting edits. Usage and request logs stay local.

## Pair two installations

Use the same 9Router build on both hosts. Back up the existing database using a
consistent SQLite backup. Start the second installation with an empty data
directory; never copy a live SQLite/WAL file or overwrite the original database.
Install a TLS certificate on each peer listener with a SAN matching its private
hostname/IP. Use a private CA or explicitly trust the peer certificate. Keep the
listener behind a VPN/firewall. TLS verification is mandatory outside loopback.

Generate independent incoming tokens on each host:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Create a private `ha.json` (mode 0600 on Unix):

```json
{
  "token": "THIS_NODE_INCOMING_TOKEN",
  "listen": {
    "host": "PRIVATE_BIND_ADDRESS",
    "port": 20130,
    "keyFile": "/private/node.key",
    "certFile": "/private/node.crt"
  },
  "peer": {
    "url": "https://PEER_PRIVATE_HOST:20130",
    "token": "PEER_INCOMING_TOKEN",
    "caFile": "/private/peer-ca.crt"
  },
  "localApiUrl": "http://127.0.0.1:20128",
  "intervalMs": 3000,
  "bindings": {}
}
```

Set `NINEROUTER_HA_CONFIG` to its absolute path in each service environment.
The normal database initialization starts the peer listener. `/api/health` checks
database readiness when HA is enabled. A listener configuration failure prevents
HA startup, rather than silently falling back to an unsynchronized instance.
`allowLoopbackHttp: true` is available only for isolated loopback tests.

Portable records present at first startup become the initial journal. Starting
from an empty peer and synchronizing imports them without wiping either node.
Both existing populated nodes can be paired, but independently created records
retain distinct IDs and may require administrator conflict resolution.

## Credentials and node bindings

Static API credentials, client keys/access restrictions, combos, model aliases,
custom models, pricing and declared routing settings synchronize. Dashboard
passwords/sessions, machine IDs, health/cooldowns, network settings and OAuth
tokens do not. Each node needs its own OAuth login, using the same account only
where the provider supports independent sessions. Sharing a subscription does
not double its rate limits.

Loopback endpoints belong to their host. A replicated local provider stays
unavailable until its local endpoint and credential are bound. For example:

```json
{
  "bindings": {
    "providerNodes:PROVIDER_NODE_ID": { "baseUrl": "http://127.0.0.1:20129/v1" },
    "providerConnections:CONNECTION_ID": { "apiKey": "THIS_HOST_PROVIDER_KEY" }
  }
}
```

Keep binding credentials in the private configuration file and restart to apply
them. Independently log in to any browser-backed service; do not copy live browser
profiles or rotating tokens. Unknown provider-specific fields are not replicated
automatically. Verify every required provider on each node before declaring it
independently available.

When the selected model has no usable local account before dispatch, 9Router may
forward that selected member to its peer. The receiver authenticates the original
client key and verifies the selected member against the original authorized
model/combo. Forwarded calls cannot loop. After a possibly accepted peer request,
the combo engine must not retry it on another model.

## Client failover

Two server URLs do not automatically make an existing client resilient. Run the
gateway on the client machine, independently of both server VMs:

```sh
node scripts/ha-gateway.mjs /private/gateway.json
```

```json
{
  "host": "127.0.0.1",
  "port": 20127,
  "origins": [
    { "name": "primary", "url": "https://PRIMARY_API_HOST", "caFile": "/private/api-ca.crt" },
    { "name": "secondary", "url": "https://SECONDARY_API_HOST", "caFile": "/private/api-ca.crt" }
  ]
}
```

Point Pi/other clients at `http://127.0.0.1:20127/v1`, retaining their existing API
key. SSH tunnels to loopback HTTP origins are also supported. Never expose the
client gateway on a public interface. It forwards inference paths only, preserves
authorization, tools and effort, and streams responses with backpressure.
`GET /health` reports origin readiness; responses identify the selected origin in
`x-9router-ha-origin`. Default routing prefers the first ready origin; optional
`strategy: "round-robin"` balances new requests between ready origins.

Readiness probes run every two seconds with one-second timeouts. Recovery needs
two successful probes. Only pre-connection failures can move an existing request
to another origin. Accepted requests, upstream errors and interrupted streams are
not replayed. A subsequent fresh request can use the alternate origin.
Client libraries can have their own retry policies; disable automatic retries
when an operation's outcome is unknown. The gateway cannot prevent a caller from
submitting the same request again.

On Linux supervise the gateway with a systemd service using `Restart=always`.
On Windows use Task Scheduler at user logon, restart-on-failure, and a periodic
watchdog that starts the task only if absent. Keep paths quoted and configuration
permissions private. A client on a failed VM cannot survive that VM's outage.

## Conflicts and security

Unrelated settings fields merge. Concurrent same-field edits preserve both
versions and select the same visible winner on both nodes, independent of clock
time and delivery order. The administrator can choose a version on the HA page.
Credential values are redacted. Provider endpoint/key disagreements disable the
affected binding rather than sending a key to an unintended destination.

Concurrent restrictions allow only requests permitted by every policy, including
resolved aliases. Revocation/disable wins over concurrent enable. Resolving a
policy can broaden access and requires an explicit administrator selection.
Duplicate combo names preserve both records but route only the smallest entity
UUID; rename the other record in the HA page. Duplicate client-key secrets are
denied. Deletion tombstones prevent stale edits from resurrecting entities.

An offline node cannot know about new revocations or enforce a global quota.
Revocation becomes effective there after synchronization. Peers are trusted to
hold all replicated API credentials: restrict pairing, protect their files and
backups, and rotate both pairing and provider/client credentials after compromise.
Do not put HA credentials in browser storage or public reverse-proxy headers.

## Recovery and rollback

Cold-start 9Router after a disk snapshot restore. Every startup creates a new
writer incarnation, preventing sequence reuse. Existing history and new offline
edits reconcile when the peer returns. Live-memory cloning of a running writer
is unsupported; stop it before restoring. Give a new VM clone a new pairing
identity before joining it as another node. Conflicting event IDs fence sync.

The journal stores a portable-state checkpoint with its causal frontier. On
startup, changes made by an older binary are compared against that checkpoint
and journaled before peer synchronization. A missing checkpoint on a nonempty
journal requires recovery review; do not delete metadata to bypass it. Preserve
the entire HA journal/checkpoint during rollback. Never restore an old database
over newer acknowledged writes.

Disable `NINEROUTER_HA_CONFIG` and restart to stop HA; normal local routing remains
available. Keep the HA tables for a later rejoin. Schema changes are additive.
Journal history is retained in this release: monitor its size, and rebootstrap
under administrator control instead of deleting events or tombstones manually.
Native SQLite uses FULL synchronous mode under HA; sql.js flushes its atomic
replacement file before acknowledging a configuration commit.

## Required acceptance

Before migrating production clients, use a dedicated test key/combo and prove:

1. Both nodes serve coding requests with tools and the requested effort.
2. Disconnect peers, edit different fields and the same field on both, then
   reconnect: independent changes merge and conflicts remain visible.
3. Revoke a key and delete a combo while disconnected; reconnect and verify no
   resurrection or accidental permission expansion.
4. Make the preferred origin unreachable to a surviving Pi client. A fresh
   request through the unchanged gateway URL must succeed on the second node.
5. Interrupt an active stream and confirm no duplicate upstream execution;
   restore connectivity and verify preferred-origin recovery.

Do not claim end-to-end HA from unit tests alone. Record the serving node,
timestamps and outcomes without recording secrets or prompts in public reports.
