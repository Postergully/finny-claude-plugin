# Staging vs Prod infrastructure diff — 2026-06-29

**Captured by:** parallel SSM `pip freeze` + `git status` + sha256sum sweep against both EC2s, 2026-06-29 03:32 UTC.

**Prod:** `i-0ef58962b09d490ee` (us-east-1) · `finny.prod.11mirror.com`
**Staging:** `i-0c2c974ff571162eb` (us-east-1) · `finny.staging.11mirror.com`

## Headline

| Question | Answer |
|---|---|
| Was `pip install -e .` ever used? | **No.** Both run `hermes-agent==0.14.0` wheel-installed. No editable markers in either `pip freeze`. |
| Is `~/.hermes/hermes-agent/` checkout what the runtime imports? | **No.** Runtime imports from `/home/ubuntu/hermes-venv/lib/python3.12/site-packages/hermes_agent-0.14.0.dist-info`. The git checkout is dev-scratch, inert at runtime. |
| Is the atomic-fetch-v3 work in Python code or skill/config layer? | **Skill + profile layer.** `feat/atomic-fetch-v3` lives in `finny-hermes-config` repo (skills + profile + memories), not `finny-hermes` (agent Python code). Confirmed by the branch HEAD message: "hindsight via hindsight_client" — uses existing client, no core agent changes. |
| Are there any orphaned in-place edits to hermes-agent that would be lost without AMI? | **One orphan on staging:** `~/.hermes/hermes-agent/agent/system_prompt.py` +19 lines uncommitted + `.bak-v3probe` sibling file. Inert at runtime (wheel install ignores it). Treat as throwaway probe work unless operator says otherwise. |
| Is prod a "clean" prod we can mirror from? | **No — prod has significant uncommitted drift across multiple surfaces.** See "PROD DRIFT" section below. This is a separate problem from the staging refresh and needs operator decision. |

## Drift inventory

### 1. Python venv packages (`pip freeze` diff)

| Package | Prod | Staging |
|---|---|---|
| oauthlib | (absent) | `3.3.1` |
| requests-oauthlib | (absent) | `2.0.0` |

