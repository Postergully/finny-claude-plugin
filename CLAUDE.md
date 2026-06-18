# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository shape

pnpm workspace (Node >=22 at root) with two packages:

- `bridge/` — `@postergully/finny-mcp` runtime MCP server (TypeScript, Node >=20). Exposes the Hermes/Finny ERP agent as a small typed tool surface. Has its own `CLAUDE.md` with security rules — read it before changing anything in `bridge/`.
- `plugin/` — `@postergully/finny-plugin` declarative Claude cowork plugin bundle: `plugin.json`, `.mcp.json`, `hooks/hooks.json`, `monitors/monitors.json`, and SKILL.md files under `skills/`. No runtime code.
- `deploy/` — production infra (Caddy reverse proxy, systemd units for `hermes-api` + `finny-mcp`, IAM).
- `docs/` — handoff docs and superpowers references.
- `docs/staging/` — staging-to-prod promotion docs: per-branch change manifests (`<branch>-changes.md`), the manifest template, the long-form how-to (`README.md`), and the snapshot-refresh checklist.

## Architecture (big picture)

```
Claude cowork (Claude.ai or CLI)
  └── plugin/  (skills + hooks + monitors + .mcp.json)
        └── bridge/  (MCP server: stdio for CLI, SSE/HTTP for browser)
              └── Hermes gateway  (OpenAI-compatible POST /v1/chat/completions, Bearer FINNY_UPSTREAM_TOKEN)
                    └── Finny / Hermes ERP agent (NetSuite)
```

Two-half design:

