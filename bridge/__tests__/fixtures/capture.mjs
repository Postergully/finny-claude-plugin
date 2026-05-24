import { queryTool } from '../../dist/mcp/tools/query.js';
import { writeFileSync } from 'node:fs';

const name = process.argv[2];
const spec = JSON.parse(process.argv[3]);

if (!process.env.LOLLY_GATEWAY_TOKEN) {
  console.error('LOLLY_GATEWAY_TOKEN not set');
  process.exit(1);
}

const env = await queryTool.handler(spec);
const safe = { ...env, lolly_session_id: 'redacted', bridge_version: 'redacted' };
writeFileSync(`__tests__/fixtures/${name}.json`, JSON.stringify(safe, null, 2) + '\n');
console.log(`wrote fixtures/${name}.json (status=${env.status})`);
