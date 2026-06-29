# `eval/` — Finny canonical eval set

The eval set is the parity gate between staging and prod, and (Phase 8) between two tenants on staging. Each entry is a single MCP tool call with an expected envelope shape and a path to the captured prod oracle envelope. The runner (`run-eval.ts`, Task 0.2) replays every entry against a target bridge URL and diffs the live envelope against the oracle (Task 0.3).

This task (0.1) ships **only** `canonical-queries.json` and this README. The runner and oracle envelopes are later tasks.

## Schema (per entry in `canonical-queries.json`)

| field | type | required | meaning |
|---|---|---|---|
| `id` | string | yes | Stable slug. Drives the oracle filename and the runner's report key. Pattern: `q\d{2}-<kebab-summary>`. |
| `tool` | string | yes | One of: `finny_query`, `finny_report`, `finny_continue`, `finny_remember`, `finny_task_status`. The 5 user-facing MCP tools the bridge exposes (see `bridge/src/mcp/tools/`). |
| `intent` | string | yes | One-sentence English description of what this query exercises. Read by humans and by the verifier; not consumed by the runner. |
| `input` | object | yes | The literal arguments passed to the MCP tool. Must conform to that tool's Zod input schema. **Identity (user_id, tenant_id, bank_id) is NEVER in input** — the bridge derives it from the verified JWT. |
| `scope` | object | yes | Subset of `input` capturing the business scope. For most query/report entries this mirrors `input.scope` or `input.params`; for tools without a scope concept (e.g. `finny_remember`) it captures the meaningful filter dimensions. Used by run-report tooling to group queries. |
| `expected_envelope_shape` | enum | yes | `ok` \| `needs_input` \| `error`. Top-level envelope shape the live bridge MUST return. The runner fails fast on shape mismatch before doing field-level diffing. |
| `expected_required_vars` | string[] | only when shape is `needs_input` | The variables the bridge must list as required. Only populated for `needs_input` entries (currently q01). |
| `prod_oracle_path` | string | yes | Repo-relative path the runner reads to get the oracle envelope. Must equal `eval/oracle/<id>.json`. Task 0.3 creates these files. |
| `notes` | string | optional | Free-form context for the verifier and future readers (e.g. why this is the error path, how a placeholder gets resolved at oracle-capture time). |

## How the runner consumes this file (Task 0.2)

