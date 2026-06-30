# Staging manifest — feat/discover-short-circuit

No non-git changes. `git merge` + standard restart on staging is sufficient
(`sudo systemctl restart finny-mcp`). Manifest exists per CLAUDE.md
staging-promotion discipline; no operator steps beyond the standard restart.

## Scope of change

- `bridge/src/mcp/tools/query.ts` — deterministic discover short-circuit for
  blessed intents. No new env vars, no new dependencies, no systemd / Caddy /
  OAuth / NetSuite tooling touched.
- `bridge/src/__tests__/mcp/tools/query.test.ts` — three new unit tests for
  the short-circuit. One test in `query-twoPhase.test.ts` updated to reflect
  the new routing decision.
- `eval/oracle/REDACTION-MAP.md` — q01 marked fixed; operator follow-up steps
  documented inline.

## Mocked-only

All test surfaces are mocked (gateway, taskManager). No staging smoke is
required for this PR per CLAUDE.md ("Mocked-only changes can skip [staging]
but should say so explicitly in the PR body.").

## Operator follow-up after deploy

After this PR merges and lands on staging:

1. Run the staging eval workflow.
2. q01 will now diff against the captured oracle (envelope shape changed
   from `partial` to `needs_input`). Recapture the q01 oracle from the
   first clean staging run.
3. After 20/20 baseline is confirmed green, open a separate PR to flip
   `.github/workflows/eval-staging.yml --allow-drift` from `1` to `0`.
   Intentionally left at `1` in this PR.
