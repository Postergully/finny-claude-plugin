import { taskStatusTool } from '../../dist/mcp/tools/taskStatus.js';
import { writeFileSync } from 'node:fs';

const [name, taskId] = [process.argv[2], process.argv[3]];

if (!name || !taskId) {
  console.error('usage: capture-task.mjs <name> <task_id>');
  process.exit(1);
}

const maxMs = Number(process.env.CAPTURE_TASK_MAX_MS ?? 300_000);
let env;
const start = Date.now();
while (Date.now() - start < maxMs) {
  env = await taskStatusTool.handler({ task_id: taskId });
  if (env.status !== 'running') break;
  await new Promise((r) => setTimeout(r, 3000));
}
const safe = { ...env, lolly_session_id: 'redacted', bridge_version: 'redacted' };
writeFileSync(`__tests__/fixtures/${name}.json`, JSON.stringify(safe, null, 2) + '\n');
console.log(`wrote fixtures/${name}.json (status=${env.status})`);
