# Staging Architecture for Finny Bridge + Hermes — Design Spec

**Date:** 2026-06-15
**Status:** Design (approved, ready for plan)
**Supersedes:** N/A
**Related plan:** `docs/superpowers/plans/2026-06-14-staging-architecture.md`
**First test target:** `docs/superpowers/plans/2026-06-11-atomic-fetch-search-as-code.md`

## Problem

We have no real staging environment. Today's "test before push" options are:

1. **Mocked bridge tests** — covers ~95% of bridge changes, fast, doesn't catch infra-shaped bugs.
2. **Sibling clone of `hermes-agent`** — runs Hermes locally; catches gateway-contract bugs but misses systemd / Caddy / OAuth / IAM / venv-layout issues.
3. **SSH tunnel to prod EC2** — every test runs against prod compute and prod NetSuite.

Hermes is an LLM agent that mutates NetSuite. Infra-shaped bugs we can't see in mocks have already bitten us (see `[[hermes-venv-mismatch]]` — systemd unit pointing at the wrong venv on EC2). We need a tier that catches infra/wiring bugs before prod, accepting that **NetSuite stays a single prod tenant** and **2 users (me + teammate) share staging**.

## Goals

- A separate EC2 box that mirrors prod's compute, OS, Caddy, systemd, Hermes install layout, and skills repos — so infra bugs surface on staging first.
- Branch → PR → staging test → manifest → merge → prod deploy. Staging gates the merge, not the deploy.
- Zero contamination of prod state: staging Hermes writes only to staging's disk; staging never replies to prod Slack; staging OAuth tokens are not interchangeable with prod's.
- Reproducible "no surprises" prod deploy: every non-git change made during a staging session is captured in a per-branch manifest committed to the PR.

## Non-goals

- **NetSuite sandbox.** Staging hits prod NetSuite. Test discipline is the only mitigation. Captured as a v2 TODO.
- **Automated CI deploy to staging.** v1 is manual (push branch + SSM restart).
- **Replacing the mocked / sibling-clone loops.** Both stay valid; staging is additive for changes that need infra parity.
- **Multi-developer concurrent staging.** Two users, serialized use. If contention shows up, revisit.
- **Public-internet dashboard.** Dashboard reaches users via Tailscale only. (The bridge MCP endpoint *is* public — see D10 — but the dashboard is not.)

## What already exists

- `deploy/hermes-bootstrap.sh` — provisions Hermes on a fresh EC2. Reused as-is for parity verification, but the **primary staging build path is an OS snapshot of prod**, not a fresh bootstrap.
- `bridge/` MCP server with stdio + SSE/HTTP transports, OAuth 2.1, `MCP_ALLOWED_HOSTS` enforcement.
- Production Caddy config, systemd units (`hermes-api.service`, `hermes-gateway.service` user-level, `finny-mcp.service` system-level), IAM role.
- SSM access to prod EC2 (`i-0ef58962b09d490ee`) — same access pattern works for staging.
- Tailscale (already in use; staging EC2 joins existing tailnet).
- Hermes desktop app installed on user's Mac; supports per-profile remote backend configuration.
- Mocked bridge test loop (`pnpm -r test`).

## Decisions

### D1. Staging EC2 = OS snapshot of prod

Staging is built from an AMI snapshot of prod EC2, not from a fresh `hermes-bootstrap.sh` run. Rationale:

- True parity. Inherits the dual-venv layout (`[[hermes-venv-mismatch]]`), the `Postergully/finny-hermes` editable install, the `Postergully/finny-hermes-config` skills checkout, the `netsuite-kb` repo, the systemd units exactly as prod has them, the Caddy config, every apt/pip/npm package.
- Removes "drift between staging-bootstrap and prod's actual current state" as a class of bug.
- `hermes-bootstrap.sh` stays useful for two cases: (a) building staging from scratch if a snapshot is unavailable, (b) verifying prod and staging are still bootstrap-equivalent.

### D2. Pure clone of `~/.hermes/` data