1. **plugin/** — declarative content marketplaces can install: SKILL.md files that teach cowork *how* to call Finny (`intent-decomposer` orchestrates discover→AskUser→execute, `judging-output` handles envelopes and intent-drift detection, `cowork-init` runs first-run setup). Plugin marketplaces don't ship MCP transport.
2. **bridge/** — the MCP server itself. CLI cowork auto-spawns it via `plugin/.mcp.json` over stdio; browser cowork connects via Custom Connector to a public HTTPS endpoint (OAuth 2.1 mandatory in prod).

The bridge exposes 5 tools (auto-approved by `plugin/hooks/hooks.json`): `finny_query`, `finny_report`, `finny_task_status`, `finny_continue`, `finny_remember`. Responses are Zod-validated envelopes — see `bridge/src/intents/` for scope validation, `bridge/src/mcp/tools/` for handlers, `bridge/src/auth/provider.ts` for OAuth.

Build-time, `bridge/scripts/inline-skills.mjs` and `inline-bless-list.mjs` inline plugin SKILLs and the bless-list into the bridge bundle (run via `prebuild`/`pretest`/`pretypecheck` hooks).

## Common commands

Root (runs across workspace):

```bash
pnpm build       # pnpm -r build
pnpm test        # pnpm -r test
pnpm lint        # pnpm -r lint
pnpm typecheck   # pnpm -r typecheck
```

Bridge (`cd bridge`):

```bash
npm run dev          # tsx watch
npm run build        # tsup → dist/index.js
npm run typecheck
npm run lint         # eslint; lint:fix for autofix
npm run test         # vitest watch
npm run test:run     # single run
npm run test:judge   # FINNY_LIVE_JUDGE_LOOP=1 vitest run src/__tests__/judgeLoop.test.ts
npm run check:all    # lint:fix + typecheck + test:run + build
```

Run a single bridge test: `cd bridge && npx vitest run path/to/file.test.ts` (or `-t "name"`).

Plugin package has no build/test — it's declarative.

## Conventions

- ESM with `.js` import extensions (required for ESM resolution).
- Strict TS (`tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`).
- Single quotes, semicolons, 2-space indent, 100 char width.
- Custom errors extend `HermesError`. Never leak stack traces or internal paths in MCP responses.
- Underscore prefix for unused vars (`_var`).

## Deploy notes (AWS)

- Caddy terminates TLS, logs to journald (no file log block in `Caddyfile`).
- `MCP_ALLOWED_HOSTS` env (DNS rebinding allowlist) is read by the bridge and passed to `createMcpExpressApp` — must be set in production.
- `WWW-Authenticate` includes `resource_metadata` per RFC 9728.
- OAuth: `AUTH_ENABLED=true`, `MCP_CLIENT_ID` and `MCP_CLIENT_SECRET` (generate with `openssl rand -hex 32`).
- See `docs/handoff/2026-05-24-finny-deploy-summary.html` for the most recent deploy state.

## Local dev loops

Hermes is **not vendored** in this repo — the bridge talks to it only over the OpenAI-compatible HTTP contract (`POST /v1/chat/completions` + Bearer `FINNY_UPSTREAM_TOKEN`). Pick the loop that matches the change:

| Loop | Setup | Use for |
|---|---|---|
| **Mocked** (default) | `cp bridge/.env.example bridge/.env`, then `npm run test:run` / `npm run dev`. Most tests already mock `HermesClient`. | Bridge logic, envelopes, intents, OAuth, MCP wiring, skills/hooks/monitors. ~95% of changes. |
| **Real upstream (sibling)** | Clone `NousResearch/hermes-agent` **next to** this repo (sibling dir, not nested, not a submodule). `python -m venv .venv && source .venv/bin/activate && pip install -e .` then `cd web && npm install && npm run build`. Run `hermes gateway start`. Set `OPENCLAW_URL=http://127.0.0.1:18789` in `bridge/.env`. Same install shape as prod (see `deploy/hermes-bootstrap.sh`). | Changing the gateway contract (new field, new error code) or repro'ing an agent-side bug. |
| **Staging EC2** | Push branch to origin, then on staging EC2 (`finny-staging`, tailnet `100.112.31.24`) via SSM: `git fetch && git checkout <branch> && pnpm install && pnpm -C bridge build && sudo systemctl restart finny-mcp && sudo -iu ubuntu systemctl --user restart hermes-gateway`. Smoke via the Hermes desktop app on the tailnet IP and via browser Claude cowork against `https://finny.staging.11mirror.com/mcp`. See `docs/staging/README.md`. | Verifying infra-shaped changes (systemd, Caddy, OAuth, profile env, NetSuite path) before merge. **Required for any change that touches non-mocked surfaces.** |
| **Staging tunnel (emergency only)** | `ssh -L 18789:127.0.0.1:8642 <ec2>` then point `OPENCLAW_URL=http://127.0.0.1:18789`. This is **prod** — prefer the Staging EC2 row above. | Last-resort verification when staging is being rebuilt. |

## Staging-to-prod promotion

Every change that touches non-mocked surfaces (systemd, Caddy, OAuth, env, NetSuite tooling, Hermes profile) **must** ride the staging tier before reaching prod. Read `docs/staging/README.md` for the long-form how-to.

### The 9-step flow

```
1. open feature branch in the relevant repo
2. push to origin, open PR                              ← reviewers see diff while staging test runs
3. CI runs mocked tests on PR (existing pnpm -r test)
4. on staging EC2 via SSM: git fetch && git checkout <branch> && build
5. restart staging units; smoke via desktop app + browser cowork
6. iterate until green; capture every non-git change in
   docs/staging/<branch-name>-changes.md, commit to the branch
7. PR contains: code diff + staging-changes manifest + green smoke
8. reviewer approves, merge to main                     ← reviewer rejects PRs missing manifest
9a. merge != deploy. Main is the "ready to deploy" pointer;
    no prod action triggered by merge.
9b. deploy = explicit operator decision. Run docs/staging/deploy-runbook.md:
    fast-forward `deployed` branch to main's tip, push, then on prod EC2
    git pull on `deployed`, walk the manifest's non-git steps, restart units.
    Can happen minutes, hours, or days after merge — and can batch
    multiple merged PRs into one deploy.
```

### The hard rule

**No prod deploy without `docs/staging/<branch-name>-changes.md` in the merged branch.** Empty content is fine ("No non-git changes — git merge + standard restart is sufficient.") but the file must exist. Reviewer enforcement is v1; CI gate captured as TODO. Why this rule exists: snapshot-from-prod staging is behind prod the moment prod merges, so non-git changes (env edits, systemd unit changes, `apt install`, Caddyfile edits) silently disappear between "worked on staging" and "deployed to prod" if not captured.

### Deployed-branch model

Prod tracks a protected `deployed` branch on each repo (`finny-claude-plugin`, `finny-hermes-config`, `finny-hermes`), not `main`. This decouples merge from deploy:

- **`main`** = blessed history; what's been reviewed, staging-tested, and approved. Moves on every PR merge.
- **`deployed`** = what's running in prod *right now*. Moves only when the operator runs the deploy runbook.
- **`git log deployed..main`** on any repo answers "what's pending deploy?"
- **Rollback** = revert `deployed` to a previous SHA + redeploy. No `git revert` PR needed.

Setup is one-time per repo (see `docs/staging/setup-deployed-branch.md`). Deploys after that follow `docs/staging/deploy-runbook.md`.

### Two-listener model

Staging exposes two surfaces, deliberately:

- **Public MCP** at `https://finny.staging.11mirror.com/mcp` (Caddy + TLS + staging OAuth client) — for browser Claude cowork end-to-end tests. Same shape as prod.
- **Tailnet dashboard** at `http://100.112.31.24:9119` (binds directly to tailnet IP, no Caddy in front) — for Hermes desktop-app chat. Tailscale is the trust boundary.

The full design is in `docs/superpowers/specs/2026-06-15-staging-architecture-design.md` (D1–D15 including the build-time addendum). Practical detail is in `docs/staging/README.md` and `docs/staging/snapshot-refresh-checklist.md`.

### Snapshot refresh

Staging is built from an OS snapshot of prod. Refresh ≤14 days, or before testing any branch >7 days old. Procedure: `docs/staging/snapshot-refresh-checklist.md`. The refresh procedure is itself a manifest replay — every Phase 2 edit captured there must run on every fresh staging box.

## When making changes

- Touching tool surface (adding/renaming a tool): update `bridge/src/mcp/tools/`, the bless-list (`bridge/src/intents/bless-list.json`), the auto-approve allowlist in `plugin/hooks/hooks.json`, and any relevant SKILL.md (`finny-usage`, `judging-output`).
- Touching skills: edit under `plugin/skills/<name>/SKILL.md`. Bridge's `prebuild` re-inlines them — rebuild the bridge to pick up changes that get bundled.
- Touching auth/transport: see `bridge/CLAUDE.md` for the security policy (Docker-first deploy, OAuth mandatory, input validation). **Always run through staging EC2 before merging — never ship infra-touching changes off the mocked-only loop.**
- Touching env / systemd / Caddy / Hermes profiles: required to staging-test, required to manifest. No exceptions.
