#!/usr/bin/env -S node --experimental-strip-types
// CLI wrapper for the eval runner.
// Usage:
//   pnpm eval --target <url> --oracle <dir> --queries <path> --out <path> [--token <bearer>]
//
// Auth: pass --token, or set FINNY_EVAL_TOKEN. No automatic .env reading.
// fetchEnvelope: POSTs to <target>/<tool-route> with the query's `input` payload and parses
// the JSON response as an envelope. Tool-route mapping is a thin convention: tool name
// `finny_query` → `tools/call`-style route (see code below).

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
// NOTE: `.ts` extensions are intentional here. This file runs under
// `node --experimental-strip-types`, which expects the on-disk filename.
// The bridge's `.js` ESM convention (per root CLAUDE.md) applies to
// bundled output; the `eval/` directory is a separate strip-types runtime.
import { runEval, type EvalQuery, type EvalEnvelope, type EvalResult } from './run-eval.ts';
import { makeFetchEnvelope } from './transport.ts';

interface CliArgs {
  target: string;
  oracle: string;
  queries: string;
  out: string;
  token?: string;
  // Budget for non-pass results. Defaults to 0 (strict). Set to N>0 to tolerate
  // known-flake queries (e.g. q01 today, tracked in #40). The runner still
  // writes the full report; only the exit code is affected.
  allowDrift: number;
}

function parseArgs(argv: string[]): CliArgs {
  const a: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--target': a.target = v; i++; break;
      case '--oracle': a.oracle = v; i++; break;
      case '--queries': a.queries = v; i++; break;
      case '--out': a.out = v; i++; break;
      case '--token': a.token = v; i++; break;
      case '--allow-drift':
        a.allowDrift = Number.parseInt(v ?? '0', 10);
        if (!Number.isFinite(a.allowDrift) || a.allowDrift < 0) {
          printHelpAndExit(2, `--allow-drift must be a non-negative integer; got ${v}`);
        }
        i++;
        break;
      case '-h':
      case '--help':
        printHelpAndExit(0);
    }
  }
  if (!a.target || !a.oracle || !a.queries || !a.out) {
    printHelpAndExit(2, 'missing required flag');
  }
  a.token = a.token || process.env.FINNY_EVAL_TOKEN;
  if (a.allowDrift === undefined) a.allowDrift = 0;
  return a as CliArgs;
}

function printHelpAndExit(code: number, msg?: string): never {
  if (msg) console.error(`error: ${msg}`);
  console.error(
    [
      'usage: pnpm eval --target <url> --oracle <dir> --queries <path> --out <path> [--token <bearer>]',
      '',
      'flags:',
      '  --target   Bridge MCP base URL (e.g. https://finny.staging.11mirror.com/mcp)',
      '  --oracle   Directory containing per-query oracle JSON files',
      '  --queries  Path to canonical-queries.json',
      '  --out      Path to write the run report (JSON array)',
      '  --token    Bearer token (or set FINNY_EVAL_TOKEN env var). Optional.',
      '  --allow-drift N   Allow up to N drift verdicts before exit 1. Defaults to 0.',
      '                    Hard fails (no oracle, shape mismatch) always trip exit 1.',
    ].join('\n'),
  );
  process.exit(code);
}

function loadQueries(path: string): EvalQuery[] {
  const raw = JSON.parse(readFileSync(resolve(path), 'utf8'));
  if (!Array.isArray(raw)) throw new Error(`queries file is not an array: ${path}`);
  return raw as EvalQuery[];
}

interface QueryWithOracleHint extends EvalQuery {
  prod_oracle_path?: string;
}

function loadOracle(dir: string, queries: QueryWithOracleHint[]): Record<string, EvalEnvelope> {
  const oracleDir = resolve(dir);
  const out: Record<string, EvalEnvelope> = {};
  if (!existsSync(oracleDir)) return out; // empty → all queries fail with "no oracle"

  // Build a basename → full path map of files actually present, for fallback lookups.
  const present = new Map<string, string>();
  for (const f of readdirSync(oracleDir)) {
    if (f.endsWith('.json')) present.set(f, join(oracleDir, f));
  }

  for (const q of queries) {
    // 1. Try the query's own prod_oracle_path (basename only — we don't trust the full path).
    if (q.prod_oracle_path) {
      const want = basename(q.prod_oracle_path);
      const hit = present.get(want);
      if (hit) {
        out[q.id] = JSON.parse(readFileSync(hit, 'utf8'));
        continue;
      }
    }
    // 2. Fallback: <oracle-dir>/<id>.json
    const direct = join(oracleDir, `${q.id}.json`);
    if (existsSync(direct)) {
      out[q.id] = JSON.parse(readFileSync(direct, 'utf8'));
    }
    // else: leave unset → runner emits status:'fail' with diff:'no oracle'.
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const queries = loadQueries(args.queries);
  const oracle = loadOracle(args.oracle, queries as QueryWithOracleHint[]);
  const fetchEnvelope = makeFetchEnvelope(args.target, args.token);

  const results: EvalResult[] = await runEval({ queries, fetchEnvelope, oracle });
  writeFileSync(resolve(args.out), JSON.stringify(results, null, 2));

  const failed = results.filter((r) => r.status !== 'pass').length;
  const drifts = results.filter((r) => r.status === 'drift').length;
  const hardFails = results.filter((r) => r.status === 'fail').length;
  console.log(
    `eval: ${results.length - failed}/${results.length} pass · ${failed} non-pass (${drifts} drift, ${hardFails} fail) · written to ${args.out}`,
  );
  // Hard fails (no-oracle, shape mismatch) always trip the gate. Drifts are
  // allowed up to args.allowDrift to tolerate known-flake queries.
  if (hardFails > 0 || drifts > args.allowDrift) {
    if (args.allowDrift > 0) {
      console.log(`eval: budget --allow-drift ${args.allowDrift} exceeded by ${drifts - args.allowDrift}`);
    }
    process.exit(1);
  }
  if (drifts > 0) {
    console.log(`eval: ${drifts} drift within budget --allow-drift ${args.allowDrift}; exit 0`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
