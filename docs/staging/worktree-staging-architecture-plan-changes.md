# Staging changes: `worktree-staging-architecture-plan`

**Date tested:** `2026-06-17` (staging dry-run complete)
**Tested by:** `Postergully` (via Claude Code, SSM)
**Staging snapshot baseline:** prod AMI `ami-08fdfeb433908de8b` (refresh status: ~2 days old at start)
**PR:** `#<TBD>`

This is PR1 of the Phase 5 sequence. It introduces the staging-tier discipline docs **and** the deployed-branch model on all 3 repos.

## Git changes (replay via merge)

- `finny-claude-plugin@worktree-staging-architecture-plan`: docs only on this branch
  - `CLAUDE.md` — step 9 split into 9a/9b; deployed-branch model section added
  - `docs/staging/README.md` — same split + deployed-branch model section + updated file list
  - `docs/staging/MANIFEST-TEMPLATE.md` — deploy decision section + non-git-changes framing update
  - `docs/staging/deploy-runbook.md` — new file
  - `docs/staging/setup-deployed-branch.md` — new file (baseline-delta invariant for `~/.hermes`)
  - `docs/staging/known-drift.md` — new file (inventory of accepted-baseline working-tree drift)
  - `docs/staging/worktree-staging-architecture-plan-changes.md` — this file
  - `docs/staging/snapshot-refresh-checklist.md` — pre-existing from Phase 1-3
- `finny-hermes@<branch>`: no changes
- `finny-hermes-config@<branch>`: no changes
- `netsuite-kb@<branch>`: no changes

## Deploy decision

- [x] **Deploy immediately after merge** — the doc changes are inert until the operator runs the setup-deployed-branch runbook, which is also what counts as "deploying" PR1.

## Non-git changes (replay manually on prod, in order)

> Run these as part of PR1's deploy. After completion, all 3 repos use the deployed-branch model.

### Step 1 — Create `deployed` branches on origin (for each repo, on a workstation with push access)

1. **finny-claude-plugin**:
   - **Command run:** `git fetch origin && git branch deployed a40d868 && git push origin deployed`
   - **Why:** prod is on `a40d868` (on `main` at the time prod last deployed). Origin/main has since moved to `7b46029` (3 auth/zitadel commits ahead — pending deploy, not running). `deployed` must reflect what's running, not what main says.
2. **finny-hermes-config**:
   - **Command run:** `git fetch origin && git branch deployed origin/feat/atomic-fetch-phase-2 && git push origin deployed`
   - **Why:** prod is on `feat/atomic-fetch-phase-2` (currently `1630537`); deployed must reflect what's running, not what main says. This drift is documented and will be closed by PR3+4.
3. **finny-hermes**:
   - **Command run:** `git fetch origin && git branch deployed origin/main && git push origin deployed`
   - **Why:** prod is on main; deployed should equal main's tip (currently `c3bdb2a`)

### Step 2 — GitHub branch protection on `deployed` (per repo)

4. For each repo, configure branch protection on `deployed`:
   - **Command run:** `gh api -X PUT /repos/<org>/<repo>/branches/deployed/protection -f required_linear_history=true -f allow_force_pushes=true -f allow_deletions=false` (or via web UI)
   - **Why:** prevents accidental commits to deployed; allows operator force-push for rollback only

### Step 3 — Switch prod's checkout to `deployed` (via SSM, per repo)

5. **finny-claude-plugin** at `/opt/finny`:
   - **Command run:** see `setup-deployed-branch.md` § "Step 3 — finny-claude-plugin (strict invariant)"
   - **Invariant:** strict — `git status --porcelain` empty before AND after; `git diff HEAD origin/deployed` empty
   - **Why:** prod's `/opt/finny` is clean; switching from main to deployed is a no-op for the working tree
6. **finny-hermes-config** at `~/.hermes`:
   - **Command run:** see `setup-deployed-branch.md` § "Step 3 — finny-hermes-config (baseline-delta invariant — the drift case)"
   - **Invariant:** baseline-delta — capture porcelain `.before`, do checkout, capture `.after`, `diff` must be empty
   - **Why:** prod's `~/.hermes` carries known runtime dirt (see `known-drift.md`); byte-equality of tracked files (`git diff HEAD origin/deployed`) is the actual safety guarantee. Switching from `feat/atomic-fetch-phase-2` to `deployed` is a no-op (both point at `1630537`).
