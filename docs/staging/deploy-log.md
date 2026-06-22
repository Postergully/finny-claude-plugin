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

---

## 2026-06-22 ~06:20 UTC — Postergully (staging-only deploy: `feat/staging-dashboard-vhost`, PR #<TBD>)

- **Scope:** staging EC2 only (`i-0c2c974ff571162eb` / `34.232.186.238`). No prod runtime changes.
- **Goal:** stand up `https://dashboard.finny.staging.11mirror.com/` mirroring prod's dashboard URL. Two parallel browser URLs, isolated per environment.
- **Pre-flight cleanup (handoff §gotcha 11):** broken `hermes-gateway` user-mode unit on staging (failed since 2026-06-18 with wrong venv `/home/ubuntu/hermes-venv/bin/python`) replaced with canonical from `deploy/systemd/hermes-gateway.service` + `TERMINAL_CWD=/home/ubuntu/.hermes/profiles/staging` drop-in. Orphan PID 33143 (Jun 18 09:15:53 sudo-shell origin) replaced via `gateway run --replace` semantics — no pre-kill, near-zero outage swap. New PID 58438 = unit-launched. Reboot footgun closed.
- **`:9119` rebind (handoff §gotcha 12):** `hermes-dashboard.service` rebound from `100.112.31.24:9119` (Tailscale) to `127.0.0.1:9119` (loopback). `--insecure` flag dropped (loopback doesn't need it). SPA banner: `mode=portable` → `mode=zero-fork ... missing=[]`.
- **Dashboard install:** `deploy-finny-dashboard.sh --instance i-0c2c974ff571162eb` (parametrization added in this PR). Built from `Postergully/finny-hermes-dashboard@main` (`b79786c9`). Loopback `:3001` 200; system unit `finny-dashboard.service` active enabled.
- **Route53:** `dashboard.finny.staging.11mirror.com` A → `34.232.186.238`, TTL 300, zone `Z01920243UX91ZKYKCMPA`. Change `/change/C04178575KQJYGLM2SRV` INSYNC.
- **Caddy:** appended new vhost block to `/etc/caddy/Caddyfile` on staging (existing `finny.staging.11mirror.com` block preserved). Validate clean. Reload triggered Let's Encrypt tls-alpn-01 issuance — cert obtained in ~3s.
- **Surface smoke:** green
  - `https://dashboard.finny.staging.11mirror.com/` → `HTTP/2 200` via Caddy with valid Let's Encrypt cert.
  - `https://finny.staging.11mirror.com/` → `HTTP/2 404` (existing bridge behavior, not regressed).
  - `https://dashboard.finny.prod.11mirror.com/` → 200 unchanged.
  - Browser smoke (operator-confirmed): UI renders, model picker (`staging`), chat streams, Sessions/Skills/Config tabs populated.
- **All multi-line file transfer used S3 + presigned URL** instead of inline heredoc-in-JSON. Avoids both the JSON-escaping fragility AND the need for `s3:GetObject` on the EC2 instance role.
- **Snapshots for rollback:** `/tmp/hermes-gateway.service.snapshot-20260622-060025`, `/tmp/hermes-dashboard.service.snapshot-20260622-061334`, `/etc/caddy/Caddyfile.snapshot-20260622-061814`.
- **Out of scope:** Bedrock router config swap on staging (deferred to next PR per user direction). CI build/publish for the dashboard repo (still operator-laptop driven).

---

## 2026-06-22 ~15:55 UTC — Postergully (orchestrator-driven, verifier-gated) (staging-only deploy: `feat/external-memory-via-hindsight`, PR [11mirror/finny-hermes-dashboard#1](https://github.com/11mirror/finny-hermes-dashboard/pull/1))

- **Scope:** staging EC2 only (`i-0c2c974ff571162eb`). No prod runtime changes. Companion to `feat/dashboard-external-memory-tab` in `finny-claude-plugin`.
- **Goal:** smoke-test the new External Memory tab → Hindsight cloud routes (`GET /api/external-memory/{providers,candidates,search}`) end-to-end on staging.
- **Pre-flight:** none. Staging was clean from the `2026-06-22 ~06:20 UTC` dashboard-vhost deploy.
- **Dashboard install:** `./deploy/scripts/deploy-finny-dashboard.sh --instance i-0c2c974ff571162eb --branch feat/external-memory-via-hindsight`. Deployed SHA `99a04599` from `Postergully/finny-hermes-dashboard@feat/external-memory-via-hindsight`. The `--branch` flag itself was added in this PR (Task 7); first end-to-end exercise of it.
- **Non-git change applied (manifest §Non-git changes):** appended `HINDSIGHT_API_KEY` to `/opt/finny/dashboard/.env`, value sourced via `sudo grep` from `~/.hermes/.env` (keys-only, value never printed into transcript). Deploy script writes a narrow `.env` and does not propagate this key; first smoke 503'd with `HINDSIGHT_API_KEY is not set in process.env` until the line was appended. `daemon-reload && systemctl restart finny-dashboard` afterward.
- **Surface smoke:** green
  - `curl http://127.0.0.1:3001/api/external-memory/providers` → `200`, providers=2.
  - `curl http://127.0.0.1:3001/api/external-memory/candidates` → `200`, total=5984.
  - `curl http://127.0.0.1:3001/api/external-memory/search?q=netsuite` → `200`, count=98.
  - Browser smoke (gstack headless Chromium via `/browse`): External providers tab renders, sharechat provider selectable, candidate cards populate with UUID + body + timestamp. Screenshots in `finny-loops@domains/dashboard-external-memory/evidence/task-8-external-memory-{tab-populated,search-netsuite}.png`.
- **Out of scope:** 5-tool MCP smoke / desktop dashboard chat / no-Slack-bleed check — N/A; this PR touches only the dashboard HTTP surface, no MCP/bridge or agent-loop changes.
- **Outcome:** green. Manifest `docs/staging/feat-dashboard-external-memory-tab-changes.md` captures non-git replay steps for prod.
- **Follow-up filed:** `deploy/scripts/deploy-finny-dashboard.sh` should propagate `HINDSIGHT_API_KEY` (and other dashboard-needed keys) automatically; current behavior writes a fixed narrow set and silently drops the rest.
