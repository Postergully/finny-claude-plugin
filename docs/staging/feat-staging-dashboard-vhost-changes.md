# Staging changes: `feat/staging-dashboard-vhost`

**Date applied:** `2026-06-22`
**Applied by:** `kalicharanshukla`
**Staging snapshot baseline:** N/A — work was done directly on staging EC2 `i-0c2c974ff571162eb`
**PR:** `#<TBD>`

## Git changes (replay via merge)

- `finny-claude-plugin@feat/staging-dashboard-vhost`: see PR — adds `deploy/systemd/hermes-gateway.service` (canonical user-mode unit), staging vhost in `deploy/caddy/Caddyfile`, `--instance` flag in `deploy/scripts/deploy-finny-dashboard.sh`, this manifest, plan + spec docs, handoff doc updates.
- `finny-hermes@<branch>`: no changes
- `finny-hermes-config@<branch>`: no changes (working tree of `~/.hermes` on staging is on `feat/atomic-fetch-v3` and was not touched)
- **External repo:** `Postergully/finny-hermes-dashboard@main` (`b79786c9`) — built locally on operator laptop, tarball deployed to `/opt/finny/dashboard` on staging via S3 + SSM (existing `deploy-finny-dashboard.sh` flow, parametrized by `--instance`).

## Deploy decision

- [x] **Already applied to staging only** (2026-06-22 ~06:20 UTC). No prod runtime impact.

## Non-git changes (replay manually on staging, in order)

> Run as `ubuntu` on staging EC2 `i-0c2c974ff571162eb` via SSM unless otherwise noted. All multi-line file content was staged via S3 + presigned URL (`s3://11mirror-staging-transfer/finny-staging-vhost/<sha>/`), never inline heredoc-in-JSON. Presigned URL avoids needing `s3:GetObject` on the EC2 instance role — same pattern as `deploy-finny-dashboard.sh`.

1. **Pre-flight cleanup of `hermes-gateway` user-mode unit (handoff §gotcha 11).**
   - Snapshotted to `/tmp/hermes-gateway.service.snapshot-20260622-060025`.
   - Replaced unit file with `deploy/systemd/hermes-gateway.service` from the repo (via S3 presigned URL).
   - Added drop-in at `~/.config/systemd/user/hermes-gateway.service.d/staging.conf` with `TERMINAL_CWD=/home/ubuntu/.hermes/profiles/staging`.
   - Did NOT pre-kill the orphan; relied on `gateway run --replace` to take over `:8642` atomically.
   - Verified: unit `active (running)`, `:8642/health` 200, exactly one `hermes_cli.main` process (PID 33143 → 58438), AGENTS context loaded (no `prompt_builder` warnings, no `prompt_injection blocked`, no `CONTEXT (0 chars)`).
   - Removed leftover `hermes-gateway.service.pre-staging.bak`.

2. **DNS A-record:** `dashboard.finny.staging.11mirror.com` → `34.232.186.238` in zone `Z01920243UX91ZKYKCMPA`.
   - `aws route53 change-resource-record-sets --hosted-zone-id Z01920243UX91ZKYKCMPA --change-batch file:///tmp/route53-staging-dashboard.json` (CREATE A, TTL 300).
   - Change ID: `/change/C04178575KQJYGLM2SRV`. INSYNC verified.

