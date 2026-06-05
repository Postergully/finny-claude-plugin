# Finny MCP Bridge — Deploy from Scratch

Step-by-step procedure to deploy the Finny MCP bridge on a fresh or
rebuilt EC2 instance. Assumes the Hermes agent is already installed
(Python venv with `hermes-agent` + `aiohttp` packages).

## Related docs (in this repo)

| Doc | What it covers |
|-----|----------------|
| `docs/superpowers/specs/2026-05-24-finny-claude-plugin-design.md` | System design: architecture, rename map, tool surface |
| `docs/superpowers/plans/2026-05-24-finny-claude-plugin.md` | Implementation plan (Phases 1–7) |
| `deploy/README.md` | Deploy artifacts overview (systemd units, Caddyfile, IAM) |
| `bridge/README.md` | Bridge package docs: stdio mode, remote mode, transport details |

This doc covers **only the MCP bridge layer** (Caddy → bridge → Hermes API).
The Hermes agent setup (Python venv, Bedrock credentials) is a prerequisite.

## Prerequisites

| Requirement | Value |
|-------------|-------|
| EC2 instance | `i-0ef58962b09d490ee` (us-east-1, t3.large) |
| Elastic IP | `34.200.24.169` |
| Domain | `finny.prod.11mirror.com` (Route 53 zone `Z0839152EVU8QUH8CT1I`) |
| Security group | `sg-0e132a794f6161a79` (ports 80, 443) |
| IAM profile | SSM-enabled (for remote access) |
| Node.js | >= 20 (we use 22.x) |
| Hermes API | Must be running on `127.0.0.1:8642` |
| Hermes upstream token | Read from `hermes dashboard --no-open` URL fragment |

## Phase 1 — Install Node.js and pnpm

```bash
# Install Node 22.x via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install pnpm
npm install -g pnpm@latest

# Verify
node --version   # v22.x
pnpm --version   # 9.x
```

## Phase 2 — Clone and build the bridge

```bash
mkdir -p /opt/finny
cd /opt/finny
git clone https://github.com/Postergully/finny-claude-plugin.git .
cd bridge
pnpm install
pnpm run build

# Verify dist/index.js exists
ls dist/index.js
```

## Phase 3 — Create .env file

```bash
# Generate a new MCP client secret
MCP_SECRET=$(openssl rand -hex 32)

cat > /opt/finny/bridge/.env << EOF
AUTH_ENABLED=true
MCP_CLIENT_ID=finny
MCP_CLIENT_SECRET=$MCP_SECRET
MCP_ISSUER_URL=https://finny.prod.11mirror.com
MCP_ALLOWED_HOSTS=finny.prod.11mirror.com,127.0.0.1,localhost
MCP_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback
TRUST_PROXY=1
CORS_ORIGINS=https://claude.ai
FINNY_UPSTREAM_URL=http://127.0.0.1:8642
FINNY_UPSTREAM_TOKEN=<read from hermes dashboard --no-open>
FINNY_MODEL=hermes-agent
HOST=127.0.0.1
PORT=3000
EOF

chmod 600 /opt/finny/bridge/.env
echo "MCP_CLIENT_SECRET=$MCP_SECRET"
# Save this secret — needed for Claude.ai Custom Connector setup
```

### Optional: Enable Google OAuth login for user identity

To require users to authenticate via Google before using the MCP bridge
(captures their verified email in the access token for dashboard/audit):

```bash
cat >> /opt/finny/bridge/.env << EOF
AUTH_REQUIRE_LOGIN=true
GOOGLE_CLIENT_ID=<your-google-oauth-client-id>
GOOGLE_CLIENT_SECRET=<your-google-oauth-client-secret>
EOF
```

Also add `https://finny.prod.11mirror.com/auth/google/callback` as an
Authorized Redirect URI in your Google Cloud Console OAuth client settings.

To disable Google login and revert to the auto-approve flow:

