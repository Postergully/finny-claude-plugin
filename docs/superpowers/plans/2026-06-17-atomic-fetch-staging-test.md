# Atomic_fetch Staging Test (PR2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the atomic_fetch search-as-code staging test per spec `2026-06-17-atomic-fetch-staging-test-design.md` and land the manifest as PR2 on `finny-claude-plugin`, unblocking PR3+4 (byte-equality reconciliation).

**Architecture:** This is a documentation-only PR. Execution happens *on staging EC2* via SSM (pytest + a Python probe driven through `finny_query` from browser cowork against `https://finny.staging.11mirror.com/mcp`); evidence is captured in a manifest file inside this repo. No code changes to the bridge or plugin.

**Tech Stack:** AWS SSM (instance `i-0c2c974ff571162eb`), pytest (skill venv at `~/.hermes/skills/netsuite-suiteql/venv/bin/python`), Hermes user-systemd unit `hermes-gateway`, browser Claude cowork (Custom Connector to staging MCP), GitHub PR via `gh`.

**Hard constraints (load-bearing — do not violate):**
- All EC2 work via SSM `i-0c2c974ff571162eb`. Wrap git/file ops in `sudo -iu ubuntu bash -lc '...'` with **single quotes** — double quotes break `$$` and `$(...)` expansion (see `docs/staging/deploy-runbook.md`).
- Per `[[never-expose-secrets]]`: env values never printed; key-only / presence-only checks. Pass secrets via `EnvironmentFile`, not as command args (SSM logs command bodies).
- Read-only NetSuite (staging shares prod NS credentials).
- No prod touch.
- Stop conditions in the spec are **STOP**, not paper-over.

---

## File structure

| Path | Action | Responsibility |
|---|---|---|
| `docs/staging/atomic-fetch-staging-test-changes.md` | Create | Manifest: phase-by-phase results, verdict, surprises. The PR2 artifact. |
| `docs/superpowers/plans/2026-06-17-atomic-fetch-staging-test.md` | (This file) | Plan; committed first. |
| `docs/staging/deploy-log.md` | Append (only if green) | Single-line note that PR2 landed and PR3+4 is unblocked. Done in the merge step. |

No code or config files in either `finny-claude-plugin` or `finny-hermes-config` are touched by PR2.

---

## Task 1: Create test branch and commit the plan

**Files:**
- Create: branch `staging-test/atomic-fetch` on `Postergully/finny-claude-plugin`
- Modify: none

- [ ] **Step 1: Confirm clean working tree on `main`**

```bash
git -C /Applications/finny-claude-plugin status
git -C /Applications/finny-claude-plugin log --oneline -3
```

Expected: working tree clean (untracked files ok), `main` tip shows commit `a6f3b25` (spec) at top.

- [ ] **Step 2: Create branch from current main**

```bash
git -C /Applications/finny-claude-plugin checkout -b staging-test/atomic-fetch
```

Expected: `Switched to a new branch 'staging-test/atomic-fetch'`.

- [ ] **Step 3: Stage and commit the plan**

```bash
git -C /Applications/finny-claude-plugin add docs/superpowers/plans/2026-06-17-atomic-fetch-staging-test.md
git -C /Applications/finny-claude-plugin commit -m "plan(staging): atomic_fetch search-as-code test execution plan (PR2)"
```

Expected: one new commit on `staging-test/atomic-fetch`.

- [ ] **Step 4: Push branch (no PR yet — PR opens at the end with the manifest)**

```bash
git -C /Applications/finny-claude-plugin push -u origin staging-test/atomic-fetch
```

Expected: branch tracked on origin.

---

## Task 2: Phase 0 — Run pytest suite on staging

**Files:**
- Read on staging: `~/.hermes/skills/netsuite-suiteql/tests/test_*.py`
- Capture target: pass/fail counts per file + total duration (for the manifest)