Sessions, memories, skills, and `.env` come over with the snapshot. No first-boot wipe. Rationale (user's call):

- Two-EC2 separation already gives prod-state isolation: staging Hermes writes only to staging's disk. Prod's `~/.hermes/sessions/` and `~/.hermes/memories/` are never touched after snapshot time.
- Sessions/memories present at boot give staging a realistic agent baseline, useful for debugging memory-dependent behavior.
- Trust boundary: only 2 users access staging, both authorized to see prod conversation content.

### D3. NetSuite credentials shared with prod

Same `FINNY_UPSTREAM_TOKEN`, same NetSuite OAuth/TBA token. Rationale:

- No NetSuite sandbox available.
- Most staging bugs are infra-shaped, not NetSuite-shaped.
- Cost: staging mutations hit real NetSuite. Same as today's tunnel-to-prod loop. Mitigated by test discipline (read-heavy, draft records only).

### D4. Active Hermes profile = `staging` (dashboard, no Slack)

After snapshot boot, switch the gateway's active profile from `default` (Slack + chat completions) to `staging` (chat completions + dashboard, no messaging integrations). Rationale:

- Same Slack bot token in two places = duplicate replies. Avoided by removing Slack from staging's profile.
- Bridge → Hermes path needs only chat completions on `127.0.0.1:8642`. Slack is unrelated.
- Chat-with-Hermes for human testing happens via the desktop dashboard, not Slack.

### D5. Own MCP OAuth client, long-lived secret, no rotation

Staging gets fresh `MCP_CLIENT_ID` / `MCP_CLIENT_SECRET` (`openssl rand -hex 32`). No expiry. Rationale:

- Two users, internal infra, low rotation value.
- Mandatory isolation: shared OAuth secret = staging tokens accepted by prod and vice versa. The one secret rotation that's non-negotiable.

### D6. Dashboard exposed via Tailscale + basic auth (per Nous docs)

Per [Hermes docs — Connecting to a Remote Backend](https://hermes-agent.nousresearch.com/docs/user-guide/desktop#connecting-to-a-remote-backend):

- Bind dashboard to staging EC2's tailnet IP, port 9119: `hermes dashboard --no-open --host <tailscale-ip> --port 9119`
- Auth provider: username/password (the docs explicitly classify u/p as "local / trusted-network use only" — a tailnet qualifies).
- `~/.hermes/.env` (mode 0600) gets:
  - `HERMES_DASHBOARD_BASIC_AUTH_USERNAME`
  - `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH` (scrypt hash, not plaintext)
  - `HERMES_DASHBOARD_BASIC_AUTH_SECRET` (so sessions survive dashboard restarts)
- Dashboard runs as its own systemd unit (`hermes-dashboard.service`, user-level) so it survives reboots. EnvironmentFile points at `~/.hermes/.env`.
- Each user adds `http://<tailscale-ip>:9119` under a `staging` profile in their desktop app, signs in once.

The docs explicitly warn: *"never expose a password-protected dashboard directly to the open internet; put it behind a VPN."* Tailscale is the recommended fit.

### D7. Branch-first flow (PR open → staging → merge → prod)

```
1. feature branch (bridge / finny-hermes / finny-hermes-config / netsuite-kb)
2. open PR
3. CI: pnpm -r test (existing mocked tests, fast)
4. push branch to staging EC2; restart staging units; smoke via desktop dashboard
5. iterate; capture every non-git change in docs/staging/<branch>-changes.md, commit to branch
6. PR contains: code diff + staging-changes manifest + green smoke evidence
7. reviewer approves, merge to main
8. prod deploy = git pull on prod EC2 + walk manifest's non-git steps + restart units
```

Staging gates the **merge**, not the deploy. The manifest is the contract that makes prod deploy additive and surprise-free.

### D8. Mandatory per-branch change manifest

Every branch tested on staging produces `docs/staging/<branch-name>-changes.md` in the bridge repo, committed to the branch. No prod deploy without it. See "Change manifest format" below.

### D10. Two listeners on staging — public MCP + tailnet dashboard

Staging exposes two distinct surfaces, deliberately:

| Surface | Reachability | Listener | Purpose | Auth |
|---|---|---|---|---|
| Bridge MCP | **Public internet** at `https://staging.finny.11mirror.com/mcp` | Caddy (TLS) → `127.0.0.1:3000` (`finny-mcp.service`) | Browser Claude cowork via Custom Connector — full parity with prod's MCP path | OAuth 2.1 with **staging-only** `MCP_CLIENT_ID`/`SECRET` (D5) + `MCP_ALLOWED_HOSTS=staging.finny.11mirror.com` |
| Hermes dashboard | **Tailnet only** at `http://<tailscale-ip>:9119` | `hermes-dashboard.service` bound to tailnet IP | Desktop-app chat with staging Hermes (replaces Slack interaction surface) | Basic auth (scrypt hash) per Nous docs |

Rationale for keeping MCP public on staging:

- The single most valuable thing staging tests is **the cowork → bridge → Hermes → NetSuite path end-to-end**. Browser Claude cowork can only reach an MCP endpoint over the public internet (Custom Connectors don't traverse tailnets). Forcing all cowork tests through CLI cowork (which can use stdio over a tailnet-tunneled bridge) leaves browser cowork untested before merge — the exact regression we're trying to prevent.
- Security posture is the same as prod: OAuth 2.1, separate client, host allowlist, Caddy TLS. The blast radius of a leaked staging MCP secret is a leaked staging secret — staging tokens are rejected by prod (D5).
- Staging Caddy config is structurally identical to prod's, just with a different `server_name` and different OAuth env. Reusing the same Caddyfile shape is its own form of parity testing.

Rationale for keeping dashboard tailnet-only:

- Per Nous docs: *"never expose a password-protected dashboard directly to the open internet."* The dashboard reads/writes `.env` and runs agent commands — qualitatively higher blast radius than an MCP endpoint.
- Two users only, both already on the tailnet. Public exposure has no benefit and real cost.

### D11. Caddy on staging mirrors prod's Caddyfile shape

- `/etc/caddy/Caddyfile` on staging serves `staging.finny.11mirror.com` (TLS auto-issued by Caddy via Let's Encrypt).
- Reverse-proxies `/mcp` to `127.0.0.1:3000` (same as prod).
- Logs to journald (same as prod, no file log block).
- Caddy config is part of the prod snapshot; post-snapshot edit replaces `finny.prod.11mirror.com` references with `staging.finny.11mirror.com`. Captured as an explicit step in Phase 2 and in the manifest template (so Caddy edits never escape into prod via stale manifests).
- DNS: `staging.finny.11mirror.com` A-record → staging EC2 Elastic IP (allocate one in Phase 1).

### D12. Snapshot refresh cadence ≤14 days

Staging snapshot refreshed from prod at least every 14 days, OR before testing any branch older than 7 days. Refresh = take fresh AMI of prod, launch as new staging EC2, re-enroll in tailnet, repoint `staging.finny.11mirror.com` DNS to the new Elastic IP, replay post-snapshot edits (Phase 2), terminate old staging. ~30 min. Keeps "worked in staging" honest as prod evolves.

The post-snapshot edits in Phase 2 are themselves a manifest — capture them as `docs/staging/snapshot-refresh-checklist.md` so refresh is a checklist replay, not a memory exercise.

## Architecture

```
Browser Claude cowork ──MCP/HTTPS──→  ┌──────────────────────────────────┐         ┌──────────────────────────────────┐
                                      │ PROD EC2                         │         │ STAGING EC2 (AMI clone of prod)  │ ←── Browser Claude cowork
                                      │ finny.prod.11mirror.com (public) │         │ staging.finny.11mirror.com       │     (Custom Connector,
                                      │   Caddy (TLS, Let's Encrypt)     │         │   Caddy (TLS, Let's Encrypt)     │      staging OAuth client)
                                      │     ↓ /mcp                       │         │     ↓ /mcp                       │
                                      │   finny-mcp.service :3000        │         │   finny-mcp.service :3000        │
                                      │   hermes-gateway.service :8642   │         │   hermes-gateway.service :8642   │
                                      │     profile: default             │         │     profile: staging             │
                                      │     (Slack + chat)               │         │     (chat only, no Slack)        │
                                      │   MCP OAuth client: prod         │         │   MCP OAuth client: staging      │
                                      │   IAM role: prod                 │         │   IAM role: staging              │
                                      │   ~/.hermes/sessions/ (own)      │         │   hermes-dashboard.service       │ ←── Hermes desktop app
                                      │   ~/.hermes/memories/ (own)      │         │     bound to tailnet IP :9119    │     (Mac, staging profile,
                                      │                                  │         │     basic auth                   │      basic-auth login)
                                      │                                  │         │   ~/.hermes/sessions/ (own)      │
                                      │                                  │         │   ~/.hermes/memories/ (own)      │
                                      └──────────────┬───────────────────┘         └──────────────┬───────────────────┘
                                                     │                                            │
                                                     ▼                                            ▼
                                                ┌───────────────────────────────────────────────────┐
                                                │   NetSuite PROD (single tenant)                   │
                                                │   Both envs share FINNY_UPSTREAM_TOKEN.           │
                                                │   Discipline-based mutation safety.               │
                                                └───────────────────────────────────────────────────┘
```

Key isolation properties:

- **Compute / memory / journald:** separate EC2 instance.
- **Sessions / memories / .env on disk:** separate filesystem; staging writes never touch prod disk.
- **MCP OAuth identity:** different client_id + secret; tokens not interchangeable between envs.
- **IAM role:** different role with mirrored permissions; CloudTrail can distinguish staging-vs-prod actions.
- **Slack:** staging profile has no Slack integration → no double-replies.
- **Dashboard reachability:** tailnet only; not on public internet.
- **NetSuite:** explicitly shared (acknowledged gap).

## Components

### Tailscale on staging EC2
- Install: `curl -fsSL https://tailscale.com/install.sh | sh`
- Authenticate: `sudo tailscale up --authkey <ephemeral-key-or-interactive>`
- Verify tailnet IP: `tailscale ip -4`
- Two human users (me + teammate) already on the tailnet; staging EC2 joins as a new node.

### `hermes-dashboard.service` (new, user-level systemd unit on staging)
```
[Unit]
Description=Hermes desktop-app backend (dashboard)
After=network-online.target hermes-gateway.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=%h/.hermes/.env
ExecStart=/home/ubuntu/.hermes/hermes-agent/.venv/bin/hermes dashboard --no-open --host %E{HERMES_DASHBOARD_HOST} --port 9119
Restart=on-failure

[Install]
WantedBy=default.target
```
- `HERMES_DASHBOARD_HOST` = staging tailnet IP, set in `~/.hermes/.env`.
- Path uses the **editable-install venv** (`.hermes/hermes-agent/.venv`), not the orphan `hermes-venv` from `[[hermes-venv-mismatch]]`. The snapshot inherits both venvs; the dashboard unit explicitly points at the right one from day one. (Fixing the gateway's wrong-venv unit is out of scope for this spec — captured as TODO.)

### Hermes profile switch (snapshot post-boot edit)
- `~/.hermes/profiles/staging.yaml` (or equivalent — exact file determined when implementing): copy of `default.yaml` with messaging integrations removed.
- `hermes gateway list` shows the active profile; switch via the appropriate Hermes CLI command.
- `hermes-gateway.service` (user-level, inherited from snapshot) restarts with the new profile selected.

### MCP OAuth on staging
- Generate: `MCP_CLIENT_ID=$(openssl rand -hex 32)`, `MCP_CLIENT_SECRET=$(openssl rand -hex 32)`.
- Store in AWS Secrets Manager under `finny/staging/oauth/*`.
- Inject into `/opt/finny/bridge/.env` on staging during post-snapshot edit.
- No expiry — long-lived; rotate manually if compromise suspected.

### `finny-mcp.service` (inherited from snapshot, edited post-boot)
- Bridge listens on `127.0.0.1:3000` (same as prod).
- `.env` updated with staging `MCP_CLIENT_ID`/`SECRET` and `MCP_ALLOWED_HOSTS=staging.finny.11mirror.com`.
- Caddy proxies `https://staging.finny.11mirror.com/mcp` → `127.0.0.1:3000`, so browser Claude cowork can register a Custom Connector pointed at staging (D10).

### Caddy on staging (inherited from snapshot, edited post-boot)
- Edit `/etc/caddy/Caddyfile`: replace `finny.prod.11mirror.com` block with `staging.finny.11mirror.com` block (same proxy target, same logging shape).
- `caddy validate /etc/caddy/Caddyfile` then `sudo systemctl reload caddy`.
- DNS: `staging.finny.11mirror.com` A-record → staging EC2 Elastic IP (allocate in Phase 1).
- TLS cert auto-issued by Caddy via Let's Encrypt on first request to the new domain.

### `~/.hermes/.env` post-snapshot edits
```bash
# new on staging:
HERMES_DASHBOARD_BASIC_AUTH_USERNAME=staging-user
HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH=<scrypt-hash>
HERMES_DASHBOARD_BASIC_AUTH_SECRET=<random-32-bytes>
HERMES_DASHBOARD_HOST=<staging-tailnet-ip>

# changed from prod values:
MCP_CLIENT_ID=<staging-id>
MCP_CLIENT_SECRET=<staging-secret>
MCP_ALLOWED_HOSTS=staging.finny.11mirror.com

# unchanged from prod (deliberate):
FINNY_UPSTREAM_TOKEN=<prod NetSuite token>
```

## Workflow

### Branch test cycle (per PR)
```
local Mac:
  git checkout -b feature/foo
  # edit code
  git push origin feature/foo
  gh pr create

  CI runs pnpm -r test on PR.

staging EC2 (via SSM):
  sudo -iu ubuntu bash -lc '
    cd /opt/finny &&
    git fetch origin &&
    git checkout feature/foo &&
    pnpm install --frozen-lockfile &&
    pnpm -C bridge build
  '
  sudo systemctl restart finny-mcp
  sudo -iu ubuntu systemctl --user restart hermes-gateway hermes-dashboard

local Mac:
  open Hermes desktop app, switch to "staging" profile
  smoke test the feature via dashboard chat
  smoke test 5 MCP tools via local Claude cowork pointed at staging tailnet IP

local Mac:
  # capture every non-git change made on staging during testing
  edit docs/staging/feature-foo-changes.md
  git add docs/staging/feature-foo-changes.md && git commit && git push

  reviewer reviews PR (code + manifest + smoke evidence)
  merge.
```

### Prod deploy (post-merge)
```
prod EC2 (via SSM):
  sudo -iu ubuntu bash -lc '
    cd /opt/finny &&
    git pull --ff-only origin main &&
    pnpm install --frozen-lockfile &&
    pnpm -C bridge build
  '
  # walk docs/staging/<merged-branch>-changes.md non-git steps
  # in the order recorded
  sudo systemctl restart finny-mcp
  sudo -iu ubuntu systemctl --user restart hermes-gateway
  # do NOT restart hermes-dashboard on prod — prod doesn't have one
```

The manifest is the prod-deploy script. If a non-git step is missing from the manifest, the staging→prod promotion is incomplete and the merge should not have happened.

## Change manifest format

Per branch, `docs/staging/<branch-name>-changes.md`:

```markdown
# Staging changes: <branch-name>
Date tested: <YYYY-MM-DD> → <YYYY-MM-DD>
Tested by: <name>
Staging snapshot baseline: prod AMI <ami-id> (taken <date>)

## Git changes (replay via merge)
- finny-claude-plugin@<branch>: <commits or "see PR #N">
- finny-hermes@<branch>: <commits, or "no changes">
- finny-hermes-config@<branch>: <commits, or "no changes">
- netsuite-kb@<branch>: <commits, or "no changes">

## Non-git changes (replay manually on prod, in order)
1. `~/.hermes/.env`: <key>=<value>
2. `/etc/systemd/system/finny-mcp.service`: <field changed>
3. `apt install <package>` (used by <reason>)
4. `<other manual edit>`
5. `sudo systemctl daemon-reload && sudo systemctl restart <unit>`

If empty: write "No non-git changes — git merge + standard restart is sufficient."

## What was tested on staging
- 5-tool smoke (finny_query, finny_report, finny_task_status, finny_continue, finny_remember): ✓
- <feature-specific test 1>: ✓
- <feature-specific test 2>: ✓

## Skipped on prod (staging-only changes)
- (e.g., extra debug logging that should NOT carry to prod)
- If empty: "None."

## Rollback
- `git revert <merge-sha>` on each repo.
- Revert non-git changes in reverse order. Specifically: <list>.
```

The manifest is required. Reviewers reject PRs without one.

## Failure modes

| Failure | Test? | Error handling? | User-visible? |
|---|---|---|---|
| Staging Caddy serving prod's domain (post-snapshot edit missed) | Phase 3 step 20 catches via OAuth metadata mismatch | Caddy returns prod cert for prod hostname → request fails before reaching bridge | Developer setting up Custom Connector sees TLS/OAuth error |
| Staging Caddy public listener misconfigured | Manual smoke | Service fails to start; surfaces in `systemctl status caddy` | No — internal only |
| Staging MCP exposed publicly with prod's OAuth client (D5 not enforced) | Phase 3 step 20 catches via metadata diff | Cross-env token reuse possible | Hidden — would only surface if a staging token gets used against prod |
| Staging OAuth client misconfigured | Manual smoke | MCP returns 401; logged | Developer setting up cowork sees error |
| Staging gateway active profile = `default` instead of `staging` | **Manual check post-snapshot — explicit step in setup** | If missed: staging Hermes responds to **prod Slack messages**. Loud, fast, recoverable. | **Yes** — Slack users see double replies. |
| systemd unit references wrong venv | Smoke catches via 5xx on first tool call | journald shows ImportError | Developer sees tool failure |
| Tailnet ACL excludes a user from staging EC2 | User can't reach dashboard | `tailscale status` debug | Developer sees connection refused |
| Dashboard `.env` missing `HERMES_DASHBOARD_BASIC_AUTH_SECRET` | Sessions invalidated on every restart | Per Nous docs warning | Annoying re-login, not a security failure |
| Staging mutates prod NetSuite | **No automated test** | **No automated mitigation** | **Real users see corrupt data** — discipline only |
| Prod deploy proceeds without manifest | Reviewer should reject; no automated gate v1 | Captured as v2 TODO (CI gate) | Prod surprise — exactly what this design exists to prevent |
| Snapshot drift > 14 days | Calendar reminder only v1 | None | "Worked in staging" weakens silently |
| Branch tested against stale snapshot, prod has diverged | Manifest still correct for the branch, but baseline is old | Snapshot-refresh discipline (D9) | Subtle prod surprises |

The NetSuite-mutation row and the manifest-skip row are the **two consciously accepted gaps**.

## Implementation tasks

Phases live in the plan document (`docs/superpowers/plans/2026-06-14-staging-architecture.md`); this spec is the contract. Plan should cover:

### Phase 1 — Snapshot + boot staging EC2
1. Take AMI snapshot of prod (`i-0ef58962b09d490ee`).
2. Launch new EC2 (t3.small, same VPC/subnet) from the AMI.
3. Allocate Elastic IP and associate with staging instance.
4. Add DNS A-record: `staging.finny.11mirror.com` → staging Elastic IP.
5. Install + enroll Tailscale on staging EC2 (`tailscale up`).
6. Create staging IAM role (mirror of prod) and attach to instance.
7. Open security-group ingress: 443 (Caddy public), 22 (SSM only — no public SSH).

### Phase 2 — Post-snapshot edits
8. Generate staging `MCP_CLIENT_ID`/`SECRET` (`openssl rand -hex 32`); store in Secrets Manager under `finny/staging/oauth/*`; write to `/opt/finny/bridge/.env`.
9. Generate dashboard basic-auth username + scrypt password hash (`hermes` CLI helper or `python -c 'from hashlib import scrypt; …'`) + auth secret; write to `~/.hermes/.env` (mode 0600).
10. Set `HERMES_DASHBOARD_HOST=<tailnet-ip>` in `~/.hermes/.env`.
11. Update `MCP_ALLOWED_HOSTS=staging.finny.11mirror.com` in `/opt/finny/bridge/.env`.
12. Edit `/etc/caddy/Caddyfile`: replace prod domain block with `staging.finny.11mirror.com` block (same proxy target `127.0.0.1:3000`, same journald logging). `caddy validate` and reload.
13. Create `~/.hermes/profiles/staging.yaml` (copy of `default` minus messaging integrations); switch active profile via `hermes gateway` CLI.
14. Add `~/.config/systemd/user/hermes-dashboard.service` unit; `systemctl --user daemon-reload`, `enable --now`.
15. Restart `finny-mcp` (system), `hermes-gateway` (user), `caddy` (system) so they pick up new env / config.
16. Capture every Phase 2 edit as `docs/staging/snapshot-refresh-checklist.md` (so the next refresh is a checklist replay).

### Phase 3 — Verify
17. `tailscale status` confirms staging EC2 on the tailnet.
18. `curl -s http://<tailnet-ip>:9119/api/status | jq '.auth_required, .auth_providers'` returns `true` and `["basic"]`.
19. Desktop app on Mac (both users): add staging profile → `http://<tailnet-ip>:9119` → sign in with basic auth → confirm dashboard chat works.
20. Public MCP path: `curl -sS https://staging.finny.11mirror.com/.well-known/oauth-protected-resource` returns staging's OAuth metadata (different `client_id` than prod).
21. Browser Claude cowork: register Custom Connector at `https://staging.finny.11mirror.com/mcp`, complete OAuth flow with staging client, confirm all 5 MCP tools (`finny_query`, `finny_report`, `finny_task_status`, `finny_continue`, `finny_remember`) work end-to-end.
22. Confirm staging Hermes did NOT respond to any prod Slack message during testing (search prod Slack channel history for the test window).

### Phase 4 — Document the discipline
23. Add **"Staging-to-prod promotion"** section to `CLAUDE.md` (workflow + manifest template path + snapshot-refresh rule + listener split: public MCP vs tailnet dashboard).
24. Create `docs/staging/README.md` (long-form how-to, snapshot refresh procedure, manifest template, Caddy edit checklist).
25. Create memory entry `staging-promotion-discipline.md` (so Claude sessions remember the rule across compaction).
26. Replace the "Staging tunnel" row in `CLAUDE.md`'s local-dev-loops table with a "Staging EC2" row.

### Phase 5 — Smoke test the loop with a real branch
27. Push the `atomic-fetch-search-as-code` branch (user's current WIP, plan at `docs/superpowers/plans/2026-06-11-atomic-fetch-search-as-code.md`) to staging.
28. Walk the full PR → staging → manifest → merge cycle for that branch as the first real exercise.
29. Document any rough edges; fix in `deploy/hermes-bootstrap.sh` and `docs/staging/README.md` so the next branch is smoother.

## TODOs (deferred)

- **Provision NetSuite sandbox.** Removes the only deliberate parity gap. Requires NetSuite admin coordination.
- **CI gate on manifest presence.** Reject PR merge if no `docs/staging/<branch>-changes.md` exists for branches that touched bridge / hermes / hermes-config. Today: reviewer enforces.
- **Auto-deploy to staging on PR open.** Removes manual `git push staging` + SSM restart. Today: manual.
- **Post-deploy canary on staging.** Runs the 5-tool smoke automatically after every staging deploy. Today: manual smoke.
- **Fix `[[hermes-venv-mismatch]]` properly on staging.** The snapshot inherits the dual-venv quirk. Eventually edit `hermes-gateway.service` ExecStart to point at the editable-install venv on staging first (lower risk than fixing prod), validate, then promote the fix to prod via the same staging-manifest flow.
- **Snapshot-refresh automation.** Today: manual every ≤14 days. Eventually: scheduled via EventBridge.
- **Cost / orphan policy.** Nightly stop + on-demand start, or quarterly utilization review. Today: neither.

## Distribution

Internal infra. No new artifact shipped to users.

## What this buys us

- **Catches infra bugs before prod** — systemd, Caddy, OAuth, IAM, venv layout, package drift.
- **Lets bridge developers push branches** with a real "tested before merge" gate.
- **Forces non-git infra changes to be captured** — the manifest is the discipline, the prod-deploy script, and the audit trail in one artifact.
- **Forces snapshot-refresh discipline** — keeps staging from silently diverging from prod.
- **Costs ~$15/mo + a day of setup + ~30 min every 14 days for snapshot refresh.**

## What this does NOT buy us

- **Safe NetSuite mutation testing.** Punted.
- **Multi-developer concurrent testing.** Two users, serialized.
- **Automated deploys.** Manual push + SSM restart.
- **Public-internet dashboard.** Tailnet only by design.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 5 issues raised in conversation, all resolved by design decisions D1–D9 |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**UNRESOLVED:** 0 — all open questions answered through brainstorming (D1–D9).
**VERDICT:** ENG CLEARED — ready to update plan and implement.

---

## Build addendum (2026-06-16)

This section captures what the spec got wrong or under-specified, discovered during the Phase 1–3 build (commits `49f0614`…`7f4e0ec` on `worktree-staging-architecture-plan`). The addendum is appended rather than retconned into D1–D10 so future readers can see the design intent vs. the build reality. The corrections are authoritative — if a Phase 4+ doc and the original D1–D10 conflict, the addendum wins.

### Drift corrections (overrides to original D1–D10)

**A1. DNS naming.**
Spec: `staging.finny.11mirror.com`. Reality: **`finny.staging.11mirror.com`**, in Route53 zone `staging.11mirror.com`. Mirrors the prod shape `finny.prod.11mirror.com`. All references in operator docs and the bridge env use the corrected form.

**A2. Hermes editable venv path.**
Spec: `~/.hermes/hermes-agent/.venv/...` (with leading dot). Reality: `~/.hermes/hermes-agent/venv/...` (no dot). Affects `hermes-dashboard.service` `ExecStart`.

**A3. Profile to clone.**
Spec said copy `default.yaml`. Reality: prod profiles dir contains a `finny/` directory (not a flat `default.yaml`). Correct move: `cp -r ~/.hermes/profiles/finny ~/.hermes/profiles/staging`, then `hermes profile use staging`.

### D11. Dashboard auth model — Hermes v0.14 has no native basic-auth env vars

The spec's D6 cited `HERMES_DASHBOARD_BASIC_AUTH_USERNAME` / `_PASSWORD_HASH` / `_SECRET` per the public Nous docs (https://hermes-agent.nousresearch.com/docs/user-guide/desktop). **Those env vars do not exist in `hermes-agent v0.14.0`** — they're future / docs-ahead-of-shipped-code. Source check: `hermes_cli/web_server.py:80-130` shows an ephemeral session token regenerated each dashboard restart, injected into the SPA HTML at `window.__HERMES_SESSION_TOKEN__`, with CORS restricted to localhost.

Implication: the dashboard cannot be auth-gated by Hermes in v0.14. **Tailscale becomes the trust boundary.** D6 stands in spirit (dashboard is tailnet-only), but the implementation differs:

- Dashboard binds **directly** to the tailnet IP (`100.112.31.24:9119`), not to localhost behind a Caddy reverse proxy with `basic_auth`.
- Session token is fetched from any tailnet device by `curl`-ing the SPA HTML and grepping out the token; pasted into the desktop app. Token rotates on every dashboard restart (refresh / reboot / `systemctl restart`).
- When Hermes ships a version with native dashboard basic-auth env vars, revisit D6 properly via the staging-promotion flow (it'll be a manifested non-git change touching `~/.hermes/.env`).

Why direct tailnet bind, not Caddy in front: Hermes v0.14 has a Host-header DNS-rebinding guard. With Caddy reverse-proxying `100.112.31.24` → `127.0.0.1`, Hermes sees `Host: 100.112.31.24` ≠ bound host `127.0.0.1` and 4xx's everything. Binding Hermes to the tailnet IP directly avoids the guard.

### D12. Caddy must be a single transparent reverse-proxy block — no path filtering

The spec's D11 said Caddy mirrors prod's Caddyfile shape. The build-time correction is sharper: **Caddy MUST proxy the entire site to the bridge.** Path-filtering routes (`/mcp*`, `/.well-known/oauth-*`) silently break OAuth — Caddy returns empty 200s for unfiltered paths, the bridge never sees `/register` / `/authorize` / `/token`, and Claude.ai's OAuth dance fails with `oauth_error=registration_endpoint_missing`.

Working Caddyfile shape (verified at `fd1ac78`):

```
finny.staging.11mirror.com {
    encode gzip
    reverse_proxy 127.0.0.1:3000 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-Proto https
    }
}
```

The bridge's OAuth router internally serves `/authorize`, `/token`, `/revoke`, `/register` (when DCR is enabled), `/.well-known/oauth-*`, and `/mcp*`. Trust the bridge's router; don't second-guess it in Caddy.

### D13. Claude.ai Custom Connector setup needs OAuth credentials in "Advanced settings"

The Claude.ai Custom Connector dialog has a collapsed **Advanced settings** section with `OAuth Client ID` and `OAuth Client Secret` fields that *look* optional but **are effectively required for any bridge that doesn't advertise `/register`**. The bridge's RFC 7591 Dynamic Client Registration is intentionally OFF in production deploys (`MCP_DANGEROUSLY_ALLOW_DCR` is not set). Without DCR, Claude.ai cannot self-register a client; the user must paste the bridge's static `MCP_CLIENT_ID` / `MCP_CLIENT_SECRET` into the Advanced settings.

Symptom of missing credentials: `oauth_error=registration_endpoint_missing` on connector setup.

Operator procedure for getting the credentials without leaking through transcript:
```bash
aws ssm start-session --target i-0c2c974ff571162eb
sudo grep -E '^MCP_CLIENT_ID|^MCP_CLIENT_SECRET' /opt/finny/bridge/.env
exit
```

### D14. Hermes profile-env gotcha — non-default profile loads only profile-dir env

When a non-default Hermes profile is active, the gateway loads env from `~/.hermes/profiles/<name>/.env` **only**, NOT from the global `~/.hermes/.env`. The profile dir's `.env` only has `API_SERVER_*` keys by default — NetSuite, Hindsight, GitHub credentials live only in the global `.env`.

Result on staging: gateway runs but tools return `gateway_unreachable: NetSuite credentials not configured`. Prod doesn't hit this because prod runs the implicit `default` profile (no profile dir → reads global `.env`). Staging has its own profile dir → must replicate the credential set.

Procedure (idempotent, captured in `docs/staging/snapshot-refresh-checklist.md` §6):
1. `cp -r ~/.hermes/profiles/finny ~/.hermes/profiles/staging`
2. Strip Slack from profile `.env` (defensive — usually not present).
3. Append NetSuite/Hindsight/GitHub keys from global `.env` to profile `.env`.
4. Dedupe by key.
5. `chmod 600` the profile `.env`.
6. `hermes profile use staging`.

### D15. `[[hermes-venv-mismatch]]` reframing — don't "fix" the venv layout on staging

The `[[hermes-venv-mismatch]]` memory framed `/home/ubuntu/hermes-venv/` as "the wrong venv" because `hermes-gateway.service`'s ExecStart points there while the running gateway was thought to use the editable install. Build-time finding: **on prod, the gateway actually runs from `hermes-venv` and that's where the NetSuite plugin chain works.** During the first staging build I switched the unit to `~/.hermes/hermes-agent/venv/...` (the editable install) — NetSuite calls then failed with `gateway_unreachable` even though the gateway process was active. Reverting to `hermes-venv` restored NetSuite.

Hypothesis: prod's NetSuite plugin chain depends on packages installed only in `hermes-venv`, not in the editable install. The editable install is used by the dashboard and CLI, not the gateway service.

D1 says staging must be a true copy of prod. **Don't try to "fix" the venv on staging.** If `[[hermes-venv-mismatch]]` ever gets fixed properly, do it on prod first via a feature branch and the staging-promotion flow (which is exactly the discipline this whole tier exists to enforce), never as a staging-only divergence.

The memory should be updated in a follow-up to reflect that the "wrong" venv is actually the working one — but that's a memory-hygiene task, not a code change.

### D16. Desktop app v0.14 always runs the agent locally

Even with Settings → Gateway → Remote set to `http://100.112.31.24:9119`, the **chat agent loop in the desktop app v0.14 always runs locally on the user's Mac.** The "Remote gateway" toggle observes/controls the remote dashboard process (it can show "Connected to … · Hermes 0.14.0") but does NOT route the chat agent through the remote box.

Implication: the desktop app's chat tab is **not** a faithful test of staging Hermes' chat behavior in v0.14. This is acceptable because **the production traffic path is via the bridge/MCP**, not the dashboard chat tab. Browser Claude cowork → `https://finny.staging.11mirror.com/mcp` exercises the real path; the dashboard is for inspecting agent state and exercising the gateway directly via its API surface.

When Hermes is upgraded to a version with full remote-chat-tab support, revisit. Captured as a TODO.

### Operational TODOs that emerged (not in original spec)

- **AWS Secrets Manager IAM grant.** Instance role `hermes-bedrock-HermesInstanceRole-I8b1EsGCg8Qn` lacks `secretsmanager:CreateSecret` / `GetSecretValue` / `PutSecretValue` on `arn:aws:secretsmanager:*:*:secret:finny/staging/oauth/*`. Phase 2 fell back to writing MCP OAuth secrets directly into `/opt/finny/bridge/.env` (mode 0600 root). Acceptable v1 (low rotation, single instance), fix in v2 by granting the IAM permissions and pulling at unit start.
- **EBS snapshot cleanup policy.** `snap-0750e633f9a5e1500` (pre-termination old staging) and prod AMI snapshots accumulate ~$1.50/mo each. Add an EventBridge / cron rule to keep only the latest 2.
- **Stop staging nightly.** Halves t3.small cost from ~$15/mo to ~$8/mo. Deferred — not worth the complexity until cost matters.
- **Memory hygiene.** Update `[[hermes-venv-mismatch]]` to reflect D15 — `hermes-venv` is the working venv on prod, don't "fix" it.
- **Hermes upgrade promotion.** When Hermes ships a version with native dashboard basic-auth env vars and full remote-chat-tab support, run the upgrade through the staging-promotion flow and revisit D11 + D16.

### Files this addendum touched (Phase 4)

- `CLAUDE.md` (root) — new "Staging-to-prod promotion" section, replaced staging-tunnel row in local-dev-loops table.
- `docs/staging/README.md` — long-form operator's guide.
- `docs/staging/MANIFEST-TEMPLATE.md` — per-branch manifest template.
- `docs/staging/snapshot-refresh-checklist.md` — already in place from Phase 2 (`49f0614`).
- Memory: `staging-promotion-discipline.md` (in user's global memory dir, indexed in `MEMORY.md`).
