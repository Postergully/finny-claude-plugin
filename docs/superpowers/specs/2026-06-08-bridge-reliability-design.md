# Bridge Reliability + Performance Pass

**Date:** 2026-06-08
**Status:** Draft — pending user review
**Scope:** `bridge/` package only. No plugin/skill behavioral changes (doc updates only).

## Problem

Three operational issues in `@postergully/finny-mcp`:

1. **Schema + timeouts + session churn** — GL queries regularly take 90–120s; current timeouts cause spurious retries. Reported symptom: bridge appears to spawn a fresh session per envelope rejection (`api-xxxxx` pattern), reloading skills (5–10s overhead). Bridge code review shows `sessionId` is reused on correction retries (`chatPipeline.ts:179`) — likely culprit is the Hermes gateway, but needs verification (deferred to Workstream C). Error envelope schema requires `retryable` (Finny would prefer optional). `error.code` enum decision pending (`OUT_OF_SCOPE` vs canonical `'refused'`).
2. **Large payloads** — `executeSuiteQL` defaults to 500 rows / hard-caps 5000; HTTP response capped at 10 MB. Future dashboard work needs raw row pass-through.
3. **Speed / call count** — Per-query gateway round-trips feel high (estimated 4–8 typical), but no real measurements. Suspected session churn on Hermes side reloading skills every call.

## Non-goals

- OAuth, MCP transport, or hooks changes (out of scope per `bridge/CLAUDE.md` security policy).
- Response streaming on `HermesClient.chat()`.
- Hermes gateway-side fixes (session caching, agent reuse). Flagged as follow-up if Workstream C instrumentation confirms gateway-side session churn.
- Plugin behavioral changes — `judging-output` and `intent-decomposer` get doc updates only.

## Design overview

Single combined PR with three workstreams: A (schema/timeouts), B (payloads), C (instrumentation). Ships behind `pnpm --filter @postergully/finny-mcp check:all`.

---

## Workstream A — Schema & Timeouts

**Risk:** Low. Mostly constants and one Zod relaxation.

### Changes

| File | Change |
|---|---|
| `bridge/src/types/envelope.ts:76` | `retryable: z.boolean()` → `z.boolean().optional()` |
| `bridge/src/types/envelope.ts:61-71` | Add comment documenting that `OUT_OF_SCOPE` is intentionally absent; canonical refusal code is `'refused'`. No enum change. |
| `bridge/src/hermes/client.ts:33` | `DEFAULT_TIMEOUT_MS = 120_000` → `150_000` |
| `bridge/src/mcp/tools/query.ts:41` and equivalents in `report.ts` | Default `deadline_ms` 10_000 → 30_000 |
| `bridge/src/mcp/tools/_shared/taskWorker.ts` | `deadlineMs: 300_000` unchanged (total task wall-clock) |
| `bridge/src/mcp/prompts/inlined.ts` polling backoff | Replace 15-step ramp with 6-step: `[5, 5, 10, 15, 30, 30]` seconds |

### Tests
- Unit: existing Zod tests updated to confirm envelope still parses with `retryable` absent.
- Unit: existing Zod tests with `retryable: true` and `retryable: false` still pass.
- Integration (stub gateway): query that takes 25s returns inline (under new 30s default).
- Integration (stub gateway): query that takes 45s returns `running` envelope, polled to completion via new backoff schedule.

---

## Workstream B — Hybrid Payload Pass-Through (with cursor escape)

**Risk:** Medium. Higher caps could blow cowork context window; cursor is the safety net.

### Approach
Default to raw pass-through up to a generous ceiling. If a result would exceed the ceiling, the bridge returns the first chunk plus `next_cursor`, and cowork fetches subsequent pages via `finny_continue({cursor})`.

### Changes

| File | Change |
|---|---|
| `bridge/src/mcp/tools/executeSuiteQL.ts:18` | `max_rows` default 500 → 5000, hard cap 5000 → 20000 |
| `bridge/src/hermes/client.ts:34` | `MAX_RESPONSE_SIZE_BYTES = 10MB` → `50MB` |
| `bridge/src/mcp/tools/_shared/suiteqlGuard.ts:47` | Update preamble to reflect new row ceiling |
| `bridge/src/types/envelope.ts` (data shape `rows`) | Add optional `next_cursor: z.string().optional()` |
| `bridge/src/mcp/tools/_shared/conversationStore.ts` | Extend to store cursor state keyed by `task_id` (cursor → remaining rows reference) |
| `bridge/src/mcp/tools/finnyContinue.ts` | Accept `{ cursor }` in addition to existing clarification path; return next chunk + new `next_cursor` if more remain |
| `plugin/skills/judging-output/SKILL.md` | Document: do not summarize raw rows; if `next_cursor` present, cowork should call `finny_continue({cursor})` to fetch more, or stop if user only needs a sample |

