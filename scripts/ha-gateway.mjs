import fs from 'node:fs';
import { createGateway } from '../src/lib/ha/gateway.js';

const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/ha-gateway.mjs /path/to/private-gateway.json');
const gateway = createGateway(JSON.parse(fs.readFileSync(file, 'utf8')));
await gateway.ready;
console.log(`9Router HA gateway listening on loopback port ${gateway.server.address().port}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await gateway.close(); process.exit(0); });
