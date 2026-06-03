# Finny Hermes-side `cowork-mcp-client` Skill — Design Spec

**Date:** 2026-06-03
**Status:** Draft for review
**Owner:** Finny plugin maintainers (hand-off artifact for Finny / Hermes side)
**Target version:** `v1.0.0`

## Problem

Finny (a Hermes ERP agent) is exposed to a smarter client agent (Claude
cowork) via the MCP bridge in this repo. The bridge enforces a strict
envelope contract, async-by-default semantics, progress streaming via an
internal `finny_progress` tool, and a `needs_input` clarification loop.

On the **client** side (cowork), three skills already codify the contract:
`finny-usage`, `intent-decomposer`, `judging-output`. They tell the client
*how to call* Finny.

There is **no equivalent artifact on the Hermes side** that tells Finny:

- "You are a brain attached as an MCP tool to a smarter agentic client."
- What each of the 5 client-facing tools is asking for.
- The envelope invariants she must honor on the way back.
- That she must emit `finny_progress` at stage boundaries so the frontend
  doesn't show a dead spinner / time out.
- That she should bias toward `needs_input` over guessing.
- That she must invoke her existing reflection skill at session end.

Without this, Finny risks:

- Inlining greetings / preambles into envelopes (breaks `judging-output`).
- Skipping progress emission → frontend shows nothing for 60s → user
  bails or the platform times out.
- Silently guessing scope → intent drift → forced retry → wasted tokens.
- Double-applying sign conventions or reformatting numbers.
- Not learning across sessions because reflection isn't triggered.

## Goal

Author a single Hermes-side skill, `cowork-mcp-client`, that loads when
Finny is invoked via the MCP bridge and codifies her role, contract, and
session lifecycle. Reference it from Finny's `AGENTS.md` so it's
discoverable but lazy-loaded (not always-on context bloat).

## Non-goals

- Re-specifying the envelope schema (already in `bridge/src/types/`).
- Re-specifying the bless-list or intent contract (already in
  `bridge/src/intents/`).
- Replacing or duplicating Finny's existing reflection skill — this skill
  only *triggers* it.
- Generic "any Hermes agent as MCP brain" abstraction — explicitly
  Finny-specific (per brainstorm decision).

## Scope decision (from brainstorm)

- **Format:** Hermes skill + one-line `AGENTS.md` reference. Not
  `resolver.md`, not inline.
- **Progress cadence:** stage-gated, ~3–6 emits per long query.
- **Clarification policy:** bias toward asking via `needs_input`.
- **Scope:** Finny-specific (knows the 5 tools, NetSuite quirks,
  4 blessed intents).
- **Reflection:** mandatory at session end, defers to Finny's existing
  internal reflect skill.

## Design

### Artifact layout

Delivered in this repo under `hermes-handoff/` for handoff to Finny:

```
hermes-handoff/
  README.md                                    # what this folder is
  cowork-mcp-client/
    CHANGELOG.md                               # semver history
    v1.0.0/
      SKILL.md                                 # the skill body itself
      AGENTS-md-snippet.md                     # ref line + install steps
```

Versioning: semver per skill. Each version is a frozen folder so Finny
can install a specific version and we can iterate without ambiguity.

### Skill frontmatter

```yaml
---
name: cowork-mcp-client
version: 1.0.0
description: >
  Activates when Finny is invoked via the MCP bridge from a client cowork
  agent. Owns the envelope contract, progress streaming via finny_progress,
  the needs_input clarification loop, the brain-as-MCP role boundary, and
  end-of-session reflection trigger.
triggers:
  - cowork
  - mcp client
  - finny_query
  - finny_report
  - finny_continue
  - finny_task_status
  - finny_remember
  - envelope
  - bridge invocation
---
```

### Section outline (target ~1500 words)

1. **Role: brain attached as MCP** (~150w)
   - You are a data brain attached as MCP to a smarter agentic client.
   - Client owns user-facing voice; you own data fidelity.
   - No greetings, summaries, or "based on what I found…" preambles.
   - You return envelopes; the client renders them.

2. **The 5 tools — what's expected** (~250w)
   - `finny_query` (90% tool, intent-driven discover→execute)
   - `finny_report` (registered reports, canned preamble)
   - `finny_task_status` (poll handle for `running` envelopes)
   - `finny_continue` (resume after `needs_input`)
   - `finny_remember` (persist a fact for next session)
   - For each: what the client is asking, what envelope shape to return.

3. **Envelope contract — invariants** (~200w)
   - Always return the canonical envelope.
   - Always set `intent_restated` (the judge checks for drift).
   - Never inline reasoning into `data.rendered_markdown`.
   - Sign conventions applied **once** (sandbox vs prod handled in bridge).
   - Five `status` values: `ok`, `partial`, `running`, `refused`, `error`,
     plus `needs_input`. When to use each.

4. **Progress emission — `finny_progress`** (~200w)
   - **Mandatory** for any execute phase expected to take >5s.
   - Stage-gated cadence: phase boundaries only.
   - Examples: "resolving entity", "querying NetSuite",
     "applying sign conventions", "composing answer".
   - 3–6 emits per query. Strings ≤80 chars, present tense, user-readable.
   - Bridge intercepts these server-side and writes to the task record so
     the client's frontend can show "Finny is querying NetSuite…" instead
     of a dead spinner.
   - Without progress emits, the platform's idle detector may time the
     session out before Finny finishes.

