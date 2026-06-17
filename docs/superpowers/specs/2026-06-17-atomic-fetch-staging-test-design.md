# Atomic_fetch search-as-code — staging test design

**Date:** 2026-06-17
**Target:** PR2 of the atomic-fetch reconciliation sequence (PR1 = deployed-branch model, shipped 2026-06-17; PR3+4 = byte-equality reconciliation, blocked on this test).
**Staging:** EC2 `i-0c2c974ff571162eb`, public MCP `https://finny.staging.11mirror.com/mcp`, code at `/home/ubuntu/.hermes/skills/netsuite-suiteql/` on tip `1630537` (`feat/atomic-fetch-phase-2`, identical to prod).

## Source of truth

No standalone design spec / plan markdown exists in either git tree (`finny-hermes-config` or `netsuite-kb`); the feature was authored as code + tests + SKILL.md. The authoritative surface for this test is therefore:

- `skills/netsuite-suiteql/SKILL.md` v3.0.0 — user-facing API contract for the four primitives.
- `skills/netsuite-suiteql/scripts/atomic_fetch.py` (407 lines, tip `1630537`) — implementation.
- `skills/netsuite-suiteql/tests/snapshots/*.json` — 10 blessed snapshot fixtures (`ap_aging_basic`, `approval_status_basic`, `gl_monthly_basic`, `gst_basic`, `open_bills_basic`, `payroll_gl_basic`, `po_status_basic`, `tds_basic`, `vendor_balance_basic`, `vendor_lookup_basic`) — what the original authors blessed as "atomic_fetch should handle these correctly". Phase 2 anchors representative queries to this set rather than to hand-picked guesses.
- 16 phase-1+2 commits between `575e260` and `1630537` on `feat/atomic-fetch-phase-2` (visible via `git log main..feat/atomic-fetch-phase-2` in `~/.hermes`).

## Goal

Verify the **search-as-code** claim of atomic_fetch end-to-end: that composing primitives (`catalog`, `schema`, `rules`, `hindsight`) inside `execute_code` pulls the right NetSuite knowledge dynamically and reduces token cost vs. the pre-atomic_fetch path of dumping full skill content. Confirm no regression vs. what's running on prod before promoting phase-1 + phase-2 history into `main` via PR3+4.

## Non-goals

- Building a controlled token-economy A/B (the pre-atomic_fetch path is gone; comparison is against documented tool-call counts, not a live baseline).
- Testing hindsight write paths.
- Any infra cleanup or prod touch.

## What atomic_fetch actually is (grounding)

Per `~/.hermes/skills/netsuite-suiteql/SKILL.md` v3.0.0 and `scripts/atomic_fetch.py` (407 lines, tip `1630537`):

Four primitives importable inside `execute_code`:

```python
from atomic_fetch import catalog, schema, rules, hindsight
```

- `catalog.search(query)` → ranked `[{intent, score, excerpt}, ...]` from `references/resolver.md` INTENT blocks (13 intents: open_bills, vendor_balance, pending_approvals, po_status, gstin_lookup, gl_summary, payment_status, days_to_pay, gl_month_close, revenue_monthly, payroll_gl_structure, deferred_revenue_balance, sales_orders_unbilled).
- `catalog.get_block(intent_id)` → full resolver block.
- `schema.describe / fields / joins` → `references/sharechat-schema.yaml`.
- `rules.lookup(domain) / gl_accounts(category)` → `references/universal-rules.yaml` (~20 keyword sections including tds, posting_only, status_derivation).
- `hindsight.recall(query, ...)` → memory-bank context.

**The CLI form (`atomic_fetch.py "<query>"`) is deprecated.** Phase 2 retired the INTENT_PATTERNS dispatcher. Tests must exercise the primitive composition path through `finny_query` → MCP → gateway → `execute_code`.

## The economic claim under test

Pre-atomic_fetch: agent `skill_view`s the full `netsuite-suiteql` skill (SKILL.md + resolver.md + multiple references) on every query → large token footprint per turn.

Post-atomic_fetch: agent calls `catalog.search` to pull only the matching resolver block (≤800-char excerpt × top-K) plus targeted schema/rules lookups → small token footprint per turn.

We measure this via gateway turn telemetry (input/output tokens, tool-call count). A green Phase 3 means atomic_fetch's token cost per query is materially below the documented pre-feature path.

## Test phases

### Phase 0 — pytest suites on staging (~5 min)

Already on disk: `tests/test_catalog_primitive.py`, `test_catalog_coverage.py`, `test_schema_primitive.py`, `test_rules_primitive.py`, `test_rules_yaml.py`, `test_hindsight_primitive.py`, `test_cli_snapshot.py`.

Run via SSM under the skill's venv. Any failure → **STOP**. This catches local regressions before any live query is issued.

### Phase 1 — primitive surface probe via one raw `execute_code` query (~5 min)

Single `finny_query` (in browser cowork against staging MCP) shaped to make the agent run a `terminal()`/`execute_code` block that:

- Calls `catalog.search` on three queries — `"open vendor bills"`, `"tds gl summary"`, `"approver pending"` — and asserts top-1 intents are `open_bills`, `gl_summary`, `pending_approvals` respectively (selectivity check).
- Asserts `schema.describe("transaction")` returns `{record_type, fields, joins}` non-empty.
- Asserts `rules.gl_accounts("tds")` returns the documented set (the SKILL.md example: 217300/217301/217312 — exact equality).
- Asserts `rules.lookup("posting_only")` is non-None.
- Calls `hindsight.recall("vendor bill")` and confirms the return is `{banks: ..., errors: ...}` shape (no exception, content irrelevant).

