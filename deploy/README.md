# Finny — EC2 Deploy

Deploy artifacts for hosting the Finny MCP bridge on the existing
Hermes EC2 instance (`i-0ef58962b09d490ee`, us-east-1).

## What's here

- `systemd/hermes-api.service` — runs `hermes gateway` (Hermes API server, loopback :8642)
- `systemd/finny-mcp.service` — runs the bridge (loopback :3000, OAuth 2.1)
- `caddy/Caddyfile` — public TLS endpoint at `finny.11mirror.com`
- `iam/finny-additions.json` — extra statements added to the `HermesDeploy` IAM policy

Before applying `iam/finny-additions.json`, replace `REPLACE_WITH_11MIRROR_HOSTED_ZONE_ID`
with the real Route 53 hosted zone ID for `11mirror.com` (without the `/hostedzone/` prefix).

## Deploy procedure

See `docs/superpowers/plans/2026-05-24-finny-claude-plugin.md` Phases 3–7
for the step-by-step deploy. Don't run any of these on a different EC2
without re-checking the security group, IAM, and Route 53 zone IDs.
