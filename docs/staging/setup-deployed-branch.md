# One-time setup: deployed branches per repo

Run once per repo to introduce the `deployed`-branch model. After this, all deploys go through `deploy-runbook.md`.

This setup happens as part of the PR1 deploy (`staging-architecture-plan` branch). After PR1 merges and is deployed, all 3 repos use the deployed-branch model.

All EC2 work via SSM. Wrap git ops in `sudo -iu ubuntu bash -lc "..."`.

---

## Per-repo overview

| Repo | Path on prod | Current prod HEAD (SHA / branch) | Initial `deployed` points at |
|---|---|---|---|
| `finny-claude-plugin` | `/opt/finny` | `a40d868` on `main` | `a40d868` (= origin/main tip) |
| `finny-hermes-config` | `~/.hermes` | `1630537` on `feat/atomic-fetch-phase-2` | `1630537` (the feature-branch tip — NOT main) |
| `finny-hermes` | `~/.hermes/hermes-agent` | `c3bdb2a` on `main` | `c3bdb2a` (= origin/main tip) |

The asymmetry on `finny-hermes-config` is the whole point: prod is running phase-2's code, and `deployed` must reflect what's running, not what main currently says.

---

## Step 1 — Create `deployed` branches on origin

For each repo, on a workstation with push access:

### finny-claude-plugin

```bash
cd /path/to/finny-claude-plugin
git fetch origin
git checkout main
git rev-parse HEAD                              # confirm == a40d868 (or whatever prod actually shows at runtime)
git branch deployed
git push origin deployed
```

### finny-hermes-config

```bash
cd /path/to/finny-hermes-config
git fetch origin
# Branch deployed at the feature-branch tip — this is what's running in prod:
git branch deployed origin/feat/atomic-fetch-phase-2
git push origin deployed
```

**Verify before pushing**: `git rev-parse origin/feat/atomic-fetch-phase-2` must equal prod's actual HEAD at setup time. Re-check via SSM if any time has passed.

### finny-hermes

```bash
cd /path/to/finny-hermes
git fetch origin
git checkout main
git branch deployed
git push origin deployed
```

---

## Step 2 — Add GitHub branch protection on `deployed` (per repo)

Via GitHub UI (Settings → Branches → Add rule) or `gh api`:

- **Pattern:** `deployed`
- **Require a pull request before merging:** off (we FF from main via the runbook, not via PRs to deployed)
- **Require linear history:** on
- **Allow force pushes:** "Specify who can force push" → restrict to operator role (needed for rollback)
- **Allow deletions:** off
- **Restrict who can push:** operator role only
- **Required status checks:** none (status checks live on main, not deployed)

The rule's only purpose is "no accidental commits to `deployed` and no unauthorized force-pushes."

Example via `gh`:

```bash
gh api -X PUT \
  /repos/<org>/<repo>/branches/deployed/protection \
  -f required_linear_history=true \
  -f allow_force_pushes=true \
  -f allow_deletions=false
```

