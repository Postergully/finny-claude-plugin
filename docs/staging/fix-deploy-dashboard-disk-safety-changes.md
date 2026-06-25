# fix/deploy-dashboard-disk-safety — changes manifest

## Summary

Patches `deploy/scripts/deploy-finny-dashboard.sh` to prevent the failure mode
that took staging offline on 2026-06-25: dashboard backup dirs accumulated
unbounded (7 × 2.5GB), filled `/` to 100% on `i-0c2c974ff571162eb`, which
truncated the next deploy mid-extract and wedged `ssm-document-worker` IPC.

## Code changes

- **Pre-flight disk check (Step 0):** refuses to deploy if `/` has <5GB free.
  Prints existing backups so operator knows what to prune.
- **Pre-flight backup prune (Step 0b):** keeps only the 2 newest
  `dashboard.bak.*` dirs; deletes the rest. Also wipes any leftover
  `dashboard.broken.*` from prior failed deploys.
- **Post-extract integrity check (Step 3b):** verifies `server-entry.js`,
  `package.json`, `dist/`, and `node_modules/@tanstack/react-router/package.json`
  exist after `tar -xzf`. Disk-full silently truncates tarballs; this catches
  it before the service is restarted into a broken state.
- **Auto-rollback on ERR:** `trap 'rollback' ERR` restores the previous
  `dashboard.bak.<ts>` and restarts the service if anything fails between the
  backup `mv` and the success line. Disarmed on success.

## Non-git changes on staging EC2 (`i-0c2c974ff571162eb`)

Operator manual recovery on 2026-06-25 ~22:50 IST:
- Deleted 5 of 7 `dashboard.bak.*` directories (kept `20260625-100719` and
  `20260625-172311` as rollback safety).
- Deleted `dashboard.broken.20260625-165712` (mid-rollback failure dir).
- Restored `/opt/finny/dashboard` from `dashboard.bak.20260625-172311`.
- Restarted `finny-dashboard` (now `active`, loopback 200, external 200).

Disk went 100% → 50% (`/dev/root` 29G total, 14G used, 15G avail).

## Staging walk-through

Walk-through is the recovery itself, completed in-session over SSH (port 22
temporarily opened to operator IP, revoked after):

1. `df -h /` confirmed root disk at 100%.
2. Pruned 5 oldest `.bak.*` dirs + `.broken.*` dir → 50% free.
3. `sudo cp -a /opt/finny/dashboard.bak.20260625-172311 /opt/finny/dashboard`.
4. `sudo systemctl restart finny-dashboard` → `active`.
5. `curl http://127.0.0.1:3001/` → 200.
6. External: `curl https://dashboard.finny.staging.11mirror.com/` → 200.

## Revert plan

`git revert <commit>` on this branch reverts the script changes. The manual
recovery (pruned backups, restored from .bak) does not need reverting — that
state is the desired state.

If a future deploy with this script triggers the new auto-rollback path, the
operator will see `=== ROLLBACK: deploy failed, restoring previous target ===`
in the SSM output. The service ends up back on the previous `.bak`; no manual
intervention required.

## Signals filed

- `staging-disk-pressure-breaks-ssm-and-deploys` (retitle of
  `ssm-staging-deploy-inprogress-no-output` — same evidence, real root cause).
- `dashboard-deploy-leaves-stale-backups-on-disk` — closed by Step 0b prune.
- `dashboard-deploy-not-atomic-on-disk-full` — closed by Step 3b integrity
  check + ERR-trap rollback.

## Operator sign-off

- [x] Disk recovery validated on `i-0c2c974ff571162eb` (50% free after prune).
- [x] `finny-dashboard` active, loopback 200, external 200.
- [ ] Next deploy of PR #6 from `feature/v3.1-capabilities-registry` exercises
      the patched script end-to-end.
