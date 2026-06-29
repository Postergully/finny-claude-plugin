# Manifest: `feat/bridge-oidc-onelogin`

## Status

**Draft.** Not for merge until OneLogin-vs-Zitadel decision is made. Belongs to **Phase 3** (Zitadel substrate / authz), NOT Phase 2.

## What this branch is

Salvage of uncommitted OneLogin OIDC bridge work that was found in the prod working tree at `/opt/finny/bridge/` on 2026-06-29. Original mtime 2026-06-18 (auth files 11:16 UTC, http.ts 17:51 UTC — a sustained work day).

Captured to a branch on prod first (`salvage/bridge-oidc-onelogin-2026-06-18` @ `638730e`), then renamed to `feat/bridge-oidc-onelogin` and bundle-transferred to local + pushed to origin (prod's deploy key is read-only by design).

See the commit message on `638730e` for the per-file rundown.

## Why it needs a decision before staging

This adds a second auth path (`AUTH_MODE=oidc`) alongside the existing built-in Google OAuth. The Phase 3 plan in `/Applications/finny-core/docs/plan/implementation.md:971` says: *"Authz substrate work for v1 lives here (NOT in Phase 3.5). Per the 2026-06-25 amendment, v1 uses Zitadel as both IdP and authz authority."*

This branch implements **OneLogin**, not Zitadel. Three resolutions possible:

1. **Zitadel is canonical, OneLogin is dead** → close branch unmerged. Salvage preserved the work for reference; the OneLogin-specific `/oauth/authorize` resource-stripping logic is reusable as a pattern if a future IdP needs the same shim.
2. **OneLogin is what's actually deployed, Zitadel was aspirational** → rebase + harden this branch, write OneLogin-specific staging walk, ship via deployed-branch flow as Phase 3's authz substrate.
3. **Hybrid: keep the OIDC verifier code (issuer-agnostic), drop the OneLogin shim** → re-PR with OIDC verifier only; layer Zitadel-specific config on top.

**Operator owes:** decision on which path, by the time Phase 3 starts.

## What was done to capture (non-git steps)

1. SSM into prod (`i-0ef58962b09d490ee`).
2. `cd /opt/finny && git checkout -b salvage/bridge-oidc-onelogin-2026-06-18 deployed`.
3. `git add bridge/src/server/http.ts bridge/package.json bridge/package-lock.json bridge/tsup.config.ts bridge/src/auth/access-db.ts bridge/src/auth/oidc.ts`.
4. `git commit -m "salvage: OneLogin OIDC bridge WIP from prod working tree (2026-06-18)"` → `638730e`.
5. `git branch -m salvage/bridge-oidc-onelogin-2026-06-18 feat/bridge-oidc-onelogin`.
6. `git push -u origin feat/bridge-oidc-onelogin` → **failed** (prod deploy key is read-only — correct).
7. `git bundle create /tmp/feat-bridge-oidc.bundle deployed..feat/bridge-oidc-onelogin`, base64, pull via SSM output, reconstruct locally, `git fetch`, `git push -u origin` from operator's laptop.
8. `git checkout deployed` on prod to restore the active branch.
9. Prod working tree is now clean (only `dashboard.bak.*` and `dashboard/` untracked, both unrelated).

## What does NOT happen at staging walk (yet)

This branch is **Draft** — no staging deploy until the OneLogin-vs-Zitadel decision lands. When it does:

- If accepted (path 2 or 3): the staging walk needs to verify cowork OAuth flow end-to-end against the chosen IdP. Reject path = `--branch deployed` redeploy.
- If rejected (path 1): close PR, retain branch for reference.

## Revert / rollback

Branch is unmerged. No prod path to revert. If salvage commit on prod (`638730e`) needs to be undone:

```bash
# On prod, via SSM
cd /opt/finny
git branch -D feat/bridge-oidc-onelogin   # branch already pushed to origin, so this is local-cleanup-only
```

The pushed branch on origin can stay — it's a salvage record. Mark it Archived if rejected.

## Sign-off

- [ ] OneLogin-vs-Zitadel decision documented
- [ ] If accepted: staging walk performed, this manifest updated with staging deploy steps
- [ ] If rejected: PR closed with rationale linked here