**Interpretation:** Staging has 2 extra packages, prod has none extra. Likely installed manually during hermes-config OAuth experimentation (not via wheel deps — hermes-agent 0.14.0 wheel doesn't pull these). Low risk; both are well-known OAuth libs. Action: drop from staging on refresh, or pin in a requirements file if intentional.

**Freeze SHA:**
- Prod: `ccb7fef7dba833985ad72ff324c531a3d415b429ade43612dc58bb4871dce701`
- Staging: `b2b700702c458ce09ab5116272aeb970357b9bf45e13b468f2a6a4cd02fdf1dc`

### 2. `~/.hermes/hermes-agent/` (git checkout, runtime-inert)

| Side | Branch | HEAD | Uncommitted |
|---|---|---|---|
| Prod | `deployed` | `c3bdb2af3` | `web/package-lock.json` (-25 lines) |
| Staging | `deployed` | `c3bdb2af3` | `web/package-lock.json` (-25 lines, same as prod) + `agent/system_prompt.py` (+19 lines) + `agent/system_prompt.py.bak-v3probe` (untracked) |

**Branch + HEAD identical** — both at the same `deployed` SHA. Same `web/package-lock.json` drift on both sides (probably npm ci side-effect). Staging-only orphan: `agent/system_prompt.py` probe edits.

**Action:**
- Prod's `package-lock.json` drift: harmless but worth committing or `git checkout -- web/package-lock.json` to get clean.
- Staging's `system_prompt.py` probe: confirm with operator → likely `git checkout --` + `rm .bak-v3probe`.

### 3. `~/.hermes/` (admin checkout — the "config + skills + memories" repo)

| Side | Branch | HEAD | Uncommitted |
|---|---|---|---|
| Prod | `deployed` | `1630537` (`feat(SKILL.md): rewrite for primitive composition + few-shot patterns; v2.0 archived as .phase1.bak`) | `config.yaml`, `cron/jobs.json`, `memories/MEMORY.md`, `memories/USER.md`, `skills/.curator_state`, `skills/.usage.json`, `skills/finny-brain-ops/SKILL.md`, `skills/finny-brain-ops/hindsight-brain/SKILL.md`, `skills/finny-brain-ops/references/_output-rules.md`, `skills/finny-brain-ops/references/accounting-period-close.md` |
| Staging | `feat/atomic-fetch-v3` | `7c41e94` | `skills/netsuite-suiteql/references/resolver.md`, `active_profile` (untracked), and a large bundled-manifest tree under `profiles/finny/skills/` (untracked) |

**Critical observation:** **prod has 10 uncommitted files** in `~/.hermes/` — including `skills/finny-brain-ops/SKILL.md` and supporting reference docs. Some of these are runtime drift (`memories/MEMORY.md`, `skills/.usage.json`, `skills/.curator_state`) which is expected — those are written by the agent itself during operation. But the `SKILL.md` and `references/*.md` edits are content edits that need to be in a commit.

**Action — this is its own decision, not just a staging issue:**
- Audit prod's `~/.hermes/` uncommitted files. Split into "runtime-generated drift" (memories, .usage.json, .curator_state — leave alone or .gitignore) vs "operator content edits" (SKILL.md, references) which need a PR.
- Staging's atomic-fetch-v3 branch is separate work that needs to land via PR (see Phase B in the refresh plan).
- After both are reconciled: prod and staging on same branch + same HEAD = mirror.

### 4. `/etc/systemd/system/` (system units)

| Unit | Prod sha256 | Staging sha256 | Match? |
|---|---|---|---|
| `finny-mcp.service` | `1ac207bf...aeed3fc` | `1ac207bf...aeed3fc` | ✓ identical |
| `finny-dashboard.service` | `a26e832b...3131e802c1` | `a26e832b...3131e802c1` | ✓ identical |

**No drift.** System-level finny units are byte-identical.

### 5. `~/.config/systemd/user/` (user units)

| Unit | Prod sha256 | Staging sha256 | Match? |
|---|---|---|---|
| `hermes-gateway.service` | `ed442ad1...91e827` | `fb03548c...0c835d983` | ✗ **DRIFT** |
| `hermes-dashboard.service` | `8cfdc4e2...3cdb25cbc` | `67f58591...0ab814d2` | ✗ **DRIFT** |

**Action:** sha256 doesn't tell us what differs. Need to actually diff the files. Most likely: staging units have staging-specific paths/env, or one side is on a newer unit definition. Capture both, diff, decide which is canonical.

### 6. Caddyfile

| Side | sha256 |
|---|---|
| Prod | `3387746f...0bc09a72` |
| Staging | `657a9339...64df6102` |

**Expected drift** — staging serves `finny.staging.11mirror.com` + dashboard vhost on tailnet IP; prod serves `finny.prod.11mirror.com`. Per the two-listener model in `docs/staging/README.md`. **No action needed** beyond confirming the diff is the expected staging-vhost block and nothing else.

### 7. `/opt/finny/` (bridge + dashboard checkout)

| Side | Branch | HEAD | Uncommitted |
|---|---|---|---|
| Prod | `deployed` | `faf4215` | `bridge/package.json`, `bridge/package-lock.json`, `bridge/src/server/http.ts`, `bridge/tsup.config.ts`, plus untracked: `bridge/src/auth/access-db.ts`, `bridge/src/auth/oidc.ts`, `dashboard.bak.20260619-190104/`, `dashboard/` |
| Staging | `deployed` | `faf4215` | Untracked: `dashboard.bak.20260625-235100/`, `dashboard.bak.20260626-002450/`, `dashboard.bak.20260626-003812/`, `dashboard/` |

**Branch + HEAD identical** — both at the same `deployed` SHA. But:

**🚨 Prod has uncommitted bridge edits + two new auth files.** `bridge/src/auth/access-db.ts` and `bridge/src/auth/oidc.ts` are **brand new files that don't exist in any commit**. Combined with `bridge/src/server/http.ts` modifications, this looks like an in-progress auth feature being developed directly on prod. **This is the most surprising finding in this entire diff.** It violates the deployed-branch model. Either:
- (a) Active development is happening on prod, in which case prod is no longer a clean "ready to deploy" target and our deploy-branch model is being bypassed.
- (b) These are stale leftovers from an aborted experiment that should be `git clean`'d.

Operator needs to investigate and decide.

**`dashboard/` and `dashboard.bak.*`:** the `.bak.` directories suggest the dashboard tarball-deploy mechanism leaves backups on disk (matches PR #21 "disk-safety + atomic rollback"). Staging has 3 backups, prod has 1 — corresponds to deploy frequency. Eventually need a retention policy; not blocking.

### 8. iptables — RESOLVED (subagent investigation 2026-06-29)

| Side | Actual rule count | Source |
|---|---|---|
| Prod | 0 rules (filter/nat/mangle empty, default ACCEPT) | Vanilla — not on tailnet |
| Staging | 14 rules across filter/nat/mangle, ALL in Tailscale chains (`ts-input`, `ts-forward`, `ts-postrouting`) | `tailscaled` injects at start |

**Original "8 vs 25" count was wrong** — included chain headers and both directions.

**Verdict: NOT drift, expected by design.** Staging hosts the dashboard on tailnet IP `100.112.31.24` per the two-listener model (`CLAUDE.md`). Prod is not on tailnet. Tailscale's userspace rule installation is byte-for-byte standard — counters confirm legitimate traffic (1.7M pkts / 3.4GB through `ts-input`).

**No `FINNY_EGRESS` chain exists on either side** — Phase 2 Task 2.3 starts greenfield.

**No reconciliation needed before Phase 2.** Phase 2 Task 2.3 will add `FINNY_EGRESS` as a new dedicated chain hooked from `OUTPUT` via `-m owner --uid-owner` — different match keys and direction from `ts-*`, no collision.

**Action:** snapshot `iptables-save` output into the manifest before Phase 2 so future drift is detectable. Otherwise, no action.

### 9. dpkg packages

caddy, nodejs, python3.12, build-essential — **all identical versions on both sides.** No drift.

### 10. `/etc/finny-snapshot-stamp`

| Side | State |
|---|---|
| Prod | (not checked — file is staging-specific concept per plan) |
| Staging | **MISSING** |

Plan calls for this file. Never adopted. **Action:** create on staging during refresh; document the convention in `docs/staging/snapshot-refresh-checklist.md`.

## Severity ranking

| # | Drift | Severity | Blocks Phase 2? |
|---|---|---|---|
| 7 | Prod has uncommitted bridge auth files (`access-db.ts`, `oidc.ts`) + bridge/server edits | 🔴 **High** | Yes — prod is not a clean mirror source while this is unresolved |
| 3 | Prod has 10 uncommitted files in `~/.hermes/` including SKILL.md content | 🟡 **Medium** | No, but should be resolved before claiming prod-mirror parity |
| 8 | ~~iptables rule count diff (8 vs 25)~~ | 🟢 **Resolved** | No — Tailscale chains on staging only, expected by design |
| 1 | Staging has extra oauthlib + requests-oauthlib | 🟢 **Low** | No |
| 5 | Hermes user-systemd units sha-differ | 🟢 **Low** | No — content diff likely cosmetic |
| 2 | Staging probe edits in `system_prompt.py` | 🟢 **Low** | No — inert at runtime |
| 6 | Caddyfile differs | 🟢 **Low** | No — expected by design |

## Recommendation

The original three-tier plan assumed prod was clean. **It isn't.** Two paths forward:

### Path 1 — Clean prod first, then mirror to staging (~1-2 days, ordered)

Sequence:
1. **Audit prod's uncommitted state.** Each high/medium-severity drift item gets a decision: commit + PR through deployed-branch flow, or `git clean` as throwaway.
2. **Particularly the bridge auth files** — investigate origin, decide if this is real WIP (then it needs a feature branch + staging walk + manifest + PR) or stale (then `git clean -fd bridge/src/auth/access-db.ts bridge/src/auth/oidc.ts` + checkout the other modified files).
3. **Reconcile iptables.** Dump both, diff, decide canonical.
4. **Land atomic-fetch-v3 from staging to prod.** Via proper PR + manifest + deployed-branch flow.
5. **Now prod is clean.** Three-tier refresh staging → prod.
6. **Phase 2 starts.**

### Path 2 — Defer prod cleanup, treat current prod-as-is as the source (~30 min)

Sequence:
1. Snapshot prod-as-is (including its uncommitted drift) via three-tier refresh:
   - Profile export/import for `~/.hermes/profiles/...`
   - rsync the `~/.hermes/` admin checkout from prod to staging at its actual current state (drift and all)
   - rsync `/opt/finny/` from prod to staging at its actual current state (drift and all)
   - Copy prod's iptables rules to staging
2. Land atomic-fetch-v3 separately via PR before merging Phase 2 work.
3. Phase 2 starts against staging-that-mirrors-prod-warts-included.
4. Prod cleanup happens later, separately.

### Recommendation: **Path 1** — but with a tight scope

Path 2 normalizes the rule violation that has prod with uncommitted auth files. That's the slow-burn problem that bites in 3 months when nobody remembers what those files were. Path 1 fixes the discipline gap.

But Path 1 doesn't need to be a 2-day project. The bridge auth files question is **15 minutes of operator investigation** (look at the files, remember/decide what they were, kill or keep). The `~/.hermes/` SKILL.md edits are similar (~30 min audit). iptables diff is mechanical. Total: maybe 2-3 hours of focused operator work before staging refresh can start.

## What I need from operator

Before any refresh proceeds, decisions on:

1. **Bridge auth files** (`/opt/finny/bridge/src/auth/access-db.ts`, `oidc.ts`, plus modified `http.ts`, `package.json`, `package-lock.json`, `tsup.config.ts` on prod): real WIP or kill?
2. **`~/.hermes/` SKILL.md edits on prod** (`skills/finny-brain-ops/SKILL.md`, `references/_output-rules.md`, `references/accounting-period-close.md`, `skills/finny-brain-ops/hindsight-brain/SKILL.md`): commit via PR, or revert?
3. **Staging probe edits** (`~/.hermes/hermes-agent/agent/system_prompt.py` + `.bak-v3probe`): preserve to tarball, or discard?
4. **iptables drift:** ok to dump both and reconcile, or are the staging extras known/intentional?
5. **Path 1 vs Path 2.**
