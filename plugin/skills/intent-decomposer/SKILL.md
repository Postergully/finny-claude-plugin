---
name: intent-decomposer
description: Owns the discover→AskUser→execute orchestration for any Lolly question. Activates immediately after lolly-usage selects lolly_query. Internalizes (never displays) discovery envelopes; biases toward asking the user when scope is ambiguous; gates first-call invented intents. Triggers: lolly question, NetSuite question, ShareChat data question, P&L, vendor balance, open bills, finance command, intent decomposition.
---

# intent-decomposer

This is the load-bearing skill of the Lolly plugin. Its job is to drive
`lolly_query` through its two phases (`discover`, then `execute`) deterministically,
without leaking discovery output to the user, and without silent-guessing on
ambiguous scope.

## When this skill activates

Right after `lolly-usage` decides the answer is `lolly_query` (the 90% tool).
Does NOT activate for `lolly_report` (registered reports skip discover) or
`lolly_task_status`. Does NOT activate for free-form `lolly_query({question})`
calls — only the intent-driven path.

## The four iron rules

### Rule 1 — INTERNALIZE, NEVER DISPLAY

The discover envelope is your working memory. It is **NOT** user-facing text.

You parse:
- The required variable list (e.g., `entity`, `period`, `consolidated`, `env`).
- The brain hints (e.g., "193 GL accounts mapped", "March 2026 ₹208 Cr anomaly").
- The example clarifying questions Lolly suggests.

You **never**:
- Paste the discover narrative.
- Paraphrase it as "here's what Lolly came back with."
- Quote the GL-account counts, anomaly flags, or any internal-reasoning-shaped content.
- Show "based on what Lolly told me, I think we need…" preambles. **The preamble is the same failure mode dressed up.**

If the discover envelope's content appears in your output to the user, you have failed.

### Rule 2 — WHEN IN DOUBT, ASK

If any variable in the resolved scope is ambiguous, missing, or below
"high confidence" — **use AskUser**.

A 30-second clarifying question beats a 30–60 second wrong-scope execute round-trip
plus a full re-discover cycle. **Asking is always cheaper than guessing.**

Bias toward asking. Don't try to be clever and infer from context. Don't use brain
hints from the discover envelope as silent justification for a guess. The brain
hints inform *what to ask about*, not *what to assume*.

### Rule 3 — PARAPHRASE INTO COWORK VOICE

Lolly's example clarifying questions are technical (NetSuite-y). Use them as
reference, not verbatim.

**Default behavior** (open-string intents):
- Combine related questions into one (e.g., "which entity AND which period" instead
  of two separate prompts).
- Drop NetSuite jargon (say "subsidiary" not "MTPL/MAS subsidiary entity").
- Lead with the most decision-critical variable.

**Per-intent overrides** (the 4 blessed intents — `p&l_statement`, `vendor_balance`,
`open_bills`, `bill_detail`): use the polished question templates below.

### Rule 4 — PERMISSION-GATE INVENTED INTENTS

The first time per session you invent an open-string intent (anything not in the
bless-list), AskUser to confirm:

> "I'd like to ask Lolly about `<intent_id>`. Proceed?"

Cache the approval in session memory keyed by `intent_id`. Subsequent calls with the
same intent in the same session skip the prompt. Bless-list intents skip this check
entirely.

## Canonical flow

```
User: "give me P&L"
  │
  ▼
[lolly-usage decides: lolly_query, intent='p&l_statement']
  │
  ▼
[intent-decomposer takes over]
  │
  ▼
1. Show user: "Pulling scope info from Lolly (~30-60s)…"
   Call lolly_query({phase: 'discover', intent: 'p&l_statement', user_question: 'give me P&L'})
  │
  ▼
2. Receive discover envelope. INTERNALIZE.
   Parse: required_variables = [entity, period, consolidated, env]
          example_questions = [...]
          brain_hints = [...]   (do NOT show)
  │
  ▼
3. For each variable, decide: do I have a high-confidence value from context?
   - YES (e.g., user explicitly said "ShareChat standalone") → use it,
     log to clarifications_resolved.
   - NO/MAYBE → AskUser (paraphrased per Rule 3, biased toward asking
     per Rule 2).
  │
  ▼
4. Once all variables resolved, call lolly_query({
     phase: 'execute',
     intent: 'p&l_statement',
     scope: { entity: 'sharechat', period: 'fy2026-q1', consolidated: false, env: 'production' },
     clarifications_resolved: [
       'entity: asked → ShareChat standalone',
       'period: asked → current quarter',
       'consolidated: defaulted false (matches user phrasing)',
       'env: defaulted production'
     ]
   })
  │
  ▼
5. Hand resulting envelope to judging-output skill.
```

## Wrong vs right examples

### Example 1 — Discovery output leak

❌ **Wrong (visible UX leak):**

> User: "give me P&L"
>
> [Calls discover, then renders to user:]
>
> *"Here's what Lolly returned for discovery. Variables Lolly needs: entity,
> period, consolidated, env. Brain hints: 193 GL accounts mapped, March 2026
> ₹208 Cr anomaly. Lolly suggests these clarifying questions: 1) Which
> subsidiary? 2) What period?…"*

✅ **Right (smooth handoff):**

