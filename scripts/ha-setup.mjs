import fs from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import selfsigned from 'selfsigned';

function endpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use an HTTPS origin such as https://10.0.0.10:20130');
  }
  return url;
}

export async function createPair({ first, second, output, firstName = 'Node A', secondName = 'Node B', apiPort = 20128 }) {
  const urls = [endpoint(first), endpoint(second)], names = [firstName, secondName];
  if (urls[0].origin === urls[1].origin) throw new Error('Peer endpoints must be different');
  if (names.some(n => typeof n !== 'string' || !n.trim() || n.length > 80 || /[\x00-\x1f\x7f]/.test(n))) throw new Error('Node names must contain 1–80 printable characters');
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) throw new Error('Invalid local API port');
  const root = path.resolve(output);
  fs.mkdirSync(root, { mode: 0o700 }); // Exclusive: never overwrite an existing pairing.
  if (process.platform === 'win32') {
    const sid = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).match(/S-1-[\d-]+/)?.[0];
    if (!sid) throw new Error('Cannot determine Windows user SID');
    execFileSync('icacls', [root, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { stdio: 'pipe' });
  }
  const tokens = urls.map(() => randomBytes(32).toString('hex'));
  const certs = await Promise.all(urls.map(url => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return selfsigned.generate([{ name: 'commonName', value: host }], { algorithm: 'sha256', keySize: 2048,
      notAfterDate: new Date(Date.now() + 365 * 86400000), extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [isIP(host) ? { type: 7, ip: host } : { type: 2, value: host }] },
      ] });
  }));
  for (const [i, url] of urls.entries()) {
    const dir = path.join(root, i === 0 ? 'node-a' : 'node-b'); fs.mkdirSync(dir, { mode: 0o700 });
    const config = { name: names[i], token: tokens[i],
      listen: { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 443), keyFile: 'node.key', certFile: 'node.crt' },
      peer: { name: names[1 - i], url: urls[1 - i].origin, token: tokens[1 - i], caFile: 'peer.crt' },
      localApiUrl: `http://127.0.0.1:${apiPort}`, intervalMs: 3000, bindings: {} };
    for (const [name, content] of Object.entries({ 'ha.json': JSON.stringify(config, null, 2) + '\n', 'node.key': certs[i].private, 'node.crt': certs[i].cert, 'peer.crt': certs[1 - i].cert })) {
      fs.writeFileSync(path.join(dir, name), content, { mode: 0o600, flag: 'wx' });
    }
  }
  fs.writeFileSync(path.join(root, 'README.txt'), [
    '1. Securely copy node-a/ to the first host and node-b/ to the second host. Keep each folder private.',
    '2. Set NINEROUTER_HA_CONFIG to the absolute path of that host\'s ha.json in its 9Router service.',
    `3. Check localApiUrl matches the local 9Router API port (generated: ${apiPort}). Allow each HA listener only from its peer over your private network/VPN.`,
    '4. Restart both 9Router services. Open Dashboard > High Availability and verify both peer identities and Connected status.',
    '5. Certificates expire after one year. Replace certificates/trust before expiry; do not rerun setup over existing files.',
    'Use docs/HA.md for backups, OAuth/local provider bindings, client failover and SSH tunnel configurations.',
    '',
  ].join('\n'), { mode: 0o600, flag: 'wx' });
  return root;
}

async function main() {
  const { values } = parseArgs({ options: {
    first: { type: 'string' }, second: { type: 'string' }, out: { type: 'string', default: './9router-ha-pair' },
    'first-name': { type: 'string', default: 'Node A' }, 'second-name': { type: 'string', default: 'Node B' },
    'api-port': { type: 'string', default: '20128' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/ha-setup.mjs --first https://FIRST_PRIVATE_HOST:20130 --second https://SECOND_PRIVATE_HOST:20130 [--out NEW_DIRECTORY] [--first-name NAME] [--second-name NAME] [--api-port 20128]\nOmit --first and --second for interactive prompts. Generates private TLS certificates and matching tokens. Never overwrites an existing directory.');
    return;
  }
  let first = values.first, second = values.second;
  if (!first || !second) {
    if (!process.stdin.isTTY) throw new Error('Provide --first and --second, or run interactively');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      first ||= (await rl.question('First node private HTTPS origin (https://HOST:20130): ')).trim();
      second ||= (await rl.question('Second node private HTTPS origin (https://HOST:20130): ')).trim();
    } finally { rl.close(); }
  }
  const root = await createPair({ first, second, output: values.out, firstName: values['first-name'], secondName: values['second-name'], apiPort: Number(values['api-port']) });
  console.log(`Pairing created in ${root}\nCopy node-a/ and node-b/ securely to their hosts. Follow README.txt. Tokens and private keys were not printed.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`HA setup failed: ${error.code || error.message}`); process.exitCode = 1; });
}
