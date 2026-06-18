# Staging snapshot-refresh checklist

> **Status:** v1 — first build complete 2026-06-15 (Phase 1 + 2 done; Phase 3 partially verified, browser-cowork OAuth + desktop app config pending user). Refresh procedure below reflects what actually worked.
>
> **Purpose:** every step that has to be re-applied after rebuilding staging from a fresh prod AMI snapshot. Walk this top-to-bottom on a refresh; the result should be the staging tier described in `docs/superpowers/specs/2026-06-15-staging-architecture-design.md`.
>
> **Refresh cadence** per spec: ≤14 days, or before testing any branch >7 days old.
>
> **Do not** print env-file values into shell output. Use key-only or presence-only checks. Per `[[never-expose-secrets]]`.

## Inventory captured at first build (2026-06-15)

- Prod AMI snapshotted: `ami-08fdfeb433908de8b` (no-reboot, prod stayed up)
- Staging EC2 launched: `i-0c2c974ff571162eb`, t3.small, us-east-1a, subnet `subnet-066872488a50f5d11`, vpc `vpc-0a79e9976522b7727`
- Security group: `sg-0de99031d6c335583` (`staging-11mirror`, 80 + 443 ingress, no public 22 — port 9445 stays internal because Caddy binds it to the tailnet IP, not 0.0.0.0)
- IAM profile: same as prod (`hermes-bedrock-HermesInstanceProfile-UHJKR9OUXOiZ`) — note: lacks `secretsmanager:CreateSecret`, see §3
- Elastic IP: `34.232.186.238` (`eipalloc-0634e783d0dcc1144`, tagged `env=staging`)
- DNS: `finny.staging.11mirror.com → 34.232.186.238` in Route53 zone `Z01920243UX91ZKYKCMPA` (`staging.11mirror.com`)
- Tailscale tailnet IP: `100.112.31.24`, hostname `finny-staging`
- SSH keypair: `finny-staging-key` (private at `~/.ssh/finny-staging-key.pem` on user's Mac); `~/.ssh/authorized_keys` rewritten to contain only this public key
- Hermes gateway venv (matches prod): `/home/ubuntu/hermes-venv/bin/python` — what `hermes-gateway.service` runs from. Despite the `[[hermes-venv-mismatch]]` memory's framing, this is the venv that actually works for NetSuite — see §7.
- Hermes editable-install venv: `/home/ubuntu/.hermes/hermes-agent/venv/bin/hermes` — used by `hermes-dashboard.service` and CLI invocations. `hermes-agent v0.14.0`, Python 3.11.15.
- EBS snapshot of pre-termination old staging: `snap-0750e633f9a5e1500` (insurance, delete after first prod-deploy round-trip works)

## Plan-vs-reality corrections (caught at first build, baked into v1 procedure below)

The plan in `docs/superpowers/plans/2026-06-14-staging-architecture.md` had several drifts from prod AMI reality:

1. **DNS name:** plan said `staging.finny.11mirror.com`; correct is `finny.staging.11mirror.com` (mirrors `finny.prod.11mirror.com`, in Route53 zone `staging.11mirror.com`).
2. **Hermes editable venv path:** plan said `…/hermes-agent/.venv/...` (with leading dot); actual is `…/hermes-agent/venv/...` (no dot).
3. **Profile to clone:** plan said copy `default.yaml`; actual prod profiles dir contains only `finny/` (a directory). Right move: `hermes profile use staging` after cloning `finny` → `staging`.
4. **Dashboard auth model:** plan assumed `HERMES_DASHBOARD_BASIC_AUTH_USERNAME/PASSWORD_HASH/SECRET` env vars per Nous docs. **These do NOT exist in `hermes-agent v0.14.0`.** Source (`hermes_cli/web_server.py:80-130`) shows an ephemeral session token, CORS restricted to localhost, and a comment that the supported remote pattern is reverse-proxy with Caddy `basic_auth` in front. Implemented accordingly: dashboard binds to `127.0.0.1:9119`, Caddy listens on tailnet `100.112.31.24:9445` with bcrypt basic_auth, proxies to localhost.
5. **`MCP_ISSUER_URL`:** plan didn't list this, but `bridge/.env` has it and it must be flipped from prod to staging hostname or every OAuth metadata response advertises prod.
6. **Bridge needs full prod-host find/replace:** safest is `sed -i 's|finny.prod.11mirror.com|finny.staging.11mirror.com|g' /opt/finny/bridge/.env` after the targeted MCP_ALLOWED_HOSTS edit.

## Phase 2 procedure (replay top-to-bottom on every refresh)

### 0. Stop prod-cloned units immediately on first boot (before any edit)

The AMI carries over running units with prod identity. Stop them so they don't serve as prod-on-staging-IP.

```bash
sudo systemctl stop caddy finny-mcp
sudo -iu ubuntu systemctl --user stop hermes-gateway
```

### 1. SSH key swap (one-time per staging instance)

**On user's Mac:**
```bash
aws ec2 create-key-pair --key-name finny-staging-key --key-type ed25519 --query 'KeyMaterial' --output text > ~/.ssh/finny-staging-key.pem && chmod 600 ~/.ssh/finny-staging-key.pem
```

(Single line. If "key pair already exists": `rm ~/.ssh/finny-staging-key.pem && aws ec2 delete-key-pair --key-name finny-staging-key`, then retry. Do not break this command across multiple lines — terminals splitting on `\` will paste it as 2-3 separate commands.)

**Then via SSM** (replace `ubuntu`'s `authorized_keys` with the new public key only — cloud-init from the AMI carried over prod's `hermes-key`):

```bash
PUB=$(ssh-keygen -y -f ~/.ssh/finny-staging-key.pem)
aws ssm send-command --instance-ids <staging-instance-id> --document-name AWS-RunShellScript \
  --parameters "commands=[\"sudo -iu ubuntu cp /home/ubuntu/.ssh/authorized_keys /home/ubuntu/.ssh/authorized_keys.pre-staging.bak\",\"echo '$PUB' | sudo -iu ubuntu tee /home/ubuntu/.ssh/authorized_keys > /dev/null\",\"sudo -iu ubuntu chmod 600 /home/ubuntu/.ssh/authorized_keys\"]"
```

(Skip on a refresh if the key is already correct — `sudo cat /home/ubuntu/.ssh/authorized_keys` should be exactly the new public key.)

### 2. Clear Slack tokens from `~/.hermes/.env`

Belt-and-suspenders for D4 (active profile = no Slack). Comment out — keeps line numbers stable for diffing against prod.

```bash
sudo -iu ubuntu cp /home/ubuntu/.hermes/.env /home/ubuntu/.hermes/.env.pre-staging.bak
sudo -iu ubuntu sed -i 's|^SLACK_BOT_TOKEN=.*|# SLACK_BOT_TOKEN cleared on staging — see snapshot-refresh-checklist.md §2|' /home/ubuntu/.hermes/.env
sudo -iu ubuntu sed -i 's|^SLACK_APP_TOKEN=.*|# SLACK_APP_TOKEN cleared on staging — see snapshot-refresh-checklist.md §2|' /home/ubuntu/.hermes/.env
sudo -iu ubuntu grep -c '^SLACK_' /home/ubuntu/.hermes/.env  # expect 0
```

### 3. Generate fresh MCP OAuth credentials (D5)

Generate **on the staging box** so values never cross your local shell:

```bash
sudo bash -c '
  NEW_ID=$(openssl rand -hex 32)
  NEW_SECRET=$(openssl rand -hex 32)
  cp /opt/finny/bridge/.env /opt/finny/bridge/.env.pre-staging.bak
  sed -i "s|^MCP_CLIENT_ID=.*|MCP_CLIENT_ID=$NEW_ID|"         /opt/finny/bridge/.env
  sed -i "s|^MCP_CLIENT_SECRET=.*|MCP_CLIENT_SECRET=$NEW_SECRET|" /opt/finny/bridge/.env
'
```

**v1 storage:** secrets live only in `/opt/finny/bridge/.env` (mode 0600 owner root). Acceptable because instance role currently lacks `secretsmanager:CreateSecret` and bootstrap creds are low-rotation. If staging is destroyed, regenerate. **TODO v2:** add `secretsmanager:GetSecretValue/PutSecretValue/CreateSecret` on `arn:aws:secretsmanager:*:*:secret:finny/staging/oauth/*` to instance role `hermes-bedrock-HermesInstanceRole-I8b1EsGCg8Qn`, then store via SSM and have the unit pull at startup.

### 4. Replace prod hostname references throughout `bridge/.env`

Patches both `MCP_ALLOWED_HOSTS` and `MCP_ISSUER_URL` (and any future variable referencing the public hostname):

```bash
sudo sed -i 's|finny.prod.11mirror.com|finny.staging.11mirror.com|g' /opt/finny/bridge/.env
# Verify (key-only):
sudo grep -c 'finny.prod.11mirror.com' /opt/finny/bridge/.env  # expect 0
sudo grep -c 'finny.staging.11mirror.com' /opt/finny/bridge/.env  # expect ≥2 (MCP_ISSUER_URL + MCP_ALLOWED_HOSTS)
```

### 5. Caddyfile — single site block, no path filter

**Match prod's shape exactly: proxy everything to the bridge.** The bridge's OAuth router serves `/authorize`, `/token`, `/revoke`, `/register` (when DCR enabled) and `/.well-known/oauth-*` plus `/mcp*`. Filtering paths in Caddy will silently break OAuth — Caddy will return empty 200s for unfiltered paths, the bridge never sees them, and Claude.ai's OAuth dance fails with cryptic errors like `registration_endpoint_missing`.

The dashboard does NOT go through Caddy — it binds directly to the tailnet IP (see §8). Why: Hermes v0.14 has a Host-header DNS-rebinding guard that rejects requests with a Host different from `--host`. With Caddy reverse-proxying 100.112.31.24 → 127.0.0.1, Hermes saw `Host: 100.112.31.24` ≠ bound host `127.0.0.1` and 4xx'd everything. Cleaner: bind Hermes directly to the tailnet IP.

```bash
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.pre-staging.bak
sudo tee /etc/caddy/Caddyfile > /dev/null <<'EOF'
finny.staging.11mirror.com {
    encode gzip
    reverse_proxy 127.0.0.1:3000 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-Proto https
    }
}
EOF
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy   # auto-issues TLS cert on first request
```

(If running through SSM where heredoc quoting is tricky, base64-encode and pipe: `echo $B64 | base64 -d | sudo tee /etc/caddy/Caddyfile`.)

**Auth note:** Hermes v0.14 has no native dashboard auth — the desktop app uses an ephemeral session token (regenerated each dashboard restart) injected into the SPA HTML at `window.__HERMES_SESSION_TOKEN__`. Tailscale is the trust boundary. To get the token, fetch the SPA from any tailnet device:

```bash
curl -s http://100.112.31.24:9119/ | grep -o '__HERMES_SESSION_TOKEN__="[^"]*"' | sed 's/.*="\([^"]*\)"/\1/'
```

Paste into desktop app's "Session token" field. **Token rotates on every dashboard restart** — you'll re-paste after refresh / reboot / unit restart. This is a v0.14 limitation; newer Hermes versions add `HERMES_DASHBOARD_BASIC_AUTH_*` env vars (and a Sign-in button in the desktop app). Captured as a TODO when Hermes is upgraded via the staging-promotion flow.

### 6. Hermes profile: clone `finny` → `staging`, scrub Slack, copy creds, switch active

**Critical gotcha:** when a non-default profile is active, Hermes loads env from `~/.hermes/profiles/<name>/.env`, **NOT** `~/.hermes/.env`. The profile dir's `.env` only has `API_SERVER_*` keys by default — NetSuite/Hindsight/GitHub credentials live only in the global `~/.hermes/.env`. If you don't copy them in, the gateway runs but tools return `gateway_unreachable: NetSuite credentials not configured`. Prod runs the implicit `default` profile (no profile dir → reads global `.env`), which is why prod doesn't hit this. Staging has its own profile dir → must replicate the credential set.

```bash
sudo -iu ubuntu cp -r /home/ubuntu/.hermes/profiles/finny /home/ubuntu/.hermes/profiles/staging

# Drop Slack from staging profile's .env if any (defensive — usually not present):
sudo -iu ubuntu test -f /home/ubuntu/.hermes/profiles/staging/.env && \
  sudo -iu ubuntu sed -i '/SLACK_/d' /home/ubuntu/.hermes/profiles/staging/.env

# Append NetSuite/Hindsight/GitHub credentials from global .env into staging profile .env.
# Append (>>) is intentional — preserves existing API_SERVER_* keys.
sudo -iu ubuntu bash -c 'grep -E "^(NETSUITE_|HINDSIGHT_|GITHUB_TOKEN)" /home/ubuntu/.hermes/.env >> /home/ubuntu/.hermes/profiles/staging/.env'

# Dedupe in case this step ran twice (idempotent guard):
sudo -iu ubuntu python3 - <<'PY'
seen=set(); out=[]
for line in open("/home/ubuntu/.hermes/profiles/staging/.env"):
    s=line.rstrip("\n")
    if not s or s.startswith("#"): out.append(line); continue
    k=s.split("=",1)[0]
    if k in seen: continue
    seen.add(k); out.append(line)
open("/home/ubuntu/.hermes/profiles/staging/.env","w").writelines(out)
PY
sudo -iu ubuntu chmod 600 /home/ubuntu/.hermes/profiles/staging/.env

# Verify (key counts only — values never echoed):
for K in NETSUITE_ACCOUNT_ID NETSUITE_CONSUMER_KEY NETSUITE_CONSUMER_SECRET \
         NETSUITE_TOKEN_ID NETSUITE_TOKEN_SECRET HINDSIGHT_API_KEY \
         HINDSIGHT_TIMEOUT GITHUB_TOKEN; do
  COUNT=$(sudo -iu ubuntu grep -cE "^${K}=" /home/ubuntu/.hermes/profiles/staging/.env)
  echo "$K: $COUNT"  # each should print 1
done

# Switch active profile:
sudo -iu ubuntu /home/ubuntu/.hermes/hermes-agent/venv/bin/hermes profile use staging
sudo -iu ubuntu /home/ubuntu/.hermes/hermes-agent/venv/bin/hermes profile list
# Confirm ◆ marker is on `staging`
```

### 7. DO NOT touch `hermes-gateway.service` — keep prod parity

The unit inherited from prod uses `/home/ubuntu/hermes-venv/...`. The `[[hermes-venv-mismatch]]` memory called this "the wrong venv," but on prod that's the venv the gateway *actually runs from* — and prod works.

During the first build I switched it to `/home/ubuntu/.hermes/hermes-agent/venv/...` (the editable install). NetSuite calls then failed with `gateway_unreachable` even though the gateway process was active. Reverting to `hermes-venv` made NetSuite work again. Hypothesis: prod's NetSuite plugin chain depends on packages installed in `hermes-venv`, not the editable install. Spec D1 says staging must be a true copy of prod — don't try to "fix" the venv on staging.

If `[[hermes-venv-mismatch]]` ever gets fixed, do it on prod first via a feature branch + the staging-promotion flow, never as a staging-only divergence.

**Action: leave the unit file alone.** Don't run any edits. Skip to §8.

### 8. Install `hermes-dashboard.service` (binds directly to tailnet IP)

```bash
sudo -iu ubuntu tee /home/ubuntu/.config/systemd/user/hermes-dashboard.service > /dev/null <<'EOF'
[Unit]
Description=Hermes desktop-app backend (dashboard)
After=network-online.target hermes-gateway.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=%h/.hermes/.env
WorkingDirectory=/home/ubuntu/.hermes/hermes-agent
Environment="VIRTUAL_ENV=/home/ubuntu/.hermes/hermes-agent/venv"
Environment="HERMES_HOME=/home/ubuntu/.hermes"
ExecStart=/home/ubuntu/.hermes/hermes-agent/venv/bin/hermes dashboard --no-open --insecure --host 100.112.31.24 --port 9119 --skip-build
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF
sudo -iu ubuntu systemctl --user daemon-reload
sudo -iu ubuntu systemctl --user enable hermes-dashboard
```

Flag notes:
- `--insecure` is required to bind to non-localhost (Hermes prints a warning otherwise; tailnet is the trust boundary per D6).
- `--host 100.112.31.24` (the staging tailnet IP). On refresh, this value changes if Tailscale assigns a different IP — re-derive from `tailscale ip -4` and update.
- `--skip-build` avoids `npm run build` at startup (the dist is already built in the editable install).
- The earlier draft of this checklist had Hermes binding to 127.0.0.1 with Caddy reverse-proxying. That doesn't work in v0.14: Hermes' Host-header DNS-rebinding guard rejects requests where `Host:` ≠ bind host. Direct tailnet bind avoids the issue.

### 8a. (v0.14 limitation, captured for awareness) Desktop app remote-chat is stub-only

Even though the desktop app's Settings → Gateway shows "Connected to http://100.112.31.24:9119 · Hermes 0.14.0", the agent **always runs locally** on the user's Mac in this version. The "Remote gateway" toggle observes/controls the remote dashboard process but does NOT route the chat agent loop through the remote box. This is fine for our purposes — the **production traffic path is via the bridge/MCP, not the dashboard chat tab.**

When Hermes is upgraded to a newer version (one with `HERMES_DASHBOARD_BASIC_AUTH_*` and full remote-chat-tab support per the public docs), revisit this.

### 9. Restart units in order

```bash
sudo systemctl restart caddy
sudo systemctl restart finny-mcp
sudo -iu ubuntu systemctl --user restart hermes-gateway
sudo -iu ubuntu systemctl --user start   hermes-dashboard
# Confirm all four active:
systemctl is-active caddy finny-mcp
sudo -iu ubuntu systemctl --user is-active hermes-gateway hermes-dashboard
```

## Phase 3 verification

### Automatable (run on staging or from any tailnet device)

```bash
# Listeners — expect 4 lines: 3000 (bridge), 9119 (hermes loopback), 9445 (caddy tailnet), 80+443 (caddy public)
ss -tlnp | awk 'NR==1 || /:3000|:9119|:9445|:443|:80/'

# Dashboard auth gate (from any tailnet device, e.g. user's Mac):
curl -sS -o /dev/null -w "no-auth: HTTP %{http_code}\n" http://100.112.31.24:9445/api/status   # expect 401
curl -sS -u finny-staging:<password> http://100.112.31.24:9445/api/status | jq .              # expect 200 JSON

# Public TLS + OAuth metadata (from anywhere):
curl -sSv https://finny.staging.11mirror.com/.well-known/oauth-protected-resource 2>&1 | grep -E 'subject|issuer'
curl -sS https://finny.staging.11mirror.com/.well-known/oauth-protected-resource | jq .resource
# expect "https://finny.staging.11mirror.com/", NOT prod

# MCP endpoint healthy (returns 401 + WWW-Authenticate per RFC 9728):
curl -sSI https://finny.staging.11mirror.com/mcp | grep -iE 'www-authenticate|http/'
```

### Manual (user)

- **Desktop app remote backend** — Settings → Gateway → Remote → URL `http://100.112.31.24:9119` → paste session token (fetched from `curl -s http://100.112.31.24:9119/ | grep -o '__HERMES_SESSION_TOKEN__="[^"]*"' | sed 's/.*="\([^"]*\)"/\1/'`) → Save and reconnect. Settings page should show `Connected to http://100.112.31.24:9119 · Hermes 0.14.0`. Note: v0.14 desktop chat **always runs locally** even with remote gateway set — see §8a.
- **Browser cowork (Claude.ai) — production traffic path** — Settings → Connectors → Add custom connector → "BETA" dialog:
  - Name: `Finny Staging`
  - Remote MCP server URL: `https://finny.staging.11mirror.com/mcp`
  - **Advanced settings → OAuth Client ID and OAuth Client Secret** are mandatory: paste the values from `/opt/finny/bridge/.env` on staging (`MCP_CLIENT_ID` and `MCP_CLIENT_SECRET`). Without these, Claude.ai fails OAuth with `registration_endpoint_missing` because the bridge does not advertise `/register` (RFC 7591 DCR is opt-in via `MCP_DANGEROUSLY_ALLOW_DCR=true`, not enabled in default deploys).
  - To get the values without leaking through transcript: `aws ssm start-session --target i-0c2c974ff571162eb` then `sudo grep -E '^MCP_CLIENT_ID|^MCP_CLIENT_SECRET' /opt/finny/bridge/.env` then `exit`.
  - After Add: Claude.ai shows "Connected" with 5 tools. Exercise at least one (`finny_query` for a read-only NetSuite query) to confirm bridge → gateway → NetSuite path.
- **No-Slack-bleed sanity check** — search prod Slack channels during the staging test window. Expect zero new bot messages tied to staging activity. If any appear, profile switch in §6 didn't take.

## Cost notes

- EBS snapshot of pre-termination old staging: `snap-0750e633f9a5e1500` (30 GiB, ~$1.50/mo). Delete after first successful prod-deploy round-trip via the new flow.
- Prod AMI: `ami-08fdfeb433908de8b` (~30 GiB, ~$1.50/mo). Delete and re-take on each refresh.
- EIP `34.232.186.238` ($0 attached, ~$3.60/mo if released).
- Staging instance t3.small: ~$15/mo running 24/7. Stop nightly to halve cost (deferred TODO from spec).

## What was actually done at first build (audit trail, 2026-06-15)

| Step | Status | Notes |
|---|---|---|
| Phase 1.0 — EBS snapshot of old staging | ✅ | `snap-0750e633f9a5e1500` |
| Phase 1.1 — Terminate old `i-0331f6ccbd741c679` | ✅ | Half-built bridge-only staging from prior session, removed |
| Phase 1.2 — Prod AMI snapshot `ami-08fdfeb433908de8b` | ✅ | `--no-reboot`, prod stayed serving |
| Phase 1.3 — Launch staging `i-0c2c974ff571162eb` | ✅ | t3.small from prod AMI |
| Phase 1.4 — EIP + DNS | ✅ | EIP `34.232.186.238`, R53 `finny.staging.11mirror.com` updated |
| Phase 1.5 — Tailscale enroll | ✅ | tailnet IP `100.112.31.24` |
| Phase 1 GATE | ✅ PASSED | SSM works, on tailnet |
| §0 — stop prod-cloned units | ✅ | All 4 stopped before any edit |
| §1 — SSH key swap | ✅ | `finny-staging-key`, single line in `authorized_keys`, mode 0600 |
| §2 — clear Slack tokens | ✅ | Before: 2 active SLACK_*; after: 0, 2 commented |
| §3 — fresh MCP OAuth | ✅ | Generated on box; Secrets Manager skipped (TODO v2) |
| §4 — fix prod-host references | ✅ | `MCP_ALLOWED_HOSTS` + `MCP_ISSUER_URL` both staging |
| §5 — Caddyfile two-block | ✅ | Validated; bcrypt basic_auth on tailnet :9445 |
| §6 — Hermes profile | ✅ | `staging` profile created, Slack scrubbed, NetSuite/Hindsight/GitHub creds copied from global ~/.hermes/.env (gotcha: profile dir's .env is loaded instead of global), ◆ confirmed |
| §7 — DO NOT touch gateway venv | ✅ reverted | First build switched to editable venv → broke NetSuite. Reverted to prod's `hermes-venv`. Lesson: stay parity-faithful. |
| §8 — install dashboard service | ✅ | Binds 127.0.0.1:9119, runs from editable venv |
| §9 — restart units | ✅ | All 4 active |
| Phase 3 (auto) — listeners + TLS + OAuth metadata + MCP 401 | ✅ | All green |
| Phase 3 (manual) — desktop app remote backend connection | ✅ | "Connected to http://100.112.31.24:9119 · Hermes 0.14.0" — but chat runs locally per §8a |
| Phase 3 (manual) — Caddyfile path filter caused OAuth fail | ✅ fixed | Original /mcp+/well-known filter swallowed /register etc. as empty 200; corrected to single proxy block matching prod |
| Phase 3 (manual) — Claude.ai connector OAuth (PRODUCTION PATH) | ✅ | Added with Advanced→OAuth Client ID/Secret (DCR not advertised; static creds bypass /register requirement). Connected. |
| Phase 3 (manual) — finny_query smoke (NetSuite reachable) | ✅ | After §7 venv revert + §6 credential copy, finny_query returns real NetSuite data through the staging bridge → gateway → NetSuite path |
| Phase 3 (manual) — remaining 4 tools smoke | ⏳ | finny_report / finny_task_status / finny_continue / finny_remember not yet exercised, but the bridge → gateway path is proven by finny_query. Optional. |
| Phase 3 (manual) — no-Slack-bleed | ⏳ | User verifies prod Slack has no bot messages during test window |