Capture envelope shape and the agent's printed assertion summary (no NetSuite data values).

### Phase 2 — three composition queries (~15 min)

Each prompt entered in browser cowork, one per resolver intent / pattern:

| # | Prompt | Intent | Pattern | Green |
|---|---|---|---|---|
| 1 | "list 10 open vendor bills with tranid + foreign unpaid" | `open_bills` | A: catalog → schema → suiteql | rows; no `custbody_*` in SELECT (would zero result); `posting='T'` honored |
| 2 | "sum TDS posted to GL this quarter, grouped by account" | `gl_summary` + `tds` rule | B: rules.gl_accounts → suiteql aggregate | groups returned; `tal.accountingbook = 1` present in SQL |
| 3 | "find pending approvals on vendor bills — what was the gotcha last time" | `pending_approvals` | C: hindsight.recall + catalog → suiteql | SQL uses `BUILTIN.DF(t.nextapprover)`, not raw `employee` join (a known 403-zero-rows trap) |

**Query #3 — hindsight composition.** Don't pre-script the `execute_code` block. Run the prompt as-is and observe what the agent composes. If it called `hindsight.recall` on its own initiative → green for Pattern C. If it didn't → run a follow-up probe that explicitly imports and calls `hindsight.recall("pending approvals vendor bills")` and confirms the return shape `{banks, errors}` cleanly. Either outcome is acceptable for PR2; agent-side hindsight best-practices belong to a later iteration. The hard requirement on #3 is the SQL-correctness check (no `employee` join trap).

**Anchoring to blessed fixtures.** Phase 2's three queries map directly to existing snapshot fixtures (`open_bills_basic`, `tds_basic`, `approval_status_basic`) — i.e., the original authors already blessed these intents as in-scope for atomic_fetch. The remaining 7 fixtures (`ap_aging_basic`, `gl_monthly_basic`, `gst_basic`, `payroll_gl_basic`, `po_status_basic`, `vendor_balance_basic`, `vendor_lookup_basic`) are out of scope for PR2 — they're covered by Phase 0 pytest.

For each: capture prompt, envelope `status` + top-level shape, gateway turn count, latency, tool-call list, pass/fail rationale. **No data values in the manifest.**

### Phase 3 — token-economy delta (~10 min)

Pull gateway log entries for the 3 Phase-2 turns. Extract per-turn `input_tokens` / `output_tokens` / tool-call count. Compare against the documented pre-atomic_fetch path: a single `skill_view(netsuite-suiteql)` returns ~the full SKILL.md + resolver.md + invoked references — order-of-magnitude tens of thousands of tokens. Atomic_fetch's targeted excerpts should land an order of magnitude below that.

Document the delta qualitatively in the manifest. If atomic_fetch's per-turn input tokens are within striking distance of, or above, the full-dump baseline → **STOP and flag**: the search-as-code economic claim is not holding and PR3+4 should not proceed.

## Capture format

Manifest at `docs/staging/atomic-fetch-staging-test-changes.md` with sections:

1. **Summary** — green / red / mixed; 2-line rationale.
2. **Phase 0** — pytest pass counts per file, total duration.
3. **Phase 1** — primitive probe: each assertion → pass/fail (no values).
4. **Phase 2** — table per the matrix above; envelope shape, turn count, latency, tool-calls used.
5. **Phase 3** — per-turn token counts, comparison narrative, holds-or-doesn't verdict.
6. **Surprises** — anything not anticipated, especially: a custbody trap actually firing, an intent miss, a primitive returning unexpected shape.
7. **Decision** — proceed to PR3+4 / iterate / pause.

## Constraints (load-bearing — do not violate)

- All EC2 work via SSM `i-0c2c974ff571162eb`, wrapped in `sudo -iu ubuntu bash -lc '...'` with single quotes (double quotes break `$$` and `$(...)` expansion — see `docs/staging/deploy-runbook.md`).
- Per `[[never-expose-secrets]]`: env values never in transcript or manifest. Use key-only / presence-only checks. Pass secrets via `EnvironmentFile`, never as command args (SSM logs command bodies).
- Read-only NetSuite queries only — staging shares prod NetSuite credentials. No writes, no mutations.
- No prod touch. PR3+4 is a separate flow.

## Stop conditions

- Phase 0 pytest red → STOP (regression in primitives themselves).
- `catalog.search` returns 0 hits or wrong top-1 intent for any selectivity probe → STOP (catalog regression — exactly what PR3+4 must not paper over).
- Gateway 5xx, MCP transport error, or `envelope_parse_failed` → STOP.
- A custbody / employee-join / subsidiary-int landmine fires (the resolver was supposed to steer past it) → STOP.
- Phase 3 shows token cost ≥ pre-feature dump → STOP.
- Anything destructive on prod — confirm with user before any action.

## PR2 shape

PR-led, not direct-to-main. Branch on `finny-claude-plugin`: `staging-test/atomic-fetch`. PR2 is documentation-only: this spec + the manifest + any small follow-up notes. No code changes. Reviewer's job is to confirm the manifest's verdict matches what the test phases recorded; if green, PR3+4 in `finny-hermes-config` becomes unblocked.

## Success → next action

If all phases green: write the manifest, commit on `staging-test/atomic-fetch`, open PR2 with the manifest as the artifact. Once PR2 lands, PR3+4 (byte-equality reconciliation per `docs/staging/deploy-runbook.md` §"Byte-equality reconciliation deploy") becomes unblocked.
