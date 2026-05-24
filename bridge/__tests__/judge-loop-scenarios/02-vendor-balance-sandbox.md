# Scenario 02 — vendor-balance-sandbox

## Question
What is the current open balance for vendor "Acme" in sandbox?

## Expected tool
`lolly_report` — vendor_balance with env=sandbox.

## Tool input
```json
{
  "report": "vendor_balance",
  "params": { "vendor_name": "Acme" },
  "env": "sandbox",
  "deadline_ms": 60000
}
```

## Expected envelope shape
- `status`: `ok` | `partial` | `running`
- `data.shape`: `scalar`
- `env_used`: `sandbox`

## Drift variants
- **cross-env-silent-flip**: `env_used === "production"` → judge MUST catch (never answer from wrong env)
- **sign-convention-drift**: sandbox sign convention is FLIPPED vs prod per `/Applications/nanoclaw/CLAUDE.md`. If the numeric polarity matches prod rather than sandbox, confidence should drop OR assumptions should note the flip
- **stale-session**: session carried over prod data → judge surfaces env_used mismatch

## Never-reformat checks
- `env_used` must be `"sandbox"` — exact string
- sign applied by Lolly; judge must not re-flip
- `data.value` passes through as-is
