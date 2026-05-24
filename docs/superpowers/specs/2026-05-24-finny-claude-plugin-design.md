# Finny Claude Plugin — Design

**Date:** 2026-05-24
**Status:** Approved by user, ready for implementation plan
**Repo (target):** `Postergully/finny-claude-plugin` (fork of `Postergully/lolly-claude-plugin`)
**Host:** EC2 `i-0ef58962b09d490ee` (us-east-1), public at `https://finny.11mirror.com`

## Goal

Expose the Hermes Bedrock agent ("Finny") as a remote MCP server reachable from Claude Desktop, Claude Code, and Claude.ai web — using the same plugin/bridge pattern that already works for Lolly (OpenClaw).

## Scope

**In:**
- Fork `lolly-claude-plugin` → `finny-claude-plugin`, mechanical rename only (`lolly`→`finny`, `Lolly`→`Finny`, `LOLLY`→`FINNY`).
- Repoint upstream from openclaw gateway (`:18789`) to Hermes API server (`127.0.0.1:8642`).
- Deploy bridge + Caddy + Hermes as three systemd services on the existing EC2.
- Publish plugin via `.claude-plugin/marketplace.json` for cowork install.

**Out:**
- Schema/intent changes. All 5 tools + their input shapes (incl. NetSuite-flavored fields like `vendor_name`) carry over verbatim.
- Stripping skills. `finance/`, `cowork-init/`, `day_dream/`, `intent-decomposer/`, `judging-output/`, `lolly-usage`→`finny-usage` all stay.
- Refactoring or rewriting any bridge logic.
- Multi-tenancy, multi-instance routing, separate dev/staging endpoints.

## Architecture

```
                 Internet
                    │
                    ▼
       finny.11mirror.com  (Route 53 → Elastic IP)
                    │ HTTPS :443
                    ▼
   ┌────────────────────────────────────────────┐
   │ EC2  i-0ef58962b09d490ee  (us-east-1)      │
   │                                            │
   │   Caddy :443  (systemd, apt)               │
   │     reverse_proxy → 127.0.0.1:3000         │
   │       │                                    │
   │   finny-mcp :3000  (systemd, Node 22)      │
   │     OAuth 2.1 issuer: finny.11mirror.com   │
   │     SSE / Streamable HTTP transport        │
   │       │ Bearer + HTTP                      │
   │   hermes-api :8642  (systemd, Python venv) │
   │     OpenAI-compat /v1/chat/completions     │
   │       │                                    │
   │       ▼                                    │
   │   Bedrock Runtime VPC Endpoint             │
   └────────────────────────────────────────────┘
                    │
                    ▼
              AWS Bedrock
        (us.anthropic.claude-sonnet-4-6)
```

Three processes, all on `i-0ef58962b09d490ee`. Caddy is the only thing facing the internet. `finny-mcp` and `hermes-api` bind to `127.0.0.1` only — defense in depth.

OAuth 2.1 lives in `finny-mcp` (inherited verbatim from lolly bridge). Caddy terminates TLS only, no auth logic.

Hermes calls Bedrock via the existing VPC interface endpoint (private path).

## Tool Surface

5 tools, names changed from `lolly_*` to `finny_*`. Input schemas, output envelopes, and intent/judging behavior preserved exactly.

| Tool | Purpose |
|---|---|
| `finny_query` | Sync chat / question to the agent |
| `finny_report` | Long-running synthesis/report |
| `finny_task_status` | Poll async task |
| `finny_continue` | Ask-back resume (needs_input loops) |
| `finny_remember` | Persist a memory/note |

`progressTool` stays internal (intercepted by bridge dispatcher), unchanged.

## Repo Layout

Pnpm monorepo, two packages:

```
finny-claude-plugin/
├── .claude-plugin/marketplace.json
├── plugin/                       # Cowork-side Claude plugin
│   ├── .mcp.json                 # remote HTTP transport (NOT local stdio)
│   ├── package.json
│   ├── bin/day-dream-poll.sh
│   ├── hooks/hooks.json
│   ├── monitors/monitors.json
│   ├── skills/
│   │   ├── cowork-init/
│   │   ├── day_dream/
│   │   ├── finance/
│   │   ├── intent-decomposer/
│   │   ├── judging-output/
│   │   └── finny-usage/          # renamed from lolly-usage
│   └── README.md
├── bridge/                        # MCP server, runs on EC2
│   └── src/
│       ├── mcp/tools/{query,report,taskStatus,continue,remember}.ts
│       ├── auth/                  # OAuth 2.1, kept verbatim
│       ├── server/                # HTTP/SSE transport
│       ├── openclaw/ → hermes/    # upstream client, just renamed
│       └── ...
├── deploy/                        # NEW (added during fork)
│   ├── systemd/
│   │   ├── hermes-api.service
│   │   └── finny-mcp.service
│   ├── caddy/Caddyfile
│   └── README.md                  # EC2 deploy walkthrough
├── package.json (workspace root)
└── pnpm-workspace.yaml
```

