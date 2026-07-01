# chore/close-eval-followups — staging manifest

No non-git changes; eval-only files + workflow tweak. No operator steps.

## What's in this branch

- `eval/oracle/q01-vendor-balance-discover.json` — refreshed to the
  deterministic `needs_input` envelope synthesized by the bridge's discover
  short-circuit (PR #41, commit `b61e23f`). New shape: `status=needs_input`,
  `unanswered=[vendor_ref, env]`, `confidence=high`, `data=null`,
  `needs_input.{question, conversation_id, round}`.
- `eval/oracle/REDACTION-MAP.md` — q01 marked fixed; new
  `conversation_id` normalization documented.
- `eval/redact.ts` + `eval/redact-oracle.mjs` — added a regex rule that
  normalizes `conversation_id` (both `conv-<uuid>` from conversationStore
  and the raw `randomUUID()` emitted by the discover short-circuit) to the
  placeholder `<conversation-id>`. Without this, every q01 run would drift
  on a fresh UUID. The rule is volatile-field normalization, not a PII
  loosening — leak guard still green.
- `eval/canonical-queries.json` — q01 `expected_required_vars` changed
  from `[vendor, period, env]` (incorrect; never matched bless-list) to
  `[vendor_ref, env]` (matches `vendor_balance` bless-list entry
  `required_scope`).
- `.github/workflows/eval-staging.yml` — `--allow-drift 1` → `--allow-drift 0`.
  The eval is now a strict gate.

## Why no operator steps

This branch touches eval harness + workflow only. No bridge / plugin /
systemd / Caddy / OAuth / NetSuite changes. Staging + prod runtimes are
unaffected by the merge itself.

## Ratification

Post-merge, the `Eval (staging)` workflow's next scheduled run (or the next
PR that touches `bridge/`, `plugin/`, `eval/`, or this workflow) will
execute against staging with `--allow-drift 0`.

- Green: q01 oracle is correct (synthesized envelope matches live staging).
- Red: drift surfaced; file an issue with the diff payload from
  `eval-result.json`. The oracle in this PR was derived by code synthesis
  (path B from the operator runbook) because no post-#41 live baseline run
  existed at branch time.
