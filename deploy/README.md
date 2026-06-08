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

## Lolly archive (knowledge handoff — 2026-06-08)

Read-only knowledge reference at `~/lolly-archive/` on prod EC2 `i-0ef58962b09d490ee`.
Pointer block lives in Hermes's live `AGENTS.md` between the markers
`<!-- BEGIN: lolly-archive-pointer ... -->` and `<!-- END: lolly-archive-pointer -->`.

Hermes's own `~/.hermes/` is byte-untouched apart from that single fenced block.
Contents at `~/lolly-archive/`:

- `workspace-main/MEMORY.md`, `USER.md`, `AGENTS.md`, `memory/` — knowledge files
- `workspace-main/skills/{netsuite, daily-synthesis, data-presentation}` — read-only skills
- `lolly-learning-sessions.md` — distilled patterns from 332 prior NetSuite sessions

### Rollback (one operator action)

```bash
# On EC2 (path captured during install — see ~/lolly-handoff/preflight.txt):
LIVE_AGENTS=<path>
sed -i.bak '/<!-- BEGIN: lolly-archive-pointer/,/<!-- END: lolly-archive-pointer/d' "$LIVE_AGENTS"
rm -rf ~/lolly-archive/
hermes status   # confirm clean
```

After rollback, `~/.hermes/` is byte-identical to pre-handoff state (modulo
the `.bak` of the live `AGENTS.md` created by `sed`).

Source spec: `docs/superpowers/specs/2026-06-08-lolly-knowledge-handoff-design.md`
Plan: `docs/superpowers/plans/2026-06-08-lolly-knowledge-handoff.md`
