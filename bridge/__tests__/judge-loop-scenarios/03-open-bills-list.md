# Scenario 03 — open-bills-list

## Question
List all open bills for vendor "Beta" in production.

## Expected tool
`finny_report` — matches the registered `open_bills` report.

## Tool input
```json
{
  "report": "open_bills",
  "params": { "vendor_name": "Beta" },
  "env": "production",
  "deadline_ms": 60000
}
```

## Expected envelope shape
- `status`: `ok` | `partial` | `running`
- `data.shape`: `rows`
- `data.columns`: should include bill_id, tranid, trandate, amount, due_date, days_overdue (per registry preamble)
- `sources`: should cite a SuiteQL source

## Drift variants
- **status-A-only**: Finny filters `status = 'A'` instead of `status IN ('A','D')` — row count is suspiciously low → judge surfaces
- **wrong-shape**: returns `scalar` (summary) instead of `rows` → judge retries asking for row format
- **empty-rows-no-explanation**: empty `data.rows` with `confidence: 'high'` → judge surfaces (should be medium/low with reason)

## Never-reformat checks
- Row data passes through as-is (no date reformatting, no amount rounding)
- Column names preserved
- `data.rows[].length === data.columns.length` invariant
