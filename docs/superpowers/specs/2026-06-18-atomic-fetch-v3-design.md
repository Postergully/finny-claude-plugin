# atomic_fetch v3 — single-call parallel-fan-out search-as-code

**Date:** 2026-06-18
**Branch:** `feat/atomic-fetch-v3-spec` (this repo, doc-only). Implementation will continue on `feat/atomic-fetch-phase-2` in `finny-hermes-config` (the existing branch is reused; v3 commits flip the design).
**Supersedes:** `2026-06-17-atomic-fetch-staging-test-design.md` (PR2-old). The staging test described there was based on the assumption that phase-2's "import primitives" pattern was the right design. Investigation 2026-06-17 → 2026-06-18 showed that pattern is the *wrong* shape for the actual goal. PR2-old is abandoned; this spec replaces it.

## Goal (one sentence)

The agent makes one bash call — `terminal("atomic_fetch '<query>'")` — and the tool internally fans out across **resolver.md / universal-rules.yaml / sharechat-schema.yaml / hindsight bank(s)** in parallel, returning **one merged JSON blob**, optimizing on three measurable dimensions ranked: tokens per query, wall-clock latency, agent↔LLM round-trips per `finny_query`.

## Why this, not phase-2

Phase-2 ("import 4 primitives, agent composes") *moves the wrong way* for the stated goal:

- It pushes composition out to the agent → multiplies round-trips.
- Each `execute_code` block is a fresh sandbox → re-imports + re-renders prior state → token cost scales with turns.
- Branch tip is also broken: `if len(sys.argv) < 2: sys.exit(1)` at module top fires before any primitive is bound, so `import atomic_fetch` from inside `execute_code` exits before `catalog`/`schema`/`rules`/`hindsight` exist.

Prod's current `atomic_fetch.py` (the runtime fork) is structurally closer to the goal than the branch design. v3 keeps prod's CLI shape and parallelizes the four sources properly.

## Three designs at a glance

| | A — prod (running) | B — phase-2 branch | C — v3 (this spec) |
|---|---|---|---|
| Agent action | one `terminal(atomic_fetch '<q>')` | `from atomic_fetch import catalog, schema, rules, hindsight` | one `terminal(atomic_fetch '<q>')` |
| Sources read | resolver, rules, hindsight (banks parallel) | resolver, rules, schema, hindsight (CLI: 1 bank seq) | **all 4 in parallel via outer `ThreadPoolExecutor(4)`** |
| Schema slice | dead code on CLI path | available as primitive | always-on, parallel slot |
| JSON shape | merged blob (no schema) | per-primitive returns, agent merges | merged blob (includes schema) |
| Round-trips per finny_query | 2 (atomic_fetch + suiteql) | 3+ (compose, then suiteql) | 2 |
| Branch tip importable? | yes | **no — sys.exit on import** | yes (CLI form is canonical) |

**Net:** A is structurally close to C; B is structurally further from C than A despite being newer. v3 builds on A and cherry-picks the salvageable pieces of B.

## v3 architecture

### Single CLI entry, four parallel slices, merged JSON

```python
# ~/.hermes/skills/netsuite-suiteql/scripts/atomic_fetch.py (v3)

def fetch(query: str) -> dict:
    """One call. Four sources. Parallel. Merged JSON."""
    with ThreadPoolExecutor(max_workers=4) as ex:
        f_resolver  = ex.submit(_resolver_slice, query)
        f_rules     = ex.submit(_rules_slice, query)
        f_schema    = ex.submit(_schema_slice, query)
        f_hindsight = ex.submit(_hindsight_slice, query)
    return _merge(
        query,
        f_resolver.result(timeout=10),
        f_rules.result(timeout=2),
        f_schema.result(timeout=2),
        f_hindsight.result(timeout=20),
        envelope_rules=ENVELOPE_RULES_SUMMARY,
    )

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: atomic_fetch.py '<query>'"})); sys.exit(1)
    print(json.dumps(fetch(sys.argv[1].strip()), indent=2))
```

### Why this satisfies the goal

- **Tokens:** one merged blob per query. SKILL.md collapses to one canonical pattern (no per-primitive few-shots). System prompt slice shrinks; per-query I/O shrinks.
- **Latency:** total wall-clock ≈ `max(slowest_slice)` instead of `sum(all_slices)`. Hindsight (network-bound, ~1–2s) sets the floor; resolver/rules/schema (FS+CPU) finish in ms.
- **Round-trips:** 1 atomic_fetch turn + 1 SuiteQL turn = 2. Same as A. B's import-primitives pattern typically takes 3+.

### The four slices

Each slice is a pure function returning a JSON-serializable dict. No shared state, no I/O dependencies between slices.

