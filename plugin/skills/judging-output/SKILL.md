---
name: judging-output
description: Read the envelope returned by any finny_* tool and decide whether to trust, retry, or surface to the user. Activates after every finny_* tool call.
---

# judging-output

Every `finny_*` tool returns an envelope. **Every** envelope — success,
partial, running, refused, or error — MUST pass through this judge before
the user sees anything. This skill owns intent-drift detection, the running
poll loop, the exhaustive `error.code` branch (including the `'other'`
escape valve), and the never-reformat rules.

## The judge loop

### Step 1 — Intent check (drift detection)

Compare `intent_restated` against the user's original question. Ask: is this
a faithful restatement of what the user asked?

- **Faithful** → proceed to Step 2.
- **Drifted** → retry ONCE with a sharper, more explicit question. After
  that one retry, surface drift to the user with the original question and
  Finny's restatement side-by-side. Do not silently re-render.

Intent-drift detection is this skill's job — `finny-usage` picks the tool,
this skill validates the answer means what the user asked.

### Step 2 — Status branch

| `status` | action |
| --- | --- |
| `ok` | render as-is (subject to confidence check below) |
| `partial` | render what's there AND surface `unanswered[]` |
| `running` | poll via `finny_task_status({task_id})` — see loop rules below |
| `refused` | surface `confidence_reason` as the refusal. Do NOT retry |
| `error` | branch on `error.code` — see Step 3 |
| `needs_input` | Finny is asking back; render `needs_input.question` + `needs_input.options[]` (numbered if present); collect user response; call `finny_continue({conversation_id, response})` — see "needs_input loop" rules below |

### Running envelope — how to poll