7. **finny-hermes** at `~/.hermes/hermes-agent`:
   - **Command run:** see `setup-deployed-branch.md` § "Step 3 — finny-hermes (likely strict, but check first)"
   - **Invariant:** strict if porcelain empty; baseline-delta if porcelain shows files (e.g., `web/package-lock.json` per audit)
   - **Why:** byte-equality verified pre-checkout regardless of which invariant fires

### Step 4 — Verify no restart needed

8. Per repo, confirm post-checkout invariant holds and unit uptimes unchanged:
   - For `/opt/finny`: `git status --porcelain` must be empty (strict).
   - For `~/.hermes` and `~/.hermes/hermes-agent`: porcelain `.before`/`.after` `diff` must be empty (baseline-delta).
   - **Command run:** `systemctl status finny-mcp` and `sudo -iu ubuntu systemctl --user status hermes-gateway` — uptimes unchanged
   - **Why:** byte-equality means no restart should be necessary; verifying ensures we didn't accidentally trigger one

### Step 5 — Smoke

9. Public MCP smoke + 1 read-only `finny_query` via cowork connector:
   - **Command run:** `curl -sSI https://finny.prod.11mirror.com/mcp | grep -iE 'www-authenticate|http/'` + connector test
   - **Why:** confirm the switchover preserved user-visible behavior

### Step 6 — Record in deploy log

10. Append to `docs/staging/deploy-log.md` (create if missing):
    - **Command run:** edit the file, capture pre-and-post SHAs per repo, byte-equality verification, smoke result
    - **Why:** establishes the deploy-log discipline for future deploys

## What was tested on staging

- [x] Discipline docs reviewed for internal consistency (CLAUDE.md ↔ README.md ↔ runbooks)
- [x] Dry-run of `setup-deployed-branch.md` against staging EC2 (`i-0c2c974ff571162eb`) on 2026-06-17:
  - [x] Created `deployed` branches on origin for all 3 repos at the prod-running SHAs (a40d868 / 1630537 / c3bdb2a)
  - [x] Switched staging's checkouts to `deployed` per repo
  - [x] Strict invariant verified on `/opt/finny` (porcelain empty before & after)
  - [x] Baseline-delta invariant verified on `~/.hermes` (49 lines before == 49 after, diff empty)
  - [x] Baseline-delta invariant verified on `~/.hermes/hermes-agent` (1 line before == 1 after, diff empty)
  - [x] Verified no restart triggered (finny-mcp uptime preserved at 2 days, hermes-gateway at 1d 23h)
- [x] Surface smoke against `https://finny.staging.11mirror.com/mcp` post-switch:
  - [x] MCP endpoint returns RFC 9728 challenge (`HTTP/2 401` + `www-authenticate: Bearer ... resource_metadata=...`)
  - [x] OAuth protected-resource metadata correct (`resource: https://finny.staging.11mirror.com/`)
  - [x] OAuth authz server metadata correct (issuer/authorize/token all on staging)
  - [x] Recent journal logs clean (no errors on finny-mcp or hermes-gateway in the 5-min window post-switch)
- [ ] 5-tool browser cowork smoke against staging (deferred — surface smoke deemed sufficient for a no-op switch; original author to exercise tools manually before merge if desired)
- [ ] Desktop app dashboard chat against tailnet IP (deferred — same reason)
- [ ] No-Slack-bleed sanity check during the staging window (deferred — switch was a no-op, no agent activity triggered)

## Skipped on prod (staging-only changes)

> None. The setup is identical on staging and prod by design — staging is the dry-run, prod is the final apply.

## Known deferred work

PR1 establishes the deployed-branch model and accepts existing working-tree drift on `~/.hermes` (and possibly `~/.hermes/hermes-agent`) as a baseline. **It does not reconcile that drift.** A follow-up PR will:

