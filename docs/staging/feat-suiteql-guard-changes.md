# feat/suiteql-guard — staging change manifest

**Branch**: `feat/suiteql-guard`
**Task**: 2.4 of finny-multitenant-migration plan (`/Applications/finny-core/docs/plan/implementation.md` L910-965).
**Date**: 2026-06-29.

## Non-git operator steps required on staging / prod

**None.** No non-git changes, git merge + standard restart is sufficient.

This PR is pure bridge TypeScript:

- New: `bridge/src/intents/suiteql-guard.ts` — `sanitizeSuiteQL()` + `SuiteQLViolation`.
- New: `bridge/src/intents/suiteql-guard.test.ts` — 32 unit tests (6 canonical + case-insensitive verb expansion + comment/separator + leader + 80-char confidentiality).
- Modified: `bridge/src/mcp/tools/executeSuiteQL.ts` — wires `sanitizeSuiteQL()` in as Gate 1a, before the existing `detectWriteVerb` legacy guard (defense in depth).
- Modified: `bridge/src/__tests__/mcp/tools/executeSuiteQL.test.ts` — loosened two assertions that hard-coded the legacy guard's `confidence_reason` wording, since the new guard's wording differs but the refusal property is preserved.

No env files, no systemd units, no Caddy config, no NetSuite tooling, no Hermes profiles, no schema changes. Mocked-only test surface — no staging smoke required.

## Staging smoke

Not required (mocked-only change). `pnpm -C bridge check:all` green locally: 501 tests pass, build success.

## Deploy

Deferred to maintenance window per Issue #31 (`finny-claude-plugin/deployed` branch drift). Operator may merge to `main` immediately; prod deploy is a separate explicit action.
