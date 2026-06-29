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
import { runEval, type EvalQuery, type EvalEnvelope, type EvalResult } from './run-eval.ts';

interface CliArgs {
  target: string;
  oracle: string;
  queries: string;
  out: string;
  token?: string;
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
      case '-h':
      case '--help':
        printHelpAndExit(0);
    }
  }
  if (!a.target || !a.oracle || !a.queries || !a.out) {
    printHelpAndExit(2, 'missing required flag');
  }
  a.token = a.token || process.env.FINNY_EVAL_TOKEN;
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

function makeFetchEnvelope(
  target: string,
  token: string | undefined,
): (q: EvalQuery) => Promise<EvalEnvelope> {
  // Convention: bridge exposes each tool at `<target>/tools/<tool-name>`.
  // The eval CLI is a thin wrapper — adjust this route mapping when the bridge contract
  // moves. The unit tests inject a mock fetchEnvelope, so this code path is exercised
  // only at the live CLI.
  return async (q: EvalQuery): Promise<EvalEnvelope> => {
    const url = `${target.replace(/\/$/, '')}/tools/${encodeURIComponent(q.tool)}`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers['authorization'] = `Bearer ${token}`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ input: q.input }),
    });
    const body = await res.text();
    let env: EvalEnvelope;
    try {
      env = JSON.parse(body) as EvalEnvelope;
    } catch {
      // Non-JSON response → synthesize an error envelope so the runner sees a shape mismatch.
      env = { shape: 'transport_error', data: { http_status: res.status, body: body.slice(0, 500) } };
    }
    return env;
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const queries = loadQueries(args.queries);
  const oracle = loadOracle(args.oracle, queries as QueryWithOracleHint[]);
  const fetchEnvelope = makeFetchEnvelope(args.target, args.token);

  const results: EvalResult[] = await runEval({ queries, fetchEnvelope, oracle });
  writeFileSync(resolve(args.out), JSON.stringify(results, null, 2));

  const failed = results.filter((r) => r.status !== 'pass').length;
  console.log(
    `eval: ${results.length - failed}/${results.length} pass · ${failed} non-pass · written to ${args.out}`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