- [ ] **Step 1: Confirm staging tip is `1630537`**

```bash
aws ssm send-command --instance-ids i-0c2c974ff571162eb \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["sudo -iu ubuntu bash -lc '"'"'cd ~/.hermes && git rev-parse HEAD && git status --porcelain | wc -l'"'"'"]' \
  --query "Command.CommandId" --output text
```

Wait, then:

```bash
aws ssm get-command-invocation --command-id <CMD_ID> --instance-id i-0c2c974ff571162eb \
  --query "[Status,StandardOutputContent]" --output text
```

Expected: `Success`, output starts with `1630537`. Porcelain line count ≤ ~70 (known runtime dirt per `docs/staging/known-drift.md`); higher = something changed.

**STOP if:** SHA ≠ `1630537` or porcelain count materially exceeds the known-drift baseline.

- [ ] **Step 2: Run pytest under the skill venv**

```bash
aws ssm send-command --instance-ids i-0c2c974ff571162eb \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["sudo -iu ubuntu bash -lc '"'"'cd ~/.hermes/skills/netsuite-suiteql && time ./venv/bin/python -m pytest tests/ -v --tb=short 2>&1 | tail -120'"'"'"]' \
  --query "Command.CommandId" --output text
```

Wait 60s, then `aws ssm get-command-invocation` as above.

Expected: a final summary line like `===== N passed in M.MMs =====`. Capture per-file collected/passed/failed counts.

**STOP if:** any test fails. Report the failing test name + traceback excerpt to the user. Do not paper over.

- [ ] **Step 3: Stash Phase 0 results in a working note**

Save raw SSM output to `/tmp/atomic-fetch-phase0.txt` locally for later transcription into the manifest. Do **not** commit this file.

- [ ] **Step 4: Mid-test commit checkpoint**

No file changes yet — skip to Task 3.

---

## Task 3: Phase 1 — Primitive surface probe via execute_code

**Files:**
- Browser cowork: one `finny_query` against `https://finny.staging.11mirror.com/mcp`
- Capture target: agent's printed assertion summary + envelope status

- [ ] **Step 1: Open browser cowork pointed at staging**

Open Claude.ai cowork in a browser, ensure the `finny.staging` Custom Connector is active (not prod). Confirm by hovering the connector — must read staging URL.

- [ ] **Step 2: Issue the probe prompt**

Paste this into cowork:

> Run a `finny_query` that executes the following Python inside `execute_code`. Print only PASS/FAIL per assertion, no NetSuite data:
>
> ```python
> from atomic_fetch import catalog, schema, rules, hindsight
>
> # Selectivity
> for q, expected in [("open vendor bills", "open_bills"),
>                     ("tds gl summary", "gl_summary"),
>                     ("approver pending", "pending_approvals")]:
>     hits = catalog.search(q)
>     top = hits[0]["intent"] if hits else None
>     print(f"catalog.search({q!r}) top={top} expected={expected} -> {'PASS' if top==expected else 'FAIL'}")
>
> # Schema
> d = schema.describe("transaction")
> print(f"schema.describe(transaction) keys={sorted(d.keys()) if d else None} -> {'PASS' if d and {'record_type','fields','joins'}<=set(d.keys()) else 'FAIL'}")
>
> # Rules
> tds = sorted(rules.gl_accounts("tds"))
> expected_tds = sorted(["217300","217301","217312"])
> print(f"rules.gl_accounts(tds)={tds} -> {'PASS' if tds==expected_tds else 'FAIL'}")
> print(f"rules.lookup(posting_only) -> {'PASS' if rules.lookup('posting_only') is not None else 'FAIL'}")
>
> # Hindsight (shape only — content irrelevant)
> try:
>     ctx = hindsight.recall("vendor bill")
>     ok = isinstance(ctx, dict) and "banks" in ctx and "errors" in ctx
>     print(f"hindsight.recall shape -> {'PASS' if ok else 'FAIL'}")
> except Exception as e:
>     print(f"hindsight.recall raised {type(e).__name__} -> FAIL")
> ```

