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

Note on gates: comments on the same line as `&&` swallow the trailing `&&` (the rest of the line becomes a bash comment, dropping the chain operator). All gates below use forms that **fail the chain on violation**, with comments on their own lines.

**finny-claude-plugin (`/opt/finny`):**

```bash
sudo -iu ubuntu bash -lc '
  cd /opt/finny &&
  git fetch origin &&
  # gate: working tree clean
  [ -z "$(git status --porcelain)" ] &&
  # record pre-pull SHA
  git rev-parse HEAD &&
  git pull --ff-only origin deployed &&
  # record post-pull SHA
  git rev-parse HEAD &&
  pnpm install --frozen-lockfile &&
  pnpm -C bridge build
'
```

**finny-hermes-config (`~/.hermes`):** uses **baseline-delta** invariant — this repo carries persistent runtime dirt (cron output, MEMORY.md edits, etc.) that's accepted as a known baseline. See `setup-deployed-branch.md` § "Why baseline-delta is acceptable here" for rationale and `known-drift.md` for the inventory.

```bash
sudo -iu ubuntu bash -lc '
  cd ~/.hermes &&
  git fetch origin &&
  # capture porcelain baseline (per-PID temp file avoids collisions on concurrent runs)
  git status --porcelain | sort > /tmp/hermes-porcelain.$$.before &&
  git rev-parse HEAD &&
  git pull --ff-only origin deployed &&
  git rev-parse HEAD &&
  git status --porcelain | sort > /tmp/hermes-porcelain.$$.after &&
  # gate: porcelain unchanged (pull added no new tracked-file modifications and no untracked artifacts)
  diff -q /tmp/hermes-porcelain.$$.before /tmp/hermes-porcelain.$$.after
'
# No build step for config repo.
```

The porcelain `diff -q` is the safety gate: a routine deploy's `git pull` should advance HEAD without adding files to the working tree. If the pull surfaces a previously-tracked file as modified (e.g., a deployed commit changed a file that prod has been editing in place), the porcelain diff will catch it and abort.

**finny-hermes (`~/.hermes/hermes-agent`):** strict if porcelain is empty; otherwise baseline-delta (see `setup-deployed-branch.md` for the pattern). Below is the baseline-delta variant since the staging audit showed `web/package-lock.json` modified:

```bash
sudo -iu ubuntu bash -lc '
  cd ~/.hermes/hermes-agent &&
  git fetch origin &&
  git status --porcelain | sort > /tmp/hermes-agent-porcelain.$$.before &&
  git rev-parse HEAD &&
  git pull --ff-only origin deployed &&
  git rev-parse HEAD &&
  git status --porcelain | sort > /tmp/hermes-agent-porcelain.$$.after &&
  # gate: porcelain unchanged
  diff -q /tmp/hermes-agent-porcelain.$$.before /tmp/hermes-agent-porcelain.$$.after &&
  cd web && npm install && npm run build
'
```

If any gate fires across any repo: stop. The chain aborts on first failure; re-run with each gate isolated to find which one fired.

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

For `/opt/finny` (strict): porcelain must be empty AND tree-equality must hold.

```bash
sudo -iu ubuntu bash -lc '
  cd /opt/finny &&
  git fetch origin &&
  # gate: porcelain empty
  [ -z "$(git status --porcelain)" ] &&
  # gate: tree-equality between HEAD and origin/deployed
  # (different commits, same file content — that is the reconciliation invariant)
  git diff --quiet HEAD origin/deployed
'
```

For `~/.hermes` and `~/.hermes/hermes-agent` (baseline-delta): capture porcelain to a per-PID `.before` file, gate on tree-equality, then proceed. Capture `.after` post-pull and `diff -q` them.

```bash
sudo -iu ubuntu bash -lc '
  cd <repo-path> &&
  git fetch origin &&
  git status --porcelain | sort > /tmp/recon-porcelain.$$.before &&
  # gate: tree-equality between HEAD and origin/deployed
  git diff --quiet HEAD origin/deployed
'
```

If the gate fires: **stop**. The tracked-file content on prod is not byte-identical to what we're about to FF to. The reconciliation case requires that prod's working-tree-at-HEAD already matches the new `deployed` tip's content — different commits, same files. If that's not true, this isn't a reconciliation; it's a routine deploy and you're using the wrong flow. Working-tree dirt (untracked files, uncommitted edits to ignored paths) is orthogonal to this gate.

### 4. Switch checkout and pull

```bash
sudo -iu ubuntu bash -lc '
  cd <repo-path> &&
  git checkout deployed &&
  git pull --ff-only origin deployed &&
  git status --porcelain | sort > /tmp/recon-porcelain.$$.after &&
  # gate: porcelain unchanged
  diff -q /tmp/recon-porcelain.$$.before /tmp/recon-porcelain.$$.after
'
```

Working tree is byte-identical for tracked files (per the pre-pull tree-equality gate); baseline dirt is unchanged (per the porcelain `diff -q`). **No build, no restart needed.** Verify by checking unit status:

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
