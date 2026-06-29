# Phase 1 — Staging parity (running progress tracker)

**Plan source:** `/Applications/finny-core/docs/plan/implementation.md` L285–510
**Started:** 2026-06-29
**Owner:** Operator (Kali) + Assistant (SSM-driven)

**Phase gate (must hold to exit):** Staging refreshed from current prod snapshot · oracle envelopes captured from staging · `pnpm eval --target https://finny.staging.11mirror.com/mcp --oracle eval/oracle` returns 100% pass · zero drift · nightly + per-PR CI workflow runs the eval against staging.

---

## Pre-Phase-1 cleanup status — ✅ COMPLETE 2026-06-29

| Item | State | Notes |
|---|---|---|
| Bridge OneLogin OIDC salvage ([finny-claude-plugin#23](https://github.com/Postergully/finny-claude-plugin/pull/23)) | Draft, parked | Pending Phase-3 IdP decision (OneLogin vs Zitadel). Does not block Phase 1. |
| Brain cron-corrections + .gitignore overhaul ([finny-hermes-config#3](https://github.com/Postergully/finny-hermes-config/pull/3)) | ✅ Merged + deployed | Merge `29f98ef` to main, `deployed` fast-forwarded, prod pulled, gateway restarted, smoke test 5/5 parity with staging |
| Phase 2 pre-flight manifests ([finny-claude-plugin#24](https://github.com/Postergully/finny-claude-plugin/pull/24)) | ✅ Merged | `2e65017` |
| Phase 1 progress tracker ([finny-claude-plugin#25](https://github.com/Postergully/finny-claude-plugin/pull/25)) | ✅ Merged | `53dd2c4` — this very doc |
| stagesnap-20260617-182341 profile (444MB) | ✅ Deleted | `hermes profile delete` 2026-06-29 |
| `system_prompt.py.bak-v3probe` on staging | Pending | Handled in Task 1.1 §0 cleanup |
| 8 follow-up issues filed in finny-hermes-config | ✅ Issues #4–#11 | See [Issues #4-#11 in finny-hermes-config](https://github.com/Postergully/finny-hermes-config/issues) |

## Deploy verification (2026-06-29, post-merge of #3)

- Prod EC2 `i-0ef58962b09d490ee` at `~/.hermes` HEAD = `29f98ef`
- atomic_fetch.py = 352 lines (PR version)
- resolver.md = 1613 lines (PR version)
- Working tree clean (0 modified, 0 deleted, 0 untracked) — .gitignore overhaul working as intended
- Memory files (MEMORY.md, USER.md, .curator_state, .usage.json) preserved on disk per design
- Gateway `/health` = `{"status":"ok"}`, bridge `/ready` = `{"ok":true,"hermes":"reachable","latency_ms":6}`
- Zero errors in journal last 2 min post-restart
- 5/5 smoke queries return matching intent/resolver-hit patterns to staging worktree

**Phase 1 Task 1.1 starts here.**

---

## Task 1.1: Refresh staging snapshot from prod

**Plan reference:** `implementation.md` L289–322
**Procedure source:** `docs/staging/snapshot-refresh-checklist.md` Phase 2

### Sub-tasks

- [ ] **Step 1: Walk snapshot-refresh-checklist Phase 2 on staging EC2 via SSM**

  - [ ] §0 Stop prod-cloned units on first boot (skip if not freshly imaged)
  - [ ] §1 SSH key swap — **skip, already done on this instance**
  - [ ] §2 Clear Slack tokens from `~/.hermes/.env`
  - [ ] §3 Generate fresh MCP OAuth credentials — **operator action** (token never enters transcript)
  - [ ] §4 Replace prod hostname references in `bridge/.env`
  - [ ] §5 Caddyfile single site block, no path filter
  - [ ] §6 Profile: clone `finny` → `staging`, scrub Slack, copy creds, switch active
  - [ ] §7 DO NOT touch `hermes-gateway.service` — keep prod parity
  - [ ] §8 Install `hermes-dashboard.service` (binds to tailnet IP)
  - [ ] §9 Restart units in order
  - [ ] **Cleanup:** discard `system_prompt.py.bak-v3probe` + uncommitted edits in `~/.hermes/hermes-agent/agent/system_prompt.py`

- [ ] **Step 2: Replay every manifest in `docs/staging/` newer than previous refresh**

  Replay order (chronological):
  - [ ] `feat-finny-dashboard-changes.md`
  - [ ] `feat-enable-hermes-dashboard-changes.md`
  - [ ] `feat-staging-dashboard-vhost-changes.md`
  - [ ] `feat-deploy-propagate-hindsight-key-changes.md`
  - [ ] `fix-deploy-dashboard-disk-safety-changes.md`
  - [ ] `fix-deploy-include-capabilities-distribution-changes.md`
  - [ ] `feat-dashboard-external-memory-tab-changes.md`
  - [ ] `feat-codebase-harness-staging-gate-changes.md`
  - [ ] `worktree-staging-architecture-plan-changes.md`
  - [ ] `brain-cron-corrections-2026-06-29-changes.md` (this run)

  Capture stdout per-step to a session log on staging at `~/snapshot-refresh-$(date +%F).log`.

- [ ] **Step 3: Verify staging boots**
  - [ ] `curl https://finny.staging.11mirror.com/mcp/health` → 200
  - [ ] `journalctl -u hermes-gateway -u finny-mcp --since '5 min ago' | grep -i error` → empty
  - [ ] Hermes desktop app on tailnet → connects to staging gateway

- [ ] **Step 4: Create `/etc/finny-snapshot-stamp`**
  Content:
  ```
  2026-MM-DD profile-refresh
  prod-sha-finny-hermes: <deployed SHA>
  prod-sha-finny-hermes-config: <deployed SHA>
  prod-sha-finny-claude-plugin: <deployed SHA>
  method: profile-export-import (not AMI)
  ```

- [ ] **Step 5: Commit manifest entry**
  - Branch: `staging/snapshot-refresh-2026-MM-DD` in `finny-claude-plugin`
  - File: `docs/staging/staging-snapshot-refresh-2026-MM-DD-changes.md`
  - Commit msg: `staging: refresh snapshot 2026-MM-DD + manifest replay [spec: Phase 1]`
  - PR + merge to main, fast-forward to deployed

### Task 1.1 verifier rubric

- [ ] Snapshot stamp ≤ 24h old (`cat /etc/finny-snapshot-stamp` on staging)
- [ ] All manifests since previous refresh have been replayed (session log exists)
- [ ] `curl <staging>/mcp/health` returns 200
- [ ] Hermes gateway journald shows no ERROR in last 5 min
- [ ] Manifest entry committed in finny-claude-plugin

---

## Task 1.2: Capture oracle envelopes from fresh staging

**Plan reference:** `implementation.md` L326–411

### Sub-tasks

- [ ] **Step 1 (assistant): Author capture helper** `eval/capture-oracle.ts` in `finny-claude-plugin`
  - Reuse `makeFetchEnvelope` from `eval/cli.ts` transport layer
  - Write one file per query to `eval/oracle/<query-id>.json`
  - Default target: `https://finny.staging.11mirror.com/mcp` — never prod
  - Reads token from `FINNY_EVAL_TOKEN` env, no defaults
  - Pre-req: `eval/canonical-queries.json` exists (Task 0.1 carry-over — needs Phase 0 closure first)

- [ ] **Step 2 (operator): Run capture against staging**
  ```bash
  cd /Applications/finny-claude-plugin
  export FINNY_EVAL_TARGET=https://finny.staging.11mirror.com/mcp
  export FINNY_EVAL_TOKEN=$(op read 'op://Finny/staging-mcp-token/credential')   # or equivalent
  node --experimental-strip-types eval/capture-oracle.ts eval/oracle/
  unset FINNY_EVAL_TOKEN
  ```
  Operator-only: token never in transcript.

- [ ] **Step 3 (assistant): Redact PII in every `eval/oracle/q*.json`**
  - Vendor names → `<vendor-1>`, `<vendor-2>`, …
  - NS internal IDs → `<acct-N>`, `<period-N>`, `<entity-N>`
  - Dollar amounts → `<amount-large>` / `<amount-small>` / nearest power of 10
  - Preserve envelope shape and field types exactly

- [ ] **Step 4 (assistant): Author `eval/oracle/REDACTION-MAP.md`** — token convention only, no real values

- [ ] **Step 5 (assistant): Verify no leak**
  ```bash
  grep -rEi 'sharechat|kali|11450275|[0-9]{6,}' eval/oracle/ | grep -v '<vendor\|<acct\|<period\|<entity\|<amount'
  ```
  Expect zero hits.

- [ ] **Step 6 (assistant): Commit + PR**
  ```bash
  git checkout -b feat/oracle-envelopes
  git add eval/capture-oracle.ts eval/oracle/ eval/oracle/REDACTION-MAP.md
  git commit -m "eval: capture redacted oracle envelopes from staging [spec: Phase 1]"
  ```

### Task 1.2 verifier rubric

- [ ] `eval/capture-oracle.ts` exists, script-only (no env defaults to prod)
- [ ] Helper reads target from `FINNY_EVAL_TARGET`; defaults to STAGING
- [ ] 20 oracle JSON files, one per canonical query
- [ ] Every oracle JSON is valid + has `shape` matching expected
- [ ] Zero matches on the redaction grep
- [ ] No tokens / JWTs / OAuth client IDs / session IDs in any oracle file
- [ ] `REDACTION-MAP.md` documents scheme without real values
- [ ] Commit message uses `[spec: Phase 1]`
- [ ] No `prod.11mirror.com` in any committed file

---

## Task 1.3: Run eval set against staging

**Plan reference:** `implementation.md` L413–454

### Sub-tasks

- [ ] **Step 1 (operator): Run eval**
  ```bash
  cd /Applications/finny-claude-plugin
  export FINNY_EVAL_TARGET=https://finny.staging.11mirror.com/mcp
  export FINNY_EVAL_TOKEN=$(op read 'op://Finny/staging-mcp-token/credential')
  pnpm eval --target $FINNY_EVAL_TARGET --oracle eval/oracle \
    --queries eval/canonical-queries.json \
    --out eval/runs/2026-MM-DD-staging-baseline.json
  unset FINNY_EVAL_TOKEN
  ```

- [ ] **Step 2 (assistant): Inspect**
  Every entry must have `status: 'pass'`. Any `fail` / `drift` blocks gate.

- [ ] **Step 3 (assistant): If not 100% pass, debug**
  Most likely cause: redaction altered structure (string→non-string coercion). Re-run capture, fix redaction, re-commit oracle. **Do NOT lower the gate.**

- [ ] **Step 4 (assistant): Commit baseline**
  `git commit -m "eval: staging baseline 100% pass [spec: Phase 1 gate]"`

### Task 1.3 verifier rubric

- [ ] Report file exists, parses as JSON
- [ ] All 20 entries `status: 'pass'`
- [ ] Zero drift / fail
- [ ] Report timestamp ≤ 1h before commit

---

## Task 1.4: Wire eval as a CI workflow

**Plan reference:** `implementation.md` L458–508

### Sub-tasks

- [ ] **Step 1 (assistant): Write `.github/workflows/eval-staging.yml`** per plan template

- [ ] **Step 2 (operator): Set repo secret**
  ```bash
  gh secret set STAGING_MCP_URL --body 'https://finny.staging.11mirror.com/mcp'
  gh secret set STAGING_MCP_TOKEN --body '<staging token>'
  ```

- [ ] **Step 3 (assistant): Push + observe first run**

- [ ] **Step 4 (assistant): Commit + PR**

### Task 1.4 verifier rubric

- [ ] Workflow file passes `actionlint`
- [ ] First scheduled or manual run completes
- [ ] On a deliberately broken PR, job fails non-zero
- [ ] On a clean PR, job passes
- [ ] `STAGING_MCP_URL` from secrets, not hardcoded

---

## Phase 1 exit checklist

When all of these check, Phase 1 is closed and Phase 2 can begin (see `finny-core` plan L716+):

- [ ] Task 1.1 verifier rubric all green
- [ ] Task 1.2 verifier rubric all green
- [ ] Task 1.3 verifier rubric all green (eval set 100% pass)
- [ ] Task 1.4 verifier rubric all green (CI workflow nightly + per-PR)
- [ ] `/etc/finny-snapshot-stamp` ≤ 24h old on staging
- [ ] Operator sign-off

---

## Decision log

| Date | Decision | Rationale |
|---|---|---|
| 2026-06-29 | Use profile-export-import path, not AMI snapshot | Prod hardware not drifted from staging meaningfully; infra parity confirmed via parallel SSM diff. AMI overhead not justified. |
| 2026-06-29 | Block Phase 1 on finny-hermes-config#3 merge | Prod is not at known-clean state until that lands; refresh-during-deploy is the failure mode the plan warns about |
| 2026-06-29 | iptables drift = expected (Tailscale) | Subagent investigation; staging has Tailscale chains because dashboard binds tailnet IP, prod does not |
| 2026-06-29 | `feat-bridge-oidc-onelogin` Draft, decision deferred to Phase 3 | OneLogin vs Zitadel v1 IdP question; Phase 3 owns authz substrate |
| 2026-06-29 | Deploy PR #3 to prod with stash-pull-restore for cron/jobs.json | Discovered cron/jobs.json is runtime-drift (written by cron tick) but was tracked. Stashed local, pulled, dropped stash. Filed as issue #11. |
| 2026-06-29 | Restart gateway after pull on prod | config.yaml skill disables (airtable, github-issues, godmode) need gateway restart to take effect |

## Activity log

| Date / Time UTC | What happened |
|---|---|
| 2026-06-29 03:32 | Pre-flight infra diff captured between prod (`i-0ef58962b09d490ee`) and staging (`i-0c2c974ff571162eb`) via parallel SSM. iptables drift resolved via subagent (= Tailscale, expected). |
| 2026-06-29 04:04 | OneLogin OIDC salvage commit `638730e` on prod, bundle-transferred via SSM port-forward, pushed to origin as `feat/bridge-oidc-onelogin`, Draft PR #23 opened. |
| 2026-06-29 04:14 | `hermes profile delete stagesnap-20260617-182341` on prod — 444MB reclaimed. |
| 2026-06-29 04:30 | Brain cron-corrections commit `129d198` on prod (95 files, +12169/-985). Manifest added 2026-06-29 ~05:00 after review feedback. PR #3 opened then updated. |
| 2026-06-29 05:00 | PR #3 merged to main (`29f98ef`). |
| 2026-06-29 05:03 | PRs #24 + #25 merged to main (`2e65017`, `53dd2c4`). |
| 2026-06-29 05:05 | 7 follow-up issues filed in finny-hermes-config (#4–#10). |
| 2026-06-29 05:10 | `deployed` fast-forwarded to `29f98ef`. Prod pulled (with stash for cron/jobs.json). Gateway restarted. Smoke test 5/5 parity. Issue #11 filed for cron/jobs.json drift. |
| **NEXT** | Phase 1 Task 1.1 — refresh staging |

## References

- Master plan: `/Applications/finny-core/docs/plan/implementation.md` L285–510
- Infra diff (snapshot): `staging-vs-prod-diff-2026-06-29.md`
- Snapshot-refresh checklist: `snapshot-refresh-checklist.md`
- Deploy runbook: `deploy-runbook.md`
- Known drift: `known-drift.md`
- Staging promotion overview: `README.md`
