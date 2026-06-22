# Staging Dashboard vhost — design

**Date:** 2026-06-22
**Branch (planned):** `feat/staging-dashboard-vhost`
**Repos touched:** `finny-claude-plugin` only (manifest + Caddyfile reference + docs)
**Repos NOT touched:** `finny-hermes-config`, `finny-hermes`
**Production impact:** none (work is entirely on staging EC2)

## 1. Goal

Make `https://dashboard.finny.staging.11mirror.com/` reach the Hermes gateway running on the staging EC2 box, mirroring the prod setup at `https://dashboard.finny.prod.11mirror.com/`. Outcome: the user can test prod and staging through two parallel browser URLs, each isolated to its own EC2 instance.

Path chosen: **Path #1 — separate vhost per environment**. No dashboard UI toggle, no shared upstream gateway, no auth changes (v1 dashboard remains no-auth on staging, matching prod).

Bedrock router work is **out of scope** here — deferred to a follow-up PR per user direction.

## 2. Current reality (verified 2026-06-22 via SSM)

### Staging EC2 — `i-0c2c974ff571162eb`, public IP `34.232.186.238`

| Component | State |
|---|---|
| Caddy (system unit) | ✅ running; Caddyfile has only `finny.staging.11mirror.com → :3000` |
| `finny-mcp.service` | ✅ active, listening `127.0.0.1:3000` |
| `hermes-gateway` user-mode unit (NOT a system unit — corrected 2026-06-22) | ❌ failed since 2026-06-18 — `ExecStart=/home/ubuntu/hermes-venv/bin/python` (wrong venv); enabled in `default.target.wants` and will auto-start on next reboot |
| Gateway actually on `:8642` | ✅ pid 33143 = orphan from `/tmp/start_gateway_proper.sh` (run via `sudo -iu ubuntu` on 2026-06-18 09:15:53 UTC, login shell exited 11s later, fork survived because user `ubuntu` has `Linger=yes`). Cmdline: `/home/ubuntu/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main gateway run --replace`. Working dir: `/home/ubuntu/.hermes/profiles/staging`. PPid=1 (reparented). Cgroup: `user.slice/user-1000.slice/session-c368.scope` (state=closing — NOT under any `.service`). |
| `hermes-dashboard.service` | ✅ running but bound to **`100.112.31.24:9119`** (Tailscale interface), NOT `127.0.0.1:9119` |
| `:3001` (dashboard SPA) | ❌ not listening — `/opt/finny/dashboard/` directory does not exist |
| `/opt/finny` git | branch `deployed` at SHA `a40d868` — **2 commits behind prod's `faf4215`** |
| `~/.hermes` | drift: branch `feat/atomic-fetch-v3` (not `deployed`) |
| `~/.hermes/hermes-agent` | branch `deployed` |

### Missing commits on staging's `/opt/finny` (prod is at `faf4215`, staging at `a40d868`)

```
faf4215 feat(deploy): enable hermes dashboard service for Sessions/Skills/Config/Memory/Jobs (#16)
3c8fc64 feat: Finny dashboard at dashboard.finny.prod.11mirror.com (#13)
```

These two PRs are exactly what added prod's `/opt/finny/dashboard/`, the `finny-dashboard` systemd unit, and the `hermes dashboard :9119` service unit. **Staging needs them.**

### Prod EC2 — `i-0ef58962b09d490ee` (cross-checks)

| Check | Result |
|---|---|
| `:9119` (`hermes-dashboard`) | ✅ 200 — confirms PR #16 is live; the §5 "mode=portable, missing=[sessions, skills, config]" warning in the handoff doc is **stale** |
| `:3001` (`finny-dashboard`) | ✅ 200 |
| Caddy | ✅ has both `finny.prod.11mirror.com` and `dashboard.finny.prod.11mirror.com` vhosts |
| Dashboard journald | now shows `mode=zero-fork` (not `mode=portable`) — different state than handoff doc says, worth a doc cleanup later |

### Route53

- Hosted zone for staging is `staging.11mirror.com.` → ID `Z01920243UX91ZKYKCMPA`.
- Existing `finny.staging.11mirror.com` A record points at `34.232.186.238` — same IP we'll use for the new dashboard record.

### Repo correction

The handoff doc §gotcha 6 references `11mirror/finny-hermes-dashboard` as the dashboard repo. That is **incorrect for current reality**. Both prod and staging use `Postergully/finny-claude-plugin` at `/opt/finny`; the dashboard ships as a subdirectory `/opt/finny/dashboard/` inside that repo. A separate doc-fix PR can correct this.

## 3. Architecture (target)

