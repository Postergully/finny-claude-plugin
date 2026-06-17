# Deploy runbook

Run this when you decide it's time to deploy merged PRs to prod. Merge does **not** auto-deploy — this runbook is the deploy.

Three flows in this doc:
- **Routine deploy** — most common; main has new commits, prod runs them
- **Byte-equality reconciliation deploy** — special case; prod's working tree already matches main (e.g., atomic-fetch reconciliation). No working-tree change.
- **Rollback** — move `deployed` back, redeploy

All EC2 work via SSM. Wrap git/file ops in `sudo -iu ubuntu bash -lc "..."` to avoid the dubious-ownership gotcha in `/opt/finny`.

---

## Pre-deploy checks (always)

Pick the repo(s) you're deploying. For each:

```bash
# Locally (or any host with git+gh):
gh pr list --repo <org>/<repo> --state merged --base main --limit 10
git log --oneline origin/deployed..origin/main          # what's pending deploy
```

For each merged PR being deployed, confirm:
- `docs/staging/<branch>-changes.md` exists in main
- The manifest's "What was tested on staging" checklist is fully checked
- The manifest's "Non-git changes" section is filled in (or explicitly says none)

If any PR is missing its manifest: stop. Do not deploy.

---

## Routine deploy

### 1. Fast-forward `deployed` to `main`'s tip

```bash
# Locally, per repo being deployed:
cd <repo>
git fetch origin
git checkout deployed
git merge --ff-only origin/main           # must be FF — abort if not
git push origin deployed
```

If `--ff-only` fails: someone pushed directly to `deployed` (branch protection should prevent this — investigate before continuing).

### 2. SSM into prod

```bash
aws ssm start-session --target i-0ef58962b09d490ee --region us-east-1 \
  --document-name AWS-StartInteractiveCommand \
  --parameters 'command=["sudo -iu ubuntu"]'
```

### 3. Pull and build, per repo

**finny-claude-plugin (`/opt/finny`):**

```bash
sudo -iu ubuntu bash -lc "
  cd /opt/finny &&
  git fetch origin &&
  git status --porcelain &&                    # must be empty
  git rev-parse HEAD &&                         # record pre-pull SHA
  git pull --ff-only origin deployed &&
  git rev-parse HEAD &&                         # record post-pull SHA
  pnpm install --frozen-lockfile &&
  pnpm -C bridge build
"
```

**finny-hermes-config (`~/.hermes`):** uses **baseline-delta** invariant — this repo carries persistent runtime dirt (cron output, MEMORY.md edits, etc.) that's accepted as a known baseline. See `setup-deployed-branch.md` § "Why baseline-delta is acceptable here" for rationale and `known-drift.md` for the inventory.

```bash
sudo -iu ubuntu bash -lc "
  cd ~/.hermes &&
  git fetch origin &&
  git status --porcelain | sort > /tmp/.hermes-porcelain.before &&
  git rev-parse HEAD &&
  git diff HEAD origin/deployed                 # MUST be empty (byte-equality of tracked files) &&
  git pull --ff-only origin deployed &&
  git rev-parse HEAD &&
  git status --porcelain | sort > /tmp/.hermes-porcelain.after &&
  diff /tmp/.hermes-porcelain.before /tmp/.hermes-porcelain.after   # must be empty (no new dirt added)
"
# No build step for config repo.
```

If `diff` shows new entries: stop and investigate — the pull added files to the working tree that weren't there before, which the byte-equality check should have prevented.

**finny-hermes (`~/.hermes/hermes-agent`):** strict if porcelain is empty; otherwise baseline-delta (see `setup-deployed-branch.md` for the pattern).

```bash
sudo -iu ubuntu bash -lc "
  cd ~/.hermes/hermes-agent &&
  git fetch origin &&
  git status --porcelain | sort > /tmp/.hermes-agent-porcelain.before &&
  git rev-parse HEAD &&
  git diff HEAD origin/deployed                 # MUST be empty &&
  git pull --ff-only origin deployed &&
  git rev-parse HEAD &&
  git status --porcelain | sort > /tmp/.hermes-agent-porcelain.after &&
  diff /tmp/.hermes-agent-porcelain.before /tmp/.hermes-agent-porcelain.after &&
  cd web && npm install && npm run build
"
```

If `git status --porcelain` is non-empty for `/opt/finny` (the strict-invariant repo): stop. The working tree has uncommitted changes that need investigation before we overwrite them. For `~/.hermes` and `~/.hermes/hermes-agent`, the baseline-delta `diff` is the safety check — if that's non-empty, stop.

### 4. Walk each manifest's non-git steps

For each PR being deployed, in merge order, walk `docs/staging/<branch>-changes.md` "Non-git changes" section. Each step says exactly what command to run. Never paste secret values from the manifest into prod — the manifest lists key names only; values come from EnvironmentFile or SecureString parameters.

### 5. Restart units