(Adjust per your org's conventions; the GitHub web UI is fine for the one-time setup.)

---

## Step 3 — Switch prod's checkout to track `deployed`

### Two invariants in play

The original drafting assumed `git status --porcelain` would be empty everywhere. **The audit on staging showed `~/.hermes` carries persistent runtime dirt and uncommitted content edits — months of it.** That work is being reconciled in a separate follow-up PR (see `known-drift.md`); this rollout uses a different invariant for that repo.

| Repo | Invariant for this rollout |
|---|---|
| `finny-claude-plugin` (`/opt/finny`) | **Strict**: `git status --porcelain` must be empty before AND after the checkout |
| `finny-hermes-config` (`~/.hermes`) | **Baseline-delta**: capture porcelain output BEFORE; capture AFTER; assert AFTER ⊆ BEFORE (no new dirt added). Document the BEFORE state as the known baseline. |
| `finny-hermes` (`~/.hermes/hermes-agent`) | **Strict** if porcelain shows nothing significant; otherwise baseline-delta |

The byte-equality check (`git diff HEAD origin/deployed`) stays unchanged everywhere — that's the actual safety guarantee.

### finny-claude-plugin (strict invariant)

```bash
sudo -iu ubuntu bash -lc "
  cd /opt/finny &&
  git fetch origin &&
  git status --porcelain &&                                # must be empty
  git rev-parse HEAD &&                                    # record current SHA
  git diff HEAD origin/deployed &&                          # MUST be empty (byte-equality)
  git checkout deployed &&
  git pull --ff-only origin deployed &&
  git rev-parse HEAD &&                                    # confirm SHA unchanged
  git status --porcelain                                    # confirm working tree still clean
"
```

### finny-hermes-config (baseline-delta invariant — the drift case)

Capture baseline first, into a file we'll diff against:

```bash
sudo -iu ubuntu bash -lc "
  cd ~/.hermes &&
  git fetch origin &&
  git status --porcelain | sort > /tmp/.hermes-porcelain.before &&
  wc -l /tmp/.hermes-porcelain.before &&
  git rev-parse HEAD &&                                    # should be the deployed-branch-equivalent SHA (e.g. 1630537)
  git diff HEAD origin/deployed                             # MUST be empty (byte-equality of TRACKED files)
"
```

`git diff HEAD origin/deployed` operates on tracked files only — modified-but-uncommitted edits and untracked files do not affect it. As long as that diff is empty, the *contents* match origin/deployed; the dirt is the same dirt before and after.

Now switch:

```bash
sudo -iu ubuntu bash -lc "
  cd ~/.hermes &&
  git checkout deployed &&                                  # warning: 'switching may discard local changes' will fire if any tracked file's content differs from deployed's tip — abort and investigate
  git pull --ff-only origin deployed &&
  git rev-parse HEAD &&                                    # confirm == pre-checkout SHA
  git status --porcelain | sort > /tmp/.hermes-porcelain.after &&
  diff /tmp/.hermes-porcelain.before /tmp/.hermes-porcelain.after
"
```

The final `diff` must be empty — meaning the operation added no new dirt. Pre-existing dirt is the *baseline*; we are explicitly accepting it as known and deferring its reconciliation to a follow-up PR.

**If `git checkout deployed` produces any output other than 'Already on deployed' or 'Switched to branch deployed' — STOP.** In particular, "Your local changes to the following files would be overwritten" means a tracked file in the working tree has been edited and the new branch's version differs. The byte-equality check above should have prevented this; if it didn't, something has changed since. Re-run the byte-equality check, find the divergent file, decide before proceeding.

### finny-hermes (likely strict, but check first)

```bash
sudo -iu ubuntu bash -lc "
  cd ~/.hermes/hermes-agent &&
  git fetch origin &&
  git status --porcelain &&                                # check what's there
  git rev-parse HEAD &&
  git diff HEAD origin/deployed                             # MUST be empty
"
```

If porcelain is empty: use the strict pattern (same shape as `/opt/finny`). If it shows files (e.g., `web/package-lock.json` per the staging audit), use the baseline-delta pattern (same shape as `~/.hermes`).

### Why baseline-delta is acceptable here

The byte-equality `git diff HEAD origin/deployed` check guarantees the *content of tracked files* matches what we're switching to. Working-tree dirt — runtime state files, untracked artifacts, uncommitted edits — is orthogonal to that guarantee. The switch from `feat/atomic-fetch-phase-2` to `deployed` (which points at the same SHA) does not touch the working tree's tracked-file content because both refs point at the same commit. The switch also does not touch untracked files at all.

What we are explicitly NOT verifying with this loosened invariant: that the runtime dirt is "correct" or "expected." That assessment is being deferred to the content-reconciliation PR.

---

## Step 4 — No restart needed

The whole point of the byte-equality invariant is that working tree files don't change. Therefore:
- **No `pnpm install` / `npm install`** on any repo
- **No build step**
- **No `systemctl restart`**

If you find yourself wanting to restart "just to be safe" — don't. A restart here would mask whether the switch actually preserved state. Verify via:

```bash
systemctl status finny-mcp                              # uptime should be unchanged
sudo -iu ubuntu systemctl --user status hermes-gateway  # uptime should be unchanged
```

Both should still show "active (running) since <whenever>" with the same start timestamp as before the switch.

---

## Step 5 — Smoke

Routine prod smoke (read-only):

```bash
curl -sSI https://finny.prod.11mirror.com/mcp | grep -iE 'www-authenticate|http/'
curl -sS https://finny.prod.11mirror.com/.well-known/oauth-protected-resource | jq .resource
```

Then a single read-only `finny_query` via your usual cowork connector. Confirms the switchover didn't break anything user-visible.

---

## Step 6 — Record in deploy log

Append to `docs/staging/deploy-log.md`:

```
## YYYY-MM-DD HH:MM TZ — <operator> (one-time deployed-branch setup)
- finny-claude-plugin: a40d868 (was on main, now on deployed)
- finny-hermes-config: 1630537 (was on feat/atomic-fetch-phase-2, now on deployed)
- finny-hermes: c3bdb2a (was on main, now on deployed)
- All byte-equality invariants verified.
- No restart, no build.
- Smoke: green.
```

---

## What this enables (after setup)

- All future deploys via `deploy-runbook.md` (FF deployed→main, then git pull on prod)
- `git log deployed..main` answers "what's pending deploy" per repo
- Atomic-fetch reconciliation (PR3+4) becomes a byte-equality reconciliation deploy with the runbook's safety check built in
- Rollback semantics are clear: move `deployed` back, redeploy

## What's still divergent after setup

- `finny-hermes-config`'s `deployed` branch points at `1630537`, while `main` is behind it. This is correct — main genuinely doesn't have phase-1 or phase-2 yet. PR3+4 fixes this by merging phase-2's commits into main. After that merge, `git log deployed..main` shows the merge commit (or the rebased commits) and the next deploy will FF deployed → main, picking those commits up.

This drift is **the documented divergence** the user wanted to acknowledge. It will be closed by PR3+4's reconciliation, not by touching prod.