## Key Config Shapes

### `plugin/.mcp.json` (remote-only)

```json
{
  "mcpServers": {
    "finny": {
      "type": "http",
      "url": "https://finny.11mirror.com/mcp"
    }
  }
}
```

OAuth completes interactively when the user adds the connector. No local node process required on the user's machine.

### `bridge/.env` (on EC2 only — NEVER committed)

```
AUTH_ENABLED=true
MCP_CLIENT_ID=finny
MCP_CLIENT_SECRET=<openssl rand -hex 32>
MCP_ISSUER_URL=https://finny.11mirror.com
TRUST_PROXY=1
CORS_ORIGINS=https://claude.ai
FINNY_UPSTREAM_URL=http://127.0.0.1:8642
FINNY_UPSTREAM_TOKEN=<matches API_SERVER_KEY>
FINNY_MODEL=hermes-agent
```

### `~/.hermes/.env` additions (on EC2 only)

```
API_SERVER_ENABLED=true
API_SERVER_KEY=<openssl rand -hex 32, shared with FINNY_UPSTREAM_TOKEN>
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=8642
```

### `Caddyfile`

```
finny.11mirror.com {
    reverse_proxy 127.0.0.1:3000
}
```

## Deploy Phases

**A. Fork & rename (Mac):** clone lolly-claude-plugin, mechanical rename, push to `Postergully/finny-claude-plugin`, `pnpm install && build && test`.

**B. EC2 infra:** extend `HermesDeploy` IAM policy (Elastic IP + SG + Route 53 perms), allocate Elastic IP, associate with instance, open SG `:80`/`:443`, create Route 53 A record `finny.11mirror.com`.

**C. EC2 install:** Node 22 + pnpm + Caddy via apt, clone repo to `/opt/finny`, build, generate secrets, write env files.

**D. systemd:** install `hermes-api.service`, `finny-mcp.service`, Caddy config; `daemon-reload && enable --now`. Verify with `systemctl status` + `curl https://finny.11mirror.com/health`.

**E. Client wiring:** publish plugin via marketplace.json; users add `https://finny.11mirror.com/mcp` to Claude.ai Custom Connectors → OAuth flow → done.

## IAM Additions to `HermesDeploy` Policy

Already-attached policy needs these additional actions appended:

- EC2 (us-east-1 only, via existing region condition):
  `ec2:AllocateAddress`, `ec2:AssociateAddress`, `ec2:DisassociateAddress`, `ec2:DescribeAddresses`, `ec2:ReleaseAddress`
- Security group ingress is already covered by `ec2:AuthorizeSecurityGroupIngress` in current policy.
- Route 53 (resource: `11mirror.com` hosted zone ARN):
  `route53:ChangeResourceRecordSets`, `route53:GetHostedZone`, `route53:ListResourceRecordSets`, `route53:GetChange`
- Route 53 (resource `*`): `route53:ListHostedZones`

## Cost Delta

- Elastic IP: $0 (free while attached)
- Caddy / Node / pnpm: $0 (run on existing EC2)
- Route 53 hosted zone for `11mirror.com`: already paid (~$0.50/mo flat)
- TLS cert: $0 (Let's Encrypt via Caddy)
- **Total addition over current ~$55-65/mo Hermes stack: $0**

## Risks & Open Questions

1. **`plugin/.mcp.json` schema for remote HTTP MCP transport** — Anthropic's spec for marketplace-distributed plugins specifying remote MCP endpoints is still evolving. The shape `{"type": "http", "url": ...}` is the documented form as of writing; if the marketplace installer rejects it, fallback is to ship the plugin with installation instructions for adding the connector via Claude.ai's Custom Connectors UI (which we control regardless).
2. **OAuth issuer URL** — `MCP_ISSUER_URL` must exactly match the public URL or OAuth metadata advertises localhost and breaks. Caddy's reverse_proxy preserves Host header by default; verify before declaring done.
3. **Hermes API server stability** — this is a relatively new feature in Hermes 0.14.0. We should run `hermes doctor` after enabling `API_SERVER_ENABLED=true` and confirm the gateway starts cleanly under systemd, not just interactively.
4. **Rename pass collisions** — any string matching `lolly` (e.g., user-facing copy in skills, comments referring to lolly@netsuite, monitor labels) gets touched by a global search/replace. Need to spot-check after rename to ensure no false positives in documentation strings.
5. **Existing `~/.hermes/.env`** — if Hermes was already started and wrote the file, the API server vars must be appended without clobbering anything else.

## Success Criteria

- `https://finny.11mirror.com/health` returns 200 OK over HTTPS
- `curl -X POST https://finny.11mirror.com/mcp` returns OAuth challenge (401 with WWW-Authenticate)
- `claude.ai` Custom Connector add flow completes OAuth and lists 5 `finny_*` tools
- Calling `finny_query` from Claude.ai returns a Hermes-generated response
- All three systemd services survive EC2 reboot
- Plugin installable via marketplace and shows `finny` MCP server as Connected
