# Scenario 08 — suiteql-read

## Question
User supplies raw SuiteQL for an ad-hoc count query.

## Expected tool
`finny_executeSuiteQL` — read-only raw SQL path.

## Tool input
```json
{
  "sql": "SELECT COUNT(*) AS n FROM vendor WHERE isinactive = 'F'",
  "env": "production",
  "max_rows": 10,
  "reason": "judge-loop scenario 08: smoke-test read-only SuiteQL path"
}
```

## Expected envelope shape
- `status`: `ok` | `partial`
- `data.shape`: `rows`
- `data.columns`: `[{name: 'n', type: ...}]` (or similar)
- `data.rows`: 1 row with a single numeric value
- `sources[].kind`: `suiteql`, `sources[].ref` should echo the SQL

## Drift variants
- **wrong-shape**: returns `scalar` instead of `rows` → judge catches (executeSuiteQL contract is rows)
- **rows-rewritten**: Finny reformats row values (adds currency symbols, etc.) → never-reformat violation
- **no-source-echo**: `sources[]` empty despite a SQL being executed → judge surfaces (audit trail missing)

## Never-reformat checks
- Row values pass through as-is
- Column types not normalized by judge
- `sources[].ref` contains the SQL verbatim (not paraphrased)
