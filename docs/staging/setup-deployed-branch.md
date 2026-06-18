# One-time setup: deployed branches per repo

Run once per repo to introduce the `deployed`-branch model. After this, all deploys go through `deploy-runbook.md`.

This setup happens as part of the PR1 deploy (`staging-architecture-plan` branch). After PR1 merges and is deployed, all 3 repos use the deployed-branch model.

All EC2 work via SSM. Wrap git ops in `sudo -iu ubuntu bash -lc "..."`.

---

## Per-repo overview

| Repo | Path on prod | Current prod HEAD (SHA / branch) | Origin/main tip | Initial `deployed` points at |
|---|---|---|---|---|
| `finny-claude-plugin` | `/opt/finny` | `a40d868` on `main` | `7b46029` (3 commits ahead: auth/zitadel migration WIP) | **`a40d868`** (NOT main tip) |
| `finny-hermes-config` | `~/.hermes` | `1630537` on `feat/atomic-fetch-phase-2` | `575e260` (phase-1/phase-2 not in main) | **`1630537`** (feature-branch tip, NOT main) |
| `finny-hermes` | `~/.hermes/hermes-agent` | `c3bdb2a` on `main` | `c3bdb2a` | `c3bdb2a` (= origin/main tip) |

**Two repos have drift between main and prod, not just one.** The asymmetry is the whole point of this model: `deployed` must reflect what's running, not what main currently says. After PR1, `git log deployed..main` per repo will show the pending-deploy queue:
- `finny-claude-plugin`: 3 auth commits (zitadel migration) pending deploy
- `finny-hermes-config`: phase-1 + phase-2 atomic-fetch commits pending reconciliation (PR3+4)
- `finny-hermes`: empty (deployed == main)

---

## Step 1 — Create `deployed` branches on origin

For each repo, on a workstation with push access:

### finny-claude-plugin

```bash
cd /path/to/finny-claude-plugin
git fetch origin
# Branch deployed at the prod-running SHA — this is NOT origin/main's tip:
git branch deployed a40d868                     # confirm SHA against prod via SSM first
git push origin deployed
```

**Verify before pushing**: SSH/SSM to prod and `cd /opt/finny && git rev-parse HEAD`. Must equal `a40d868` (or whatever the operator confirms at runtime). Origin/main is ahead with auth/zitadel WIP — those are pending deploy, not running.

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

The commit-equality check (`git diff --quiet HEAD origin/deployed`) is the actual safety guarantee — it ensures `HEAD` and `origin/deployed` point at the same commit before we switch branches, which makes `git checkout deployed` a no-op for tracked files.

### finny-claude-plugin (strict invariant)

Note on gates: comments on the same line as `&&` swallow the `&&` (the rest of the line becomes a bash comment). All gates below use `--quiet` / `[ -z ... ]` forms that **fail the chain on violation**, and comments live on their own lines.

```bash
sudo -iu ubuntu bash -lc '
  cd /opt/finny &&
  git fetch origin &&
  # gate: working tree clean
  [ -z "$(git status --porcelain)" ] &&
  # record current SHA
  git rev-parse HEAD &&
  # gate: byte-equality vs origin/deployed (exits non-zero if diff exists)
  git diff --quiet HEAD origin/deployed &&
  git checkout deployed &&
  git pull --ff-only origin deployed &&
  # confirm SHA unchanged
  git rev-parse HEAD &&
  # gate: working tree still clean post-checkout
  [ -z "$(git status --porcelain)" ]
'
```

If any step fails, the script aborts. Re-run with each gate isolated to find which one fired.

### finny-hermes-config (baseline-delta invariant — the drift case)

Capture baseline first, into a file we'll diff against. **Use a per-operator temp path** (`$$` = caller's PID) so concurrent runs don't collide:

```bash
sudo -iu ubuntu bash -lc '
  cd ~/.hermes &&
  git fetch origin &&
  # capture baseline porcelain
  git status --porcelain | sort > /tmp/hermes-porcelain.$$.before &&
  wc -l /tmp/hermes-porcelain.$$.before &&
  # should be the deployed-branch-equivalent SHA (e.g. 1630537)
  git rev-parse HEAD &&
  # gate: byte-equality of tracked files (fails chain if non-empty)
  git diff --quiet HEAD origin/deployed
'
```

