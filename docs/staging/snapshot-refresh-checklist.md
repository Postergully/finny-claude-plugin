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
- Hermes editable venv (gateway + dashboard both run from this): `/home/ubuntu/.hermes/hermes-agent/venv/bin/hermes` (`hermes-agent v0.14.0`, Python 3.11.15)
- Hermes orphan venv (still on disk, no longer used by any unit on staging): `/home/ubuntu/hermes-venv/bin/hermes` — see `[[hermes-venv-mismatch]]` note
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

### 5. Caddyfile — two site blocks: public MCP + tailnet dashboard with basic_auth

**Generate the bcrypt hash on user's Mac** (TTY input, no echo, plaintext stays local):

```bash
docker run --rm -it caddy:2 caddy hash-password
# (or `caddy hash-password` if installed locally)
```

Paste the resulting `$2a$14$…` hash into the Caddyfile below. **Caddyfile syntax requires escaping `$` as `$$`.**

```bash
HASH_ESC='<the-hash-with-each-$-doubled-to-$$>'  # e.g. $$2a$$14$$LCucAyUSnVAF...
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.pre-staging.bak
sudo tee /etc/caddy/Caddyfile > /dev/null <<EOF
finny.staging.11mirror.com {
    encode gzip
    reverse_proxy /mcp* 127.0.0.1:3000 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-Proto https
    }
    reverse_proxy /.well-known/* 127.0.0.1:3000 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-Proto https
    }
}

http://100.112.31.24:9445 {
    basic_auth {
        finny-staging $HASH_ESC
    }
    reverse_proxy 127.0.0.1:9119 {
        header_up Host {host}
    }
}
EOF
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy   # auto-issues TLS cert on first request
```

The dashboard listener binds to the **tailnet IP** (not 0.0.0.0), so port 9445 is unreachable from the public internet regardless of SG. SG keeps its existing 80+443 ingress.

(If running this through SSM where heredoc quoting is tricky, base64-encode the content and pipe `echo $B64 | base64 -d | sudo tee /etc/caddy/Caddyfile`.)

### 6. Hermes profile: clone `finny` → `staging`, scrub Slack, switch active

```bash
sudo -iu ubuntu cp -r /home/ubuntu/.hermes/profiles/finny /home/ubuntu/.hermes/profiles/staging
# Drop Slack from staging profile's .env if any:
sudo -iu ubuntu test -f /home/ubuntu/.hermes/profiles/staging/.env && \
  sudo -iu ubuntu sed -i '/SLACK_/d' /home/ubuntu/.hermes/profiles/staging/.env
sudo -iu ubuntu /home/ubuntu/.hermes/hermes-agent/venv/bin/hermes profile use staging
sudo -iu ubuntu /home/ubuntu/.hermes/hermes-agent/venv/bin/hermes profile list
# Confirm ◆ marker is on `staging`
```

### 7. Fix `hermes-gateway.service` to use editable venv (one-time per snapshot baseline)

The unit inherited from prod points at `/home/ubuntu/hermes-venv/...` — the orphan venv (`[[hermes-venv-mismatch]]`). Staging is the safe testbed for fixing it; the fix promotes to prod via the staging-promotion flow (Phase 5).

```bash
sudo -iu ubuntu cp /home/ubuntu/.config/systemd/user/hermes-gateway.service \
                  /home/ubuntu/.config/systemd/user/hermes-gateway.service.pre-staging.bak
sudo -iu ubuntu tee /home/ubuntu/.config/systemd/user/hermes-gateway.service > /dev/null <<'EOF'
[Unit]
Description=Hermes Agent Gateway - Messaging Platform Integration
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=/home/ubuntu/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main gateway run --replace
WorkingDirectory=/home/ubuntu/.hermes/hermes-agent
Environment="PATH=/home/ubuntu/.hermes/hermes-agent/venv/bin:/usr/bin:/home/ubuntu/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
Environment="VIRTUAL_ENV=/home/ubuntu/.hermes/hermes-agent/venv"
Environment="HERMES_HOME=/home/ubuntu/.hermes"
Restart=always
RestartSec=5
RestartMaxDelaySec=300
RestartSteps=5
RestartForceExitStatus=75
KillMode=mixed
KillSignal=SIGTERM
ExecReload=/bin/kill -USR1 $MAINPID
TimeoutStopSec=210
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF
sudo -iu ubuntu systemctl --user daemon-reload
```

### 8. Install `hermes-dashboard.service` (binds to 127.0.0.1, Caddy fronts it)

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
ExecStart=/home/ubuntu/.hermes/hermes-agent/venv/bin/hermes dashboard --no-open --host 127.0.0.1 --port 9119 --skip-build
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

`--skip-build` avoids `npm run build` at startup (the dist is already built in the editable install). Loopback bind keeps Hermes' own CORS/host-guard happy; Caddy provides the auth + tailnet exposure.

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

- **Desktop app remote backend** — Settings → Gateway → "Add remote gateway" → URL `http://100.112.31.24:9445` → username `finny-staging` → password (the one you bcrypt-hashed). Confirm dashboard chat works against staging.
- **Browser cowork** (Claude.ai) — register Custom Connector at `https://finny.staging.11mirror.com/mcp` → complete OAuth → exercise all 5 MCP tools (`finny_query`, `finny_report`, `finny_task_status`, `finny_continue`, `finny_remember`).
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
| §6 — Hermes profile | ✅ | `staging` profile created, Slack scrubbed, ◆ confirmed |
| §7 — fix gateway venv | ✅ | Now uses editable venv (`…/hermes-agent/venv`) |
| §8 — install dashboard service | ✅ | Binds 127.0.0.1:9119, runs from editable venv |
| §9 — restart units | ✅ | All 4 active |
| Phase 3 (auto) — listeners + auth gate + TLS + OAuth metadata + MCP 401 | ✅ | All green |
| Phase 3 (manual) — desktop app config | ⏳ | User to add `http://100.112.31.24:9445` as remote gateway |
| Phase 3 (manual) — 5-tool browser smoke | ⏳ | User to register Custom Connector + run tools |
| Phase 3 (manual) — no-Slack-bleed | ⏳ | User to verify during test window |
