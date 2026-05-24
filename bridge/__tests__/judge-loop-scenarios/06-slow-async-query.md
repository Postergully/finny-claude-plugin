# Scenario 06 — slow-async-query

## Question
How many vendor records exist in production? (canonical slow query per §10.1)

## Expected tool
`lolly_query` with short deadline_ms to force the async path.

## Tool input
```json
{
  "question": "How many vendor records exist in production?",
  "expected_shape": "scalar",
  "max_tokens": 2000,
  "deadline_ms": 2000
}
```

## Expected envelope shape
- **First call**: `status: 'running'`, `task_id` populated, `data.shape: 'scalar'` (data.value === task_id per builder)
- **Poll via lolly_task_status**: eventually `status: 'ok' | 'partial'` with scalar count

## Drift variants
- **never-running**: query completes in 2s (unlikely but possible) → record as anomaly, not drift
- **task-id-missing**: `status: 'running'` without task_id → schema validation should have already rejected; if it slips through, judge surfaces
- **task-not-found-on-poll**: lolly_task_status returns error → infrastructure problem (TTL expired?)
- **poll-returns-different-question**: completed envelope's intent_restated drifts from original question → judge catches

## Never-reformat checks
- `task_id` exact string pass-through on both running + completed envelopes
- `elapsed_ms` monotonic across poll iterations
- `data.value` on completion is a number (count), not a reformatted "X vendors" string
