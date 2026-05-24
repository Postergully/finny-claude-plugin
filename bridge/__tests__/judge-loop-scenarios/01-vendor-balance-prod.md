# Scenario 01 — vendor-balance-prod

## Question
What is the current open balance for vendor "Acme" in production?

## Expected tool
`lolly_report` — matches the registered `vendor_balance` report.

## Tool input
```json
{
  "report": "vendor_balance",
  "params": { "vendor_name": "Acme" },
  "env": "production",
  "deadline_ms": 60000
}
```

## Expected envelope shape
- `status`: `ok` | `partial` | `running` (async path valid)
- `data.shape`: `scalar`
- `confidence`: `medium` | `high`
- `env_used`: `production`

## Drift variants
- **wrong-env**: `env_used === "sandbox"` → judge MUST surface (never silently flip)
- **sign-flip**: value positive when it should be negative (ShareChat prod convention) → judge surfaces in confidence_reason
- **wrong-entity**: `intent_restated` names a different vendor → judge retries once, then surfaces

## Never-reformat checks
- `data.value` — raw numeric; no currency symbol, no thousands separator normalization by judge
- `env_used` — exact string match
- sign bit — must pass through untouched
