---
name: cowork-init
description: First-run initialization for the Lolly plugin. Forces mandatory-read of core skills (lolly-usage, intent-decomposer, judging-output), offers to enable the day_dream daily monitor, discloses the auto-approve hook, and writes a marker file. Idempotent — re-runs only on plugin version bump or explicit /lolly:cowork-init invocation. Triggers: first time using lolly tools, plugin onboarding, lolly setup, plugin first run, lolly install.
---

# cowork-init

First-run flow for the Lolly plugin. Runs once per workspace; idempotent on
re-runs (gated by a marker file at `.claude/lolly-plugin-initialized`).

## When this skill activates

- The first session per workspace where any `lolly_*` tool is about to be called,
  AND the marker file is absent or stale, OR
- Explicit invocation: `/lolly:cowork-init`.

## Flow

### Step 1 — Mandatory read

Before proceeding with any Lolly tool call, you MUST read these three skills in
order:

1. `lolly-usage` — when to call Lolly + which of the 4 public tools.
2. `intent-decomposer` — discover→AskUser→execute orchestration. The load-bearing
   one. Internalize the four iron rules.
3. `judging-output` — envelope handling, intent-drift detection, error-code
   branching, never-reformat rules.

Do NOT call any `lolly_*` tool until you've internalized all three.

### Step 2 — day_dream cron offer

AskUser:

> *"Do you want me to enable a daily 6 PM synthesis (`day_dream`)? It runs while
> cowork is active, summarizes the day's interactions with Lolly, and writes
> the synthesis back to Lolly's memory for 11mirror writeback."*

Three options:
1. **Yes, 6 PM local** — confirm the monitor in `monitors/monitors.json` is
   enabled. (It's enabled by default once the plugin loads — this is just
   acknowledgment.)
2. **Yes, custom time** — AskUser for `HH:MM` in 24-hour format, then write
   the user's choice into a session memory note for the day_dream skill to
   honor at runtime. (The monitor itself fires daily at 18:00; if the user
   wants a different time, day_dream skill skips when triggered outside the
   user's preferred hour.)
3. **No, skip for now** — set marker, never re-prompt this workspace until
   plugin version bumps. User can invoke `/lolly:cowork-init` again to revisit.

### Step 3 — Auto-approve disclosure

Print:

> *"This plugin auto-approves these 5 Lolly MCP tool calls (no per-call prompt):*
> *`lolly_query`, `lolly_report`, `lolly_task_status`, `lolly_continue`,*
> *`lolly_remember`. The bridge has its own destructive-intent guard.*
> *To revoke, disable the plugin in `/plugin`."*

### Step 4 — Write marker

Write `.claude/lolly-plugin-initialized` with this content:

```json
{
  "initialized_at": "<ISO-8601 timestamp>",
  "plugin_version": "<from .claude-plugin/plugin.json>",
  "day_dream_enabled": true,
  "day_dream_hour": 18
}
```

Use the `Write` tool to create the marker file. Set `day_dream_enabled: false`
if user chose "No, skip for now". Set `day_dream_hour` to the user's chosen
hour if they picked custom.

### Step 5 — Catch-up check (every session start, after init)

After init has run (this session or a previous one), check: "did day_dream run
yesterday?" Look for a tag `day_dream/<YYYY-MM-DD>` in cowork's session memory
or by querying Lolly briefly. If not, AskUser:

> *"Yesterday's day_dream didn't run. Want to run it now?"*

If yes, invoke `/lolly:day_dream YYYY-MM-DD` (the previous date).

### Step 6 — Re-init on version bump

If marker `plugin_version` < current `plugin.json` version, re-run the full init
flow. This lets us add new mandatory-read skills in `0.2.0+` without operator
action.

When re-running on version bump, SKIP the day_dream cron offer if the marker
shows it was previously answered (yes or no). Don't re-ask choices the user
already made.

## No bridge changes

All cowork-side. Marker lives in the user's `.claude/` directory.

## Cross-references

- `lolly-usage`, `intent-decomposer`, `judging-output` — the mandatory-read skills.
- `day_dream` — the skill the cron schedules.