```
Internet (TLS via Caddy on STAGING box)
                │
   dashboard.finny.staging.11mirror.com  ← NEW vhost
                │
       443 → 127.0.0.1:3001                ← NEW listener (from PR #13 manifest)
                │
       finny-dashboard.service              ← NEW (system unit)
                │  ├─ POST /v1/chat/completions  →  127.0.0.1:8642 (existing)
                │  └─ GET  /api/sessions etc     →  127.0.0.1:9119 (NEW for staging)
                │
       hermes-gateway (existing pid 33143)  +  hermes-dashboard.service (rebound to loopback)
                │
       /opt/finny  (now at faf4215, was at a40d868)
       /opt/finny/dashboard/  (newly populated by FF + manifest walk)
```

Same shape as prod §1 in the handoff doc.

## 4. Constraints & non-goals

- **No prod changes.** Every step runs on the staging box or in staging-only AWS resources.
- **No new code in the dashboard or bridge.** This is a deploy/infra task — staging consumes commits already merged to `main` and `deployed` for prod's benefit.
- **No auth.** Per user direction, staging remains no-auth-v1 like prod.
- **No Bedrock router.** Follow-up PR.
- **Don't FF `~/.hermes` to `deployed`.** Staging `~/.hermes` is intentionally on `feat/atomic-fetch-v3` for active testing — leave it alone.
- **Don't FF `/opt/finny/dashboard`** — it doesn't exist yet on staging. It will appear *as a subdirectory* when we FF `/opt/finny`.

## 5. Plan outline (formal plan to be written via writing-plans skill)

### Phase A — fix the broken `hermes-gateway` user-mode unit (pre-flight cleanup)

**Subagent investigation (2026-06-22) corrected the earlier framing:** the broken unit is **user-mode**, not system. There is NO system unit. The unit at `/home/ubuntu/.config/systemd/user/hermes-gateway.service` is enabled, has `ExecStart` pointing at the wrong venv `/home/ubuntu/hermes-venv/bin/python`, and **will auto-start on next reboot**. Its `gateway run --replace` semantics will then SIGTERM the working orphan PID 33143 and itself fail — leaving staging with no gateway. This is a reboot footgun that must be fixed BEFORE any other change.

**Cleanup steps (executed in order, in a tmux session on staging):**

