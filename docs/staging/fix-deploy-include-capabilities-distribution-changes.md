# fix/deploy-include-capabilities-distribution — changes manifest

## Summary

Patches `deploy/scripts/deploy-finny-dashboard.sh` to include the dashboard
repo's `distribution/` directory in the deploy tarball. Without it, the new
`/api/capabilities` route ships without its `capabilities.yaml` data file
and 500s in production despite the local build looking healthy.

Discovered on 2026-06-25 during PR #6 (`feature/v3.1-capabilities-registry`)
staging verification: deploy succeeded, service active, but
`curl /api/capabilities` returned 500 because the route's parent-directory
walk for `distribution/capabilities.yaml` found no such file on the box.
The yaml IS committed in the dashboard repo (`distribution/capabilities.yaml`
@ `8fce36b6`), but the tar arg list explicitly enumerates ship paths and
did not include it.

## Code changes

- `deploy/scripts/deploy-finny-dashboard.sh`:
  - Add `distribution` to the `tar -czf` argument list (was: `dist
    server-entry.js package.json pnpm-lock.yaml public node_modules
    pnpm-workspace.yaml`).
  - Add `distribution/capabilities.yaml` to the post-extract integrity check
    so future tarball regressions fail fast and trigger the existing
    auto-rollback ERR trap.
  - Code comment captures the 2026-06-25 incident as the reason this file
    is load-bearing.

## Non-git changes on staging EC2 (`i-0c2c974ff571162eb`)

None directly attributable to this branch. The 2026-06-25 manual recovery
(disk prune + `.bak` restore) was already captured in
`docs/staging/fix-deploy-dashboard-disk-safety-changes.md` (PR #21, merged
as `0cc54f4`). The redeploy of `feature/v3.1-capabilities-registry` with
this fix in the local working tree is what surfaced the 500 → 200 transition
that proved the fix.

## Staging walk-through

Local-tree run on 2026-06-25 23:51 IST (uncommitted) reproduced the fix:

1. First deploy of PR #6 with the unpatched script → service active,
   loopback 200, but `https://dashboard.finny.staging.11mirror.com/api/capabilities`
   returned 500.
2. Edit `deploy-finny-dashboard.sh` to add `distribution` to tar args +
   integrity check.
3. Re-run deploy → integrity check confirmed
   `distribution/capabilities.yaml` present, service active, loopback 200.
4. `curl /api/capabilities` → 200 with valid JSON shape
   `{"role":"...","surfaces":{...}}`.

After this branch merges and the deploy script is the authoritative
artifact, the next deploy of PR #6 will reproduce step 3 without local
edits.

## Revert plan

`git revert <commit>` removes the changes. The 500 returns until either
(a) the yaml is moved to a path the route already searches, or
(b) the route's lookup logic is changed.

## Signals filed

- `capabilities-yaml-vendor-sync-drift-risk` — pre-existing, retained as
  open. This patch ships the yaml; it does not enforce sync with
  `finny-core/distribution/capabilities.yaml`. Drift mitigation is a
  separate concern.
- New: `deploy-script-explicit-tar-list-omits-data-files` — closed by this
  patch's integrity check. Future data files added to dashboard repo must
  be added to both the tar arg list AND the integrity check.

## Operator sign-off

- [x] Staging deploy verified: integrity check passes, loopback 200,
      `/api/capabilities` returns 200.
- [ ] Next redeploy of `feature/v3.1-capabilities-registry` (post-worker
      fix on the route's dev-override) consumes this patched script
      end-to-end.
