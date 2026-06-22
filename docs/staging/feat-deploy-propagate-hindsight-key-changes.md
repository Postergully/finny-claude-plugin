# Staging changes: `feat/deploy-propagate-hindsight-key`

**Date tested:** `2026-06-22` (static-check only; not redeployed to staging)
**Tested by:** `Postergully (orchestrator-driven)`
**Staging snapshot baseline:** prod AMI (current staging EC2 `i-0c2c974ff571162eb`, snapshot per `2026-06-22 ~06:20 UTC` deploy-log entry)
**PR:** this branch in `finny-claude-plugin`. Follow-up to [Postergully/finny-claude-plugin#19](https://github.com/Postergully/finny-claude-plugin/pull/19) and [11mirror/finny-hermes-dashboard#1](https://github.com/11mirror/finny-hermes-dashboard/pull/1).

## Git changes (replay via merge)

- `finny-claude-plugin@feat/deploy-propagate-hindsight-key`: single commit modifying `deploy/scripts/deploy-finny-dashboard.sh` to read `HINDSIGHT_API_KEY` from `~/.hermes/.env` on the EC2 box and include it in the generated `/opt/finny/dashboard/.env`. Mirrors the existing `API_SERVER_KEY` propagation pattern. Fail-loud if the key is missing.
- `finny-hermes`: no changes.
- `finny-hermes-dashboard`: no changes.
- `finny-hermes-config`: no changes.
- `netsuite-kb`: no changes.

## Deploy decision

- [ ] **Deploy immediately after merge** — PR is independent, ship it as soon as merged
- [x] **Hold for batch** — safe to merge but wait for the next batched deploy window (this PR is purely a deploy-script ergonomics fix; no runtime change to the dashboard process itself)
- [ ] **Hotfix** — deploy ASAP, do not batch with anything else
- [ ] **Reconciliation deploy** — special case (e.g., byte-equality reconciliation); see deploy-runbook.md byte-equality flow

Rationale: the bug this fixes only matters when running `deploy-finny-dashboard.sh`. As long as the manual `.env` patch from PR #19's manifest remains in place on prod between deploys, this PR landing or not is invisible to runtime. Land it whenever the next batched deploy window runs.

## Non-git changes (replay manually on prod, in order)

**No non-git changes — `git pull` on `deployed` + standard restart is sufficient.**

This PR only edits a script that runs at deploy-time on the laptop / via SSM. Merging the PR does not affect anything running on prod. The fix becomes effective the **next time** `deploy/scripts/deploy-finny-dashboard.sh` is run.

### Operator note on PR #19's manual step

PR #19's manifest (`docs/staging/feat-dashboard-external-memory-tab-changes.md`) enumerates a manual `HINDSIGHT_API_KEY` append + restart as a non-git change. **Until this script-fix PR is merged AND a fresh dashboard deploy has run after the merge, that manual step is still required** — re-running the unfixed script wipes `/opt/finny/dashboard/.env` and restores the narrow 4-key version, which 503s the External Memory routes.

After this PR is merged AND the next dashboard deploy completes, the manual append step in PR #19's manifest is obsolete. A future PR can edit PR #19's manifest to drop that step from the rollback procedure (or this manifest can backfill once the deploy lands).

## What was tested on staging

- [x] `bash -n deploy/scripts/deploy-finny-dashboard.sh` — exit 0 (clean static check).
- [x] `grep -nE 'HINDSIGHT' deploy/scripts/deploy-finny-dashboard.sh` — confirms 5 references where there were 0 on `main` (one in the comment, one in the read, one in the missing-key error, one in the env-file write, one passing the value through).
- [ ] End-to-end staging deploy — **NOT exercised in this window** by operator decision. Staging is currently green from PR #19's smoke (the manual `.env` patch is still in place); rerunning the deploy with the unfixed script would wipe the manual patch and re-introduce the 503. The fix is mechanically obvious (mirrors `API_SERVER_KEY` propagation verbatim) and can be exercised on the next planned staging refresh / batched deploy window.

## Skipped on prod (staging-only changes)

> Things done on staging for testing/debug that should NOT carry to prod.

None.

## Rollback

1. `git revert <merge-sha>` on `finny-claude-plugin`.
2. No runtime restart needed. If a deploy ran with the fixed script and you want to roll back the script behavior without rolling back the dashboard, the `/opt/finny/dashboard/.env` file already has `HINDSIGHT_API_KEY` written — manually delete that line if you want pure-revert state, then `sudo systemctl restart finny-dashboard`.
3. The pre-fix manual append from PR #19's manifest works as a fallback at any time.

## Notes / surprises

The fix is the smallest possible change: read one more key from `~/.hermes/.env`, fail-loud if absent (mirroring `API_SERVER_KEY`'s pattern verbatim), interpolate into the same heredoc that writes the `.env` file. No restructuring, no new helper, no scope creep.

A more general fix would be a key-list to propagate, or a tee from `~/.hermes/.env` filtered by an allowlist — explicitly out of scope here. If the dashboard grows more env requirements, consider that refactor; for one new key, hardcoding is honest and reviewable.
