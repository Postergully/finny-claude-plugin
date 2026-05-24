# Finny — EC2 Deploy

Deploy artifacts for hosting the Finny MCP bridge on the existing
Hermes EC2 instance (`i-0ef58962b09d490ee`, us-east-1).

## What's here

- `systemd/hermes-api.service` — runs `hermes gateway` (Hermes API server, loopback :8642)
- `systemd/finny-mcp.service` — runs the bridge (loopback :3000, OAuth 2.1)
- `caddy/Caddyfile` — public TLS endpoint at `finny.prod.11mirror.com`
- `iam/finny-additions.json` — extra statements added to the `HermesDeploy` IAM policy

The IAM additions are scoped to the `prod.11mirror.com` hosted zone
(`Z0839152EVU8QUH8CT1I`). The public hostname is `finny.prod.11mirror.com`.

## Deploy procedure

See `docs/superpowers/plans/2026-05-24-finny-claude-plugin.md` Phases 3–7
for the step-by-step deploy. Don't run any of these on a different EC2
without re-checking the security group, IAM, and Route 53 zone IDs.
