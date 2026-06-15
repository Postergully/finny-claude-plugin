# Staging snapshot-refresh checklist

> **Status:** WIP — first build in progress 2026-06-15. Phase 2 partially executed; Phase 3 not yet started. Refresh procedure here will be finalized once a full build cycle completes.
>
> **Purpose:** every step that has to be re-applied after rebuilding staging from a fresh prod AMI snapshot. Walk this top-to-bottom on a refresh; the result should be the staging tier described in `docs/superpowers/specs/2026-06-15-staging-architecture-design.md`.
>
> **Refresh cadence** per spec: ≤14 days, or before testing any branch >7 days old.
>
> **Do not** print env-file values into shell output. Use key-only or presence-only checks. Per `[[never-expose-secrets]]`.

## Inventory captured at first build (2026-06-15)

- Prod AMI snapshotted: `ami-08fdfeb433908de8b` (no-reboot, prod stayed up)
- Staging EC2 launched: `i-0c2c974ff571162eb`, t3.small, us-east-1a, subnet `subnet-066872488a50f5d11`, vpc `vpc-0a79e9976522b7727`
- Security group: `sg-0de99031d6c335583` (`staging-11mirror`, 80 + 443 ingress, no public 22)
- IAM profile: same as prod (`hermes-bedrock-HermesInstanceProfile-UHJKR9OUXOiZ`) — note: lacks `secretsmanager:CreateSecret`, see §3
- Elastic IP: `34.232.186.238` (`eipalloc-0634e783d0dcc1144`, tagged `env=staging`)
- DNS: `finny.staging.11mirror.com → 34.232.186.238` in Route53 zone `Z01920243UX91ZKYKCMPA` (`staging.11mirror.com`)
- Tailscale tailnet IP: `100.112.31.24`, hostname `finny-staging`
- Hermes editable venv (used by dashboard service): `/home/ubuntu/.hermes/hermes-agent/venv/bin/hermes` (`hermes-agent v0.14.0`, Python 3.11.15)
- Hermes orphan venv (currently used by gateway service, see §9 about fixing): `/home/ubuntu/hermes-venv/bin/hermes`
- EBS snapshot of pre-termination old staging: `snap-0750e633f9a5e1500` (insurance, delete after first prod-deploy round-trip works)

## Plan-vs-reality corrections (caught at first build)

The plan in `docs/superpowers/plans/2026-06-14-staging-architecture.md` had three drifts from the prod AMI:

1. **DNS name:** plan says `staging.finny.11mirror.com`; correct is `finny.staging.11mirror.com` (mirrors `finny.prod.11mirror.com`, in Route53 zone `staging.11mirror.com`).
2. **Hermes editable venv path:** plan says `/home/ubuntu/.hermes/hermes-agent/.venv/...` (with leading dot); actual is `/home/ubuntu/.hermes/hermes-agent/venv/...` (no dot).
3. **Profile to clone:** plan says copy `default.yaml`; actual prod profiles dir contains only `finny/` (a directory, not a single yaml). Right move: clone `finny` profile dir to `staging`, scrub Slack from staging copy. Switch via `hermes profile use staging`.

Also: dashboard binds to non-localhost requires `--insecure` flag (Hermes prints a warning otherwise; tailnet/VPN is the appropriate trust boundary per D6).

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

(Single line. If this fails with "key pair already exists", first `rm ~/.ssh/finny-staging-key.pem && aws ec2 delete-key-pair --key-name finny-staging-key`, then retry.)

**Then via SSM** (replace `ubuntu`'s `authorized_keys` with the new public key only — cloud-init from the AMI carried over prod's `hermes-key` public key):

```bash
PUB=$(ssh-keygen -y -f ~/.ssh/finny-staging-key.pem)
aws ssm send-command --instance-ids i-0c2c974ff571162eb --document-name AWS-RunShellScript \
  --parameters "commands=[\"sudo -iu ubuntu bash -c 'echo \\\"$PUB\\\" > /home/ubuntu/.ssh/authorized_keys && chmod 600 /home/ubuntu/.ssh/authorized_keys'\"]"
```

