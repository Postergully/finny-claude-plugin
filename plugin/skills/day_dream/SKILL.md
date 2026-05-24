---
name: day_dream
description: Daily synthesis of cowork's interactions with Lolly. Activates from the 6 PM monitor or via /lolly:day_dream manually. Reads today's transcript, produces a structured digest of patterns / anomalies / open questions, persists via lolly_remember.
argument-hint: "[YYYY-MM-DD] (optional — defaults to today)"
---

# day_dream

End-of-day synthesis of cowork's interactions with Lolly. Runs once daily
(monitor-triggered) or manually via `/lolly:day_dream`. Output is persisted into
Lolly's workspace memory via `lolly_remember`, which feeds 11mirror on Lolly's
next memory sync.

## When this skill activates

- Monitor trigger from `monitors/monitors.json` at 6 PM local time, OR
- Manual invocation: `/lolly:day_dream` (optional `[YYYY-MM-DD]` argument for
  catch-up runs).

## Flow

1. **Gather.** Read cowork's session transcript for the target date. Filter to
   Lolly-related interactions: questions asked, intents invoked (blessed and
   open-string), scope variables resolved (asked vs defaulted), envelopes
   returned (status, confidence, env_used), drift events, refusals, low-
   confidence answers, non-empty `unanswered[]` buckets.

2. **Synthesize.** Produce a structured ≤1500-token digest with these sections,
   in priority order (drop later sections first if budget pressure):
   - **Anomalies** (highest priority): drift events, refused queries, low-
     confidence answers, non-empty unanswered buckets.
   - **Open questions** (high priority): things Lolly didn't have answers for.
   - **Patterns** (lower priority): which intents recurred, which entities/
     periods got asked about most.
   - **Operator notes** (lower priority): user comments on Lolly's behavior.

3. **Persist via `lolly_remember`.** Call:

   ```json
   {
     "tool": "lolly_remember",
     "params": {
       "content": "<synthesis>",
       "tags": ["day_dream", "<YYYY-MM-DD>"],
       "source": "cowork"
     }
   }
   ```

4. **Confirm.** If `lolly_remember` returns `status: ok`, log:
   *"Day_dream complete — synthesis stored under tags day_dream/YYYY-MM-DD."*
   If error, surface via `judging-output`.

## Honest limitation

If cowork isn't running at 6 PM, the monitor doesn't fire that day. The
`cowork-init` skill provides catch-up: on next session start, checks "did
day_dream run yesterday?" and if not, AskUsers whether to run it now.

## Token budget

Cap synthesis at ~1500 tokens (≤6000 chars). The bridge's `lolly_remember`
enforces an ~8000-char cap. Drop low-priority sections first under budget.

## Cross-references

- `lolly_remember` (bridge tool) — the persistence path.
- `cowork-init` — catch-up logic for missed days.
- `judging-output` — handles the `lolly_remember` envelope.