### Cursor mechanics
- Cursor triggered when result rows > 20000 OR serialized JSON > 50 MB.
- First envelope returns up to ceiling rows + `next_cursor: <opaque token>`.
- `finny_continue({cursor})` returns next chunk of same shape with new `next_cursor` (or absent on final page).
- Cursor state TTL: 10 minutes, evicted from `conversationStore`.

### Tests
- Unit: 3000-row stub result returns inline, no cursor.
- Unit: 25000-row stub result returns 20000 rows + `next_cursor`; second call drains remaining 5000 with no cursor.
- Unit: 60 MB stub result triggers cursor at byte ceiling, not row ceiling.
- Unit: expired cursor returns explicit `error.code = 'other'` with `retryable: false`.
- Integration: real `executeSuiteQL` against stub Hermes returns 5000 rows by default without truncation.

---

## Workstream C — Instrumentation + Watch CLI

**Risk:** Low. Read-only on production behavior — observability changes only.

### Changes

| File | Change |
|---|---|
| `bridge/src/hermes/gatewayLog.ts` | Add fields: `latency_ms`, `prompt_tokens`, `completion_tokens`, `correction_retry: bool`, `tool_loop_iter: n`, `session_id`, `session_created: bool` |
| `bridge/src/mcp/tools/_shared/chatPipeline.ts` | Emit per-query aggregate: `total_calls`, `total_latency_ms`, breakdown by phase (`initial` / `correction` / `progress_loop`) |
| `bridge/src/hermes/sessionStore.ts:52` | Increment `sessionCreated` counter; assert sessionId reuse in correction retry path; log warning if a correction retry creates a new session |
| `bridge/scripts/analyze-gateway-log.mjs` (new) | Summarize a log window: avg calls/query, p50/p95 latency, session-creation rate, correction-retry rate |
| `bridge/scripts/bridge-watch.mjs` (new) | Live terminal TUI tailing gateway log; shows running aggregates (calls/min, p50/p95 latency, active sessions, correction-retry rate); useful during dev/testing |

### Verification step (session reuse)
Before any optimization work in a future spec:
1. Run `bridge-watch` against a 1-week prod log window.
2. Check `session_created` rate: should be ~1 per principal per hour (LRU TTL is 1h). If higher, investigate Hermes gateway side.
3. If gateway *is* creating fresh `api-xxxxx` sessions per request despite stable bridge `session_id`, file a follow-up against the Hermes repo. **Out of scope for this spec.**

### Tests
- Unit: gateway log entries contain new fields with correct values.
- Unit: correction retry path increments `correction_retry` exactly once per failed validation.
- Unit: aggregate emission contains all phases with non-zero `latency_ms`.
- Manual: run `bridge-watch` against a synthetic test run, confirm live update and accurate aggregates.

---

## Test plan (combined)

### Automated
- `pnpm --filter @postergully/finny-mcp test:run` — all existing tests pass plus new tests above.
- `pnpm --filter @postergully/finny-mcp typecheck` — strict TS, no errors.
- `pnpm --filter @postergully/finny-mcp lint` — clean.
- `pnpm --filter @postergully/finny-mcp build` — bundle succeeds, `dist/index.js` produced.

### Manual scenarios
1. **Long GL query** — Issue a complex GL P&L query against staging. Expect: returns inline within 30s, or returns `running` and resolves on first or second poll.
2. **Large dataset** — Issue a SuiteQL returning ~3000 rows. Expect: single envelope, no cursor, all rows present.
3. **Huge dataset** — Issue a SuiteQL returning ~25000 rows. Expect: first envelope has 20000 + `next_cursor`; `finny_continue({cursor})` returns remaining 5000.
4. **Session churn check** — Run `bridge-watch` while issuing 10 sequential queries on the same principal. Expect: `session_created` increments at most once.
5. **Schema relaxation** — Send mock Finny envelope with `error` block lacking `retryable`. Expect: parses cleanly.

### Rollback
Combined PR; revert is one commit. No DB migrations, no config keys to roll back. Caddy/systemd untouched.

---

## Open questions (post-implementation)

These are explicitly NOT to be answered in this spec — they're for the follow-up driven by Workstream C data:

- Is the per-query call count actually high in production, or just in code-reading?
- Where does latency actually live — Finny inference, gateway round-trips, or bridge serialization?
- Does Hermes gateway side reuse sessions correctly given the bridge sends a stable `session_id`?
- Are there obvious batching wins (collapsed `finny_progress` loop, batched correction prompts)?

Follow-up spec will be opened with measured data, not estimates.