5. **`needs_input` loop — bias toward asking** (~200w)
   - When scope is ambiguous (entity, period, consolidated y/n, env),
     emit `status: needs_input` with a focused question and (when finite)
     numbered options.
   - Asking 30s is cheaper than executing the wrong scope (60s + retry).
   - Brain hints inform *what to ask about*, not *what to assume*.
   - Client will call `finny_continue({conversation_id, response})` —
     resume from there, do **not** re-discover.

6. **Long-running tasks — `running` status** (~150w)
   - If `deadline_ms` will be exceeded, return `running` with `task_id`
     early. Don't try to fit everything in the wait window.
   - Keep emitting `finny_progress` while the task runs.
   - Client polls `finny_task_status` with progressive backoff up to ~5min.
   - Bridge bounds task lifetime at 300s — terminate cleanly before that.

7. **Dos and don'ts** (~200w)
   - DO: restate intent verbatim-ish in `intent_restated`. Emit progress
     at each stage. Ask via `needs_input` when uncertain. Apply sign
     conventions exactly once. Refuse destructive verbs explicitly via
     `status: refused`.
   - DON'T: greet, summarize, add preambles. Reformat numbers (no
     currency symbols, no rounding). Retry on `refused`. Leak internal
     reasoning into rendered markdown. Silently switch `env` from
     production to sandbox.

8. **Failure modes & error codes** (~150w)
   - Map common failures to `error.code`:
     `entity_not_found`, `period_invalid`, `permission_denied`,
     `upstream_timeout`, `other` (escape valve with `confidence_reason`).
   - Surface real errors via `status: error`; don't swallow.

9. **Session-end reflection** (~200w)
   - At the end of every MCP-invoked session, invoke Finny's existing
     internal `reflect` skill / tool to capture learnings.
   - **Triggers on terminal envelope statuses:** `ok`, `partial`,
     `refused`, `error`. Does **not** fire on `running` or `needs_input`
     (those aren't session-end).
   - For multi-turn `needs_input` → `finny_continue` flows, reflection
     fires once after the final terminal envelope of the chain.
   - What to capture (defer to the internal reflect skill for *how*):
     ambiguous intents, brain hints that proved useful (or misleading),
     clarifications the client had to ask twice, scope patterns worth
     memoizing for next time, sign-convention edge cases.
   - Reflection is **not optional**. It's how Finny gets smarter across
     sessions and how the cowork plugin's day-dream cron has anything to
     consolidate.

### `AGENTS.md` reference (one line)

> When invoked via the MCP bridge (any of `finny_query`, `finny_report`,
> `finny_task_status`, `finny_continue`, `finny_remember`), load the
> `cowork-mcp-client` skill before responding.

## Versioning policy

- **Semver per skill.** `v1.0.0` is initial release.
- New folder per version (`v1.1.0/`, `v2.0.0/`, …). Old versions kept.
- `CHANGELOG.md` at the skill root tracks changes.
- Spec docs are dated (`YYYY-MM-DD-…`) and accumulate in
  `docs/superpowers/specs/`. Each material change to the skill gets a new
  spec doc, not edits to the old one.

### Bump rules

- **Patch** (`v1.0.x`): wording fixes, clarifications, no contract change.
- **Minor** (`v1.x.0`): new sections, new dos/don'ts, new error codes,
  additive only. Finny can upgrade in place.
- **Major** (`vx.0.0`): contract changes that require Finny to behave
  differently (e.g., new mandatory emit, removed status value). Coordinated
  with a bridge release.

## Risks

- **Finny ignores the skill.** Mitigated by trigger keywords and the
  `AGENTS.md` reference, but ultimately depends on Finny's loader honoring
  trigger-based activation. Verify on first deploy.
- **Reflection skill name mismatch.** This spec assumes Finny has an
  internal skill she already invokes for memory writeback. If the actual
  skill is named differently (`reflect`, `consolidate-learnings`,
  `session-end`), the v1.0.0 SKILL.md may need a one-line update — patch
  bump to `v1.0.1`.
- **Progress emit cadence too low / too high.** 3–6 was chosen by judgment.
  If frontend telemetry shows users still bail at 30s, bump cadence in
  `v1.1.0`.

## Acceptance

- Spec doc committed at
  `docs/superpowers/specs/2026-06-03-finny-cowork-mcp-client-skill-design.md`.
- Handoff folder `hermes-handoff/cowork-mcp-client/v1.0.0/` contains
  `SKILL.md`, `AGENTS-md-snippet.md`.
- `hermes-handoff/cowork-mcp-client/CHANGELOG.md` has a `v1.0.0` entry.
- `hermes-handoff/README.md` explains the folder's purpose.
- All committed on a feature branch and pushed (after user approval).

## Next steps after handoff

1. User hands `v1.0.0/SKILL.md` + `AGENTS-md-snippet.md` to Finny.
2. Finny installs as a skill in her Hermes skill directory and updates
   her `AGENTS.md`.
3. Smoke test: run a real cowork → Finny query, verify progress emits land
   in the task record, verify reflection fires on session end.
4. If telemetry surfaces issues, bump version per the rules above.
