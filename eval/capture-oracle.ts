#!/usr/bin/env -S node --experimental-strip-types
// Oracle capture helper. Replays every entry in `canonical-queries.json` against a target
// bridge URL and writes the response envelope to `<outDir>/<q.id>.json`. The operator
// (not the orchestrator) runs this against a freshly-refreshed staging instance with a
// staging token. The captured envelopes are then redacted in-place per the redaction
// policy (see `eval/README.md` and `eval/oracle/REDACTION-MAP.md` once Step 3 lands).
//
// HARD RULES enforced here:
//   1. Target defaults to staging. Prod hostnames are refused (exit 2).
//   2. Token, if present, is attached as Bearer; never logged.
//   3. Output files always overwrite — capture is the authoritative source — but each
//      overwrite is announced to stderr so the operator notices.
//
// Usage:
//   FINNY_EVAL_TOKEN=<staging-bearer> \
//   FINNY_EVAL_TARGET=https://finny.staging.11mirror.com/mcp \
//   node --experimental-strip-types eval/capture-oracle.ts eval/oracle/

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvalQuery, EvalEnvelope } from './run-eval.ts';
import { makeFetchEnvelope } from './transport.ts';

const DEFAULT_TARGET = 'https://finny.staging.11mirror.com/mcp';

function refuseProdTarget(target: string): void {
  // Belt-and-suspenders: the helper must NEVER touch prod, even if an operator exports
  // a stale FINNY_EVAL_TARGET. Refuse anything that doesn't look like staging or a local
  // dev URL. The check is hostname-based and conservative: explicit allow-list rather
  // than trying to enumerate every prod-shaped hostname.
  let host = '';
  try {
    host = new URL(target).hostname;
  } catch {
    console.error(`invalid FINNY_EVAL_TARGET (not a URL): ${target}`);
    process.exit(2);
  }
  const allowed =
    host === 'finny.staging.11mirror.com' ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host.endsWith('.tail.ts.net'); // tailnet hostnames for staging dashboard reach
  if (!allowed) {
    console.error(`refusing non-staging target hostname: ${host}`);
    console.error('capture-oracle is staging-only. Set FINNY_EVAL_TARGET to a staging URL.');
    process.exit(2);
  }
}

function loadQueries(): EvalQuery[] {
  // Resolve relative to this file, not cwd, so the helper works from anywhere.
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, 'canonical-queries.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`could not read canonical-queries.json at ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`canonical-queries.json is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`canonical-queries.json is not a JSON array`);
  }
  return parsed as EvalQuery[];
}

async function main(): Promise<void> {
  const target = process.env.FINNY_EVAL_TARGET ?? DEFAULT_TARGET;
  refuseProdTarget(target);

  const token = process.env.FINNY_EVAL_TOKEN;
  const outDir = resolve(process.argv[2] ?? 'eval/oracle');

  console.error(`capture-oracle: target=${target}`);
  console.error(`capture-oracle: token=${token ? 'present' : 'absent'}`);
  console.error(`capture-oracle: outDir=${outDir}`);

  mkdirSync(outDir, { recursive: true });

  const queries = loadQueries();
  console.error(`capture-oracle: ${queries.length} queries loaded`);

  const fetchEnvelope = makeFetchEnvelope(target, token);

  let okCount = 0;
  let transportErrorCount = 0;

  for (const q of queries) {
    let envelope: EvalEnvelope;
    try {
      envelope = await fetchEnvelope(q);
    } catch (err) {
      // fetch() itself rejected (DNS, network, abort). Synthesize a transport_error so
      // the operator sees a real file rather than a missing one.
      envelope = {
        shape: 'transport_error',
        data: { http_status: 0, body: `fetch threw: ${(err as Error).message}` },
      };
    }

    const outPath = join(outDir, `${q.id}.json`);
    const overwriting = existsSync(outPath);
    writeFileSync(outPath, JSON.stringify(envelope, null, 2));

    const shape = envelope.shape ?? 'unknown';
    if (shape === 'transport_error') {
      transportErrorCount++;
    } else {
      okCount++;
    }
    console.error(
      `captured ${q.id} (shape=${shape})${overwriting ? ' [overwrote existing]' : ''}`,
    );
  }

  console.error(
    `capture-oracle: done. ${okCount}/${queries.length} captured · ${transportErrorCount} transport_error`,
  );
  // Exit 0 even if some envelopes are transport_error — those are real envelopes the
  // operator may want to inspect. The script only exits non-zero if it crashes (1) or
  // the prod-URL guard trips (2, handled above).
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