1. Reads `canonical-queries.json` and, for each entry, reads the file at `prod_oracle_path`.
2. POSTs `input` to the target bridge URL as the named `tool` (with sealed identity supplied by the runner's bearer token, never injected into `input`).
3. Compares the live envelope against the oracle:
   - `ok` if shape matches and field-level diff is empty.
   - `drift` if shape matches but content differs (semantic drift — investigate).
   - `fail` if shape mismatches or oracle file is missing.
4. Emits `{ id, status, diff }[]` to the path passed via `--out`.

CLI surface (Task 0.2, implemented in `eval/cli.ts`):

```bash
pnpm eval \
  --target https://finny.staging.11mirror.com/mcp \
  --oracle eval/oracle \
  --queries eval/canonical-queries.json \
  --out eval/runs/<date>-<env>.json \
  [--token <bearer>]
```

Flags:

| flag | required | meaning |
|---|---|---|
| `--target` | yes | Bridge MCP base URL. The CLI POSTs each query's `input` to `<target>/tools/<tool-name>` and parses the JSON response as an envelope. |
| `--oracle` | yes | Directory containing per-query oracle JSON files (one per `id`). The CLI prefers each query's `prod_oracle_path` (basename) and falls back to `<oracle-dir>/<id>.json`. Missing oracle → runner emits `status: 'fail'`, never silent skip. |
| `--queries` | yes | Path to `canonical-queries.json` (or any compatible array). |
| `--out` | yes | Path to write the run report (JSON array of `{ id, status, diff }`). |
| `--token` | no | Bearer token for `Authorization: Bearer <token>`. If omitted, falls back to env var `FINNY_EVAL_TOKEN`. The CLI never reads `.env` files automatically and never prints the token. |

Test the runner itself (no live bridge needed): `pnpm test:eval` (mocks `fetchEnvelope`).

## How oracle envelopes map (Task 0.3)

Each entry's `prod_oracle_path` points to the file the runner reads as the source of truth. Task 0.3 captures these by replaying each query against prod with read-only OAuth, then redacting the captured envelope:

- Real vendor names → `<vendor-1>`, `<vendor-2>`, …
- Real account numbers → `<acct-N>`
- Dollar amounts → preserve order of magnitude only (e.g. `$$$$` for thousands, `$$$$$` for millions); **do not record the exact figure**.
- Live tokens / API keys / session IDs → strip entirely or replace with `<token-redacted>`.
- Cursor tokens → `cursor:opaque-token-1`, `cursor:opaque-token-2`, …
- Task IDs → `task:opaque-id-1`, …
- Conversation IDs → `conv:opaque-id-1`, …

The envelope **shape** must be preserved verbatim (top-level keys, nested structure, types). Only the **values** are redacted.

### Coverage map

| dimension | entries |
|---|---|
| `finny_query` | q01, q02, q03, q04, q20 |
| `finny_report` | q05, q06, q07, q08, q09, q10, q11, q12 (one per enum + 2 error variants) |
| `finny_continue` | q13 (cursor), q14 (conversation), q15 (invalid cursor) |
| `finny_remember` | q16 (cowork), q17 (manual) |
| `finny_task_status` | q18 (known), q19 (unknown) |
| Report enums | `vendor_balance` q05, `open_bills` q06, `bill_detail` q07, `vendor_summary` q08, `gstin_lookup` q09, `po_status` q10 |
| `phase: discover` | q01 |
| `phase: execute` | q02, q04, q20 |
| `expected_envelope_shape: needs_input` | q01 |
| `expected_envelope_shape: ok` | q02, q03, q05, q06, q07, q08, q09, q10, q13, q14, q16, q17, q18, q20 |
| `expected_envelope_shape: error` | q04, q11, q12, q15, q19 |
| `env: sandbox` | q03, q10 |
| `env: production` | q01, q02, q04, q05, q06, q07, q08, q09, q11, q12, q20 |
| Pagination cursor flow | q20 issues a cursor; q13 drains it; q15 attacks an invalid one |
| `needs_input` round-trip | q01 emits; q14 demonstrates `finny_continue`'s response branch |

## Redaction policy (HARD RULE)

No real PII or live tokens may live in `eval/`. Specifically:

- No real vendor names. Use `<vendor-N>` placeholders.
- No real account / GL / GSTIN numbers. Use `<acct-N>`, `<gstin-placeholder>`, etc.
- No dollar figures beyond order of magnitude.
- No live OAuth tokens, API keys, JWT bodies, or session IDs.
- No `user_id`, `tenant_id`, or `bank_id` in **any** entry's `input`. These are sealed at the bridge from the verified JWT and the LLM never sees them.

The verifier will grep for these placeholder tokens (`<vendor-`, `<acct-`, `cursor:opaque-`, `task:opaque-`, `conv:opaque-`) to confirm redaction discipline. If you need a real value at runtime (e.g. a real cursor for q13), capture it during Task 0.3's oracle replay, then redact it in both the oracle file and this query file before commit.

## Capturing oracle envelopes (Task 1.2)

Phase 1 captures oracle envelopes from a freshly-refreshed staging instance, NOT from prod. The orchestrator does not run capture; the operator does, locally, with a staging bearer token that never enters the agent transcript.

The helper: `eval/capture-oracle.ts`. It uses the same transport as the runner (`eval/transport.ts`) and writes one envelope per query to `<outDir>/<q.id>.json`.

### Required env vars

| var | required | meaning |
|---|---|---|
| `FINNY_EVAL_TARGET` | no | Bridge MCP base URL. Defaults to `https://finny.staging.11mirror.com/mcp`. The helper hard-refuses any hostname outside an explicit allow-list (staging, localhost, tailnet) — there is no flag to override. |
| `FINNY_EVAL_TOKEN` | no | Bearer token attached as `Authorization: Bearer <token>`. Optional (some queries may succeed unauthenticated against staging). The helper logs only `token: present` / `token: absent` — never the value. |

### How to invoke

```bash
FINNY_EVAL_TOKEN=<staging-bearer> \
  node --experimental-strip-types eval/capture-oracle.ts eval/oracle/
```

Output dir defaults to `eval/oracle/` if omitted. Existing files are overwritten (capture is the authoritative source); each overwrite is announced on stderr so the operator notices.

The helper exit codes:
- `0` — every query produced a file (including `transport_error` envelopes — those are real responses worth preserving).
- `1` — the script itself crashed.
- `2` — the prod-URL guard tripped.

### After capture: redact

Captured envelopes contain real PII (vendor names, account numbers, dollar amounts, opaque tokens). Before commit, redact each file per the policy in the previous section, recording the original→placeholder mapping in `eval/oracle/REDACTION-MAP.md`. The map itself is gitignored — it lives only on the operator's machine — but its existence and shape are tracked in Task 1.2 Step 3.

## Adding a new query (3-line recipe)

1. Append a new entry to `canonical-queries.json` with the schema above. Use the next free `q\d{2}-…` slug.
2. Capture the oracle envelope by replaying the entry against prod read-only, redact per the policy above, and save to `eval/oracle/<id>.json`.
3. Run `pnpm eval --target <staging-url> --oracle eval/oracle --queries eval/canonical-queries.json` and confirm the new entry comes back `pass`.

## CI integration

The eval runs in CI via `.github/workflows/eval-staging.yml`:

- **Schedule:** nightly at `06:00 UTC` (cron `0 6 * * *`).
- **Path-triggered on PRs** when any of these change: `bridge/**`, `plugin/**`, `eval/**`, or the workflow file itself.
- **Manual trigger:** the workflow exposes `workflow_dispatch`, so an operator can fire a run from the Actions tab without waiting for cron or a PR.

### Required secrets

| secret | required | purpose |
|---|---|---|
| `STAGING_MCP_URL` | yes | Base URL of the staging bridge (e.g. `https://finny.staging.11mirror.com/mcp`). The workflow's first step exits non-zero with a clear error if this is unset. |
| `STAGING_EVAL_TOKEN` | no | Bearer token for staging if it requires auth. Forwarded to the runner as `FINNY_EVAL_TOKEN`. If unset the eval runs unauthenticated. |

Add both under **Repo Settings → Secrets and variables → Actions**.

We deliberately use `pull_request` (not `pull_request_target`) so secrets are not exposed to forked-repo PRs.

### Hard-fail on missing oracle (intentional)

Until Task 1.2 Steps 2–5 land oracle envelopes under `eval/oracle/`, every run will fail with `diff: 'no oracle'` for each query. That is the desired signal: do **not** mark this workflow as a required status check on PRs until oracle capture has been completed and committed.

### Manual trigger

```text
GitHub UI → Actions → "Eval (staging)" → Run workflow → pick branch → Run workflow
```

The job uploads `eval-result.json` as an artifact (`eval-result`, 14-day retention) on every run, including failures, so the report is available for debugging.
