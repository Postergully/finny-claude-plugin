#!/usr/bin/env node
// Summarize a window of gateway log JSONL records.
// Usage:
//   node scripts/analyze-gateway-log.mjs < path/to/log.jsonl
//   journalctl -u finny-mcp -o cat | node scripts/analyze-gateway-log.mjs
//
// Reports: total queries, total gateway calls, avg calls per query,
// p50/p95 latency per phase, session-creation rate, correction-retry rate.

import { createInterface } from 'node:readline';

const calls = [];
const aggregates = [];

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    continue;
  }
  if (rec.kind === 'gateway_call') calls.push(rec);
  else if (rec.kind === 'gateway_query_aggregate') aggregates.push(rec);
}

function pct(arr, p) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
}

const totalCalls = calls.length;
const totalQueries = aggregates.length;
const callLatencies = calls.map((c) => c.response?.latency_ms ?? 0);
const sessionCreations = calls.filter((c) => c.diagnostics?.session_created).length;
const correctionRetries = calls.filter((c) => c.diagnostics?.correction_retry).length;

const phaseLatencies = { initial: [], correction: [], progress_loop: [] };
for (const agg of aggregates) {
  for (const [phase, stats] of Object.entries(agg.aggregate.phases)) {
    if (stats.calls > 0) phaseLatencies[phase].push(stats.latency_ms);
  }
}

const callsPerQuery = aggregates.map((a) => a.aggregate.total_calls);

console.log('=== Gateway log summary ===');
console.log(`Total gateway calls:    ${totalCalls}`);
console.log(`Total queries:          ${totalQueries}`);
console.log(
  `Avg calls per query:    ${totalQueries ? (totalCalls / totalQueries).toFixed(2) : 'n/a'}`
);
console.log(`Session creations:      ${sessionCreations}`);
console.log(
  `Session-creation rate:  ${totalQueries ? ((sessionCreations / totalQueries) * 100).toFixed(1) : 'n/a'}% of queries`
);
console.log(
  `Correction retries:     ${correctionRetries} (${
    totalCalls ? ((correctionRetries / totalCalls) * 100).toFixed(1) : 'n/a'
  }% of calls)`
);
console.log('');
console.log('Latency p50 / p95 (ms):');
console.log(`  per call:           ${pct(callLatencies, 0.5)} / ${pct(callLatencies, 0.95)}`);
console.log(
  `  initial phase:      ${pct(phaseLatencies.initial, 0.5)} / ${pct(phaseLatencies.initial, 0.95)}`
);
console.log(
  `  correction phase:   ${pct(phaseLatencies.correction, 0.5)} / ${pct(phaseLatencies.correction, 0.95)}`
);
console.log(
  `  progress_loop:      ${pct(phaseLatencies.progress_loop, 0.5)} / ${pct(phaseLatencies.progress_loop, 0.95)}`
);
console.log('');
console.log(
  `p50 / p95 calls per query: ${pct(callsPerQuery, 0.5)} / ${pct(callsPerQuery, 0.95)}`
);
