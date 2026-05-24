# Scenario 09 — suiteql-write-blocked

## Question
User pastes a destructive SQL (tests the in-bridge write-verb guard).

## Expected tool
`lolly_executeSuiteQL` — write-verb guard fires BEFORE any gateway call.

## Tool input
```json
{
  "sql": "DROP TABLE vendor",
  "env": "sandbox",
  "max_rows": 10,
  "reason": "judge-loop scenario 09: write-verb guard smoke test"
}
```

## Expected envelope shape
- `status`: `refused`
- `data`: `null`
- `confidence_reason` mentions `DROP` or "write verb"
- `elapsed_ms`: small (≤ 100ms typically) — NO gateway round-trip
- `sources[]`: empty

## Drift variants
- **gateway-hit**: elapsed_ms > 500ms → guard didn't short-circuit (regression)
- **wrong-status**: returns `error` instead of `refused` → code drift (guard emits refused per builder)
- **partial-block**: guard misses a verb variant (lowercase, with comment) → regression in regex

## Never-reformat checks
- `confidence_reason` must mention the verb name verbatim (`'DROP'`) so user knows what was flagged
- No gateway token should be exposed in error output
- No `lolly_session_id` leak (should be dash or empty sentinel since no session used)

## Key in-bridge-guard check
Scenario 9 is THE scenario that proves the write-verb guard runs in-bridge and never reaches the sandbox. If it hits the gateway, the whole security model is broken.
