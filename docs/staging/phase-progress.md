# Phase 1 & 2 — Staging parity + SOUL/AGENTS split (running progress tracker)

**Plan source:** `/Applications/finny-core/docs/plan/implementation.md` L285–966
**Started:** 2026-06-29
**Owner:** Operator (Kali) + Assistant (SSM-driven)

## Phase status overview

| Phase | Status | Notes |
|---|---|---|
| **Phase 1 — Staging parity** | 🟡 Partial complete | Task 1.1 done; 1.2/1.3/1.4 (eval set) deferred to a dedicated session |
| **Phase 2 — SOUL/AGENTS split + per-UID hardening** | 🟢 In progress | Task 2.1 PR open (finny-hermes-config#12); 2.2/2.3/2.4 next |

**Phase 1 gate:** Staging refreshed from current prod snapshot · oracle envelopes captured (deferred) · eval 100% pass (deferred) · CI workflow (deferred). 1.1 alone is enough to unblock Phase 2.

**Phase 2 gate:** Fresh client profile loads only the AGENTS.md overlay · touching SOUL.md doesn't require client edits · cross-profile `cat .env` denied at OS layer · SuiteQL guard at bridge.

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

- [x] Task 1.1 verifier rubric all green (2026-06-29)
- [ ] Task 1.2 verifier rubric all green — **deferred**
- [ ] Task 1.3 verifier rubric all green (eval set 100% pass) — **deferred**
- [ ] Task 1.4 verifier rubric all green (CI workflow) — **deferred**
- [x] `/etc/finny-snapshot-stamp` written on staging (2026-06-29)
- [x] Operator sign-off for proceeding to Phase 2 without 1.2/1.3/1.4

Phase 1 closed (with deferred sub-tasks tracked). Phase 2 in progress.

---

## Phase 2 — SOUL/AGENTS split + per-UID hardening

**Plan reference:** `implementation.md` L716–966.

**Phase gate:** Fresh client profile loads only the AGENTS.md overlay · touching SOUL.md doesn't require client edits · cross-profile `cat .env` denied at OS layer · SuiteQL guard at bridge.

### Tasks

| # | Task | Repo | PR | Status |
|---|---|---|---|---|
| 2.1 | Extract SOUL.md from AGENTS.md (additive) | finny-hermes-config | [#12](https://github.com/Postergully/finny-hermes-config/pull/12) | ✅ Open for review |
| 2.2 | Runtime loader merge (SOUL + AGENTS, [invariant] precedence) | finny-hermes | [#9](https://github.com/Postergully/finny-hermes/pull/9) | ✅ PR open, awaiting smoke + merge + deploy + activation |
| 2.3 | Per-UID hardening for client-admin profile | finny-hermes-config | — | Pending |
| 2.4 | SuiteQL parameterization at the bridge | finny-claude-plugin | — | Pending |

### Task 2.1 — completed 2026-06-29

Additive multi-tenant layout. Root files byte-identical (no runtime change). New files:
- `common-infra/SOUL.md` (154 lines, 18 `[invariant]` tags) — identity, security, authority, envelope contract, mandatory-first-call rule, memory write-back
- `common-infra/README.md` — load order docs + editing policy
- `client-overlays/sharechat/AGENTS.md` (89 lines = 46% of original 195) — tenant context, first-call script body, resolver pointers, SuiteQL execution rules, lolly archive

Manifest: `finny-hermes-config/docs/staging/soul-agents-split-changes.md`.
Deploy is safe (additive). No restart needed. Loader still reads root files.

### Task 2.2 — shipped 2026-06-29

Per plan L778-826 (with 2026-06-29 amendment — see decision log below).

PR: [finny-hermes#9](https://github.com/Postergully/finny-hermes/pull/9) @ `0231263` on branch `soul-agents-merge`.

**What landed:**
- New `InvariantConflict` exception in `agent/prompt_builder.py`
- Pure `_merge_invariants(soul, overlay) -> str` (string in, string out — no I/O)
- Extended `load_soul_md()` with conditional `FINNY_OVERLAY_PATH` env-var branch
- Untouched: `_load_agents_md`, `build_context_files_prompt`, fallback chain (verified byte-identical via diff)
- Tests: 9 new pass + 123 existing pass
- Diff: 284 insertions across 2 files

**Spec amendment that landed in the implementation:**
- Loader does NOT live in `hermes_agent/context_loader.py` (plan pseudocode was wrong). Real location: `agent/prompt_builder.py:1300-1448`
- Topology was NOT `load_context(soul, agents)` — actual loader uses `load_soul_md()` zero-arg + `_load_agents_md(cwd)` single-arg with a first-match-wins fallback chain
- Task 2.2 became ADDITIVE rather than replacement: extended `load_soul_md()` instead of replacing the topology
- Feature-flagged via `FINNY_OVERLAY_PATH` env var — default (unset) preserves byte-identical pre-PR behavior for upstream Hermes users
- `[invariant]` conflict semantics: SOUL is authoritative over the **entire** `[invariant]` namespace. Overlays can only echo verbatim (silent dedupe); ANY new or changed `[invariant]` line in overlay raises `InvariantConflict`. Stricter than the plan's "duplicate keys raise" phrasing — worker's judgment call confirmed by operator.

**Operator-owned cutover steps:**
1. Staging smoke per PR body (gateway restart + journal scan, no errors in 5 min window)
2. Merge `finny-hermes#9` to main
3. Bundled deploy of finny-hermes-config (3 commits pending: PR #12 SOUL/AGENTS split + manifests + tracker update) + finny-hermes (PR #9 loader) together
4. Set `FINNY_OVERLAY_PATH=/home/ubuntu/.hermes/client-overlays/sharechat/AGENTS.md` in staging gateway systemd unit / profile `.env` to ACTIVATE the overlay
5. Verify activation: cowork query against staging should reflect merged SOUL+overlay content
6. **Sidequest while SSM'd in:** fix [finny-hermes-config#11](https://github.com/Postergully/finny-hermes-config/issues/11) (cron/jobs.json runtime drift — gitignore it) — small scope, big QoL win, prevents future deploy-pull friction
7. Update this tracker marking 2.2 fully closed + activation step logged

### Task 2.3 — per-UID hardening

Per plan L830-907. New system user per profile (`hermes-sharechat`), chown profile dir 0700, .env 0600, systemd template `finny-profile@.service` with `ProtectSystem=strict NoNewPrivileges=yes`, iptables OWNER egress allowlist. Cross-UID `cat .env` must return Permission denied.

### Task 2.4 — SuiteQL guard at bridge

Per plan L910-965. Create `bridge/src/intents/suiteql-guard.ts` with `sanitizeSuiteQL()` — allow SELECT/WITH only, reject DDL/DML keywords, reject `;`/`--`/`/*`. Wire into every SuiteQL call site in bridge. 6 unit tests.

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
| 2026-06-29 | Refresh staging in-place (not AMI re-image) for Task 1.1 | finny-hermes-config#3 already deployed to prod; just need staging checkouts to match. Quarantined `staging.preimport` orphan (mirror of the stagesnap problem on prod). |
| 2026-06-29 | Defer Phase 1.2/1.3/1.4 (eval canonical queries) | Phase 2 (SOUL/AGENTS split) doesn't need the eval set; it has its own exit gate. Eval set is a 1-2 day side quest that doesn't block Phase 2 architecture work. Will revisit when needed. |
| 2026-06-29 | Phase 2 Task 2.1 — additive only, no root file changes | Root SOUL.md + AGENTS.md are loaded by current gateway. Moving them breaks staging until Task 2.2 loader change ships. Split files into `common-infra/` + `client-overlays/sharechat/` alongside root; root deleted after Task 2.2 ships. |
| 2026-06-29 | Envelope contract → SOUL.md (platform invariant) | Envelope shape is enforced by the bridge regardless of client. All future multi-tenant clients use the same envelope. Goes in SOUL, not AGENTS. |
| 2026-06-29 | Mandatory first-call rule → SOUL.md, script path → AGENTS.md | The *requirement* to run a first-call script is platform-invariant (skipping costs 14s + risks hallucinated imports). The *specific script* (atomic_fetch.py path, payload shape) is client-specific. |
| 2026-06-29 | Task 2.2 — additive `FINNY_OVERLAY_PATH` extension, not loader replacement | Plan pseudocode (`load_context(soul, agents)`) didn't match real `finny-hermes` topology (`load_soul_md()` + `_load_agents_md(cwd)` with fallback chain). Replacement would silently change prompt shape for every upstream Hermes user. Feature-flagged opt-in preserves byte-identical default behavior. |
| 2026-06-29 | Task 2.2 — `[invariant]` namespace is SOUL-authoritative | Plan said "duplicate keys raise on conflict" but didn't cover new-key-in-overlay case. Worker chose stricter "overlays can only echo verbatim; any new or changed `[invariant]` line raises `InvariantConflict`." Operator confirmed: invariants are platform-level (Neuu Labs domain); allowing overlays to add invariants would let clients elevate tenant-specific behavior to platform-immutable status, breaking the layering model. Future extension if needed: namespaced invariants like `[invariant tenant:<client>]`. |
| 2026-06-29 | **Process rule: locate-the-function preflight for finny-hermes Python tasks** | Phase 2-9 tasks that modify `finny-hermes` Python MUST include a preflight step BEFORE worker dispatch: (a) file path of target function, (b) actual signature copy-pasted from source, (c) caller inventory via `grep -rn`, (d) test path. Plan pseudocode is no longer sufficient — must be reality-grounded. Triggered by the Task 2.2 halt-and-rescope cycle (signal `verifier-spec-vs-reality-conflation` went 2→3). Saves the loop a strike on every future Python task. |

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
| 2026-06-29 05:13 | Phase 1 Task 1.1 — staging refreshed in-place: `~/.hermes` + `~/.hermes/profiles/staging` checkouts → `deployed @ 29f98ef`. Probe edits in `system_prompt.py` discarded. `staging.preimport` orphan profile (421MB) quarantined to `/tmp`. `/etc/finny-snapshot-stamp` written. Gateway restarted. |
| 2026-06-29 05:24 | Operator ran query 1 ("vendor balance for Google Cloud India") — correct answer, but gateway log showed Finny tried 4 hallucinated `netsuite_kb` imports before recovering. atomic_fetch.py NOT called as first tool. Investigation: AGENTS.md mandate is present (line 109) but agent chose not to follow. Filed as instruction-following gap (not infra). |
| 2026-06-29 ~05:50 | Phase 1.2/1.3/1.4 (eval canonical queries + capture + CI) **deferred** per operator decision to a dedicated eval-build session. Phase 2 unblocked. |
| 2026-06-29 06:00 | Phase 2 Task 2.1 — SOUL/AGENTS split shipped additively. `common-infra/SOUL.md` (154 lines, 18 `[invariant]` tags), `common-infra/README.md`, `client-overlays/sharechat/AGENTS.md` (89 lines = 46% of original). Root files byte-identical. Verifier rubric all PASS. PR finny-hermes-config#12 open. |
| 2026-06-29 (later) | Phase 2 Task 2.2 dispatched, worker halted at locate-the-function step (plan pseudocode `load_context(soul, agents)` didn't match real `finny-hermes` topology). Spec amendment landed: additive `FINNY_OVERLAY_PATH` extension, namespace-locked `[invariant]` conflict rule, locate-the-function preflight rule added to decision log. Worker resumed on amended spec. |
| 2026-06-29 (later) | Phase 2 Task 2.2 shipped — finny-hermes#9 @ `0231263` on `soul-agents-merge`. 284 insertions across 2 files, 9 new tests + 123 existing pass. Awaiting operator-owned: staging smoke → merge → bundled deploy with finny-hermes-config 3-commit backlog → set `FINNY_OVERLAY_PATH` to activate overlay. |
| **NEXT** | Operator-owned cutover for Task 2.2 (steps 1-7 in Task 2.2 section above). Then **Task 2.3 — per-UID hardening** in finny-hermes-config. Task 2.4 (SuiteQL guard at bridge) can run in parallel since it's independent. |

## Phase 2 → Phase 3 transition gate

Before Phase 3 begins (Distr packaging + Setup view + Zitadel), the following MUST close:

- [ ] Phase 0 — eval canonical query set (Task 0.1) defined + checked into repo
- [ ] Phase 1.2 — oracle envelopes captured from staging
- [ ] Phase 1.3 — baseline eval 100% pass on staging
- [ ] Phase 1.4 — eval-staging CI workflow nightly + per-PR

**Why:** The HTML spec (`docs/superpowers/specs/2026-06-23-finny-multitenant-architecture.html` v3.1) puts the eval-set parity gate at **Spec Phase 1 exit**. Plan deferred Phase 1.2-1.4 to fit a Phase 2 implementation window, but spec Phase 2 ("Parallel Change on staging") and Phase 3 ("Synthetic 2nd tenant") both have explicit gates that require the eval set to exist ("ShareChat eval set still 100% green" / "Both eval sets green simultaneously"). Phase 3 is where Zitadel + Distr packaging land — architectural complexity jumps significantly. Catching parity regressions at that boundary without the eval scaffold is much harder than catching them at the Task 2.2/2.3/2.4 boundary.

**Forcing function:** Plan Phases 2.3 and 2.4 may ship without the eval set (operator decision 2026-06-29). Plan Phase 3 may NOT start without it. Phase 2 → Phase 3 is the latest viable window to author the eval set.

## References

- Master plan: `/Applications/finny-core/docs/plan/implementation.md` L285–510
- Infra diff (snapshot): `staging-vs-prod-diff-2026-06-29.md`
- Snapshot-refresh checklist: `snapshot-refresh-checklist.md`
- Deploy runbook: `deploy-runbook.md`
- Known drift: `known-drift.md`
- Staging promotion overview: `README.md`