- [ ] **Step 3: Capture envelope and assertion lines**

Copy the envelope (status + top-level shape) and the six PASS/FAIL lines into `/tmp/atomic-fetch-phase1.txt`. **No data values.**

Expected: 6× `PASS`, envelope `status: "ok"`.

**STOP if:**
- any line says `FAIL`
- envelope status is `error` / `refused` / `envelope_parse_failed`
- `rules.gl_accounts("tds")` returns anything other than the documented `[217300, 217301, 217312]` (selectivity *and* economic-claim regression — exactly what PR3+4 must not paper over)

- [ ] **Step 4: No commit yet**

Manifest gets written once at the end (Task 8). Move to Task 4.

---

## Task 4: Phase 2 query #1 — open_bills_basic (Pattern A)

**Files:**
- Browser cowork: one `finny_query`
- Capture target: per-query row in the manifest's Phase 2 table

- [ ] **Step 1: Issue the blessed prompt**

The exact `cli_queries.json` input for `open_bills_basic` is:

> `show me unpaid bills`

Paste verbatim into cowork. Do **not** elaborate or pre-script the `execute_code`.

- [ ] **Step 2: Observe what the agent composed**

Note the tool-calls in order. Pattern A expectation: `catalog.search` → `schema.describe`/`schema.fields` → `suiteql(...)`. Capture the SQL string the agent ran.

- [ ] **Step 3: Run the SQL safety checks (in your head, off the captured SQL)**

