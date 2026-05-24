# Lolly Plugin for Claude Code

Cowork-side discipline plugin for the Lolly NetSuite agent. Enforces:

- **Two-phase discovery flow** — cowork internalizes discovery envelopes (never displays them) via the load-bearing `intent-decomposer` skill.
- **Bias toward asking** — if any scope variable is ambiguous, AskUser. A 30-second clarifying question beats a 30-minute wrong-scope round trip.
- **Auto-approved tool calls** — the 5 public Lolly MCP tools are pre-approved at install time (no per-call permission prompts).
- **Daily synthesis** — opt-in `day_dream` cron at 6 PM that writes a digest of the day's Lolly interactions back to her memory for 11mirror writeback.

## Install

The Lolly plugin has two install steps for **browser cowork** (Claude.ai). Local Claude Code (CLI) only needs step 1.

### Step 1 — Install the plugin (skills, hooks, monitors)

In Claude Code or Claude.ai:

```
/plugin marketplace add Postergully/lolly-claude-plugin
/plugin install lolly@postergully-lolly-claude-plugin
```

Requires `gh` auth on your machine for the private repo. This installs:

- 7 skills (`cowork-init`, `lolly-usage`, `intent-decomposer`, `judging-output`, `day_dream`, `finance/*`)
- `SessionStart` hook for first-run init
- `PreToolUse` auto-approve for the 5 public Lolly tools
- Daily 6 PM `day_dream` monitor

The first time the plugin loads in a workspace, the `SessionStart` hook fires and prompts the planner to read `cowork-init`, which:
1. Reads `lolly-usage`, `intent-decomposer`, `judging-output`.
2. Asks whether to enable the daily `day_dream` synthesis monitor.
3. Discloses the auto-approve hook behavior.
4. Writes `.claude/lolly-plugin-initialized` marker (idempotent on subsequent sessions).

### Step 2 — Wire up the MCP bridge (browser cowork only)

Browser cowork needs a Custom Connector to reach Lolly's MCP bridge. The plugin's `.mcp.json` only auto-spawns for **local Claude Code (CLI)**. Browser cowork runs in anthropic.com and cannot spawn local processes — it needs an HTTPS endpoint.

In Claude.ai → Settings → Custom connectors → Add new:

- **URL**: `https://<your-public-bridge-host>/mcp` — your operator-specific HTTPS endpoint (e.g., ngrok tunnel or a public reverse proxy in front of the bridge on `:3000`).
- **OAuth Client ID**: `security find-generic-password -a "$USER" -s lolly-mcp-oauth-id -w` (paste the value, don't print).
- **OAuth Client Secret**: `security find-generic-password -a "$USER" -s lolly-mcp-oauth-secret -w` (same).

Click Connect. After OAuth completes, you should see 5 Lolly tools (`lolly_query`, `lolly_report`, `lolly_task_status`, `lolly_continue`, `lolly_remember`) in the tool picker.

> **Why two steps?** Plugin marketplaces handle declarative content (skills, hooks, monitors). MCP transport (HTTP/SSE) is configured separately because browser cowork can't spawn local processes. The two are intentionally decoupled. Same pattern as the [11mirror plugin](https://github.com/Postergully/11mirror-plugin), which uses `claude plugins add` for cowork (HTTPS gateway) and `.mcp.json` for Claude Code (local stdio).

### Step 1 only — local CLI install (alternative)

For development on the same machine as the bridge:

```bash
claude --plugin-dir /path/to/lolly-claude-plugin/plugin
```

The plugin's `.mcp.json` auto-spawns the bridge from stdio. No Custom Connector needed.

## What's in the plugin

| Skill | Purpose |
|---|---|
| `cowork-init` | First-run flow: mandatory-read, day_dream cron offer, marker file |
| `lolly-usage` | When to call Lolly + which of the 4 public tools to use |
| `intent-decomposer` | Load-bearing: discover→AskUser→execute orchestration |
| `judging-output` | Envelope handling, intent-drift detection, error-code branching |
| `day_dream` | Daily synthesis flow (cron-triggered or manual) |
| `finance/income-statement` | `/lolly:finance:income-statement` slash command |
| `finance/reconciliation` | `/lolly:finance:reconciliation` slash command |
| `finance/audit-netsuite` | `/lolly:finance:audit-netsuite` slash command |
| `finance/variance-analysis` | `/lolly:finance:variance-analysis` slash command |

| Component | Purpose |
|---|---|
| `.mcp.json` | Stdio config for the Lolly bridge |
| `hooks/hooks.json` | `PreToolUse` auto-approve for the 5 public Lolly tools |
| `monitors/monitors.json` | Daily 6 PM trigger for `day_dream` |

## Auto-approve hook

The plugin ships a `PreToolUse` hook that auto-allows these 5 tools (explicit allowlist, no wildcard):

- `mcp__lolly__lolly_query`
- `mcp__lolly__lolly_report`
- `mcp__lolly__lolly_task_status`
- `mcp__lolly__lolly_continue`
- `mcp__lolly__lolly_remember`

To revoke: disable the plugin in `/plugin`. New tools added to the bridge in the future will require a plugin update before they auto-approve.

## Remote OAuth install (alternative)

For running Lolly on one machine and driving from cowork in the browser, see the bridge README at `../bridge/README.md` for the OAuth + ngrok setup. The plugin manifest above takes precedence for marketplace installs; the remote OAuth path is for users connecting via cowork custom connectors instead.

## Spec & rationale

See `docs/superpowers/specs/2026-05-15-cowork-plugin-design.md` in the workspace repo for the full design rationale, red-team analysis, and decision log.