`git diff --quiet HEAD origin/deployed` is a commit-vs-commit comparison — it exits non-zero if `HEAD` and `origin/deployed` point at different commits (or the same commit with different tree hashes, which shouldn't happen). It does NOT inspect the working tree. Working-tree dirt (untracked files, uncommitted edits) is orthogonal: as long as `HEAD` already points at the same commit as `origin/deployed`, `git checkout deployed` is a no-op for tracked files, so working-tree dirt carries across the switch unchanged. The `diff -q` of porcelain `.before`/`.after` confirms that empirically post-switch.

Now switch:

```bash
sudo -iu ubuntu bash -lc '
  cd ~/.hermes &&
  git checkout deployed &&
  git pull --ff-only origin deployed &&
  # gate: SHA unchanged (deployed and feat/atomic-fetch-phase-2 point at the same commit)
  [ "$(git rev-parse HEAD)" = "1630537a4822c0b9614d40d28bc81700687d9d84" ] &&
  git status --porcelain | sort > /tmp/hermes-porcelain.$$.after &&
  # gate: no new dirt added
  diff -q /tmp/hermes-porcelain.$$.before /tmp/hermes-porcelain.$$.after
'
```

If `git checkout deployed` errors with "Your local changes to the following files would be overwritten" — STOP. That means a tracked file's working-tree version differs from the deployed branch's version, which the byte-equality gate above should have caught. Re-run that gate to find the divergent file. Each gate fails the chain and aborts the script — pre-existing dirt is the *baseline*; we are explicitly accepting it as known and deferring its reconciliation to a follow-up PR.

### finny-hermes (likely strict, but check first)

First, check porcelain so you know which pattern to use:

```bash
sudo -iu ubuntu bash -lc '
  cd ~/.hermes/hermes-agent &&
  git fetch origin &&
  git status --porcelain
'
```

If porcelain is empty: use the strict pattern (same shape as `/opt/finny`). If it shows files (e.g., `web/package-lock.json` per the staging audit), use the baseline-delta pattern (same shape as `~/.hermes`):

```bash
# Baseline-delta variant, if porcelain showed files:
sudo -iu ubuntu bash -lc '
  cd ~/.hermes/hermes-agent &&
  git fetch origin &&
  git status --porcelain | sort > /tmp/hermes-agent-porcelain.$$.before &&
  git rev-parse HEAD &&
  # gate: byte-equality
  git diff --quiet HEAD origin/deployed &&
  git checkout deployed &&
  git pull --ff-only origin deployed &&
  git status --porcelain | sort > /tmp/hermes-agent-porcelain.$$.after &&
  diff -q /tmp/hermes-agent-porcelain.$$.before /tmp/hermes-agent-porcelain.$$.after
'
```

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
- finny-claude-plugin: a40d868 (was on main, now on deployed; main tip is 7b46029, 3 commits ahead — pending deploy of auth/zitadel WIP)
- finny-hermes-config: 1630537 (was on feat/atomic-fetch-phase-2, now on deployed; main tip is 575e260, lacks phase-1/phase-2)
- finny-hermes: c3bdb2a (was on main, now on deployed; deployed == main, no drift)
- /opt/finny: strict invariant verified.
- ~/.hermes: baseline-delta invariant verified (porcelain before/after diff empty).
- ~/.hermes/hermes-agent: baseline-delta invariant verified (web/package-lock.json was the only modified file pre-checkout).
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

- `finny-claude-plugin`: `deployed` at `a40d868`; `main` at `7b46029` (3 auth/zitadel commits ahead). These are pending deploy — they were merged to main but never deployed to prod. The next routine deploy via the runbook will FF `deployed` → `main` and ship them.
- `finny-hermes-config`: `deployed` at `1630537` (feat/atomic-fetch-phase-2 tip); `main` is behind at `575e260` because phase-1/phase-2 were never merged. PR3+4 fixes this by merging phase-2's commits into main (rebase-and-merge). After that, `git log deployed..main` shows the rebased commits and the next deploy is a byte-equality reconciliation deploy (per `deploy-runbook.md`).
- `finny-hermes`: no drift — `deployed` == `main` == `c3bdb2a`.

These drifts are **the documented divergences** the user wanted to acknowledge. They will be closed by:
- finny-claude-plugin: a routine deploy of the 3 pending main commits (operator decision when ready).
- finny-hermes-config: PR3+4's byte-equality reconciliation, not by touching prod.