Confirm against the captured SQL:
- No `custbody_*` field appears in `SELECT` (custbody-zero-rows trap, SKILL.md pitfall #1)
- `posting = 'T'` appears in `WHERE`
- `FETCH FIRST` not `LIMIT`
- If joining `TransactionAccountingLine`: `tal.accountingbook = 1`

**STOP if:** any pitfall present in the SQL. Report which pitfall + the captured SQL excerpt.

- [ ] **Step 4: Capture the gateway turn for Phase 3**

```bash
aws ssm send-command --instance-ids i-0c2c974ff571162eb \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["sudo -iu ubuntu bash -lc '"'"'journalctl --user -u hermes-gateway -n 200 --no-pager 2>&1 | grep -E \"input_tokens|output_tokens|tool_call|Tool terminal\" | tail -30'"'"'"]' \
  --query "Command.CommandId" --output text
```

Wait, fetch result. Save token counts and tool-call list for query #1 to `/tmp/atomic-fetch-phase2-q1.txt`. Note: token field names depend on gateway log format — capture whatever signal is present (exact tokens preferred; tool-call count required as a fallback).

- [ ] **Step 5: Record verdict (PASS/FAIL/MIXED) for query #1**

Append a row to a working table in `/tmp/atomic-fetch-phase2.txt` with: prompt, intent matched, envelope status, turn count, latency, tool-calls used, pitfall-check verdict.

---

## Task 5: Phase 2 query #2 — tds_basic (Pattern B)

**Files:**
- Browser cowork: one `finny_query`

- [ ] **Step 1: Issue the blessed prompt**

The exact `cli_queries.json` input for `tds_basic` is:

> `TDS payable for May`

Paste verbatim into cowork.

- [ ] **Step 2: Observe Pattern B path**

Expected order: `rules.gl_accounts("tds")` (or `rules.lookup("tds")`) → SuiteQL aggregate over `TransactionAccountingLine`. Capture the SQL.

- [ ] **Step 3: SQL safety checks**

Confirm:
- `tal.account IN (217300, 217301, 217312)` (or equivalent — rule-derived, not hardcoded)
- `tal.accountingbook = 1`
- `t.posting = 'T'`
- `GROUP BY tal.account` (per SKILL.md Pattern B example)

**STOP if:** GL list isn't rule-derived (e.g., agent hardcoded different numbers) — that means catalog/rules wasn't actually consulted.

- [ ] **Step 4: Capture gateway turn**

Same SSM call shape as Task 4 Step 4. Save to `/tmp/atomic-fetch-phase2-q2.txt`.

- [ ] **Step 5: Record verdict for query #2**

Append row to `/tmp/atomic-fetch-phase2.txt`.

---

## Task 6: Phase 2 query #3 — approval_status_basic (Pattern C, hindsight observation)

**Files:**
- Browser cowork: up to two `finny_query` calls

- [ ] **Step 1: Issue the blessed prompt**

The exact `cli_queries.json` input for `approval_status_basic` is:

> `approval status for bill 99`

Paste verbatim into cowork. **Do not pre-script** the `execute_code` block — the point is to observe what the agent composes.

- [ ] **Step 2: Observe whether the agent invoked `hindsight.recall`**

If it did → record "Pattern C: agent-initiated hindsight, PASS". Skip Step 3.

If it didn't → continue to Step 3 (direct probe).

- [ ] **Step 3: Direct hindsight probe (only if Step 2 was no)**

Paste this follow-up into cowork:

> Run a `finny_query` that executes only:
>
> ```python
> from atomic_fetch import hindsight
> ctx = hindsight.recall("pending approvals vendor bills")
> print(f"banks_count={len(ctx.get('banks', {}))} errors_count={len(ctx.get('errors', []))} shape_ok={isinstance(ctx, dict) and 'banks' in ctx and 'errors' in ctx}")
> ```

Expected: `shape_ok=True`. Counts can be anything (including 0).

**STOP if:** `shape_ok=False` or the call raises.

- [ ] **Step 4: SQL correctness check on the original query**

Capture the SQL the agent ran for "approval status for bill 99". Confirm:
- It uses `BUILTIN.DF(t.nextapprover)` (per SKILL.md pitfall: raw `employee` join silently 403s → 0 rows)
- No `custbody_*` field in `SELECT`

**STOP if:** raw `JOIN employee` present, or any custbody field in `SELECT`. This is a pitfall the resolver was supposed to steer past.

- [ ] **Step 5: Capture gateway turn(s)**

```bash
aws ssm send-command --instance-ids i-0c2c974ff571162eb \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["sudo -iu ubuntu bash -lc '"'"'journalctl --user -u hermes-gateway -n 300 --no-pager 2>&1 | grep -E \"input_tokens|output_tokens|tool_call|Tool terminal\" | tail -40'"'"'"]' \
  --query "Command.CommandId" --output text
```

Save to `/tmp/atomic-fetch-phase2-q3.txt`. Include both turns if the direct hindsight probe ran.

- [ ] **Step 6: Record verdict for query #3**

Append row(s) to `/tmp/atomic-fetch-phase2.txt`. Note hindsight-was-agent-initiated vs direct-probe in the row.

---

## Task 7: Phase 3 — Token-economy delta

**Files:**
- Read: `~/.hermes/skills/netsuite-suiteql/SKILL.md` size on staging
- Read: `~/.hermes/skills/netsuite-suiteql/references/resolver.md` size on staging
- Capture target: per-turn input tokens vs. baseline estimate

- [ ] **Step 1: Estimate the pre-feature baseline**

```bash
aws ssm send-command --instance-ids i-0c2c974ff571162eb \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["sudo -iu ubuntu bash -lc '"'"'cd ~/.hermes/skills/netsuite-suiteql && wc -c SKILL.md references/resolver.md references/quickstart.md references/sharechat-config.yaml references/sharechat-schema.yaml references/universal-rules.yaml references/suiteql-patterns.yaml 2>/dev/null'"'"'"]' \
  --query "Command.CommandId" --output text
```

Wait, fetch result. Convert byte counts to a rough token estimate (~4 bytes/token for English+code). Pre-feature path = `skill_view(netsuite-suiteql)` returning approximately the union of these files.

- [ ] **Step 2: Compute the delta**

For each Phase 2 query, take the per-turn `input_tokens` captured in `/tmp/atomic-fetch-phase2-q{1,2,3}.txt`. Compare against the baseline estimate from Step 1.

Expected: atomic_fetch's per-query input tokens are at least a 5× reduction vs. baseline (the search-as-code claim). Exact numbers will vary; what matters is the order-of-magnitude relationship.

**STOP if:** any Phase 2 query's input tokens are within 50% of the baseline or above. The economic claim is not holding; PR3+4 should not proceed without explanation.

- [ ] **Step 3: Write delta verdict to working note**

Save the comparison table (baseline tokens, per-query tokens, ratio, holds/doesn't) to `/tmp/atomic-fetch-phase3.txt`.

---

## Task 8: Write the manifest

**Files:**
- Create: `docs/staging/atomic-fetch-staging-test-changes.md`

- [ ] **Step 1: Assemble the manifest from working notes**

Use this exact section structure (from spec §"Capture format"):

```markdown
# Atomic_fetch staging test — change manifest (PR2)

**Date:** 2026-06-17 (or actual run date)
**Operator:** <name>
**Staging EC2:** i-0c2c974ff571162eb @ ~/.hermes tip 1630537
**Spec:** docs/superpowers/specs/2026-06-17-atomic-fetch-staging-test-design.md
**Plan:** docs/superpowers/plans/2026-06-17-atomic-fetch-staging-test.md

## Summary

<green | red | mixed>. <2-line rationale.>

## Phase 0 — pytest suite

- test_catalog_primitive.py: <N passed>
- test_catalog_coverage.py: <N passed>
- test_schema_primitive.py: <N passed>
- test_rules_primitive.py: <N passed>
- test_rules_yaml.py: <N passed>
- test_hindsight_primitive.py: <N passed>
- test_cli_snapshot.py: <N passed>
- Total: <N passed in M.MMs>

## Phase 1 — primitive surface probe

| Assertion | Result |
|---|---|
| catalog.search("open vendor bills") top == "open_bills" | <PASS/FAIL> |
| catalog.search("tds gl summary") top == "gl_summary" | <PASS/FAIL> |
| catalog.search("approver pending") top == "pending_approvals" | <PASS/FAIL> |
| schema.describe("transaction") has {record_type,fields,joins} | <PASS/FAIL> |
| rules.gl_accounts("tds") == ["217300","217301","217312"] | <PASS/FAIL> |
| rules.lookup("posting_only") is non-None | <PASS/FAIL> |
| hindsight.recall(...) returns {banks, errors} shape | <PASS/FAIL> |

## Phase 2 — composition queries

| # | Prompt | Pattern | Intent matched | Envelope | Turns | Tool-calls | Pitfalls | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | "show me unpaid bills" | A | open_bills | <ok/...> | <N> | <list> | clean | <PASS/FAIL> |
| 2 | "TDS payable for May" | B | gl_summary | <ok/...> | <N> | <list> | clean | <PASS/FAIL> |
| 3 | "approval status for bill 99" | C | pending_approvals | <ok/...> | <N> | <list> | clean | <PASS/FAIL> |

Notes on #3: <agent-initiated hindsight | direct probe required>.

## Phase 3 — token-economy delta

| Source | Bytes | Est. tokens |
|---|---|---|
| Pre-feature dump (SKILL.md + 6 refs) | <bytes> | <tokens> |
| Q1 input_tokens | — | <tokens> |
| Q2 input_tokens | — | <tokens> |
| Q3 input_tokens | — | <tokens> |

Ratio (baseline / per-query): <X>×, <Y>×, <Z>×. Search-as-code claim <holds | does not hold>.

## Surprises

<anything not anticipated; especially custbody traps, intent misses, primitive shape changes, or token deltas outside expected order of magnitude>

## Decision

<proceed to PR3+4 | iterate | pause>
```

- [ ] **Step 2: Fill in actual values from `/tmp/atomic-fetch-phase{0,1,2,3}.txt`**

No `<placeholder>` text remains. **No NetSuite data values anywhere.** **No env values anywhere.**

- [ ] **Step 3: Self-check the manifest before commit**

```bash
grep -E "<[a-z]+>|TODO|TBD" /Applications/finny-claude-plugin/docs/staging/atomic-fetch-staging-test-changes.md
```

Expected: empty output. If any placeholder remains, fill it in.

```bash
grep -iE "BEARER|sk-|AKIA|password|secret" /Applications/finny-claude-plugin/docs/staging/atomic-fetch-staging-test-changes.md
```

Expected: empty output. If any secret-shaped string appears, scrub it.

- [ ] **Step 4: Commit the manifest**

```bash
git -C /Applications/finny-claude-plugin add docs/staging/atomic-fetch-staging-test-changes.md
git -C /Applications/finny-claude-plugin commit -m "manifest(staging): atomic_fetch search-as-code test results (PR2)"
```

- [ ] **Step 5: Push**

```bash
git -C /Applications/finny-claude-plugin push
```

---

## Task 9: Open PR2

**Files:**
- GitHub PR on `Postergully/finny-claude-plugin`: `staging-test/atomic-fetch` → `main`

- [ ] **Step 1: Open the PR**

```bash
cd /Applications/finny-claude-plugin && gh pr create --title "PR2: atomic_fetch search-as-code staging test" --body "$(cat <<'EOF'
## Summary
- Test plan + manifest for atomic_fetch search-as-code (PR2 of the atomic-fetch reconciliation sequence)
- Spec: `docs/superpowers/specs/2026-06-17-atomic-fetch-staging-test-design.md`
- Plan: `docs/superpowers/plans/2026-06-17-atomic-fetch-staging-test.md`
- Manifest (artifact): `docs/staging/atomic-fetch-staging-test-changes.md`

## Verdict
See manifest §Decision. If green → PR3+4 (byte-equality reconciliation per `docs/staging/deploy-runbook.md`) becomes unblocked.

## Test plan
- [x] Phase 0 pytest on staging
- [x] Phase 1 primitive surface probe via finny_query
- [x] Phase 2 composition queries (open_bills_basic, tds_basic, approval_status_basic)
- [x] Phase 3 token-economy delta vs. pre-feature dump baseline

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Capture the PR URL for the user**

Expected output: GitHub PR URL. Report it back in the session-end status.

- [ ] **Step 3: Do NOT merge**

Reviewer (the user) merges PR2. After merge, PR3+4 (byte-equality reconciliation in `finny-hermes-config`) is the next step — that's a separate plan, not part of PR2.

---

## Self-review notes

- **Spec coverage:** Phase 0 → Task 2. Phase 1 → Task 3. Phase 2 (3 queries) → Tasks 4/5/6. Phase 3 → Task 7. Manifest sections (Summary/Phase 0–3/Surprises/Decision) → Task 8 step 1. PR2 shape → Task 1 + Task 9. Stop conditions appear inline at every phase. ✓
- **No placeholders in steps:** every SSM command is concrete; every prompt is verbatim from `cli_queries.json` or written out fully; capture-target files are named. ✓
- **Type/name consistency:** primitive names (`catalog.search`, `schema.describe`, `rules.gl_accounts`, `hindsight.recall`) match SKILL.md v3.0.0 exactly. Snapshot fixture IDs match `tests/fixtures/cli_queries.json`. Branch name `staging-test/atomic-fetch` consistent across Tasks 1, 8, 9. ✓
- **Constraint preservation:** SSM-only / single-quoted heredoc / no-secrets / read-only NetSuite / no prod touch all called out in header and reinforced where relevant. ✓