(Skip if you're rebuilding and the keypair + authorized_keys swap already happened on a prior instance.)

### 2. Clear Slack tokens from `~/.hermes/.env`

Belt-and-suspenders for D4. Comment out — keeps line numbers stable for diffing.

```bash
sudo -iu ubuntu cp /home/ubuntu/.hermes/.env /home/ubuntu/.hermes/.env.pre-staging.bak
sudo -iu ubuntu sed -i 's|^SLACK_BOT_TOKEN=.*|# SLACK_BOT_TOKEN cleared on staging — see snapshot-refresh-checklist.md §2|' /home/ubuntu/.hermes/.env
sudo -iu ubuntu sed -i 's|^SLACK_APP_TOKEN=.*|# SLACK_APP_TOKEN cleared on staging — see snapshot-refresh-checklist.md §2|' /home/ubuntu/.hermes/.env
# Verify:
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

**v1 storage:** secrets live only in `/opt/finny/bridge/.env` (mode 0600 owner root). Acceptable because instance role currently lacks `secretsmanager:CreateSecret` and bootstrap creds are low-rotation. If staging is destroyed, regenerate. **TODO v2:** add `secretsmanager:GetSecretValue/PutSecretValue/CreateSecret` on `arn:aws:secretsmanager:*:*:secret:finny/staging/oauth/*` to instance role `hermes-bedrock-HermesInstanceRole-I8b1EsGCg8Qn`, then store via SSM.

### 4. Update bridge MCP host allowlist

```bash
sudo sed -i 's|^MCP_ALLOWED_HOSTS=.*|MCP_ALLOWED_HOSTS=finny.staging.11mirror.com|' /opt/finny/bridge/.env
# If MCP_ISSUER_URL or MCP_REDIRECT_URIS reference prod hostname, fix those too.
```

### 5. Caddyfile — replace prod block with staging block

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

(If running this through SSM where heredoc quoting is tricky, base64-encode the content and pipe `echo $B64 | base64 -d | sudo tee /etc/caddy/Caddyfile`.)

### 6. Hermes profile: clone `finny` → `staging`, scrub Slack, switch active

```bash
sudo -iu ubuntu cp -r /home/ubuntu/.hermes/profiles/finny /home/ubuntu/.hermes/profiles/staging
# Drop Slack from staging profile's .env if present:
sudo -iu ubuntu test -f /home/ubuntu/.hermes/profiles/staging/.env && sudo -iu ubuntu sed -i '/SLACK_/d' /home/ubuntu/.hermes/profiles/staging/.env
# Switch sticky default profile:
sudo -iu ubuntu /home/ubuntu/.hermes/hermes-agent/venv/bin/hermes profile use staging
# Verify ◆ marker on `staging`:
sudo -iu ubuntu /home/ubuntu/.hermes/hermes-agent/venv/bin/hermes profile list
```

### 7. Dashboard basic-auth credentials (`~/.hermes/.env`)

**TODO — needs verification.** Hermes does not ship a `--hash-password` CLI subcommand. Per Nous docs the var name is `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH` (scrypt). Procedure to generate the hash without exposing plaintext is unconfirmed at first-build time. Once confirmed, append three lines:

```
HERMES_DASHBOARD_BASIC_AUTH_USERNAME=<user>
HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH=<scrypt-hash>
HERMES_DASHBOARD_BASIC_AUTH_SECRET=<openssl rand -hex 32>
HERMES_DASHBOARD_HOST=100.112.31.24
```

to `/home/ubuntu/.hermes/.env` (mode 0600 owner ubuntu:ubuntu).

### 8. `hermes-dashboard.service` (user-level systemd)

```bash
sudo -iu ubuntu mkdir -p /home/ubuntu/.config/systemd/user
sudo -iu ubuntu tee /home/ubuntu/.config/systemd/user/hermes-dashboard.service > /dev/null <<'EOF'
[Unit]
Description=Hermes desktop-app backend (dashboard)
After=network-online.target hermes-gateway.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=%h/.hermes/.env
ExecStart=/home/ubuntu/.hermes/hermes-agent/venv/bin/hermes dashboard --no-open --insecure --host ${HERMES_DASHBOARD_HOST} --port 9119
Restart=on-failure

[Install]
WantedBy=default.target
EOF
sudo -iu ubuntu systemctl --user daemon-reload
sudo -iu ubuntu systemctl --user enable --now hermes-dashboard
```

`--insecure` is required to bind to non-localhost; tailnet is the trust boundary (D6).

### 9. Fix `hermes-gateway.service` to use editable venv (one-time, then carries through future snapshots)

Currently the unit (inherited from prod via AMI) uses `/home/ubuntu/hermes-venv/...` — the orphan venv (`[[hermes-venv-mismatch]]`). Staging is a safe testbed to flip it to the editable venv. The change becomes part of the next prod AMI when the fix is promoted to prod via the staging-promotion flow (Phase 5).

Edit `~/.config/systemd/user/hermes-gateway.service`:
- `WorkingDirectory=/home/ubuntu/.hermes/hermes-agent`
- `ExecStart=/home/ubuntu/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main gateway run --replace`
- `Environment="VIRTUAL_ENV=/home/ubuntu/.hermes/hermes-agent/venv"`
- `Environment="PATH=/home/ubuntu/.hermes/hermes-agent/venv/bin:..."` (prepend)

Then `sudo -iu ubuntu systemctl --user daemon-reload`.

### 10. Restart units in order

```bash
sudo systemctl restart finny-mcp
sudo -iu ubuntu systemctl --user restart hermes-gateway hermes-dashboard
sudo systemctl reload caddy
```

### 11. Verification (Phase 3 in plan)

- `tailscale status` shows `finny-staging`
- `curl -s http://100.112.31.24:9119/api/status | jq '.auth_required, .auth_providers'` → `true`, `["basic"]`
- `curl -sS https://finny.staging.11mirror.com/.well-known/oauth-protected-resource` → TLS green, references staging `client_id`
- Browser cowork Custom Connector at `https://finny.staging.11mirror.com/mcp` → OAuth → all 5 tools green
- Prod Slack bot count of new messages during test window: 0

## What was actually done at first build (audit trail, 2026-06-15)

| Step | Status | Notes |
|---|---|---|
| 0 — stop prod-cloned units | ✅ done | All 4 units stopped/inactive |
| 1 — SSH key swap | 🟡 pending | Keypair create attempted twice, both failed (terminal line-break + 0-byte file). Currently no `finny-staging-key` exists. |
| 2 — clear Slack tokens | ✅ done | Before: 2 active SLACK_*; after: 0 active, 2 commented, mode 0600 ubuntu:ubuntu preserved |
| 3 — fresh MCP OAuth | ✅ done | Generated on box, written to `/opt/finny/bridge/.env`, backup at `.env.pre-staging.bak`. Secrets Manager skipped (instance role lacks perms — TODO v2). |
| 4 — MCP_ALLOWED_HOSTS | ✅ done | Set to `finny.staging.11mirror.com` |
| 5 — Caddyfile | ✅ done | Validated by `caddy validate` |
| 6 — Hermes profile | ✅ done | `staging` profile created, Slack scrubbed, sticky default set (◆ marker confirmed) |
| 7 — dashboard auth creds | 🟡 pending | Hash format / generation procedure unconfirmed |
| 8 — dashboard service | 🟡 pending | Blocked on §7 |
| 9 — gateway venv fix | 🟡 pending | Approved by user; not yet applied |
| 10 — restart units | 🟡 pending | Wait until §1, §7, §8, §9 done |
| 11 — verification | 🟡 pending | Phase 3, not yet started |

## Cost notes

- EBS snapshot of pre-termination old staging: `snap-0750e633f9a5e1500` (30 GiB, ~$1.50/mo). Delete after first successful prod-deploy round-trip via the new flow.
- Prod AMI: `ami-08fdfeb433908de8b` (~30 GiB, ~$1.50/mo). Delete and re-take on each refresh.
- EIP `34.232.186.238` ($0 attached, ~$3.60/mo if released).
- Staging instance t3.small: ~$15/mo running 24/7. Stop nightly to halve cost (deferred TODO from spec).
