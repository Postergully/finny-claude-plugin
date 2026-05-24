---
name: lolly-usage
description: Decide when to call Lolly (vs answering from Claude's own knowledge) and which of the three lolly_* tools to use. Activates when the user asks a question about ShareChat financial data, NetSuite records, vendors, bills, GSTIN, or POs.
argument-hint: "<question>"
---

# lolly-usage

Lolly is the ShareChat NetSuite agent. Call her when the user asks about
**actual ShareChat financial data** — never for generic accounting or schema
questions. Every Lolly call MUST be followed by a `judging-output` pass before
the user sees an answer.

## When to call Lolly

Call Lolly if ANY of these are true:

- The question is about **ShareChat-specific** financial or ERP state.
- It references a concrete NetSuite object: vendor, bill (VendBill), PO,
  GSTIN, journal, BillCredit, vendor prepayment (VPrep), employee approver.
- It asks for the **current state** of production or sandbox data
  ("what's the open balance…", "show me the last N bills…", "which POs…").

Do NOT call Lolly for:

- General accounting concepts ("what is accrual accounting?").
- NetSuite schema questions that have documented answers ("what fields does
  VendBill have?"). Answer from your own knowledge or docs.
- Hypothetical or policy questions ("what should we do if a vendor…?").
- Anything unrelated to ShareChat's NetSuite tenant.

When in doubt and the question touches live data, call Lolly.

## Tool selection rubric (3 tools)

Pick one. In rough order of preference:

### 1. `lolly_report` — matches a registered report

Use when the question clearly maps to one of the 6 registered reports. This
is the **most predictable** surface — the preamble is canned, so Lolly's
answer shape is stable.

Registered reports:

| report            | use when the user asks about…                                 |
| ----------------- | ------------------------------------------------------------- |
| `vendor_balance`  | open balance for a named vendor                               |
| `open_bills`      | list of open bills (VendBill status IN ('A','D'))             |
| `bill_detail`     | line items / breakdown of a specific bill                     |
| `vendor_summary`  | 3-query vendor rollup: VendBill + VPrep + PurchOrd            |
| `gstin_lookup`    | vendor's GSTIN (pulls via REST taxRegistration)               |
| `po_status`       | PO state, approvals, linked receipts                          |

If the question matches, `lolly_report` wins over `lolly_query`.

### 2. `lolly_query` — free-form natural-language question

The **90% tool**. Use when the question is about live data but doesn't match
a registered report, or combines signals ("show me the top 5 vendors by open
balance whose GSTIN starts with 29").

Pass:

- `question` — the user's question, lightly cleaned up.
- `expected_shape` — `'scalar'` for counts/totals, `'rows'` for lists,
  `'narrative'` for explain/why questions.
- `entity_hints` — at minimum `{ env: 'production' }`.

### 3. `lolly_task_status` — poll a running task

**Only** use to poll a `task_id` returned by a prior `lolly_query` or
`lolly_report` call that came back with `status: 'running'`. Never invoked
standalone. Poll every 5–10 s; see judging-output for retry limits.

## Parameter defaults

- **`env`**: default `'production'`. Switch to `'sandbox'` only if the user
  explicitly asks or is clearly testing. Never silently switch envs.
- **`deadline_ms`**: default `10000` for `lolly_query` (returns `running`
  quickly so the cowork agent can poll). For reports known to be slow
  (`vendor_summary`, bulk `open_bills`), the user can raise to `60000`.
- **`expected_shape`**: guess from the question:
  - "how many…", "total…", "balance" → `'scalar'`
  - "list…", "show me the…", "which…" → `'rows'`
  - "why…", "explain…", "what happened with…" → `'narrative'`

## What NOT to do

- **Do NOT retry on `status: 'running'`.** That means Lolly accepted the
  task and is working. Poll `lolly_task_status({task_id})` instead.
- **Do NOT parse `data.rows` and reformat numbers.** The envelope has
  already applied ShareChat's flipped sign conventions (sandbox vs prod).
  Re-signing or adding currency symbols will corrupt the answer.
- **Do NOT treat `status: 'refused'` or `error.code: 'other'` as
  retryable.** Surface to the user via judging-output. Lolly refused for a
  reason.
- **Do NOT invoke `lolly_task_status` without a `task_id` from a prior
  call.** There is no listing mode.

## Worked examples

### Example 1 — vendor balance matches a registered report

User: *"What's vendor Acme's open balance?"*

This matches `vendor_balance`.

```json
lolly_report({
  "report": "vendor_balance",
  "params": { "vendor_name": "Acme" },
  "env": "production"
})
```

Then hand the envelope to `judging-output`.

### Example 2 — free-form question → lolly_query

User: *"Show me the last 5 open bills for vendor Beta."*

There's an `open_bills` report, but the "for vendor Beta" + "last 5" narrows
it; use `lolly_query` to let Lolly compose the right SuiteQL:

```json
lolly_query({
  "question": "List the last 5 open bills for vendor Beta",
  "expected_shape": "rows",
  "entity_hints": { "env": "production" }
})
```

Then hand the envelope to `judging-output`.

### Example 3 — running envelope → poll with lolly_task_status

The prior `lolly_query` returned:

```json
{
  "status": "running",
  "task_id": "task_xyz",
  "data": {
    "value": "task_xyz",
    "rendered_markdown": "{\"task_id\":\"task_xyz\",\"deadline_exceeded_ms\":10000}"
  }
}
```

> Note on envelope shape: for `running` envelopes the `task_id` appears at
> **both** the top level AND in `data.value`. Read it from either — they're
> the same string. `data.rendered_markdown` holds a JSON blob with
> `{task_id, deadline_exceeded_ms}` for debugging; do not parse it for the
> poll loop.

Wait ~10 s, then:

```json
lolly_task_status({ "task_id": "task_xyz" })
```

Each resulting envelope goes through `judging-output`. Repeat up to the
limit defined there (don't spin forever).

## Cross-reference: judging-output

Every `lolly_*` response — success, partial, running, refused, or error —
MUST pass through the `judging-output` skill before the user sees anything.
That skill owns:

- intent-drift detection,
- the `running` poll loop (how often, how many times),
- the `error.code` branch including the `'other'` escape valve for Lolly's
  semantic self-reports (`approval_required`, `needs_clarification`),
- never-reformat rules for money, signs, GSTIN, and dates.

Call Lolly, get envelope, invoke `judging-output`. No exceptions.
