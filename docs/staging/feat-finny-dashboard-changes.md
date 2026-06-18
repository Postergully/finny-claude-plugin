# Staging changes: `feat/finny-dashboard`

**Date tested:** `2026-06-18` → `<deploy-date>`
**Tested by:** `kalicharanshukla`
**Staging snapshot baseline:** N/A — staging EC2 was bypassed for this PR (see "Notes / surprises")
**PR:** `#<TBD>`

## Git changes (replay via merge)

- `finny-claude-plugin@feat/finny-dashboard`: see PR — adds `deploy/systemd/finny-dashboard.service`, edits `deploy/caddy/Caddyfile`, this manifest.
- `finny-hermes@<branch>`: no changes
- `finny-hermes-config@<branch>`: no changes
- `netsuite-kb@<branch>`: no changes
- **External repo:** `11mirror/finny-hermes-dashboard@main` — new repo, holds the Finny-rebranded fork of `outsourc-e/hermes-workspace v2.3.0`. Cloned to `/opt/finny/dashboard` on prod (see non-git step 1 below).

## Deploy decision

- [x] **Deploy immediately after merge** — first deploy of the dashboard. URL `https://dashboard.finny.prod.11mirror.com` is unreachable until this lands; nothing else depends on it.

## Non-git changes (replay manually on prod, in order)

> **Fast path (recommended for first deploy):** run `deploy/scripts/deploy-finny-dashboard.sh` from your laptop. It does steps 2-9 automatically (build local, upload to S3, drive EC2 via SSM, verify loopback). After it finishes, you still do step 10 (Caddy reload) and step 11 (browser smoke). Steps 1, 4, and 6 are pre-flight and already verified by `Task #6` of the design doc.
>
> **Manual path** (below) is the fallback if the script breaks or for documentation.
>
> Run as `ubuntu` on prod EC2 `i-0ef58962b09d490ee` via SSM unless otherwise noted.

1. **DNS A-record** (already done 2026-06-18): `dashboard.finny.prod.11mirror.com` → `34.200.24.169` (same EC2 IP as `finny.prod.11mirror.com`).
   - **Command run:** `aws route53 change-resource-record-sets --hosted-zone-id Z0839152EVU8QUH8CT1I --change-batch ...` (CREATE A record, TTL 300)
   - **Why:** Caddy needs DNS pointing at the box before TLS auto-provisioning works. Done in advance — verified `dig +short dashboard.finny.prod.11mirror.com` returns `34.200.24.169`.
2. **Clone dashboard repo to `/opt/finny/dashboard`.**
   - **Command run:** `sudo mkdir -p /opt/finny/dashboard && sudo chown ubuntu:ubuntu /opt/finny/dashboard && sudo -iu ubuntu git clone https://github.com/11mirror/finny-hermes-dashboard /opt/finny/dashboard`
   - **Why:** Dashboard source is in a separate repo (11mirror org), not in this repo. Source tree must exist before build/install.
3. **Write `/opt/finny/dashboard/.env`.**
   - **Command run:** Use `cat > /opt/finny/dashboard/.env <<EOF ... EOF` as `ubuntu`. Keys to set:
     - `HERMES_API_URL=http://127.0.0.1:8642`
     - `HERMES_API_TOKEN=<value of API_SERVER_KEY from ~/.hermes/.env if set; omit otherwise>`
     - `HOST=127.0.0.1`
     - `PORT=3001`
   - **Why:** Service expects loopback gateway + listen-loopback. Never paste secret values into transcripts; pull `API_SERVER_KEY` directly from `~/.hermes/.env` on prod via `sudo -iu ubuntu bash -c 'grep ^API_SERVER_KEY ~/.hermes/.env'` (presence-check only).
4. **Verify `~/.hermes/.env` has `API_SERVER_ENABLED=true`.**
   - **Command run:** `sudo -iu ubuntu grep -q '^API_SERVER_ENABLED=true' ~/.hermes/.env && echo OK`
   - **Why:** Without this, the Hermes gateway doesn't open the HTTP API server on `:8642` and the dashboard can't talk to it. If missing, append `API_SERVER_ENABLED=true` and `sudo -iu ubuntu systemctl --user restart hermes-gateway` (or `sudo systemctl restart hermes-api`, depending on which unit owns the gateway on this box).
5. **Install + build dashboard.**
   - **Command run:** `cd /opt/finny/dashboard && pnpm install --ignore-workspace && pnpm --ignore-workspace build`
   - **Why:** Vite/TanStack Start builds `dist/` and `server-entry.js` outputs. The `--ignore-workspace` flag is required because upstream's `pnpm-workspace.yaml` has only `allowBuilds:` (no `packages:`), which pnpm 9+ rejects. Document this for future operators.
