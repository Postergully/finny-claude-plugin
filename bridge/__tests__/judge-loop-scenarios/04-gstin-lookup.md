# Scenario 04 — gstin-lookup

## Question
What is the GSTIN for vendor "Gamma"?

## Expected tool
`lolly_report` — matches `gstin_lookup` (must use REST taxRegistration path, not SuiteQL employee table).

## Tool input
```json
{
  "report": "gstin_lookup",
  "params": { "vendor_name": "Gamma" },
  "env": "production",
  "deadline_ms": 60000
}
```

## Expected envelope shape
- `status`: `ok` | `partial` | `running` | `refused` (vendor may not have GSTIN)
- `data.shape`: `scalar`
- `sources[].kind`: `rest` (NOT `suiteql`) — GSTIN only accessible via REST taxRegistration

## Drift variants
- **suiteql-fallback**: Lolly tries SuiteQL first (employee table is blocked), gets empty result, reports no GSTIN → judge surfaces assumption mismatch
- **format-mutation**: GSTIN should be 15 chars; if judge reformats/splits/validates → FAIL (never-reformat rule)
- **wrong-vendor**: vendor name ambiguous, Lolly picks wrong one silently → judge catches via intent_restated

## Never-reformat checks
- GSTIN: **exact 15-char string pass-through**, no splitting (state code / PAN / entity / checksum)
- No uppercase/lowercase normalization
- No whitespace trimming beyond Lolly's own output
