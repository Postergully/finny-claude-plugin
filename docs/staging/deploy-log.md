# Deploy log

Append-only record of deploys to prod (`i-0ef58962b09d490ee`). Each entry per the template in `deploy-runbook.md` Step 7 (or `setup-deployed-branch.md` Step 6 for the one-time setup).

---

## 2026-06-17 15:33 UTC — Postergully (one-time deployed-branch setup, PR #8)

- **finny-claude-plugin** at `/opt/finny`: was on `main` @ `a40d868`, now on `deployed` @ `a40d868` (no SHA change). Strict invariant: porcelain empty before AND after.
- **finny-hermes-config** at `~/.hermes`: was on `feat/atomic-fetch-phase-2` @ `1630537`, now on `deployed` @ `1630537` (no SHA change). Baseline-delta: porcelain 63 lines before == 63 lines after, `diff -q` empty.
- **finny-hermes** at `~/.hermes/hermes-agent`: was on `main` @ `c3bdb2a`, now on `deployed` @ `c3bdb2a` (no SHA change). Baseline-delta: porcelain 1 line before == 1 line after (`web/package-lock.json`), `diff -q` empty.
- All commit-equality gates (`git diff --quiet HEAD origin/deployed`) passed before checkout — confirming the switch was a true no-op for tracked content.
- **No restart, no build.** finny-mcp uptime preserved at 4 days; hermes-gateway uptime preserved at 1 week 2 days.
- **Surface smoke**: green
  - MCP RFC 9728 challenge correct (`HTTP/2 401` + `www-authenticate: Bearer ... resource_metadata=...`)
  - OAuth protected-resource metadata: `resource = https://finny.prod.11mirror.com/`
  - OAuth authz server metadata: issuer/authorize/token endpoints all on prod
  - Journal logs clean (only entry is the smoke curl HEAD → 401, 1ms)

**Pending deploy queue after this setup** (`git log origin/deployed..origin/main` per repo):
- `finny-claude-plugin`: 14 commits — 3 auth/zitadel WIP commits + 1 chore/CI fix + 10 staging-architecture-plan commits. To be deployed via routine deploy when ready.
- `finny-hermes-config`: phase-1 + phase-2 atomic-fetch commits not yet on `main`. To be reconciled via PR3+4 (byte-equality reconciliation deploy).
- `finny-hermes`: empty (deployed == main).

**Known deferred work**: `~/.hermes` working-tree drift (63 modified/untracked items as of audit time). Inventory in `docs/staging/known-drift.md`. Reconciliation via a follow-up PR.

**Branch protection** on `deployed` branches: applied 2026-06-17 ~15:50 UTC for all 3 repos via `gh api`. Settings: `required_linear_history=true`, `allow_force_pushes=true` (operator force-push needed for rollback), `allow_deletions=false`. Verified on all 3 origins.
