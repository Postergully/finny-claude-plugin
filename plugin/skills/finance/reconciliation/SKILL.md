---
name: finance:reconciliation
description: Reconcile vendor accounts — bills, payments, credits, prepayments. Maps to open-string intent `vendor_reconciliation`. User invocation: /lolly:finance:reconciliation [vendor]
argument-hint: "[vendor name or GSTIN] (optional — decomposer will ask if missing)"
---

# /lolly:finance:reconciliation

Reconcile a vendor's account: open bills, recent payments, credits, prepayments,
and the resulting net open balance.

## Routing

This command maps to the OPEN-STRING intent `vendor_reconciliation`. NOT in the
bridge bless-list — passes through to Lolly directly. Hand off to
`intent-decomposer` with:

- `intent: 'vendor_reconciliation'`
- `user_question: <the user's full request, including $ARGUMENTS>`

`intent-decomposer` will:
- Apply Rule 4 (permission-gate invented intents) — first call per session
  triggers AskUser confirmation. Subsequent calls in same session pass through.
- Call `lolly_query phase: 'discover'` to get Lolly's variable list.
- Drive AskUser for any missing variables.
- Call `lolly_query phase: 'execute'`.
- Hand to `judging-output`.

## Notes for the user

Open-string intents have less-strict scope enforcement than blessed intents.
If Lolly's discover phase comes back with vague example questions, the
decomposer's default paraphrase rules apply (combine, drop jargon, lead with
critical variable).

## Cross-references

- `intent-decomposer` — owns the orchestration.
- `judging-output` — handles the resulting envelope.
