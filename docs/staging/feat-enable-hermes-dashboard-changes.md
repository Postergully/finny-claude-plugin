# Staging changes: `feat/enable-hermes-dashboard`

**Date applied:** `2026-06-19`
**Applied by:** `kalicharanshukla`
**Staging snapshot baseline:** N/A — staging EC2 was bypassed (already-running prod was the test bed; see "Notes / surprises")
**PR:** `#<TBD>`

## Git changes (replay via merge)

- `finny-claude-plugin@feat/enable-hermes-dashboard`: see PR — adds `deploy/systemd/hermes-dashboard.service` and this manifest.
- `finny-hermes@<branch>`: no changes
- `finny-hermes-config@<branch>`: no changes
- `netsuite-kb@<branch>`: no changes

## Deploy decision

- [x] **Already applied to prod live** (2026-06-19 16:32 UTC). Dashboard SPA capabilities banner flipped from `mode=portable / missing=[sessions, skills, config]` to `mode=zero-fork / missing=[]`. Sessions, Skills, Config, Memory, Jobs tabs are now functional. This PR captures the change in git so the box state is reproducible.

## Non-git changes (replay manually on prod, in order)

> Run as `ubuntu` on prod EC2 `i-0ef58962b09d490ee` via SSM unless otherwise noted.

1. **Build the upstream's web UI once.**
   - **Command run:** `sudo -u ubuntu bash -lc "cd /home/ubuntu/.hermes/hermes-agent/web && npm run build"`
   - **Why:** `hermes dashboard --skip-build` requires a pre-built UI at `/home/ubuntu/.hermes/hermes-agent/hermes_cli/web_dist/`. The Vite build outputs there (not `web/dist/`). One-time per Hermes version. ~12 seconds, peaks ~600MB RAM. Future Hermes upgrades will re-do this.

2. **Install the user-mode systemd unit.**
   - **Command run:** `sudo -u ubuntu cp /opt/finny/deploy/systemd/hermes-dashboard.service /home/ubuntu/.config/systemd/user/hermes-dashboard.service`
   - **Why:** This unit is owned by `ubuntu` (user-mode), not root, mirroring the existing `hermes-gateway.service` pattern. `sudo systemctl ...` from root won't see it; you must use `sudo -iu ubuntu systemctl --user ...`.

3. **Reload + enable + start.**
   - **Command run:**
     ```
     sudo -iu ubuntu systemctl --user daemon-reload
     sudo -iu ubuntu systemctl --user enable --now hermes-dashboard
     ```
   - **Why:** `enable --now` both enables auto-start on boot and starts immediately.

4. **Verify.**
   - **Command run:**
     ```
     sudo -iu ubuntu systemctl --user status hermes-dashboard --no-pager
     sudo ss -tlnp | grep 9119
     curl -fsS http://127.0.0.1:9119/health
     ```
   - **Expected:** unit `active (running)`, port `127.0.0.1:9119` listening with `hermes` as the owner, `/health` returns 200 (the upstream's `/health` returns the dashboard's HTML splash, which is intentional — JSON health lives at `/api/health` and other API endpoints under `/api/*`).

5. **Force the Finny SPA to re-detect capabilities.**
   - **Command run:** `sudo systemctl restart finny-dashboard`
   - **Why:** The Finny SPA caches its gateway-capabilities probe at boot. Restarting flips its banner from `mode=portable` to `mode=zero-fork`. Without this, refreshing the browser still shows degraded tabs.

6. **Smoke test the public URL.**
   - **Command run:** `curl -fsS -I https://dashboard.finny.prod.11mirror.com/`
   - **Expected:** `HTTP/2 200`. Browser refresh: Skills tab shows the upstream's skill catalog (not the "Contact your admin" empty state); Sessions tab shows past chat sessions; Dashboard "Recent Sessions" widget populates.

## What was tested on staging

- [ ] **Skipped — see "Notes / surprises".** Same posture as the original dashboard deploy: local laptop spike + prod-live verification. Staging EC2 was not exercised. Future infra-touching changes to this dashboard or the gateway must go through staging normally.

## Skipped on prod (staging-only changes)

None.

## Rollback

If `hermes dashboard` misbehaves and Sessions/Skills tabs need to come down:

1. `sudo -iu ubuntu systemctl --user stop hermes-dashboard` — stops the service immediately
2. `sudo -iu ubuntu systemctl --user disable hermes-dashboard` — removes auto-start on boot
3. `sudo systemctl restart finny-dashboard` — Finny SPA re-detects, flips back to `mode=portable`
4. (Optional) `sudo -u ubuntu rm /home/ubuntu/.config/systemd/user/hermes-dashboard.service` — clean uninstall
5. Public URL stays up; only the affected tabs gate themselves to "not available" again.

The pre-built `~/.hermes/hermes-agent/hermes_cli/web_dist/` directory is harmless to leave behind — it's ~5MB.

## Notes / surprises

- **Vite build output went to a non-obvious location.** Upstream's `web/vite.config.ts` writes to `../hermes_cli/web_dist/`, not `web/dist/`. If you grep for the build output thinking it's at the conventional path, you'll think the build silently failed. Documented for the next operator who wants to upgrade Hermes.

- **`hermes dashboard --status` self-counts.** Running `hermes dashboard --status` itself shows up in its own process list. Filter with `pgrep -af "hermes dashboard --port"` if you want to count only daemonized instances.

- **`/health` returns HTML, not JSON.** The dashboard's `/health` endpoint serves the upstream's web UI splash (which has health checks embedded). Don't write monitoring against `/health` expecting JSON; use `/api/sessions` or other `/api/*` endpoints which return JSON (and require the bearer token).

- **48MB resident memory.** Idle. Box has 2.6GB free, this is a comfortable headroom. If the dashboard ever spawns a `hermes --tui` PTY child via `--tui`, RAM will grow per session — we did NOT enable `--tui` (Finny SPA has its own terminal/chat surface).

- **The `--insecure` flag binds to non-loopback. We did NOT use it.** Dashboard at `:9119` is loopback-only; only the Finny SPA on `:3001` (also loopback) reverse-proxies to it. There is no public route to `:9119` and there should never be — it has read+write access to `~/.hermes/.env` (provider API keys, NetSuite secrets, Slack tokens) via its `/api/config` endpoint.

- **Auth is the same `API_SERVER_KEY` used by the gateway.** The Finny SPA's `.env` already has `HERMES_API_TOKEN=<API_SERVER_KEY value>`. The SPA uses it for both `:8642` and `:9119` calls. No additional secret rotation needed.

- **Mode banner change is the canonical signal.** `[gateway] ... mode=zero-fork ... missing=[]` in `journalctl -u finny-dashboard` is the ground truth. `mode=portable / missing=[sessions, skills, config]` means the user-mode unit is down or unreachable from the Finny SPA process.