1. **Snapshot the current unit file** for rollback: `cp ~/.config/systemd/user/hermes-gateway.service /tmp/hermes-gateway.service.snapshot-$(date +%Y%m%d-%H%M%S)`.
2. **Diff `hermes-dashboard.service` (working sibling user unit) against `hermes-gateway.service`** to copy the right path conventions for venv / WorkingDirectory / Environment.
3. **Stop the orphan PID 33143 cleanly** (`kill -TERM 33143`; wait; verify port released). This causes a brief `:8642` outage — staging only, no production impact.
4. **Edit the unit** so:
   - `ExecStart=/home/ubuntu/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main gateway run --replace`
   - `WorkingDirectory=/home/ubuntu/.hermes/hermes-agent`
   - `Environment=VIRTUAL_ENV=/home/ubuntu/.hermes/hermes-agent/venv`
   - `Environment=PATH=/home/ubuntu/.hermes/hermes-agent/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`
   - `Environment=TERMINAL_CWD=/home/ubuntu/.hermes/profiles/staging` (matches orphan's cwd; aligns with handoff §6 gotcha 1 staging guidance)
5. `systemctl --user daemon-reload && systemctl --user restart hermes-gateway`
6. Verify: `systemctl --user status hermes-gateway` shows `active (running)`; `curl -sI http://127.0.0.1:8642/health` → 200; `ps -ef | grep hermes_cli.main` shows ONE process (no orphan + unit).
7. Remove the leftover `~/.config/systemd/user/hermes-gateway.service.pre-staging.bak`.

**Rollback:** restore the snapshot, `daemon-reload`, restart. Worst case staging has zero gateway momentarily — no prod impact.

**This phase MUST happen before Phase B**, otherwise the `:9119` enablement work or any reboot during the deploy could leave staging headless.

### Phase B — bring `/opt/finny` to prod parity

- Manual FF: `git -C /opt/finny fetch origin deployed && git merge --ff-only origin/deployed` on staging.
- Walk the existing prod manifests:
  - `docs/staging/feat-finny-dashboard-changes.md` (PR #13)
  - `docs/staging/feat-enable-hermes-dashboard-changes.md` (PR #16)
- These manifests already specify systemd unit installs (`finny-dashboard.service`, `hermes-dashboard.service`), npm/pnpm install steps, and restart sequence.
- Verify resulting state: `:3001` reachable on loopback, `:9119` reachable on loopback.

### Phase C — fix `hermes-dashboard.service` binding

Currently bound to `100.112.31.24:9119` (Tailscale interface). Dashboard SPA expects `127.0.0.1:9119`. Re-running the PR #16 manifest may already do this; if not, edit the unit's bind argument and restart. Verify with `curl http://127.0.0.1:9119/` returning 200.

### Phase D — DNS

Add Route53 A record:
- Zone: `Z01920243UX91ZKYKCMPA` (`staging.11mirror.com.`)
- Name: `dashboard.finny.staging.11mirror.com.`
- Type: A
- Value: `34.232.186.238`
- TTL: 300

Use `aws route53 change-resource-record-sets` with a JSON change-batch (matches the pattern used for prior records).

### Phase E — Caddy vhost on staging

Append to `/etc/caddy/Caddyfile` on staging:

```
dashboard.finny.staging.11mirror.com {
    encode gzip
    reverse_proxy 127.0.0.1:3001 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-Proto https
    }
}
```

Reload: `sudo systemctl reload caddy`. Watch journalctl for cert issuance.

Note: per handoff §gotcha 7, `/etc/caddy/Caddyfile` is hand-managed and not symlinked to the repo. We'll mirror the same edit into `deploy/caddy/Caddyfile` in the repo for traceability, but the live edit is what counts.

### Phase F — smoke test

1. `curl -sI https://dashboard.finny.staging.11mirror.com/` → expect 200, valid TLS.
2. Browser: load URL, confirm UI renders.
3. Pick a model in Settings → Provider (per handoff §5 fallback workaround).
4. Send a test chat message → confirm it streams.
5. Switch tabs (Sessions, Skills, Config) → confirm they populate (proves `:9119` is wired).
6. Confirm `https://dashboard.finny.prod.11mirror.com/` is **unaffected** (sanity check).

### Phase G — manifest + deploy log

Write `docs/staging/feat-staging-dashboard-vhost-changes.md` covering:
- Files touched on staging (`/etc/caddy/Caddyfile`, systemd unit changes, `/opt/finny` FF target SHA).
- Route53 record added.
- Restart steps.
- Smoke checks.
- Rollback plan: revoke Route53 record, remove vhost block from Caddyfile and reload, optional `git reset --hard a40d868` on `/opt/finny` if PRs need to be backed out.

Append a row to `docs/staging/deploy-log.md`.

### Phase H — staging → prod promotion (this PR specifically)

This PR's *code* changes are minimal — only docs/manifests + (optional) `deploy/caddy/Caddyfile` mirror. None of it has runtime effect on prod. Promotion follows the standard deployed-branch flow described in handoff §9:
- Merge feature branch → `main`.
- FF protected `deployed` to `main`'s tip.
- Prod runs `git pull` on `/opt/finny` (no manifest steps needed since this PR's runtime steps are staging-only).

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Bringing `/opt/finny` to `faf4215` re-runs PR #13/#16 manifests on staging and they fail mid-way | Each manifest has its own rollback steps; do Phase B in a tmux session and stop on first error |
| Caddy fails to issue the new cert (rate-limit, DNS not propagated) | Phase D before Phase E; wait for `dig dashboard.finny.staging.11mirror.com` to resolve before reloading Caddy |
| Dashboard SPA on staging accidentally talks to prod's gateway | It can't — SPA hard-coded to `127.0.0.1:8642`/`:9119` of its own host (per §5). Verify with `journalctl -u finny-dashboard` after first request |
| `~/.hermes` drift on `feat/atomic-fetch-v3` causes gateway behavior different from prod, masking dashboard issues | Acknowledge, don't fix here; staging is intentionally a feature-test box for that work. Note in deploy log. |
| Failed `hermes-gateway.service` (system) auto-starts on reboot and kills the working user-mode gateway via `--replace` | Phase A removes this risk before any Caddy/DNS work |

## 7. Open items confirmed with user

- DNS via Route53 CLI ✅ (zone exists, value is `34.232.186.238`)
- Dashboard repo = `finny-claude-plugin/dashboard/` (no separate v2 fork) ✅
- Prod `:9119` is already fixed ✅ (verified 200)
- No-auth on staging dashboard ✅
- Bedrock router → next PR ✅

## 8. What this is NOT

- Not a UI toggle inside the dashboard.
- Not a shared dashboard pointing at multiple gateways.
- Not a Tailscale-only deployment.
- Not introducing auth.
- Not changing prod.
- Not the Bedrock router work.

## 9. Next step

Once user approves this spec, invoke the `writing-plans` skill to produce the executable implementation plan covering Phases A–H with exact SSM commands, Route53 JSON, and verification checks per phase.