> User: "give me P&L"
>
> [Status: "Pulling scope info from Lolly (~30-60s)…"]
>
> [Calls discover silently. Reads the narrative. Uses AskUser:]
>
> *"Quick check before I pull the P&L — which entity (ShareChat standalone, MTPL,
> or consolidated) and which period (April, current quarter, or full FY)?"*
>
> [User answers. Calls lolly_query phase:execute with full scope. Returns the
> actual P&L envelope via judging-output.]

### Example 2 — Preamble = same leak

❌ **Wrong:**

> *"Based on what Lolly told me, I think we need to know which entity and period.
> Let me ask: …"*

✅ **Right:** AskUser directly. No "based on what Lolly told me" framing. The user
doesn't need to know discover happened.

### Example 3 — Silent guessing on brain hints

❌ **Wrong:**

> Decomposer reads brain hint "March 2026 anomaly" in the discover envelope.
> Assumes user wants March. Calls execute with `period: '2026-03'`. Returns
> wrong P&L. User has to retry.

✅ **Right:**

> Decomposer sees no period in user question. The brain hint about March
> tells it *to ask about period*, not to assume March.
>
> AskUser: *"Which period — April, current quarter, or full FY?"*
>
> Asking costs 30s. Guessing wrong costs 60s+ and a misleading answer.

## Per-intent question templates (blessed intents)

For these 4 intents, use the polished templates below. The templates are
designed to combine related variables into one AskUser prompt.

### `p&l_statement`

Required variables: `entity`, `period`, `consolidated`, `env`.

Template:

> *"Which entity ({entity_options}) and which period ({period_options})? Default
> assumption: standalone (not consolidated), production env."*

`entity_options` from discover hints, typically: `ShareChat standalone | MTPL | consolidated`.
`period_options`: typically: `April | current quarter | full FY | custom range`.

If user phrasing implies consolidated (e.g., "group P&L"), set `consolidated: true`
without asking.

### `vendor_balance`

Required variables: `vendor`, `env`.

Template:

> *"Which vendor (name, GSTIN, or NetSuite ID)? I'll check production by default."*

If discover envelope's `unanswered[]` flags multiple vendors with the same name,
defer to `judging-output`'s `needs_input` handler — Lolly will ask back via
`lolly_continue`.

### `open_bills`

Required variables: `vendor` (optional — empty means all vendors), `env`,
`as_of_date` (optional — defaults to today).

Template:

> *"Open bills as of when, and for which vendor (or all vendors)?"*

Common shortcut: if user says "today" or doesn't specify, default `as_of_date`
to today and skip that part of the question.

### `bill_detail`

Required variables: `bill_id` OR (`vendor` + `bill_number`), `env`.

Template:

> *"Which bill — by NetSuite ID, or by vendor + bill number?"*

If user already named both a vendor and a bill number, use them; only AskUser if
neither is present.

## Default paraphrase rules (open-string intents)

For intents NOT in the blessed set, you don't have a polished template. Apply
these rules to Lolly's example clarifying questions:

1. **Combine related variables** into one AskUser prompt. Two questions about
   "which entity" and "which subsidiary" become one question.
2. **Drop NetSuite-specific jargon.** Say "subsidiary" not "consolidation level."
   Say "vendor" not "vendor record."
3. **Lead with the decision-critical variable.** If choosing the period
   determines what entity options are valid, ask period first.
4. **Don't include the example wording verbatim** — Lolly's phrasing is for
   your reference, not the user's eyes.

## Edge cases

| Case | Decomposer behavior |
|---|---|
| Discover returns `error.code` (not narrative) | Hand to `judging-output` error branch. Do NOT retry execute. |
| Discover returns `status: 'refused'` (e.g., destructive guard fires) | Surface refusal reason via `judging-output`. Do NOT retry. |
| User answers "I don't know" or "you decide" | Call execute with explicit `assumed_<var>: true` flag in scope; ensure `judging-output` surfaces those assumptions. |
| User answers ambiguously ("the usual one") | AskUser again with explicit options. Cap at 3 AskUser rounds, then fall back to "I need more info to proceed" — do NOT execute on guesses. |
| Execute returns `status: 'needs_input'` | Pass to `judging-output`'s needs_input handler (already implemented). Decomposer's job is done. |
| Execute returns `error.code: 'wrong_tool'` (scope incomplete) | Hand to `judging-output`, which loops back to discover. Decomposer re-runs from step 1 with new scope context. |

## Permission-gate cache (Rule 4)

Track invented intents per session. Pseudocode:

```
session_approved_intents: Set<string> = empty

before calling lolly_query with intent X where X not in bless-list:
  if X not in session_approved_intents:
    AskUser("I'd like to ask Lolly about '" + X + "'. Proceed? (yes/no)")
    if yes:
      session_approved_intents.add(X)
    else:
      abort the call; tell user "OK, skipping."
```

Cache is session-scoped. Restart of cowork session resets the cache — that's
acceptable; sessions are the user's natural unit of trust.

## Cross-references

- `lolly-usage` — picks the tool BEFORE this skill activates. If lolly-usage
  picks `lolly_report`, this skill does NOT run.
- `judging-output` — runs AFTER this skill. Owns envelope handling,
  intent-drift detection, error-code branching, never-reformat rules.

Every Lolly call: `lolly-usage` → `intent-decomposer` (this skill) → tool
invocation → `judging-output` → user.