**`_resolver_slice(query)`** — reads `references/resolver.md` once (memoized at module level via `functools.lru_cache(maxsize=1)`). Parses `<!-- INTENT: ... -->` blocks into a list. Scores each block against query word overlap. Returns:
```
{
  "hits": [{"intent": str, "score": int, "excerpt": str (≤800 chars)}, ...top 5],
  "sections": [{"intent": str, "matched_via": "trigger"|"keyword"}, ...],
  "loaded": bool
}
```

**`_rules_slice(query)`** — reads `references/universal-rules.yaml` (memoized). Scans `keyword_sections` against query terms. Returns:
```
{
  "detected_intents": [str, ...],
  "rules_for_intent": {
    "<intent>": {"gl_accounts": [str, ...], "keywords": [str, ...]},
    ...
  }
}
```

**`_schema_slice(query)`** — reads `references/sharechat-schema.yaml` (memoized). Always runs. Infers record types from query keywords (best-guess) **and** from any intents detected by a quick rules pre-scan running in this slice's own thread (independent — doesn't await `_rules_slice`). Returns:
```
{
  "schema_for_intent": {
    "<intent>": {"record_type": str, "fields": [...], "joins": [...]},
    ...
  }
}
```
If no record type can be inferred, returns `{"schema_for_intent": {}}`. Empty is allowed; caller handles gracefully.

**`_hindsight_slice(query)`** — reads `~/.hermes/hindsight/config.json` for bank list (or `HINDSIGHT_BANK_IDS` env). Inner `ThreadPoolExecutor` fans out across banks. Per-bank work is `subprocess.run(venv_python, "-c", ...)` with 15s per-bank timeout, 20s overall deadline. Returns:
```
{
  "hindsight_context": str (merged, ≤3000 chars),
  "hindsight_per_bank": {"<bank_id>": str | None, ...},
  "hindsight_errors": [{"bank": str, "msg": str}, ...]
}
```

### Merged JSON shape

```
{
  "query": str,
  "detected_intents": [str, ...],   # union of resolver.sections + rules.detected_intents
  "resolver_hits": [...],
  "resolver_sections": [...],
  "rules_for_intent": {...},
  "schema_for_intent": {...},
  "hindsight_context": str,
  "hindsight_errors": [...],
  "envelope_rules": {...},
  "ready_to_execute": bool,
  "context_richness": "full" | "partial" | "intent_only" | "empty",
  "next_step": str
}
```

`ready_to_execute` = `True` whenever at least one intent is detected and at least one of {resolver_hits, schema_for_intent, rules_for_intent} is non-empty.

`context_richness`:
- `"full"` — all four slices returned non-empty
- `"partial"` — 2-3 slices non-empty
- `"intent_only"` — intent detected but no enrichment
- `"empty"` — no intent

## Cherry-pick from `feat/atomic-fetch-phase-2`