1. Snapshot every modified-but-uncommitted tracked file's working-tree contents on prod.
2. Per-file decision: commit (real work, e.g., `memories/MEMORY.md` Hindsight DUAL-BANK entries), revert (accidental), or gitignore (runtime artifact).
3. Triage untracked files: gitignore, commit, or delete.
4. Run the reconciliation through the new discipline (branch → staging → manifest → merge → deploy).
5. Once the working tree is clean, retire the baseline-delta exception and restore the strict invariant everywhere.

Inventory: `docs/staging/known-drift.md`. Re-snapshot prod before starting the reconciliation PR — that file is staging-audit-derived, not authoritative.

PR1 is **not** blocked on this work — the byte-equality safeguard (`git diff HEAD origin/deployed`) protects tracked-file content during the rollout regardless of working-tree dirt.

## Rollback

If something goes sideways during PR1's prod apply:

1. **If branch creation step (Step 1) caused issues:** `git push --delete origin deployed` per repo. No prod impact yet.
2. **If branch protection step (Step 2):** disable the protection rule via GitHub UI. No prod impact.
3. **If the checkout switch (Step 3) failed on a repo:** `sudo -iu ubuntu bash -lc "cd <path> && git checkout <previous-branch>"`. Verify the appropriate invariant and unit uptimes unchanged. Repos:
   - `/opt/finny` → previous branch was `main` — verify `git status --porcelain` empty (strict)
   - `~/.hermes` → previous branch was `feat/atomic-fetch-phase-2` — verify porcelain `diff` against the pre-checkout `.before` snapshot is empty (baseline-delta); the pre-existing dirt should be unchanged
   - `~/.hermes/hermes-agent` → previous branch was `main` — strict if porcelain was empty pre-checkout, else baseline-delta
4. **Revert PR1**: `git revert <merge-sha>` on `finny-claude-plugin`. Restores discipline docs to the pre-PR1 state.
5. Restart units only if Step 4's verification showed they had been restarted (unexpected).

## Notes / surprises

### From staging dry-run (2026-06-17)

1. **finny-claude-plugin had drift too, not just finny-hermes-config.** Origin/main is at `7b46029` (3 auth/zitadel commits ahead: token expiry → 10 years, removed Google auth code, merge). Prod is at `a40d868`. The deployed-branch model handles this correctly — `deployed` was created at `a40d868`. After PR1 lands, `git log deployed..main` will show the auth WIP as pending deploy. This had to be reflected in the docs mid-rollout.

2. **`git checkout deployed` produced `M <file>` lines** for tracked files with working-tree edits (e.g., `~/.hermes`'s 12 modified files). This is git reporting "modifications carried across the branch switch" — *not* a real diff. Both pre and post HEAD SHAs matched origin/deployed; the byte-equality safeguard was satisfied. Documented this in `setup-deployed-branch.md` so future operators don't panic.

3. **Staging has more untracked artifacts than the original prod-derived inventory.** Pytest installed into the netsuite-suiteql venv, `atomic_fetch.py.backup`, `itc-computation-logic.md` untracked authoring. Captured in `known-drift.md` with a 2026-06-17 timestamp. The reconciliation PR will re-snapshot prod (which differs from staging) before deciding per-file action.

4. **Surface smoke green, no restart triggered, no listener disruption.** finny-mcp uptime preserved at 2 days, hermes-gateway at 1d 23h — confirms the spec's claim that a byte-equality switch is a true no-op.

### Pre-known concerns (from adversarial review + staging audit):
- `git status --porcelain` on `~/.hermes` surfaces months of uncommitted edits and untracked files (cron output, `memories/MEMORY.md` +114 lines, several SKILL.md edits, `resolver.md` +309 lines, `profiles/staging/`, `MEMORY.md.bak.*`). This is **expected and accepted as a baseline** for PR1 — see `known-drift.md`. The byte-equality check (`git diff HEAD origin/deployed`) is the actual safeguard.
- GitHub default merge style is "Create a merge commit." For PR1 itself, **rebase-and-merge** preferred to keep linear history on `finny-claude-plugin`'s main.
- Branch protection rules on `deployed` need to permit operator force-push for rollback. Verify the GitHub role mapping before applying the rule.
- Day_dream synthesis artifacts in `~/.hermes` will be gitignored by the follow-up reconciliation PR (against `finny-hermes-config`, not this repo). PR1 does not modify `~/.hermes`'s `.gitignore`.
