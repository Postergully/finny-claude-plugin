#!/usr/bin/env node
// Live watch over a streaming gateway log (stdin or `tail -F`-style).
// Renders a continuously-updated dashboard to the terminal:
//   - calls/min, avg calls/query (last 5 min)
//   - p50/p95 latency per phase (last 5 min)
//   - active session count (last 5 min)
//   - session-creation rate
//   - correction-retry rate
//
// Usage:
//   journalctl -u finny-mcp -o cat -f | node scripts/bridge-watch.mjs
//   tail -F /var/log/finny/gateway.jsonl | node scripts/bridge-watch.mjs

import { createInterface } from 'node:readline';

const WINDOW_MS = 5 * 60 * 1000;
const REFRESH_MS = 1000;

const calls = [];
const aggregates = [];

function pct(arr, p) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
}

function pruneOlderThan(arr, cutoff) {
  while (arr.length > 0 && new Date(arr[0].ts).getTime() < cutoff) arr.shift();
}

function render() {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  pruneOlderThan(calls, cutoff);
  pruneOlderThan(aggregates, cutoff);

  const callsPerMin = (calls.length / (WINDOW_MS / 60_000)).toFixed(1);
  const callLatencies = calls.map((c) => c.response?.latency_ms ?? 0);
  const sessionCreations = calls.filter((c) => c.diagnostics?.session_created).length;
  const correctionRetries = calls.filter((c) => c.diagnostics?.correction_retry).length;
  const sessions = new Set(
    calls.map((c) => c.diagnostics?.session_id).filter(Boolean)
  );

  const phaseLatencies = { initial: [], correction: [], progress_loop: [] };
  for (const agg of aggregates) {
    for (const [phase, stats] of Object.entries(agg.aggregate.phases)) {
      if (stats.calls > 0) phaseLatencies[phase].push(stats.latency_ms);
    }
  }

  const callsPerQuery = aggregates.map((a) => a.aggregate.total_calls);

  process.stdout.write('\x1b[2J\x1b[0;0H');
  console.log(`bridge-watch — last ${WINDOW_MS / 60_000}m window — ${new Date().toISOString()}`);
  console.log('');
  console.log(`Calls/min:              ${callsPerMin}`);
  console.log(`Queries (window):       ${aggregates.length}`);
  console.log(
    `Avg calls/query:        ${aggregates.length ? (calls.length / aggregates.length).toFixed(2) : 'n/a'}`
  );
  console.log(`Active sessions:        ${sessions.size}`);
  console.log(
    `Session creations:      ${sessionCreations}${
      aggregates.length ? ` (${((sessionCreations / aggregates.length) * 100).toFixed(1)}% of queries)` : ''
    }`
  );
  console.log(
    `Correction retries:     ${correctionRetries}${
      calls.length ? ` (${((correctionRetries / calls.length) * 100).toFixed(1)}% of calls)` : ''
    }`
  );
  console.log('');
  console.log('Latency p50 / p95 (ms):');
  console.log(`  per call:             ${pct(callLatencies, 0.5)} / ${pct(callLatencies, 0.95)}`);
  console.log(
    `  initial:              ${pct(phaseLatencies.initial, 0.5)} / ${pct(phaseLatencies.initial, 0.95)}`
  );
  console.log(
    `  correction:           ${pct(phaseLatencies.correction, 0.5)} / ${pct(phaseLatencies.correction, 0.95)}`
  );
  console.log(
    `  progress_loop:        ${pct(phaseLatencies.progress_loop, 0.5)} / ${pct(phaseLatencies.progress_loop, 0.95)}`
  );
  console.log('');
  console.log(
    `p50 / p95 calls/query:   ${pct(callsPerQuery, 0.5)} / ${pct(callsPerQuery, 0.95)}`
  );
  console.log('');
  console.log('Ctrl-C to exit.');
}

setInterval(render, REFRESH_MS);

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return;
  }
  if (rec.kind === 'gateway_call') calls.push(rec);
  else if (rec.kind === 'gateway_query_aggregate') aggregates.push(rec);
});

render();