3. **Pre-build upstream Hermes web UI** (one-time per Hermes version, mirrors PR #16 step 1):
   - `sudo -u ubuntu bash -lc "cd /home/ubuntu/.hermes/hermes-agent/web && npm ci && npm run build"`.
   - Outputs to `/home/ubuntu/.hermes/hermes-agent/hermes_cli/web_dist/` (`index.html` + assets, ~12s build).

4. **Run the parametrized deploy script:**
   - `./deploy/scripts/deploy-finny-dashboard.sh --instance i-0c2c974ff571162eb`.
   - Builds dashboard locally from `~/code/finny-hermes-dashboard@main` (`b79786c9`), tarballs, uploads to S3, drives staging EC2 via SSM to: extract to `/opt/finny/dashboard/`, write `.env` (token sourced from `~/.hermes/.env` on-box), install `finny-dashboard.service`, enable + start.
   - Verified: `:3001` 200 on loopback, service `active enabled`.

5. **Replace `hermes-dashboard.service` user-mode unit with the loopback-bound canonical** (PR #16 manifest applied to staging):
   - Snapshotted previous unit (was `--insecure --host 100.112.31.24 --port 9119`) to `/tmp/hermes-dashboard.service.snapshot-20260622-061334`.
   - Wrote a staging-specific unit (preserves staging's `EnvironmentFile=%h/.hermes/.env` + `After=hermes-gateway.service`, drops `--insecure`, flips `--host` to `127.0.0.1`).
   - Pulled via S3 presigned URL to `~/.config/systemd/user/hermes-dashboard.service`.
   - `daemon-reload`, `restart`. Verified `:9119` listening on `127.0.0.1` (NOT Tailscale).
   - Restarted `finny-dashboard` to flip SPA banner: `mode=zero-fork core=[health, chatCompletions, models, streaming, dashboard] enhanced=[sessions, skills, memory, config, jobs] missing=[]`.

6. **Append staging dashboard vhost to `/etc/caddy/Caddyfile`:**
   - Snapshotted to `/etc/caddy/Caddyfile.snapshot-20260622-061814`.
   - Pulled new file via S3 presigned URL.
   - `caddy validate` returned `Valid configuration`.
   - `systemctl reload caddy` succeeded.
   - Caddy auto-provisioned Let's Encrypt cert via tls-alpn-01 in ~3 seconds.
   - Regression-checked existing `https://finny.staging.11mirror.com/` still routes through Caddy.

7. **Smoke test:**
   - `curl -sI https://dashboard.finny.staging.11mirror.com/` → `HTTP/2 200`, valid TLS, `via: 1.1 Caddy`.
   - Browser (operator-confirmed): UI renders with Finny brand, model picker shows `staging` model, chat message streamed back, Sessions/Skills/Config tabs populated.
   - Confirmed prod URLs unaffected (`dashboard.finny.prod.11mirror.com` still 200, `finny.prod.11mirror.com` unchanged).

## What was tested on staging

- [x] **Yes — entire flow ran on staging** (`i-0c2c974ff571162eb`). This PR's runtime steps are by definition staging-only; there is no prod-side runtime work.

## Skipped on prod (staging-only changes)

All non-git steps in this manifest. Prod gets only the doc + `deploy/scripts/deploy-finny-dashboard.sh` + `deploy/caddy/Caddyfile` + `deploy/systemd/hermes-gateway.service` source changes via the standard deployed-branch promotion. No services restart on prod.

## Rollback

1. **DNS:** `aws route53 change-resource-record-sets ... DELETE` the `dashboard.finny.staging.11mirror.com` A record.
2. **Caddy:** `sudo cp /etc/caddy/Caddyfile.snapshot-20260622-061814 /etc/caddy/Caddyfile && sudo systemctl reload caddy`.
3. **Dashboard service on staging:** `sudo systemctl disable --now finny-dashboard`. Optional: `rm -rf /opt/finny/dashboard/`.
4. **`hermes-dashboard` user-mode unit:** restore from `/tmp/hermes-dashboard.service.snapshot-20260622-061334`, `daemon-reload`, restart.
5. **`hermes-gateway` user-mode unit:** restore from `/tmp/hermes-gateway.service.snapshot-20260622-060025`, remove `~/.config/systemd/user/hermes-gateway.service.d/`, `daemon-reload`. The orphan was not killed during the swap (per D2 sequencing), so on the next `start` the new (restored, broken) unit's `--replace` would still take over — accept that staging gateway will fail to start; the orphan is gone after our fix. If full rollback is needed, also kill the unit-launched gateway and manually restart from the orphan-style approach.
6. **Git:** revert merge SHA on `finny-claude-plugin` `main`.

## Notes / surprises

- The dashboard repo (`Postergully/finny-hermes-dashboard`) is **not** tracked by `finny-claude-plugin`. The deploy script reads from operator laptop `~/code/finny-hermes-dashboard` and tarballs the build output. Documented for future operators; long-term, build/publish should move to CI (TODO candidate).
- Staging's `~/.hermes` working tree is intentionally on `feat/atomic-fetch-v3`. Not reset to `deployed`. Gateway behavior on staging may differ from prod for that reason — flag this if any chat anomalies show up.
- `hermes-gateway` user-mode unit was failing since 2026-06-18 with wrong venv (`/home/ubuntu/hermes-venv/bin/python`); fixed in this deploy to point at `/home/ubuntu/.hermes/hermes-agent/venv/bin/python` via the canonical unit + `TERMINAL_CWD` drop-in. Reboot footgun closed.
- `hermes-dashboard` was previously bound to `100.112.31.24:9119` (Tailscale interface) with `--insecure`; rebound to `127.0.0.1:9119` (no `--insecure` needed on loopback) to match the dashboard SPA's expectation.
- All multi-line file content was staged via S3 + presigned URL instead of inline heredocs in `aws ssm send-command --parameters`, eliminating the JSON-escaping failure mode AND avoiding the need for `s3:GetObject` on the staging EC2 instance role.
- Staging `/v1/models` returns model id `"staging"` (the profile name), unlike prod's `"hermes-agent"`. Same gateway behavior — just a profile-name surface difference.
- The `TERMINAL_CWD` drop-in is benign overlap with the existing `.env`-set `TERMINAL_CWD`; gateway prints a deprecation warning suggesting move to `config.yaml` (non-blocking).
- No Bedrock router work — explicitly deferred to next PR per user direction.
