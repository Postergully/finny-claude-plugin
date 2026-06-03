# AGENTS.md snippet — install instructions

Add the following line to Finny's `AGENTS.md` (or the equivalent
always-on instructions file in her Hermes skill setup):

```markdown
## MCP bridge invocations

When invoked via the MCP bridge — i.e. any of the client-facing tools
`finny_query`, `finny_report`, `finny_task_status`, `finny_continue`,
`finny_remember` — load the `cowork-mcp-client` skill before responding.
That skill defines the envelope contract, progress streaming via
`finny_progress`, the `needs_input` clarification loop, and the
mandatory session-end reflection trigger.
```

## Where to put `SKILL.md`

Drop the `v1.0.0/SKILL.md` from this folder into Finny's Hermes skill
directory (wherever the existing skills live, e.g. `skills/` or
`hermes/skills/`). The trigger keywords in the frontmatter handle
activation — no further wiring needed beyond the AGENTS.md line above.

## Verification after install

1. Issue a real cowork query that's expected to take >5s (e.g. a
   `vendor_summary` report or a multi-subsidiary P&L).
2. Confirm `finny_progress` strings appear in the bridge's task record
   (check `taskManager` logs in the bridge for `[finny_progress]
   task=… text="…"` lines).
3. Confirm a `needs_input` envelope is emitted when scope is ambiguous
   (e.g. ask "what's the open balance?" with no vendor named).
4. Confirm reflection fires at session end — check Finny's memory layer
   for a new entry tagged with the session id.

If any of those four don't happen, the skill isn't activating. Most
likely cause: trigger keywords in the frontmatter aren't being matched
by Finny's loader. Patch by adding the relevant keyword and bumping to
`v1.0.1`.

## Reflection skill name

This skill assumes Finny has an internal skill or tool she invokes for
session-end memory writeback. The skill body refers to it generically as
"your internal reflect skill". If the actual skill is named something
else (e.g. `consolidate-learnings`, `session-end-reflection`), update
§9 of `SKILL.md` to use the correct name and bump to `v1.0.1`.