```bash
sudo systemctl restart finny-mcp
sudo -iu ubuntu systemctl --user restart hermes-gateway
# Do NOT restart hermes-dashboard on prod — prod doesn't run one.
```

### 6. Smoke

```bash
# Public MCP up?
curl -sSI https://finny.prod.11mirror.com/mcp | grep -iE 'www-authenticate|http/'

# OAuth metadata correct?
curl -sS https://finny.prod.11mirror.com/.well-known/oauth-protected-resource | jq .resource
```

Then exercise all 5 MCP tools via browser cowork connector against prod. Do at least one read-only `finny_query` end-to-end.

### 7. Record deploy

Append to `docs/staging/deploy-log.md` (create if missing):

```
## YYYY-MM-DD HH:MM TZ — <operator>
- finny-claude-plugin: <pre-sha> → <post-sha> (PRs: #N, #M)
- finny-hermes-config: <pre-sha> → <post-sha> (PRs: #X)
- finny-hermes: no change
- Smoke: green / issues: <none|describe>
```

---

## Byte-equality reconciliation deploy

Use this when the working tree on prod is **already** the code in `main` (the atomic-fetch case: code authored directly on prod, then retroactively merged through the discipline). No working-tree change should occur.

### 1. Verify byte-equality on origin

```bash
cd <repo>
git fetch origin
git diff origin/deployed origin/main          # shows the commits being "reconciled"
```

This diff is informational — it shows what code is "moving" from feature-branch-on-prod state into the deployed branch's history. The actual files won't change on prod.

### 2. FF `deployed` to `main` on origin

```bash
git checkout deployed
git merge --ff-only origin/main
git push origin deployed
```

### 3. Pre-pull invariant check on prod

For `/opt/finny` (strict): `git status --porcelain` must be empty AND `git diff HEAD origin/deployed` must be empty.

For `~/.hermes` and `~/.hermes/hermes-agent` (baseline-delta): capture porcelain to `.before`, run `git diff HEAD origin/deployed` (must be empty — that's the byte-equality proof for tracked files), then proceed. Capture `.after` post-pull and `diff` them.

```bash
sudo -iu ubuntu bash -lc "
  cd <repo-path> &&
  git fetch origin &&
  git status --porcelain | sort > /tmp/recon-porcelain.before &&
  git diff HEAD origin/deployed                 # MUST BE EMPTY — byte-equality of tracked files
"
```

If `git diff HEAD origin/deployed` is non-empty: **stop**. The tracked-file content on prod is not byte-identical to what we're switching to. Do not proceed without understanding why. This is the core safeguard for the reconciliation case — working-tree dirt (untracked files, uncommitted edits to ignored paths) is orthogonal to it.

### 4. Switch checkout and pull

```bash
sudo -iu ubuntu bash -lc "
  cd <repo-path> &&
  git checkout deployed &&                      # may print 'Already on' or 'Switched to'
  git pull --ff-only origin deployed &&         # should be no-op if already up-to-date
  git status --porcelain | sort > /tmp/recon-porcelain.after &&
  diff /tmp/recon-porcelain.before /tmp/recon-porcelain.after   # must be empty
"
```

Working tree is byte-identical for tracked files (per the pre-pull `git diff` check); baseline dirt is unchanged (per the `diff` of porcelain snapshots). **No build, no restart needed.** Verify by checking unit status:

```bash
systemctl status finny-mcp                     # 'active (running)' since whatever pre-deploy timestamp
sudo -iu ubuntu systemctl --user status hermes-gateway
```

### 5. Smoke (read-only)

Same as routine deploy step 6. Confirm nothing changed in behavior.

### 6. Record in deploy log with the special note

```
## YYYY-MM-DD HH:MM TZ — <operator> (byte-equality reconciliation)
- <repo>: <pre-sha> → <post-sha> on `deployed` branch
- Working tree unchanged (byte-equality verified pre-pull)
- No build, no restart
- PRs reconciled: #N
```

---

## Rollback

Two flavors: rollback the deploy that just happened, or rollback further back.

### Rollback last deploy

```bash
# Locally, per repo:
cd <repo>
git fetch origin
git checkout deployed
git log --oneline -5                           # find the SHA from before this deploy
git reset --hard <previous-sha>
git push --force-with-lease origin deployed    # branch protection must allow operator force-push
```

Then on prod:

```bash
sudo -iu ubuntu bash -lc "
  cd <repo-path> &&
  git fetch origin &&
  git reset --hard origin/deployed
"
```

Walk any non-git steps in **reverse order** (uninstall packages, restore env keys, revert systemd unit edits) per the manifest's Rollback section.

Restart units. Smoke.

### Rollback further back

Same procedure, but pick an older SHA. Walk **all** intervening manifests' Rollback sections in reverse chronological order.

---

## Branch protection assumed

These commands assume `deployed` is a protected branch with:
- No force-push **except** from designated operators (rollback requires force-push)
- No direct commits (only FF merges from main allowed)
- Linear history required

If branch protection is not yet set up, see `setup-deployed-branch.md`.