When `status === 'running'`, read the `task_id` from either the top-level
`task_id` field OR `data.value` — they are the same string. Do NOT parse
`data.rendered_markdown`; it's a debugging JSON blob (`{task_id,
deadline_exceeded_ms}`), not the poll handle.

Poll cadence: progressive backoff. Cap: 6 polls (~95 s of waits). The
bridge's 300s `awaitTaskOrEscalate` deadline still bounds task lifetime
from above.

Schedule (cumulative wait time per poll):

| Poll # | Wait before this poll | Cumulative |
|---|---|---|
| 1 | 5 s | 5 s |
| 2 | 5 s | 10 s |
| 3 | 10 s | 20 s |
| 4 | 15 s | 35 s |
| 5 | 30 s | 65 s |
| 6 | 30 s | 95 s |

After 6 polls (~95 s of waits, plus query time), if still `running`,
stop and surface to the user: "Finny is still working on this — the
query is unusually slow. Two options: (1) **wait longer** — Finny may
finish in another minute; (2) **narrow the scope** — specify a single
subsidiary (e.g., MTPL standalone) which usually speeds it up
significantly." Frame option 1 as "wait longer", NOT "try again with
a longer deadline" — the user shouldn't think they need to re-issue
the query; the bridge keeps working until its 300s deadline.

Real Finny latencies (measured 2026-05-14/15, n=4 chains):
- p50 ≈ 149 s
- p90 ≈ 183 s

The 6-poll backoff covers p90 + headroom on the new 30s default
deadline_ms.

Each poll return goes through this skill again from Step 1 — a `running`
poll can return `ok`, `partial`, `refused`, or `error` just like the
initial call.

### needs_input — how to resume

When `status === 'needs_input'`, Finny is asking cowork to clarify
something her resolved scope didn't cover (e.g., three vendors named
"Acme"). Read `needs_input`:

- `question` — the clarification Finny needs answered. Render verbatim.
- `options` (optional) — finite-set choices. If present, render as a
  numbered list and let the user pick by number, surfacing the option
  `id` to the user only on debug; the user-facing label is `label`.
- `conversation_id` — opaque token. Do NOT show it to the user. Pass it
  back unchanged on the finny_continue call.
- `round` — clarification turn (1-indexed). Cap is 3.

Resume by calling:

```json
finny_continue({
  "conversation_id": "<from needs_input>",
  "response": {
    // pick ONE:
    "selected_option": "<id from options[]>",
    "answer": "<free-form user reply>"
  }
})
```

The bridge re-injects the original intent + scope + your new
clarification and re-runs execute. The return goes through this skill
again from Step 1 — a continue can return `ok`, `partial`, `refused`,
`error`, or another `needs_input` (up to the 3-round cap, after which
the bridge returns `partial` with `unanswered[]` describing the loop).

If finny_continue returns `error.code: 'gateway_rejected'` with a
message about an "unknown or expired conversation_id", the in-memory
conversation has aged out (30-min idle eviction) or the bridge
restarted. Restart from a fresh `finny_query` call — do NOT retry
finny_continue.

### Step 3 — `error.code` branch (exhaustive)

Nine codes. Branch explicitly on each — no fallthrough, no "default retry":

- **`envelope_parse_failed`** — the bridge tried twice to parse Finny's
  output as an envelope and failed both times. Infra-ish. Retry ONCE with
  a simpler/more direct question. If it fails again, surface "Finny had
  trouble structuring the response" with the `error.message` verbatim.
- **`gateway_rejected`** — 4xx from the Hermes gateway. Usually not
  user-retryable. Surface `error.message`.
- **`gateway_unreachable`** — network/connectivity. Tell the user to retry
  in a few minutes.
- **`timeout`** — rare on the public surface; async tools return `running`
  instead. Offer to rephrase the question as a `finny_query` so the async
  path can absorb the wait.
- **`unauthorized`** — gateway token revoked or expired. Surface — this
  requires user action, not an automatic retry.
- **`refused`** (as an error code, distinct from `status: 'refused'`) —
  in practice rare; treat exactly like `status: 'refused'`. Surface the
  reason, do not retry.
- **`internal`** — bridge bug. Surface the raw `error.message` so the user
  can file a useful bug report.
- **`wrong_tool`** — the caller passed `phase: 'execute'` for a blessed
  intent (e.g., `p&l_statement`) without resolving the required scope.
  `error.message` lists the missing variables. Drop back to
  `phase: 'discover'` for the same intent, parse the resulting narrative,
  ask the user the missing variables, then retry with `phase: 'execute'`
  and full scope. Do NOT retry execute without resolving scope — the
  bridge will reject again.
- **`other`** — agent-semantic self-report. This is the escape valve for
  codes Finny generates at the agent layer rather than the bridge/gateway
  layer. The specific code rides in `error.message`. Parse it:
  - `approval_required` — Finny judged the query ambiguous or potentially
    destructive. Surface her `assumptions[]` alongside the message and ask
    the user to clarify. Do NOT retry automatically.
  - `needs_clarification` — similar to `approval_required`. Surface
    `assumptions[]` + ask.
  - anything else — surface `error.message` verbatim; offer the user the
    choice to retry, rephrase, or accept.

### Step 4 — Confidence check

For any envelope with `status: 'ok'` or `status: 'partial'`:

- `confidence: 'high'` → render as-is.
- `confidence: 'medium'` → render AND append `confidence_reason` as a
  brief note ("Finny flagged medium confidence because: …").
- `confidence: 'low'` → render AND warn the user explicitly that
  confidence is low, surfacing `confidence_reason` as the explanation. Do
  not hide low-confidence answers.

## Discovery-phase envelopes — DO NOT show the user

This is the most-violated rule in this skill. Read carefully.

When you called `finny_query` with `phase: 'discover'`, the response is
**your tool input**, not the user's answer. Finny returned a
`status: 'ok'`, `data.shape: 'narrative'` envelope describing the
variables you need to gather, brain-derived hints, and example
clarifying questions she suggests asking. **NEVER render this to the
user as if it were the answer.**

### What you do with a discovery envelope

1. **Parse** the narrative for the variables Finny listed (`entity`,
   `period`, `consolidated`, `env`, etc.).
2. **Use AskUser** to ask the user the actual clarifying questions
   (Finny's suggested phrasings are starting points; rephrase to match
   your conversational style and the user's prior context).
3. **Assemble** the resolved scope from the user's answers.
4. **Call `finny_query` again** with `phase: 'execute'` + the resolved
   scope. THAT result is what the user sees.

### What you must NOT do

- ❌ **Do NOT** print the discovery narrative to the user as a final
  answer. Lines like "Here is what Finny came back with: 193 GL accounts
  mapped, March 2026 anomaly..." reveal Finny's *internal reasoning*,
  not the answer.
- ❌ **Do NOT** present Finny's example clarifying questions verbatim
  ("Finny suggests: 1. Which subsidiary? 2. What period?"). Use AskUser
  with your own framing — those are reference questions for *you*.
- ❌ **Do NOT** count discovery toward drift detection. `intent_restated`
  in a discovery envelope paraphrases the user's *underlying* question,
  not the discovery request. Drift detection runs on the execute-phase
  envelope.

### Right vs wrong behavior

**Wrong (visible UX leak):**

> User: "give me P&L"
>
> [Calls discover, then renders to user:]
>
> "Here's what Finny returned for discovery. Variables Finny needs:
> entity, period, consolidated, env. Brain hints: 193 GL accounts
> mapped, March 2026 ₹208 Cr anomaly. Finny suggests these clarifying
> questions: 1) Which subsidiary? 2) What period?..."

**Right (smooth handoff):**

> User: "give me P&L"
>
> [Calls discover silently. Reads the narrative. Uses AskUser:]
>
> "Quick check — which entity (ShareChat standalone, MTPL, or
> consolidated) and which period (April, current quarter, FY)?"
>
> [User answers. Calls finny_query phase:execute with full scope.
> Returns the actual P&L envelope.]

If discovery returns a non-`ok` status (e.g., `error`, `refused`), branch
on it normally per Steps 2-3 above — those are real failures to surface.

## Destructive intent — refuse before delegation

Finny is **read-only against NetSuite**. Any natural-language question that
names a destructive verb applied to a NetSuite entity is refused in-bridge
**before** the question reaches Finny. The bridge's `finny_query` handler
runs a destructive-intent guard analogous to the SuiteQL write-verb guard:
if the question matches both a destructive verb AND a NetSuite entity, the
handler returns `status: 'refused'` with `elapsed_ms: 0` — no task created,
no gateway call, no LLM delegation.

Verbs that trip the guard (non-exhaustive, case-insensitive, whole-word):

- `delete`, `drop`, `remove`, `truncate`, `purge`, `wipe`, `erase`
- `void`, `cancel`, `close out`, `write off` / `write-off`
- `expunge`, `destroy`, `nuke`

Entities that trip (with plural and phrase forms): `bill(s)`,
`vendor bill(s)`, `invoice(s)`, `journal entry / entries`,
`purchase order(s)` / `po(s)`, `payment(s)`, `vendor(s)`, `customer(s)`,
`transaction(s)`, `record(s)`, `account(s)`, `item(s)`, `employee(s)`.

**Both must match.** "Delete this line from your last response" is fine
(no entity). "Show me old vendor bills" is fine (no verb). "Delete overdue
vendor bills" is refused (verb + entity).

### What the judge does on refusal

When the envelope comes back `status: 'refused'` with `elapsed_ms: 0`, the
judge MUST:

1. Surface the `confidence_reason` verbatim — it names the verb and entity
   the guard flagged so the user understands exactly why.
2. NOT retry. The guard is deterministic. Rephrasing inside the judge layer
   would defeat the safety property.
3. Offer the user two next steps: (a) rephrase as a read-only question
   ("list overdue vendor bills"); (b) escalate via a workflow that
   explicitly supports writes, which the bridge does not provide today.

### Softer action words that do NOT trip

`archive`, `close`, `hide`, `mark`, `flag`, `review`, `audit`, `list`,
`show`, `count` are NOT in the verb list, even though some of them can
imply state change. If a user asks to "archive old vendor bills",
`finny_query` will delegate to Finny and the judge will see a normal
envelope. This is intentional — most "archive"-shaped questions mean
"show me records I'd archive if I were going to" rather than an actual
mutate. If Finny herself decides the question is destructive, she emits
`status: 'error'`, `error.code: 'other'`, `error.message: 'approval_required'`
via the §10.3 escape valve, which the judge still handles via Step 3.

### Bridge guard vs agent escape valve

Two layers, same outcome:

| Layer | Fires when | Signal |
| --- | --- | --- |
| Bridge destructive-intent guard | Question matches verb + entity | `status: 'refused'`, `elapsed_ms: 0`, no task_id |
| Finny's own judgement (escape valve) | Question is subtler but Finny decides destructive | `status: 'error'`, `error.code: 'other'`, `error.message: 'approval_required'` |

The bridge guard is the fast, deterministic, auditable layer. The escape
valve is the probabilistic safety net for intents the regex missed.
Scenario 07 in the judge-loop harness exercises the bridge guard. A softer
scenario (07b, "archive old vendor bills") exercises the fall-through to
Finny + the escape valve, confirming the guard doesn't false-positive on
legitimate read-ish phrasings.

## Never-reformat rules

Finny has already normalised her output. Reformatting corrupts it. Four
categories are strictly hands-off:

- **Money amounts** — preserve decimal places exactly. Don't round, don't
  add currency symbols that aren't already there, don't switch locales.
- **Signs** — numbers come back sign-corrected per ShareChat's flipped
  sandbox-vs-production convention. Flipping them again yields the wrong
  answer. Never re-sign.
- **GSTIN** — as-is. Do not reformat, split into state/PAN components,
  validate checksum, or uppercase. What Finny returns is the record.
- **Dates** — NetSuite's native format. Do not re-parse into ISO, do not
  reformat for "friendliness". If the user asked for a specific format,
  go back to Finny with that in the question.

## Cursor pagination — what `next_cursor` means

When a `rows` envelope contains `data.next_cursor`, the bridge truncated the
result at the row/byte ceiling (2000 rows / 8 MB serialized per page). The
remainder is buffered server-side under the opaque cursor token.

To fetch more rows:

```json
finny_continue({ "cursor": "<next_cursor value>" })
```

The result is a fresh envelope with the next page of rows and (if more
remain) a new `next_cursor`.

### Decision: drain or stop?

- If the user wants a **complete export** (e.g., "show me all open bills"),
  drain the cursor: keep calling `finny_continue({cursor})` until
  `next_cursor` is absent.
- If the user wants a **sample or top-N** (e.g., "the top 10 vendors") and
  the first page already contains the answer, stop — do not drain. Surface
  to the user that more rows are available if needed.
- If you stop with rows still buffered, the cursor expires after 10 minutes
  of idleness. Restart from `finny_query` to re-fetch.

### Do NOT summarize or truncate raw rows

Even when many rows arrive, surface them through to the user (or to a
downstream rendering tool — e.g., a dashboard). Do not collapse rows into
a written summary unless the user asked for one. Pass-through is the design.

### Cursor errors

If `finny_continue({cursor})` returns `error.code: 'other'` with a message
about an unknown or expired cursor, the buffered remainder has aged out.
Restart from `finny_query` — do NOT retry `finny_continue` on the same
cursor.

## Unanswered bucket

A non-empty `unanswered[]` means Finny tried to cover the question but
some piece was out of reach (blocked query, ambiguous entity, missing
field). Render those items in a dedicated "What we didn't find:" section
below the main answer. **Never drop them** — silent omission is the worst
failure mode.

## Drift detection — concrete examples

| User asked | `intent_restated` says | verdict |
| --- | --- | --- |
| Vendor "Acme" | "vendor Acme Corp" | OK — same entity, normalised name |
| Vendor "Acme" | "vendor Beta" | DRIFT — different entity. Retry with vendor ID |
| "open balance" | "total balance including closed bills" | DRIFT — semantics flipped. Retry explicit |
| Asked production | `env_used: sandbox` | DRIFT — env swap. Never silently render. Retry with explicit `env: production` |

Env drift is the highest-severity drift: sandbox and production have
different data AND flipped sign conventions. If `env_used` disagrees with
what the user asked, surface to the user — never silently switch.

Same-name vendors without a disambiguator are a partial-answer case (put
the ambiguity in `unanswered`), not a drift case.

## Worked examples

### Example 1 — Happy path

Envelope:

```json
{
  "status": "ok",
  "intent_restated": "Open balance for vendor Acme in production",
  "confidence": "high",
  "data": { "shape": "scalar", "value": -125000.50 },
  "unanswered": [],
  "env_used": "production"
}
```

Intent faithful, `status: ok`, `confidence: high`. Render the value as-is
— preserving sign, decimal places, and absence of currency symbols.

### Example 2 — Drift caught, retry once, then surface

First envelope:

```json
{
  "status": "ok",
  "intent_restated": "Total balance including closed bills for vendor Acme",
  "confidence": "high",
  "data": { "shape": "scalar", "value": 450000.00 }
}
```

User asked for **open** balance. Semantic drift ("open" → "total
including closed"). Retry once with:

```json
finny_query({
  "question": "What is the current OPEN (unpaid) balance for vendor Acme in production — exclude closed bills.",
  "expected_shape": "scalar",
  "entity_hints": { "env": "production" }
})
```

If the retry still drifts, surface to the user:

> Finny answered "total balance including closed bills" but you asked
> for the open balance. I retried with an explicit question and she still
> returned the closed-bill total. You may want to ask directly, or fall
> back to `finny_report({report: 'vendor_balance', …})`.

### Example 3 — `'other'` escape valve

Envelope:

```json
{
  "status": "error",
  "intent_restated": "Close all open bills for vendor Beta",
  "error": {
    "code": "other",
    "message": "approval_required",
    "retryable": false
  },
  "assumptions": [
    "User asked to close bills — this is a write operation",
    "No confirmation of which bills were intended"
  ]
}
```

`error.code: 'other'` with `error.message: 'approval_required'`. Do NOT
retry. Surface Finny's `assumptions[]` and ask the user to clarify:

> Finny needs approval before acting on this. She flagged:
> - "User asked to close bills — this is a write operation"
> - "No confirmation of which bills were intended"
>
> Could you confirm exactly which bills, and that you want a write
> operation? (Note: the bridge currently supports read-only flows.)

### Surfacing progress on each poll

When `finny_task_status` returns `status: 'running'` with a non-empty
`progress` field, render it to the user as a single-line status:

> *"Finny is: \<progress\>"*

Update only when the value changes (don't repeat the same string on
consecutive polls — that's noise). Track the last-seen progress string
in your working memory; suppress duplicates.

If `progress` is undefined or empty on a poll, leave the user-facing
status unchanged (they last saw whatever progress fired before).

This converts the 30-180s wait from a silent spinner to a live trace
of what Finny is doing — "querying NetSuite", "applying sign
conventions", "assembling MIS P1/P2 buckets", etc. Finny emits these
via `finny_progress` (an internal bridge tool not visible to cowork's
allowlist).

## Cross-reference: finny-usage

The `finny-usage` skill picks which tool to call and with what parameters.
This skill judges what comes back. Every Finny call: `finny-usage` →
tool invocation → `judging-output` → user.
