# Scenario 10 — cross-env-drift

## Question
User explicitly asks a production-scoped question, but Lolly's session/context may answer from sandbox.

## Expected tool
`lolly_query` with `entity_hints.env: 'production'`.

## Tool input
```json
{
  "question": "In production, how many open vendor bills are there right now?",
  "expected_shape": "scalar",
  "entity_hints": { "env": "production" },
  "max_tokens": 2000,
  "deadline_ms": 60000
}
```

## Expected envelope shape
- `status`: `ok` | `partial` | `running`
- `env_used`: MUST be `"production"`
- `intent_restated` mentions `production` explicitly

## Drift variants
- **silent-sandbox**: `env_used === "sandbox"` despite user asking prod → CRITICAL drift; judge MUST catch (never silently answer from wrong env)
- **env-mismatch-low-confidence**: env_used correct but assumptions say "pulled from sandbox for speed" → judge surfaces
- **intent-restated-drops-env**: intent_restated doesn't mention production → soft drift; judge surfaces as warning
- **confident-but-wrong-env**: env_used = sandbox + confidence = high → worst case, judge MUST catch

## Never-reformat checks
- `env_used` exact string match
- `intent_restated` verbatim

## Key cross-env check
This is the canonical "silent env flip" test. Per CLAUDE.md NetSuite rules, sandbox and production have FLIPPED sign conventions. Silently answering from the wrong env gives numerically-wrong answers that look right. Judge catching this is non-negotiable.