```bash
sed -i 's/AUTH_REQUIRE_LOGIN=true/AUTH_REQUIRE_LOGIN=false/' \
  /opt/finny/bridge/.env
sudo systemctl restart finny-mcp
```

## Phase 4 — Install systemd services

```bash
# Copy service files
sudo cp deploy/systemd/finny-mcp.service /etc/systemd/system/
sudo cp deploy/systemd/hermes-api.service /etc/systemd/system/

# Enable and start services
sudo systemctl daemon-reload
sudo systemctl enable hermes-api finny-mcp
sudo systemctl start hermes-api
sudo systemctl start finny-mcp
```

## Phase 5 — Install and configure Caddy

Caddy runs as a native systemd service (not Docker).

```bash
# Install Caddy (if not already installed)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy

# Deploy Caddyfile
sudo cp deploy/caddy/Caddyfile /etc/caddy/Caddyfile

# Restart Caddy (will auto-obtain TLS cert for finny.prod.11mirror.com)
sudo systemctl restart caddy

# Verify TLS cert issued
sudo journalctl -u caddy --no-pager -n 10
```

## Phase 6 — Verify

```bash
# Health (no auth)
curl -s https://finny.prod.11mirror.com/health
# Expected: {"status":"ok","transport":"http","auth":true,"loginRequired":false}

# Deep readiness (probes Hermes API)
curl -s https://finny.prod.11mirror.com/ready
# Expected: {"ok":true,...}

# OAuth metadata discovery
curl -s https://finny.prod.11mirror.com/.well-known/oauth-authorization-server | jq .issuer
# Expected: "https://finny.prod.11mirror.com/"

# MCP endpoint (should 401 with resource_metadata)
curl -sI https://finny.prod.11mirror.com/mcp | grep www-authenticate
# Expected: Bearer ... resource_metadata=".../.well-known/oauth-protected-resource/mcp"

# Reboot test
sudo reboot
# Wait ~30s (simpler boot than lolly), then:
curl -s https://finny.prod.11mirror.com/ready
# Expected: {"ok":true,...}
```

## Phase 7 — Connect from Claude.ai

In Claude.ai Custom Connector settings:

| Field | Value |
|-------|-------|
| URL | `https://finny.prod.11mirror.com/mcp` |
| Client ID | `finny` |
| Client Secret | (the MCP_CLIENT_SECRET from Phase 3) |

After connecting, Claude.ai should list 5 tools:
`finny_query`, `finny_report`, `finny_task_status`, `finny_continue`, `finny_remember`

## Boot sequence (after reboot)

| Order | Service | What it does | Time |
|-------|---------|--------------|------|
| 1 | caddy.service | TLS termination, auto-cert | immediate |
| 2 | hermes-api.service | Hermes Python agent on :8642 | ~5s |
| 3 | finny-mcp.service | Node MCP bridge on :3000 (depends on hermes-api) | immediate |

The full stack is ready in ~10s after boot. Much simpler than lolly
(no Docker, no sandbox, no SSH tunnel, no gateway start script).

## Troubleshooting

```bash
# Check service status
sudo systemctl status finny-mcp hermes-api caddy

# Bridge logs
sudo journalctl -u finny-mcp -f

# Hermes logs
sudo journalctl -u hermes-api -f

# Restart just the bridge (after code changes)
sudo systemctl restart finny-mcp

# Restart Hermes (if it died)
sudo systemctl restart hermes-api

# Full restart of everything
sudo systemctl restart caddy hermes-api finny-mcp
```

## Secret rotation

```bash
# Rotate MCP_CLIENT_SECRET (must also update Claude.ai connector after)
NEW=$(openssl rand -hex 32)
sed -i "s|^MCP_CLIENT_SECRET=.*|MCP_CLIENT_SECRET=$NEW|" /opt/finny/bridge/.env
sudo systemctl restart finny-mcp
echo "New secret: $NEW — update Claude.ai Custom Connector"
```
