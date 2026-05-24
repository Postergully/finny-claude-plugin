# Scenario 05 — vendor-disambiguation

## Question
What is the open balance for vendor "Delta"? (assume two vendors share this name)

## Expected tool
`lolly_report` — vendor_balance. Expected drift path: Lolly must NOT silently pick one.

## Tool input
```json
{
  "report": "vendor_balance",
  "params": { "vendor_name": "Delta" },
  "env": "production",
  "deadline_ms": 90000
}
```

## Expected envelope shape
- `status`: `partial` | `refused` | `error` (with error.code `other` + message `approval_required`/`needs_clarification`)
- `unanswered[]`: MUST list the ambiguity (e.g. "Multiple vendors named Delta: IDs 123, 456 — which one?")
- OR `assumptions[]` explicitly picks one ID/GSTIN and flags it

## Drift variants
- **silent-pick**: Lolly picks one vendor without naming the choice in assumptions → judge MUST catch (confidence high + no disambiguation = drift)
- **sum-both**: Lolly sums balances across both matches → judge catches via unanswered analysis
- **wrong-one-confident**: picks wrong one with `confidence: 'high'` → intent_restated should name the picked ID

## Never-reformat checks
- `unanswered[]` entries pass through verbatim
- Vendor IDs + GSTINs in assumptions not re-formatted