6. **Verify Node 22+ and pnpm 9+ are installed.**
   - **Command run:** `node --version` (expect `v22.x` or higher), `pnpm --version` (expect `9.x` or higher)
   - **Why:** Both must be present for step 5 to succeed. Install via `apt install nodejs` + `npm i -g pnpm@9` if missing.
7. **Install systemd unit.**
   - **Command run:** `sudo cp /opt/finny/deploy/systemd/finny-dashboard.service /etc/systemd/system/finny-dashboard.service && sudo systemctl daemon-reload && sudo systemctl enable --now finny-dashboard`
   - **Why:** Without this the service isn't a managed unit (no auto-start, no journald, no restart-on-crash). Note: `/opt/finny/deploy/...` is the path on prod — this PR adds the file at `deploy/systemd/finny-dashboard.service` in the `finny-claude-plugin` repo, which is checked out to `/opt/finny`.
8. **Verify dashboard listens on `127.0.0.1:3001`.**
   - **Command run:** `sudo ss -tlnp | grep 3001` and `curl -fsS -I http://127.0.0.1:3001/ | head -1`
   - **Why:** Confirms the systemd unit started and bound the right port before exposing via Caddy.
9. **Reload Caddy.**
   - **Command run:** `sudo systemctl reload caddy`
   - **Why:** Picks up the new `dashboard.finny.prod.11mirror.com` vhost from `deploy/caddy/Caddyfile` (which is symlinked or copied to `/etc/caddy/Caddyfile` per existing prod setup). Caddy auto-provisions TLS via Let's Encrypt on first hit.
10. **Smoke test the public URL.**
    - **Command run:** `curl -fsS -I https://dashboard.finny.prod.11mirror.com/` (expect HTTP/2 200 once cert is provisioned, may take 10-30s on first request).
    - **Why:** Cert provisioning is the first thing that breaks. Watch `journalctl -u caddy -n 50` if it fails.
11. **Browser smoke test.**
    - **Manual:** Open `https://dashboard.finny.prod.11mirror.com/` in a browser. Verify: brain SVG splash + "Finny" wordmark, dashboard renders, chat sends a message and gets a response from the default Hermes profile, no "Hermes Workspace" text in chrome (NPC/playground/agora copy is acceptable per `BRAND.md` v1 deferral).

## What was tested on staging

- [ ] **Skipped — see "Notes / surprises".** This PR was tested locally only, not on the staging EC2 box. Operator decision per resolved decisions in the design doc.

## Skipped on prod (staging-only changes)

None.

## Rollback

If the dashboard misbehaves and needs to come down:

1. `sudo systemctl disable --now finny-dashboard` — stops + disables the service
2. (Optional) Comment out the `dashboard.finny.prod.11mirror.com { ... }` block in `/etc/caddy/Caddyfile` and `sudo systemctl reload caddy` — removes the vhost so the URL stops resolving cleanly. Without this, users get an upstream-down error from Caddy instead of cert/TLS issues.
3. (Optional, harder rollback) Delete `/opt/finny/dashboard/` — frees disk. Re-clone if you want to redeploy.
4. Git rollback: revert the merge SHA on `finny-claude-plugin` `main`, fast-forward `deployed` to the new tip, deploy as a normal rollback per `deploy-runbook.md`.

The DNS A-record can stay — it's harmless without a service behind it (Caddy returns its default response).

## Notes / surprises

- **Staging EC2 was bypassed.** This violates the hard rule in `CLAUDE.md` ("non-mocked surfaces must ride staging"). Reason: the user explicitly chose "local-as-staging" and accepted the risk. Local laptop build + dev-server run was the validation gate. Future infra-touching changes to this dashboard must go through staging EC2 normally.
- **Numeric passcode was dropped from the original plan.** v1 ships fully open. Anyone with the URL gets full UI access including Terminal, Files, MCP, Memory, and Skills tabs. Tab-removal and real auth are deferred to v2.
- **`pnpm --ignore-workspace` flag is mandatory** because upstream's `pnpm-workspace.yaml` only has `allowBuilds:` (no `packages:` field) and pnpm 9+ rejects that as a malformed workspace. If a future upstream merge adds a real workspace, this flag should come off.
- **Anime avatar replaced with a hand-drawn brain SVG** (`public/finny-brain.svg`). Chosen over emoji because emoji rendering depends on system fonts (colorful on macOS, monochrome on Linux). PNG icons (`claude-icon-192.png`, `claude-icon-512.png`, `claude-banner.png`) untouched in v1 — only used by PWA installs which v1 won't exercise.
- **Hermes Agent (the upstream Python package and gateway service) is unchanged.** The dashboard is a UI-only fork; all backend integration happens via the unchanged `HERMES_API_URL` env var. The agent itself still identifies as "Hermes" in chat — that's a Hermes-profile-side change, not a dashboard change.