**Keep (7 commits — foundations Design C builds on):**
- `3f7b3b6` — `KEYWORD_SECTIONS` → `universal-rules.yaml` migration. Rules slice depends on this.
- `4253bac` — Expand to 11 keyword_sections. Catalog coverage.
- `46e320c` — `rules.lookup` / `rules.gl_accounts` over YAML. Lifted into `_rules_slice` body.
- `35ca856` — Catalog primitive (`search`, `get_block`) over `resolver.md`. Lifted into `_resolver_slice`.
- `29ff4a1` — Schema primitive over `sharechat-schema.yaml`. Lifted into `_schema_slice`.
- `4963f3b` — Catalog bug fix (only HTML-commented `<!-- INTENT: -->` blocks count, skip markdown headings).
- `0ea13c6` — Multi-bank hindsight fan-out (env redaction + timeouts + dict-shape result). Lifted into `_hindsight_slice` (replaces prod's inline single-bank logic).

**Skip (9 commits — wrong design or obsolete):**
- `1630537` — SKILL.md "import primitives, do NOT use CLI". Exact opposite of v3 direction.
- `e3e6575`, `76d00a2`, `fefd0b8` — refactor old CLI to compose new primitives. v3 rewrites this layer with parallelization.
- `3db2795` — older single-version hindsight primitive; `0ea13c6` supersedes.
- `97df52e`, `a119e2d` — snapshot baselines for old CLI behavior; v3 writes fresh fixtures matching merged JSON shape.
- `07e6512` — PR-review fixes specific to old composition path; individual line-fixes only if survive rewrite.
- `7c2ab9d` — CI catalog drift workflow. Nice-to-have; not on critical path. May land separately.

## Ship gate

**v3 ships if and only if** measured against Design A (current prod) baseline:

> **≥2× reduction on at least 2 of 3 dimensions** {tokens per query, latency per query, round-trips per query}

Non-regression required on the third dimension (i.e., not worse than 1.0× of A).

## Measurement methodology

### Corpus

The 9 blessed query inputs from `skills/netsuite-suiteql/tests/fixtures/cli_queries.json`:
- `vendor_balance_basic`: "what's outstanding to vendor Acme"
- `open_bills_basic`: "show me unpaid bills"
- `tds_basic`: "TDS payable for May"
- `gst_basic`: "GST input credit balance"
- `payroll_gl_basic`: "payroll GL for April"
- `ap_aging_basic`: "AP aging buckets"
- `po_status_basic`: "status of PO 12345"
- `gl_monthly_basic`: "GL movements last month"
- `vendor_lookup_basic`: "find vendor Acme"
- `approval_status_basic`: "approval status for bill 99"

(10 fixtures, 9 distinct intents — `vendor_balance_basic` and `vendor_lookup_basic` both cover vendor_balance shape; counted as 9 unique-intent measurement points.)

### Procedure

Each fixture runs through both:

1. **Design A baseline** — current prod via `https://finny.production.../mcp` (or against an A-pinned staging gateway). Capture per-query metrics.
2. **Design C candidate** — staging running v3-build via `https://finny.staging.11mirror.com/mcp`. Capture per-query metrics.

Per-query metrics from the bridge gateway log (already structured JSON in journald):
- **`input_tokens`, `output_tokens`** per `gateway_call` aggregate (sum across all phases for the finny_query)
- **`total_latency_ms`** per `gateway_query_aggregate`
- **`total_calls`** per `gateway_query_aggregate` (= round-trips per finny_query)

Average across the 9 queries → A and C baselines for each dimension. Compute ratios `A/C` for tokens, latency, round-trips. Apply ship gate.

### Capture format

Manifest at `docs/staging/atomic-fetch-v3-perf-changes.md`:
- Per-query table: query, A tokens/latency/calls, C tokens/latency/calls, ratios
- Aggregate row: averages across 9, gate verdict
- Surprises section
- Decision: ship to prod / iterate / pause

## Non-goals

- Touching prod outside the deploy-runbook flow.
- Replacing the messaging-platform gateway (separate concern).
- A live A/B in production. We measure on staging only and compare against captured prod baselines.
- Hindsight write paths.
- Adding new intents beyond the 11 already in phase-2's `universal-rules.yaml` expansion.

## Constraints (load-bearing — preserved verbatim)

- All EC2 work via SSM (`i-0c2c974ff571162eb` staging, `i-0ef58962b09d490ee` prod). Wrap git/file ops in `sudo -iu ubuntu bash -lc '...'` with **single quotes** — double quotes break `$$` and `$(...)` expansion.
- Per `[[never-expose-secrets]]`: env values never in transcript or manifest. Pass secrets via `EnvironmentFile`, never as command args (SSM logs command bodies).
- Read-only NetSuite (staging shares prod NS).
- No prod touch outside `docs/staging/deploy-runbook.md` flows.

## Stop conditions

- v3 build cannot achieve ≥2× win on any dimension after one implementation pass → halt, report, decide whether parallelization assumptions hold.
- Hindsight slice times out >50% of the time on staging → investigate before shipping (may indicate hindsight cloud regression unrelated to v3).
- Schema slice can't infer record type for >50% of queries → re-evaluate the always-on choice.
- Any slice's failure mode breaks the merge step (no JSON returned at all) → halt; need defensive `_merge` with per-slice partial-failure handling.

## Out of scope for this spec (deferred)

- **CI catalog drift workflow** (`7c2ab9d` from phase-2). Lands separately.
- **terminal_tool log redaction** (the journald cred-leak finding). Independent code change in hermes-agent.
- **NetSuite cred rotation** (the leaked-creds-in-journald discovery). Separate operator decision.
- **Reconciling prod-direct SKILL.md drift back to git history** (the original "PR3+4 byte-equality reconciliation" plan). Now obsolete because v3 replaces both prod's SKILL.md and the branch's SKILL.md with a new v3-shaped doc.

## Out-of-scope-but-related discoveries to capture in this PR

These came up during 2026-06-17 investigation and need an entry in `docs/staging/known-drift.md`:

1. Prod's `default` profile gateway runs from `~/.hermes/hermes-agent/venv/bin/python`, but its systemd unit's `ExecStart` points at `~/hermes-venv/bin/python` (different venv). Prod works because the running process predates the unit-file change. Staging hit this — fresh `systemctl start` launched the wrong venv, didn't bind 8642.

2. The HTTP listener on `127.0.0.1:8642` requires `API_SERVER_ENABLED=true` (+ `API_SERVER_HOST`/`API_SERVER_PORT`/`API_SERVER_KEY`) in `~/.hermes/.env` to be picked up at gateway start. The systemd unit doesn't load `~/.hermes/.env` automatically; the gateway must be started with that env sourced.

3. Prod-direct edits to `~/.hermes/profiles/default/skills/netsuite-suiteql/SKILL.md` (272 lines) and `~/.hermes/profiles/default/skills/netsuite-suiteql/scripts/atomic_fetch.py` (352 lines) exist that are not in any tracked git branch. Profile clone-all carried these forward to staging, masking the drift. Open follow-up: bring prod's working tree back into a tracked branch before v3 lands.
