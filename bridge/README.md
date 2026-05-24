# @postergully/finny-mcp

This package is a cloned-and-owned fork of [`freema/hermes-mcp`](https://github.com/freema/hermes-mcp) (imported at upstream SHA `6a2aa7d3cac8bfea17756a0b4cbc517fe1046a7a`). Upstream infrastructure — gateway client, OAuth, async task store, instance routing — is kept unchanged. The generic tool surface (`hermes_chat`, `hermes_chat_async`, `hermes_status`, `hermes_instances`, `hermes_task_*`) has been replaced with three semantic tools scoped to Finny: `finny_query`, `finny_report`, `finny_task_status`. (`finny_executeSuiteQL` exists internally for unit tests but is intentionally not exposed on the public MCP surface — see M4.1 carry-forward.)

See the design spec at [`docs/FINNY-AS-PLUGIN-DESIGN.md`](../../nanoclaw/docs/FINNY-AS-PLUGIN-DESIGN.md) and the envelope reference in this repo under `docs/ENVELOPE.md` (written in M2).

## Local stdio mode (M1+)

Used by cowork's stdio connector config. Bridge spawned as a child process, MCP over stdin/stdout. No network, no auth.

```bash
# Build once
cd bridge && pnpm install && pnpm run build

# Inside .mcp.json (plugin side) — invokes the Keychain-sourced wrapper
{
  "command": "finny-mcp-launch",
  "args": ["node", "/Applications/nanoclaw/finny-claude-plugin/bridge/dist/index.js"]
}
```

`finny-mcp-launch` (operator's host-side script, not in this repo) reads `finny-gateway-token` from macOS Keychain and injects as `FINNY_GATEWAY_TOKEN` env. Never appears in `ps` args or scrollback.

## Remote mode — HTTPS + OAuth (M4)

Used when enrolling as a Claude cowork **custom connector**. Bridge runs as a long-lived HTTP server; cowork connects over HTTPS; every call is authenticated with OAuth 2.1 bearer tokens.

### Transport

**Streamable HTTP on `/mcp`** — the only load-bearing endpoint. Token-by-token streaming works via the Streamable HTTP `text/event-stream` upgrade path inside `/mcp`; no separate SSE endpoint needed. Legacy `/sse` + `/messages` were deleted in M4 Task 3 to shrink the attack surface.

- `POST /mcp` — JSON-RPC request/response
- `GET /mcp` — server-initiated event stream (notifications)
- `DELETE /mcp` — explicit session termination
- Session identity via `Mcp-Session-Id` header

### Preflight

1. **Gateway up**: `curl -sSf http://127.0.0.1:8642/health` must return `{"ok":true,"status":"live"}`. If not, restart via the Container-A procedure in `/Applications/nanoclaw/CLAUDE.md` — never `kubectl exec`.

2. **`FINNY_GATEWAY_TOKEN` fresh** — re-read from `hermes dashboard --no-open` URL fragment and probe:

   ```bash
   curl -sS -o /dev/null -w "%{http_code}\n" \
     -H "Authorization: Bearer $FINNY_GATEWAY_TOKEN" \
     http://127.0.0.1:8642/v1/models
   ```

   Must return `200`. A `401` here means the gateway token drifted on the bridge side — NOT a NetSuite credential problem. See the §1 Boundaries rule 5 in the design doc for why these are distinct hops.

3. **OAuth creds in Keychain** (one-time provisioning, never echo the generated values):

   ```bash
   security add-generic-password -a "$USER" -s finny-mcp-oauth-id -U \
     -w "$(openssl rand -hex 16)"
   security add-generic-password -a "$USER" -s finny-mcp-oauth-secret -U \
     -w "$(openssl rand -hex 32)"
   ```

4. **ngrok tunnel** pointing `https://revenue-frostlike-surely.ngrok-free.dev` at `http://127.0.0.1:3000`.

### Launch

```bash
finny-mcp-launch --remote
```

Does:
- Reads `finny-gateway-token`, `finny-mcp-oauth-id`, `finny-mcp-oauth-secret` from Keychain.
- Sets `MCP_ISSUER_URL=https://revenue-frostlike-surely.ngrok-free.dev` (override via env for a different public URL).
- Sets `ACCESS_LOG_PATH=/tmp/finny-mcp-access.log`.
- Execs the bridge in `--transport http --port 3000 --issuer-url …` mode.
- Auth auto-enables because `--transport http + --issuer-url` signals remote deployment.

### Connector URL (for cowork)

```
https://revenue-frostlike-surely.ngrok-free.dev/mcp
```

Enter as-is in cowork settings → Custom connectors → Add new. Paste OAuth client_id + secret from Keychain (never echo). Cowork redirects to `/authorize` → approve → returns to settings "Connected".

### Access log

One JSONL line per `/mcp` request at `ACCESS_LOG_PATH`. Shape only — never `data.rows`, `data.narrative`, `intent_restated`, `assumptions`, `error.message`, `confidence_reason`. Example:

```json
{"ts":"2026-05-12T11:05:40Z","method":"POST","path":"/mcp","status":200,"duration_ms":103,"tool":"finny_query","envelope_status":"refused","envelope_confidence":"high","finny_session_id":"—"}
```

Tail with `tail -f /tmp/finny-mcp-access.log | jq .`.

### Troubleshooting

| Symptom | Diagnosis | Fix |
|---|---|---|
| `401` from `/mcp` with valid cowork bearer | OAuth session expired (default 1h TTL) | Disconnect + reconnect connector in cowork settings |
| `401` from `/authorize` | Unknown `client_id` | Re-provision Keychain entries, re-paste into cowork |
| `400 Unregistered redirect_uri` at authorize | Cowork's callback URL isn't in `MCP_REDIRECT_URIS` | Observe the `redirect_uri` query param in the failing authorize URL, add to `MCP_REDIRECT_URIS`, restart |
| Fast `401` from bridge → gateway (4-7ms) | Stale `FINNY_GATEWAY_TOKEN` | Re-read from `hermes dashboard --no-open`, re-run the Keychain store, restart bridge. **NOT a NetSuite problem.** |
| `ERR_EMPTY_RESPONSE` at dashboard | Gateway crashed or wrong container | Container-A restart procedure (see `/Applications/nanoclaw/CLAUDE.md`) |

---

(Original upstream README follows.)

<!-- mcp-name: io.github.postergully/finny-mcp -->

# Hermes MCP Server

[![npm version](https://badge.fury.io/js/hermes-mcp.svg)](https://www.npmjs.com/package/hermes-mcp)
[![CI](https://github.com/freema/hermes-mcp/workflows/CI/badge.svg)](https://github.com/freema/hermes-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GHCR](https://img.shields.io/badge/GHCR-ghcr.io%2Ffreema%2Fhermes--mcp-blue?logo=github)](https://github.com/freema/hermes-mcp/pkgs/container/hermes-mcp)
[![Website](https://img.shields.io/badge/Website-hermes--mcp.cloud-e24b4a)](https://hermes-mcp.cloud)

<a href="https://glama.ai/mcp/servers/@freema/hermes-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@freema/hermes-mcp/badge" />
</a>

🦞 Model Context Protocol (MCP) server for [Hermes](https://github.com/hermes/hermes) AI assistant integration.

## Demo

<p align="center">
  <img src="docs/assets/claude-ai-demo.gif" alt="Hermes MCP in Claude.ai" width="720" />
</p>

## Why I Built This

Hey! I created this MCP server because I didn't want to rely solely on messaging channels to communicate with Hermes. What really excites me is the ability to connect Hermes to the Claude web UI. Essentially, my chat can delegate tasks to my Claw bot, which then handles everything else — like spinning up Claude Code to fix issues for me.

Think of it as an AI assistant orchestrating another AI assistant. Pretty cool, right?

## Quick Start

### Docker (Recommended)

Pre-built images are published to GitHub Container Registry on every release.

```bash
docker pull ghcr.io/freema/hermes-mcp:latest
```

Create a `docker-compose.yml`:

```yaml
services:
  mcp-bridge:
    image: ghcr.io/freema/hermes-mcp:latest
    container_name: hermes-mcp
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - FINNY_UPSTREAM_URL=http://host.docker.internal:18789
      - FINNY_UPSTREAM_TOKEN=${FINNY_UPSTREAM_TOKEN}
      - FINNY_MODEL=hermes
      - AUTH_ENABLED=true
      - MCP_CLIENT_ID=hermes
      - MCP_CLIENT_SECRET=${MCP_CLIENT_SECRET}
      - MCP_ISSUER_URL=${MCP_ISSUER_URL:-}
      - CORS_ORIGINS=https://claude.ai
    extra_hosts:
      - "host.docker.internal:host-gateway"
    read_only: true
    security_opt:
      - no-new-privileges
```

Generate secrets and start:

```bash
export MCP_CLIENT_SECRET=$(openssl rand -hex 32)
export FINNY_UPSTREAM_TOKEN=your-gateway-token
docker compose up -d
```

Then in Claude.ai add a custom MCP connector pointing to your server with `MCP_CLIENT_ID=hermes` and your `MCP_CLIENT_SECRET`.

> **Tip:** Pin a specific version instead of `latest` for production: `ghcr.io/freema/hermes-mcp:1.1.0`

### Local (Claude Desktop)

```bash
npx hermes-mcp
```

Add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "hermes-agent": {
      "command": "npx",
      "args": ["hermes-mcp"],
      "env": {
        "FINNY_UPSTREAM_URL": "http://127.0.0.1:8642",
        "FINNY_UPSTREAM_TOKEN": "your-gateway-token",
        "FINNY_MODEL": "hermes-agent",
        "FINNY_TIMEOUT_MS": "300000"
      }
    }
  }
}
```

### Remote (Claude.ai) without Docker

```bash
AUTH_ENABLED=true MCP_CLIENT_ID=hermes MCP_CLIENT_SECRET=your-secret \
  MCP_ISSUER_URL=https://mcp.your-domain.com \
  CORS_ORIGINS=https://claude.ai FINNY_UPSTREAM_TOKEN=your-gateway-token \
  npx hermes-mcp --transport sse --port 3000
```

> **Important:** When running behind a reverse proxy (Caddy, nginx, etc.), you **must** set `MCP_ISSUER_URL` (or `--issuer-url`) to your public HTTPS URL. Without this, OAuth metadata will advertise `http://localhost:3000` and clients will fail to authenticate.

See [Installation Guide](docs/installation.md) for details.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Your Server                             │
│                                                                 │
│  ┌─────────────────┐      ┌─────────────────────────┐          │
│  │   Hermes      │      │    Hermes MCP         │          │
│  │   Gateway       │◄────►│    Bridge Server        │          │
│  │   :18789        │      │    :3000                │          │
│  │                 │      │                         │          │
│  │  OpenAI-compat  │      │  - OAuth 2.1 auth       │          │
│  │  /v1/chat/...   │      │  - CORS protection      │          │
│  └─────────────────┘      │  - Input validation     │          │
│                           └──────────┬──────────────┘          │
│                                      │                          │
└──────────────────────────────────────┼──────────────────────────┘
                                       │ HTTPS + OAuth 2.1
                                       ▼
                              ┌─────────────────┐
                              │   Claude.ai     │
                              │   (MCP Client)  │
                              └─────────────────┘
```

## Available Tools

### Sync Tools

| Tool | Description |
|------|-------------|
| `hermes_chat` | Send messages to Hermes and get responses |
| `hermes_status` | Check Hermes gateway health |
| `hermes_instances` | List all configured Hermes instances |

### Async Tools (for long-running operations)

| Tool | Description |
|------|-------------|
| `hermes_chat_async` | Queue a message, get task_id immediately |
| `hermes_task_status` | Check task progress and get results |
| `hermes_task_list` | List all tasks with filtering |
| `hermes_task_cancel` | Cancel a pending task |

## Prompts

The bridge exposes two MCP prompts via `prompts/list` + `prompts/get` so any harness connecting to it gets a baseline for tool usage and envelope judging — no plugin install required.

| Prompt | Description |
|--------|-------------|
| `finny_usage` | How to decide when to call Finny and which `finny_*` tool to pick. Load on connect. |
| `finny_judging` | How to read a Finny envelope and decide trust / retry / surface. Load after every tool call. |

Prompt bodies are generated at build time from `plugin/skills/<name>/SKILL.md` (single source of truth). Plugin users (Claude Code with the companion plugin installed) get the richer skill-file version with frontmatter, activation hints, and reference links. Every other harness — Claude Desktop with a manual `.mcp.json`, Cursor, raw MCP clients — gets the compact prompt body via the MCP prompts capability.

To inspect:

```text
# MCP prompts/list
> { "method": "prompts/list" }
< { "prompts": [ {"name": "finny_usage", ...}, {"name": "finny_judging", ...} ] }

# MCP prompts/get
> { "method": "prompts/get", "params": { "name": "finny_usage" } }
< { "description": "...", "messages": [ { "role": "user", "content": { "type": "text", "text": "<skill body>" } } ] }
```

## Multi-Instance Mode

Orchestrate multiple Hermes gateways from a single MCP server. One bridge, many claws — route requests to prod, staging, dev, or whatever you name them (lobster-supreme and the-claw-abides are perfectly valid names).

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Claude.ai / Claude Desktop                    │
│                              (MCP Client)                            │
└──────────────────────┬───────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     Hermes MCP Bridge Server                        │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │  Instance     │  │  Instance     │  │  Instance     │              │
│  │  Registry     │  │  Resolver     │  │  Validator    │              │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘               │
│         │                 │                  │                        │
│  ┌──────┴─────────────────┴──────────────────┴───────┐               │
│  │              Per-Instance Hermes Clients          │              │
│  │     (separate auth, timeout, URL per instance)     │              │
│  └────────┬──────────────┬──────────────┬────────────┘               │
└───────────┼──────────────┼──────────────┼────────────────────────────┘
            │              │              │
            ▼              ▼              ▼
   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
   │  🦞 prod     │ │  🦞 staging  │ │  🦞 dev      │
   │  (default)   │ │              │ │              │
   │  :18789      │ │  :18789      │ │  :18789      │
   │  Hermes GW │ │  Hermes GW │ │  Hermes GW │
   └──────────────┘ └──────────────┘ └──────────────┘
```

### Setup

```bash
FINNY_INSTANCES='[
  {"name": "prod", "url": "http://prod:18789", "token": "tok1", "default": true},
  {"name": "staging", "url": "http://staging:18789", "token": "tok2"},
  {"name": "dev", "url": "http://dev:18789", "token": "tok3"}
]'
```

### Usage

All tools accept an optional `instance` parameter to target a specific gateway:

```
# Chat with staging instance
hermes_chat message="Deploy status?" instance="staging"

# Check health of prod
hermes_status instance="prod"

# List all configured instances
hermes_instances

# Async task targeting dev
hermes_chat_async message="Run tests" instance="dev"
```

When `instance` is omitted, the default instance is used. Each instance has its own auth token, timeout, and URL — fully isolated.

### Key Features

- **Zero-migration upgrade** — existing single-instance deployments work without any config change
- **Per-instance isolation** — separate auth tokens, timeouts, and URLs
- **Dynamic routing** — Claude picks the right instance per request
- **Task tracking** — async tasks remember which instance they target
- **Security** — tokens are never exposed via `hermes_instances`

See [Configuration — Multi-Instance Mode](docs/configuration.md#multi-instance-mode) for the full reference.

## Documentation

- [Installation](docs/installation.md) — Setup for Claude Desktop & Claude.ai
- [Configuration](docs/configuration.md) — Environment variables & options
- [Deployment](docs/deployment.md) — Docker & production setup
- [Threat Model](docs/threat-model.md) — What Claude can/can't trigger, trust boundaries & attack surfaces
- [Logging](docs/logging.md) — What gets logged, where, and what is never logged
- [Development](docs/development.md) — Contributing & adding tools
- [Security](SECURITY.md) — Security policy & best practices

## Security

⚠️ **Always enable authentication in production!**

```bash
# Generate secure client secret
export MCP_CLIENT_SECRET=$(openssl rand -hex 32)

# Run with auth enabled
AUTH_ENABLED=true MCP_CLIENT_ID=hermes MCP_CLIENT_SECRET=$MCP_CLIENT_SECRET \
  hermes-mcp --transport sse
```

Configure CORS to restrict access:

```bash
CORS_ORIGINS=https://claude.ai,https://your-app.com
```

See [Configuration](docs/configuration.md) for all security options.

## Requirements

- Node.js ≥ 20
- Hermes gateway running with HTTP API enabled:
  ```json5
  // hermes.json
  { "gateway": { "http": { "endpoints": { "chatCompletions": { "enabled": true } } } } }
  ```

## License

MIT

## Author

Created by [Tomáš Grasl](https://www.tomasgrasl.cz/)

## Related Projects

- [Hermes](https://github.com/hermes/hermes) — The AI assistant this MCP connects to
- [MCP Specification](https://spec.modelcontextprotocol.io/) — Model Context Protocol docs
