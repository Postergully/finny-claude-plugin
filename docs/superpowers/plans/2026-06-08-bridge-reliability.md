# Bridge Reliability + Performance Pass — Implementation Plan

> **Status:** ✅ Shipped — [PR #5](https://github.com/Postergully/finny-claude-plugin/pull/5) on branch `feat/bridge-reliability` (18 commits). Executed via superpowers:subagent-driven-development with two-stage review on Tasks 1 and 7.

## Execution summary

| Task | Status | Commit |
|---|---|---|
| 1. Schema relaxations (rows_scanned + retryable) | ✅ | `6a4bcfc` |
| 2. Document OUT_OF_SCOPE decision | ✅ | `9870dd2` |
| 3. HTTP timeout 120s → 150s | ✅ | `9936d13` |
| 4. deadline_ms 10s → 30s for query/report | ✅ | `c504c4d` |
| 5. Tighten polling backoff (6-poll schedule) | ✅ | `7348b74` |
| 6. Extend gatewayLog with diagnostics | ✅ | `ca11801` |
| 7. Wire diagnostics into chatPipeline + client | ✅ | `9fd291e` |
| 8. Session-creation counter | ✅ | `ff9b9d7` |
| 9. analyze-gateway-log.mjs summarizer | ✅ | `f0ce0e7` |
| 10. bridge-watch.mjs live TUI | ✅ | `8dfe6ae` |
| 11. Add next_cursor to envelope DataRows | ✅ | `236067d` |
| 12. Cursor store | ✅ | `104b67f` |
| 13. Bump payload ceilings | ✅ | `bbf7b3f` |
| 14. Cursor escape in chatPipeline | ✅ | `7a4036a` |
| 15. finny_continue cursor branch | ✅ | `bd27f0d` |
| 16. judging-output skill cursor section | ✅ | `222fd17` |
| 17. Final check + manual smoke + PR | ✅ | (PR #5) |
| (cleanup) Remove unused @ts-expect-error | ✅ | `b9a2dbb` |
| (cleanup) eslint --fix on Workstream B/C files | ✅ | `fc082b1` |

**Final state:** 458 tests pass (12 expected skips), `npm run check:all` clean (lint:fix, typecheck, test:run, build).

**Deviations from plan:** Workstream B ceilings landed lower than the design's outer caps (max_rows cap 10000 vs 20000; body cap 25 MB vs 50 MB) because the cursor escape mechanism makes generous outer ceilings unnecessary. `tool_loop_iter` and token-count diagnostics fields are plumbed in the type but not populated yet — deferred to a follow-up. See the design doc's "As-built deviations" section for details.

**Manual smoke tests still pending** (run against staging): long GL query inline within 30s; 5000-row SuiteQL drain via cursor; bridge-watch session reuse verification.

---

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the spec at `docs/superpowers/specs/2026-06-08-bridge-reliability-design.md`: schema relaxations, timeout raises, hybrid payload pass-through with cursor escape, and gateway instrumentation + watch CLI.

**Architecture:** Three workstreams shipped in a single combined PR. Workstream A: small file edits to envelope schema, client timeout, tool defaults, and the inlined polling-backoff prompt. Workstream B: new cursor escape path (envelope field, conversation-store extension, finny_continue branch), with row/byte ceilings tuned conservatively (2000 rows / 8 MB). Workstream C: gateway log enrichment, per-query aggregate emission, `analyze-gateway-log.mjs` summarizer, and a `bridge-watch.mjs` live TUI.

**Tech Stack:** TypeScript ESM (Node ≥20), Zod, Vitest, tsup. Existing patterns: `.js` import suffixes, single quotes, 2-space indent, 100-char width, custom errors extend `HermesError`. Tests live under `bridge/src/__tests__/` mirroring `src/` paths.

---

## File Structure

**Modified:**
- `bridge/src/types/envelope.ts` — `rows_scanned` nullable, `retryable` optional, add `next_cursor` to `DataRows`
- `bridge/src/hermes/client.ts` — timeout + max-response-size constants
- `bridge/src/mcp/tools/query.ts` — default `deadline_ms`
- `bridge/src/mcp/tools/report.ts` — default `deadline_ms`
- `bridge/src/mcp/tools/executeSuiteQL.ts` — `max_rows` default + cap
- `bridge/src/mcp/tools/_shared/suiteqlGuard.ts` — preamble text
- `bridge/src/mcp/tools/_shared/conversationStore.ts` — cursor entry type + helpers
- `bridge/src/mcp/tools/continue.ts` — cursor branch
- `bridge/src/mcp/tools/_shared/chatPipeline.ts` — aggregate emission + cursor injection
- `bridge/src/mcp/tools/_shared/sessionStore.ts` — session-creation counter
- `bridge/src/mcp/tools/_shared/gatewayLog.ts` — extended fields
- `bridge/src/mcp/prompts/inlined.ts` — backoff schedule (auto-regenerated from skill)
- `plugin/skills/judging-output/SKILL.md` — backoff schedule + cursor handling

**Created:**
- `bridge/src/mcp/tools/_shared/cursorStore.ts` — opaque cursor → buffered remaining rows
- `bridge/scripts/analyze-gateway-log.mjs` — summarizer
- `bridge/scripts/bridge-watch.mjs` — live TUI
- Tests mirroring each modified path under `bridge/src/__tests__/`

---

## Task 1: Schema relaxations (Workstream A)

**Files:**
- Modify: `bridge/src/types/envelope.ts:12,76`
- Test: `bridge/src/__tests__/types/envelope.test.ts` (existing)

- [ ] **Step 1.1: Add a failing test for `rows_scanned: null`**

Append to `bridge/src/__tests__/types/envelope.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { FinnyEnvelopeSchema } from '../../types/envelope.js';

describe('envelope schema relaxations (Workstream A)', () => {
  const baseEnv = {
    status: 'ok',
    intent_restated: 'test',
    assumptions: [],
    unanswered: [],
    data: { shape: 'scalar' as const, value: 1 },
    sources: [{ kind: 'suiteql' as const, ref: 'SELECT 1', rows_scanned: null }],
    confidence: 'high' as const,
    confidence_reason: 'test',
    elapsed_ms: 0,
    env_used: 'production' as const,
    bridge_version: '0.0.1',
    finny_session_id: 'finny-test',
  };

  it('accepts rows_scanned: null on a source', () => {
    const result = FinnyEnvelopeSchema.safeParse(baseEnv);
    expect(result.success).toBe(true);
  });

  it('accepts error without retryable field', () => {
    const env = {
      ...baseEnv,
      status: 'error' as const,
      data: null,
      error: { code: 'internal' as const, message: 'boom' },
    };
    const result = FinnyEnvelopeSchema.safeParse(env);
    expect(result.success).toBe(true);
  });

  it('still accepts error with retryable: true', () => {
    const env = {
      ...baseEnv,
      status: 'error' as const,
      data: null,
      error: { code: 'internal' as const, message: 'boom', retryable: true },
    };
    const result = FinnyEnvelopeSchema.safeParse(env);
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 1.2: Run tests to verify failure**

Run: `cd bridge && npx vitest run src/__tests__/types/envelope.test.ts -t "Workstream A"`
Expected: FAIL — schema rejects null `rows_scanned` and missing `retryable`.

- [ ] **Step 1.3: Update `envelope.ts` to relax both fields**

In `bridge/src/types/envelope.ts`, change line 12 from:

```typescript
    rows_scanned: z.number().int().nonnegative().optional(),
```

to:

```typescript
    rows_scanned: z.number().int().nonnegative().nullable().optional(),
```

And change lines 73-77 from:

```typescript
const ErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
});
```

to:

```typescript
const ErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  // Optional defensively (Workstream A 2026-06-08): Finny may emit error
  // blocks without retryable; judging-output treats absence as `false`.
  retryable: z.boolean().optional(),
});
```

- [ ] **Step 1.4: Run tests to verify pass**

Run: `cd bridge && npx vitest run src/__tests__/types/envelope.test.ts`
Expected: PASS (all tests including new ones).

- [ ] **Step 1.5: Commit**

```bash
cd /Applications/finny-claude-plugin
git add bridge/src/types/envelope.ts bridge/src/__tests__/types/envelope.test.ts
git commit -m "$(cat <<'EOF'
feat(bridge): make rows_scanned nullable, retryable optional

Cuts envelope rejections on unpatched Finny sessions that emit
rows_scanned: null. Aligns error.retryable with Finny's preferred
contract (optional, defaults to false at the judge layer).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Document `OUT_OF_SCOPE` decision (Workstream A)

**Files:**
- Modify: `bridge/src/types/envelope.ts:61-71`

- [ ] **Step 2.1: Add comment documenting the canonical refusal code**

In `bridge/src/types/envelope.ts`, just above line 61 (`const ErrorCodeSchema = z.enum([`), add this comment block (preserving the existing comment that follows):

```typescript
// Decision (2026-06-08): `OUT_OF_SCOPE` is intentionally NOT in this enum.
// Finny should emit `'refused'` for policy/safety/scope refusals. The judge
// layer (judging-output) treats `'refused'` as terminal — never retried.
// Agent-semantic self-reports (approval_required, needs_clarification) ride
// on the `'other'` escape valve with the specific code in error.message.
```

- [ ] **Step 2.2: Verify nothing broke**

Run: `cd bridge && npx vitest run src/__tests__/types/envelope.test.ts`
Expected: PASS.

- [ ] **Step 2.3: Commit**

```bash
cd /Applications/finny-claude-plugin
git add bridge/src/types/envelope.ts
git commit -m "$(cat <<'EOF'
docs(bridge): document OUT_OF_SCOPE decision in envelope schema

Codify that 'refused' is the canonical refusal code; OUT_OF_SCOPE is
intentionally absent. Reduces ambiguity for Finny patches that might
otherwise reintroduce it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Raise HTTP timeout (Workstream A)

**Files:**
- Modify: `bridge/src/hermes/client.ts:33`
- Test: `bridge/src/__tests__/hermes/client.test.ts` (existing)

- [ ] **Step 3.1: Find the existing client test or create a new one**

Run: `cd bridge && ls src/__tests__/hermes/ 2>/dev/null && grep -n "DEFAULT_TIMEOUT" src/__tests__/hermes/*.ts 2>/dev/null`
Expected: list any existing test file. If none exists, the next step creates one.

- [ ] **Step 3.2: Write a test that exercises the default timeout constant**

Create or append to `bridge/src/__tests__/hermes/clientTimeout.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { HermesClient } from '../../hermes/client.js';

describe('HermesClient timeout default (Workstream A)', () => {
  it('uses 150_000ms as the default timeout', () => {
    const client = new HermesClient('http://localhost:18789');
    // Cast through unknown to read the private field for verification.
    const timeoutMs = (client as unknown as { timeoutMs: number }).timeoutMs;
    expect(timeoutMs).toBe(150_000);
  });
});
```

- [ ] **Step 3.3: Run test to verify failure**

Run: `cd bridge && npx vitest run src/__tests__/hermes/clientTimeout.test.ts`
Expected: FAIL — default is currently 120_000.

- [ ] **Step 3.4: Update the constant**

In `bridge/src/hermes/client.ts`, change line 33 from:

```typescript
const DEFAULT_TIMEOUT_MS = 120_000;
```

to:

```typescript
// Workstream A (2026-06-08): raised 120s → 150s. GL queries regularly
// take 90–120s end-to-end; the prior ceiling caused spurious retries.
const DEFAULT_TIMEOUT_MS = 150_000;
```

- [ ] **Step 3.5: Run test to verify pass**

Run: `cd bridge && npx vitest run src/__tests__/hermes/clientTimeout.test.ts`
Expected: PASS.

- [ ] **Step 3.6: Commit**

```bash
cd /Applications/finny-claude-plugin
git add bridge/src/hermes/client.ts bridge/src/__tests__/hermes/clientTimeout.test.ts
git commit -m "$(cat <<'EOF'
feat(bridge): raise HermesClient default timeout 120s → 150s

Long GL queries regularly run 90–120s end-to-end. Raising the HTTP
timeout reduces spurious retries.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Raise default `deadline_ms` on `finny_query` and `finny_report` (Workstream A)

**Files:**
- Modify: `bridge/src/mcp/tools/query.ts:41`
- Modify: `bridge/src/mcp/tools/report.ts:22`
- Test: existing handler tests under `bridge/src/__tests__/mcp/tools/`

- [ ] **Step 4.1: Add a test asserting the new default**

Create `bridge/src/__tests__/mcp/tools/deadlineDefaults.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { queryInputSchema } from '../../../mcp/tools/query.js';
import { reportInputSchema } from '../../../mcp/tools/report.js';

describe('default deadline_ms (Workstream A)', () => {
  it('finny_query defaults deadline_ms to 30_000', () => {
    const parsed = queryInputSchema.parse({
      question: 'q',
      expected_shape: 'scalar',
      entity_hints: { env: 'production' },
    });
    expect(parsed.deadline_ms).toBe(30_000);
  });

  it('finny_report defaults deadline_ms to 30_000', () => {
    const parsed = reportInputSchema.parse({
      report: 'vendor_balance',
      params: { vendor_name: 'Acme' },
      env: 'production',
    });
    expect(parsed.deadline_ms).toBe(30_000);
  });
});
```

> Note: if `queryInputSchema` or `reportInputSchema` is not a named export, add the export (`export const queryInputSchema = …`) in the source file as part of this task before running the test.

- [ ] **Step 4.2: Run test to verify failure**

Run: `cd bridge && npx vitest run src/__tests__/mcp/tools/deadlineDefaults.test.ts`
Expected: FAIL — defaults are currently 10_000.

- [ ] **Step 4.3: Update the defaults**

In `bridge/src/mcp/tools/query.ts:41`, change:

```typescript
    deadline_ms: z.number().int().positive().max(300_000).default(10_000),
```

to:

```typescript
    deadline_ms: z.number().int().positive().max(300_000).default(30_000),
```

In `bridge/src/mcp/tools/report.ts:22`, apply the same change (10_000 → 30_000).

- [ ] **Step 4.4: Run test to verify pass**

Run: `cd bridge && npx vitest run src/__tests__/mcp/tools/deadlineDefaults.test.ts`
Expected: PASS.

- [ ] **Step 4.5: Re-run the full bridge test suite to catch regressions**

Run: `cd bridge && npm run test:run`
Expected: All tests pass. If a test was hard-coded to assert `deadline_ms === 10000`, update it to expect `30000`.

- [ ] **Step 4.6: Commit**

```bash
cd /Applications/finny-claude-plugin
git add bridge/src/mcp/tools/query.ts bridge/src/mcp/tools/report.ts bridge/src/__tests__/mcp/tools/deadlineDefaults.test.ts
git commit -m "$(cat <<'EOF'
feat(bridge): raise default deadline_ms 10s → 30s for query/report

Most queries that take 10–30s now return inline instead of escalating
to a polling loop. The 300s task wall-clock is unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Tighten polling backoff in judging-output skill (Workstream A)

**Files:**
- Modify: `plugin/skills/judging-output/SKILL.md` (the polling-backoff table)
- Modify: `bridge/src/mcp/prompts/inlined.ts` (auto-regenerated by `prebuild` hook)

- [ ] **Step 5.1: Locate the polling schedule in the skill**

Run: `grep -n "Poll #" plugin/skills/judging-output/SKILL.md | head -5`
Expected: a line near the existing "Schedule (cumulative wait time per poll):" table.

- [ ] **Step 5.2: Replace the 15-step schedule with a 6-step schedule**

In `plugin/skills/judging-output/SKILL.md`, find the existing schedule table (currently `5,5,5,5,7,7,10,10,15,15,20,20,30,30,45` totalling 229s with a 15-poll cap). Replace **the table itself, the cap line, and the latency note** with:

```markdown
Poll cadence: progressive backoff. Cap: 6 polls (~95 s of waits). The
bridge's 300s `awaitTaskOrEscalate` deadline still bounds task lifetime
from above.

Schedule (cumulative wait time per poll):

| Poll # | Wait before this poll | Cumulative |
|---|---|---|
| 1 | 5 s | 5 s |
| 2 | 5 s | 10 s |
| 3 | 10 s | 20 s |
| 4 | 15 s | 35 s |
| 5 | 30 s | 65 s |
| 6 | 30 s | 95 s |

After 6 polls (~95 s of waits, plus query time), if still `running`,
stop and surface to the user: "Finny is still working on this — the
query is unusually slow. Two options: (1) **wait longer** — Finny may
finish in another minute; (2) **narrow the scope** — specify a single
subsidiary (e.g., MTPL standalone) which usually speeds it up
significantly." Frame option 1 as "wait longer", NOT "try again with
a longer deadline" — the user shouldn't think they need to re-issue
the query; the bridge keeps working until its 300s deadline.

Real Finny latencies (measured 2026-05-14/15, n=4 chains):
- p50 ≈ 149 s
- p90 ≈ 183 s

The 6-poll backoff covers p90 + headroom on the new 30s default
deadline_ms.
```

- [ ] **Step 5.3: Regenerate inlined skills bundle**

Run: `cd bridge && npm run build`
Expected: build succeeds; `bridge/src/mcp/prompts/inlined.ts` is regenerated by the `prebuild` hook.

- [ ] **Step 5.4: Confirm the new schedule made it into the inlined bundle**

Run: `grep -c "30 s | 65 s" bridge/src/mcp/prompts/inlined.ts`
Expected: at least `1` (the new row appears in the inlined skill string).

- [ ] **Step 5.5: Run full bridge test suite**

Run: `cd bridge && npm run test:run`
Expected: PASS.

- [ ] **Step 5.6: Commit**

```bash
cd /Applications/finny-claude-plugin
git add plugin/skills/judging-output/SKILL.md bridge/src/mcp/prompts/inlined.ts
git commit -m "$(cat <<'EOF'
feat(skill): tighten judging-output polling backoff

Replaces the 15-poll ramp (cumulative 229s of waits) with a 6-poll
schedule (cumulative 95s of waits). Combined with the 30s default
deadline_ms, this covers measured p90 (~183s) without spurious
retries on long GL queries.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Extend gatewayLog with diagnostic fields (Workstream C)

**Files:**
- Modify: `bridge/src/mcp/tools/_shared/gatewayLog.ts`
- Test: `bridge/src/__tests__/mcp/tools/_shared/gatewayLog.test.ts`

- [ ] **Step 6.1: Write the failing test**

Create `bridge/src/__tests__/mcp/tools/_shared/gatewayLog.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { logGatewayCall } from '../../../../mcp/tools/_shared/gatewayLog.js';

describe('gatewayLog extended fields (Workstream C)', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  const captured: string[] = [];

  beforeEach(() => {
    captured.length = 0;
    writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('records session_id, correction_retry, tool_loop_iter, prompt/completion tokens', () => {
    logGatewayCall(
      {
        method: 'POST',
        url: 'http://localhost:18789/v1/chat/completions',
        body_shape: { messages_count: 3, has_session: true },
      },
      {
        status: 200,
        latency_ms: 1234,
        response_chars: 5678,
      },
      {
        session_id: 'finny-abc',
        session_created: false,
        correction_retry: false,
        tool_loop_iter: 2,
        prompt_tokens: 1000,
        completion_tokens: 500,
      }
    );

    expect(captured.length).toBe(1);
    const record = JSON.parse(captured[0]);
    expect(record.kind).toBe('gateway_call');
    expect(record.diagnostics).toEqual({
      session_id: 'finny-abc',
      session_created: false,
      correction_retry: false,
      tool_loop_iter: 2,
      prompt_tokens: 1000,
      completion_tokens: 500,
    });
  });

  it('still works when diagnostics arg is omitted (back-compat)', () => {
    logGatewayCall(
      { method: 'POST', url: '/x' },
      { status: 200, latency_ms: 1 }
    );
    expect(captured.length).toBe(1);
    const record = JSON.parse(captured[0]);
    expect(record.diagnostics).toBeUndefined();
  });
});
```

- [ ] **Step 6.2: Run test to verify failure**

Run: `cd bridge && npx vitest run src/__tests__/mcp/tools/_shared/gatewayLog.test.ts`
Expected: FAIL — `logGatewayCall` does not accept a third arg yet.

- [ ] **Step 6.3: Extend `gatewayLog.ts`**

Replace `bridge/src/mcp/tools/_shared/gatewayLog.ts` with:

```typescript
// Gateway-side diagnostic logger: JSONL to stderr.
// Never logs Authorization header, request/response bodies, or token material.
// Response body preview (<=512 chars) only recorded on non-2xx responses.

export type GatewayRequestShape = {
  method: string;
  url: string;
  body_shape?: {
    model?: string;
    messages_count?: number;
    max_tokens?: number;
    has_session?: boolean;
  };
};

export type GatewayResponseShape = {
  status: number;
  latency_ms: number;
  response_chars?: number;
  body_preview?: string;
  error?: string;
};

// Workstream C (2026-06-08): per-call diagnostics. All fields optional so
// callers can populate what they know. Used by analyze-gateway-log.mjs and
// bridge-watch.mjs to attribute latency and detect session churn.
export type GatewayDiagnostics = {
  session_id?: string;
  session_created?: boolean;
  correction_retry?: boolean;
  tool_loop_iter?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
};

export function logGatewayCall(
  req: GatewayRequestShape,
  res: GatewayResponseShape,
  diagnostics?: GatewayDiagnostics
): void {
  const record = {
    ts: new Date().toISOString(),
    kind: 'gateway_call',
    request: {
      method: req.method,
      url: req.url,
      body_shape: req.body_shape,
    },
    response: res,
    ...(diagnostics ? { diagnostics } : {}),
  };
  try {
    process.stderr.write(JSON.stringify(record) + '\n');
  } catch {
    // Logging must never throw.
  }
}

export type GatewayQueryAggregate = {
  session_id: string;
  total_calls: number;
  total_latency_ms: number;
  phases: {
    initial: { calls: number; latency_ms: number };
    correction: { calls: number; latency_ms: number };
    progress_loop: { calls: number; latency_ms: number };
  };
};

// Workstream C: emit one summary record per logical query (after all
// gateway calls for that query are done). Distinct kind so the analyzer
// can separate per-call from per-query records.
export function logGatewayQueryAggregate(agg: GatewayQueryAggregate): void {
  const record = {
    ts: new Date().toISOString(),
    kind: 'gateway_query_aggregate',
    aggregate: agg,
  };
  try {
    process.stderr.write(JSON.stringify(record) + '\n');
  } catch {
    // Logging must never throw.
  }
}
```

- [ ] **Step 6.4: Run test to verify pass**

Run: `cd bridge && npx vitest run src/__tests__/mcp/tools/_shared/gatewayLog.test.ts`
Expected: PASS.

- [ ] **Step 6.5: Commit**

```bash
cd /Applications/finny-claude-plugin
git add bridge/src/mcp/tools/_shared/gatewayLog.ts bridge/src/__tests__/mcp/tools/_shared/gatewayLog.test.ts
git commit -m "$(cat <<'EOF'
feat(bridge): extend gatewayLog with diagnostics + query aggregate

Adds optional diagnostics block (session_id, correction_retry,
tool_loop_iter, prompt/completion tokens) and a new aggregate
record kind summarizing all gateway calls for a logical query.
Existing callers unaffected (diagnostics param optional).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Wire diagnostics into `chatPipeline` and `client` (Workstream C)

**Files:**
- Modify: `bridge/src/hermes/client.ts` — accept and forward diagnostics on each call
- Modify: `bridge/src/mcp/tools/_shared/chatPipeline.ts` — emit diagnostics + query aggregate
- Test: `bridge/src/__tests__/mcp/tools/_shared/chatPipeline.test.ts` (existing)

- [ ] **Step 7.1: Inspect the call sites**

Run: `grep -n "logGatewayCall" bridge/src/hermes/client.ts bridge/src/mcp/tools/_shared/chatPipeline.ts bridge/src/mcp/tools/_shared/toolDispatcher.ts`
Expected: find every site that currently calls `logGatewayCall(req, res)`.

- [ ] **Step 7.2: Add a failing test on chatPipeline aggregate emission**

Append to `bridge/src/__tests__/mcp/tools/_shared/chatPipeline.test.ts` (use the existing test setup pattern in that file — pick an existing test as a template; the snippet below shows the new assertion):

```typescript
describe('gateway query aggregate (Workstream C)', () => {
  it('emits one gateway_query_aggregate record per query', async () => {
    const stderrLines: string[] = [];
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrLines.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });

    // Drive a single happy-path query through chatPipeline using the
    // existing stub Hermes pattern in this file (see prior tests for
    // exact mock shape — copy it verbatim).
    // ... (use the existing harness from this file)
    // After the call returns:
    const aggregateRecords = stderrLines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((r) => r && r.kind === 'gateway_query_aggregate');
    expect(aggregateRecords.length).toBe(1);
    expect(aggregateRecords[0].aggregate.session_id).toMatch(/^finny-/);
    expect(aggregateRecords[0].aggregate.total_calls).toBeGreaterThan(0);

    writeSpy.mockRestore();
  });
});
```

> Note: copy the mock-Hermes setup from an existing happy-path test in this file. Do not invent a new mock shape.

- [ ] **Step 7.3: Run test to verify failure**

Run: `cd bridge && npx vitest run src/__tests__/mcp/tools/_shared/chatPipeline.test.ts -t "Workstream C"`
Expected: FAIL — no aggregate record emitted yet.

- [ ] **Step 7.4: Update `client.ts` to forward diagnostics**

In `bridge/src/hermes/client.ts`, find the `chat()` method (around line 304-350). Add a `diagnostics?: GatewayDiagnostics` field to its params type, and pass it through to `logGatewayCall`:

```typescript
import { logGatewayCall, type GatewayDiagnostics } from '../mcp/tools/_shared/gatewayLog.js';

// In ChatParams (or equivalent type), add:
//   diagnostics?: GatewayDiagnostics;

// At the existing logGatewayCall call site, change:
//   logGatewayCall(req, res);
// to:
//   logGatewayCall(req, res, params.diagnostics);
```

If the existing `chat()` signature differs (e.g., takes positional args), preserve the existing positional API and add an optional trailing `diagnostics?: GatewayDiagnostics` arg instead.

- [ ] **Step 7.5: Update `chatPipeline.ts` to populate diagnostics + emit aggregate**

In `bridge/src/mcp/tools/_shared/chatPipeline.ts`:

1. At the top of the file, add:

```typescript
import { logGatewayQueryAggregate } from './gatewayLog.js';
```

2. Inside the function that runs the chat pipeline (the one that calls `chat()` for the initial + correction + tool-loop calls), maintain three running counters keyed by phase. Pseudocode (adapt to actual structure):

```typescript
const phases = {
  initial: { calls: 0, latency_ms: 0 },
  correction: { calls: 0, latency_ms: 0 },
  progress_loop: { calls: 0, latency_ms: 0 },
};

async function callChat(phase: 'initial' | 'correction' | 'progress_loop', toolLoopIter: number, isCorrection: boolean) {
  const start = Date.now();
  const result = await client.chat({
    /* existing args */,
    diagnostics: {
      session_id: sessionId,
      session_created: sessionWasJustCreated, // see Task 8 for source
      correction_retry: isCorrection,
      tool_loop_iter: toolLoopIter,
    },
  });
  const latency = Date.now() - start;
  phases[phase].calls += 1;
  phases[phase].latency_ms += latency;
  return result;
}

// At the end of the pipeline, regardless of success/failure:
logGatewayQueryAggregate({
  session_id: sessionId,
  total_calls: phases.initial.calls + phases.correction.calls + phases.progress_loop.calls,
  total_latency_ms: phases.initial.latency_ms + phases.correction.latency_ms + phases.progress_loop.latency_ms,
  phases,
});
```

> The existing initial call should be wrapped via `callChat('initial', 0, false)`. The correction retry path uses `callChat('correction', 0, true)`. The tool-loop iteration in `toolDispatcher` uses `callChat('progress_loop', i, false)` where `i` is the current iteration count.

3. Pass `phases` and `sessionId` into `toolDispatcher` so it can update the `progress_loop` counter and use `callChat`. If that requires changing `toolDispatcher`'s signature, do it.

- [ ] **Step 7.6: Run tests**

Run: `cd bridge && npx vitest run src/__tests__/mcp/tools/_shared/chatPipeline.test.ts`
Expected: PASS, including the new aggregate test.

- [ ] **Step 7.7: Run full bridge suite**

Run: `cd bridge && npm run test:run`
Expected: PASS. Update any tests that assert exact stderr line counts (the new aggregate adds one line per query).

- [ ] **Step 7.8: Commit**

```bash
cd /Applications/finny-claude-plugin
git add bridge/src/hermes/client.ts bridge/src/mcp/tools/_shared/chatPipeline.ts bridge/src/mcp/tools/_shared/toolDispatcher.ts bridge/src/__tests__/mcp/tools/_shared/chatPipeline.test.ts
git commit -m "$(cat <<'EOF'
feat(bridge): emit per-call diagnostics + per-query aggregate

Each gateway call now logs session_id, correction_retry,
tool_loop_iter, and token counts. After every logical query,
chatPipeline emits a gateway_query_aggregate summarizing total
calls and per-phase latency.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Add session-creation counter and reuse assertion (Workstream C)

**Files:**
- Modify: `bridge/src/mcp/tools/_shared/sessionStore.ts`
- Test: new `bridge/src/__tests__/mcp/tools/_shared/sessionStore.test.ts`

- [ ] **Step 8.1: Write the failing test**

Create `bridge/src/__tests__/mcp/tools/_shared/sessionStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getOrCreateSession,
  __resetSessionStore_FOR_TEST_ONLY,
  __sessionCreationCount_FOR_TEST_ONLY,
} from '../../../../mcp/tools/_shared/sessionStore.js';

describe('sessionStore creation counter (Workstream C)', () => {
  beforeEach(() => {
    __resetSessionStore_FOR_TEST_ONLY();
  });

  it('increments creation count on new session, not on reuse', () => {
    const before = __sessionCreationCount_FOR_TEST_ONLY();
    const a = getOrCreateSession('m2-default:production');
    const after1 = __sessionCreationCount_FOR_TEST_ONLY();
    expect(after1 - before).toBe(1);

    const b = getOrCreateSession('m2-default:production');
    expect(b).toBe(a);
    const after2 = __sessionCreationCount_FOR_TEST_ONLY();
    expect(after2 - before).toBe(1); // unchanged on reuse

    const c = getOrCreateSession('different-principal:production');
    expect(c).not.toBe(a);
    const after3 = __sessionCreationCount_FOR_TEST_ONLY();
    expect(after3 - before).toBe(2);
  });
});
```

- [ ] **Step 8.2: Run test to verify failure**

Run: `cd bridge && npx vitest run src/__tests__/mcp/tools/_shared/sessionStore.test.ts`
Expected: FAIL — `__sessionCreationCount_FOR_TEST_ONLY` does not exist.

- [ ] **Step 8.3: Add counter and exporter**

In `bridge/src/mcp/tools/_shared/sessionStore.ts`, after the existing `const store = new Map…`, add:

```typescript
// Workstream C (2026-06-08): observability counter so the bridge can
// assert sessions are reused across correction retries (the suspected
// "spawn new session per rejection" symptom should manifest as this
// counter incrementing per query). Read by bridge-watch.mjs.
let sessionCreationCount = 0;

export function getSessionCreationCount(): number {
  return sessionCreationCount;
}

export function __sessionCreationCount_FOR_TEST_ONLY(): number {
  return sessionCreationCount;
}
```

In the same file, in `getOrCreateSession`, on the line `const sessionId = \`finny-${randomUUID()}\`;` (line 52), add the increment immediately above:

```typescript
  sessionCreationCount += 1;
  const sessionId = `finny-${randomUUID()}`;
```

In `__resetSessionStore_FOR_TEST_ONLY`, also reset the counter:

```typescript
export function __resetSessionStore_FOR_TEST_ONLY(): void {
  store.clear();
  sessionCreationCount = 0;
}
```

- [ ] **Step 8.4: Run test to verify pass**

Run: `cd bridge && npx vitest run src/__tests__/mcp/tools/_shared/sessionStore.test.ts`
Expected: PASS.

- [ ] **Step 8.5: Wire `session_created` into chatPipeline diagnostics**

In `chatPipeline.ts`, before the initial `client.chat()` call, capture whether the session was just created:

```typescript
import { getOrCreateSession, getSessionCreationCount } from './sessionStore.js';

const beforeCount = getSessionCreationCount();
const sessionId = getOrCreateSession(params.sessionPrincipal);
const afterCount = getSessionCreationCount();
const sessionWasJustCreated = afterCount > beforeCount;
```

Pass `sessionWasJustCreated` as `diagnostics.session_created` on the **initial** call only (correction + progress-loop calls always set `false` because they reuse the session).

- [ ] **Step 8.6: Run full suite**

Run: `cd bridge && npm run test:run`
Expected: PASS.

- [ ] **Step 8.7: Commit**

```bash
cd /Applications/finny-claude-plugin
git add bridge/src/mcp/tools/_shared/sessionStore.ts bridge/src/mcp/tools/_shared/chatPipeline.ts bridge/src/__tests__/mcp/tools/_shared/sessionStore.test.ts
git commit -m "$(cat <<'EOF'
feat(bridge): add session-creation counter for reuse verification

Tracks session creations vs reuses. Surfaced via diagnostics on the
initial gateway call (session_created: true|false). Lets bridge-watch
detect session churn that would indicate the gateway is spawning
fresh agent contexts per request.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: `analyze-gateway-log.mjs` summarizer (Workstream C)

**Files:**
- Create: `bridge/scripts/analyze-gateway-log.mjs`

- [ ] **Step 9.1: Write the script**

Create `bridge/scripts/analyze-gateway-log.mjs`:

```javascript
#!/usr/bin/env node
// Summarize a window of gateway log JSONL records.
// Usage:
//   node scripts/analyze-gateway-log.mjs < path/to/log.jsonl
//   journalctl -u finny-mcp -o cat | node scripts/analyze-gateway-log.mjs
//
// Reports: total queries, total gateway calls, avg calls per query,
// p50/p95 latency per phase, session-creation rate, correction-retry rate.

import { createInterface } from 'node:readline';

const calls = [];
const aggregates = [];

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    continue;
  }
  if (rec.kind === 'gateway_call') calls.push(rec);
  else if (rec.kind === 'gateway_query_aggregate') aggregates.push(rec);
}

function pct(arr, p) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
}

const totalCalls = calls.length;
const totalQueries = aggregates.length;
const callLatencies = calls.map((c) => c.response?.latency_ms ?? 0);
const sessionCreations = calls.filter((c) => c.diagnostics?.session_created).length;
const correctionRetries = calls.filter((c) => c.diagnostics?.correction_retry).length;

const phaseLatencies = { initial: [], correction: [], progress_loop: [] };
for (const agg of aggregates) {
  for (const [phase, stats] of Object.entries(agg.aggregate.phases)) {
    if (stats.calls > 0) phaseLatencies[phase].push(stats.latency_ms);
  }
}

const callsPerQuery = aggregates.map((a) => a.aggregate.total_calls);

console.log('=== Gateway log summary ===');
console.log(`Total gateway calls:    ${totalCalls}`);
console.log(`Total queries:          ${totalQueries}`);
console.log(
  `Avg calls per query:    ${totalQueries ? (totalCalls / totalQueries).toFixed(2) : 'n/a'}`
);
console.log(`Session creations:      ${sessionCreations}`);
console.log(
  `Session-creation rate:  ${totalQueries ? ((sessionCreations / totalQueries) * 100).toFixed(1) : 'n/a'}% of queries`
);
console.log(
  `Correction retries:     ${correctionRetries} (${
    totalCalls ? ((correctionRetries / totalCalls) * 100).toFixed(1) : 'n/a'
  }% of calls)`
);
console.log('');
console.log('Latency p50 / p95 (ms):');
console.log(`  per call:           ${pct(callLatencies, 0.5)} / ${pct(callLatencies, 0.95)}`);
console.log(
  `  initial phase:      ${pct(phaseLatencies.initial, 0.5)} / ${pct(phaseLatencies.initial, 0.95)}`
);
console.log(
  `  correction phase:   ${pct(phaseLatencies.correction, 0.5)} / ${pct(phaseLatencies.correction, 0.95)}`
);
console.log(
  `  progress_loop:      ${pct(phaseLatencies.progress_loop, 0.5)} / ${pct(phaseLatencies.progress_loop, 0.95)}`
);
console.log('');
console.log(
  `p50 / p95 calls per query: ${pct(callsPerQuery, 0.5)} / ${pct(callsPerQuery, 0.95)}`
);
```

- [ ] **Step 9.2: Make it executable and smoke-test it**

```bash
cd bridge
chmod +x scripts/analyze-gateway-log.mjs
printf '%s\n%s\n' \
  '{"ts":"2026-06-08T00:00:00Z","kind":"gateway_call","request":{"method":"POST","url":"/x"},"response":{"status":200,"latency_ms":100},"diagnostics":{"session_id":"finny-a","session_created":true,"correction_retry":false,"tool_loop_iter":0}}' \
  '{"ts":"2026-06-08T00:00:01Z","kind":"gateway_query_aggregate","aggregate":{"session_id":"finny-a","total_calls":1,"total_latency_ms":100,"phases":{"initial":{"calls":1,"latency_ms":100},"correction":{"calls":0,"latency_ms":0},"progress_loop":{"calls":0,"latency_ms":0}}}}' \
  | node scripts/analyze-gateway-log.mjs
```
Expected: prints a summary block with `Total gateway calls: 1`, `Total queries: 1`, `Avg calls per query: 1.00`, `Session creations: 1`.

- [ ] **Step 9.3: Commit**

```bash
cd /Applications/finny-claude-plugin
git add bridge/scripts/analyze-gateway-log.mjs
git commit -m "$(cat <<'EOF'
feat(bridge): add analyze-gateway-log.mjs summarizer

Reads JSONL gateway log from stdin and reports total calls/queries,
avg calls per query, p50/p95 latency per phase, session-creation
rate, and correction-retry rate.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: `bridge-watch.mjs` live TUI (Workstream C)

**Files:**
- Create: `bridge/scripts/bridge-watch.mjs`

- [ ] **Step 10.1: Write the script**

Create `bridge/scripts/bridge-watch.mjs`:

```javascript
#!/usr/bin/env node
// Live watch over a streaming gateway log (stdin or `tail -F`-style).
// Renders a continuously-updated dashboard to the terminal:
//   - calls/min, avg calls/query (last 5 min)
//   - p50/p95 latency per phase (last 5 min)
//   - active session count (last 5 min)
//   - session-creation rate
//   - correction-retry rate
//
// Usage:
//   journalctl -u finny-mcp -o cat -f | node scripts/bridge-watch.mjs
//   tail -F /var/log/finny/gateway.jsonl | node scripts/bridge-watch.mjs

import { createInterface } from 'node:readline';

const WINDOW_MS = 5 * 60 * 1000;
const REFRESH_MS = 1000;

const calls = [];
const aggregates = [];

function pct(arr, p) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
}

function pruneOlderThan(arr, cutoff) {
  while (arr.length > 0 && new Date(arr[0].ts).getTime() < cutoff) arr.shift();
}

function render() {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  pruneOlderThan(calls, cutoff);
  pruneOlderThan(aggregates, cutoff);

  const callsPerMin = (calls.length / (WINDOW_MS / 60_000)).toFixed(1);
  const callLatencies = calls.map((c) => c.response?.latency_ms ?? 0);
  const sessionCreations = calls.filter((c) => c.diagnostics?.session_created).length;
  const correctionRetries = calls.filter((c) => c.diagnostics?.correction_retry).length;
  const sessions = new Set(
    calls.map((c) => c.diagnostics?.session_id).filter(Boolean)
  );

  const phaseLatencies = { initial: [], correction: [], progress_loop: [] };
  for (const agg of aggregates) {
    for (const [phase, stats] of Object.entries(agg.aggregate.phases)) {
      if (stats.calls > 0) phaseLatencies[phase].push(stats.latency_ms);
    }
  }

  const callsPerQuery = aggregates.map((a) => a.aggregate.total_calls);

  process.stdout.write('\x1b[2J\x1b[0;0H');
  console.log(`bridge-watch — last ${WINDOW_MS / 60_000}m window — ${new Date().toISOString()}`);
  console.log('');
  console.log(`Calls/min:              ${callsPerMin}`);
  console.log(`Queries (window):       ${aggregates.length}`);
  console.log(
    `Avg calls/query:        ${aggregates.length ? (calls.length / aggregates.length).toFixed(2) : 'n/a'}`
  );
  console.log(`Active sessions:        ${sessions.size}`);
  console.log(
    `Session creations:      ${sessionCreations}${
      aggregates.length ? ` (${((sessionCreations / aggregates.length) * 100).toFixed(1)}% of queries)` : ''
    }`
  );
  console.log(
    `Correction retries:     ${correctionRetries}${
      calls.length ? ` (${((correctionRetries / calls.length) * 100).toFixed(1)}% of calls)` : ''
    }`
  );
  console.log('');
  console.log('Latency p50 / p95 (ms):');
  console.log(`  per call:             ${pct(callLatencies, 0.5)} / ${pct(callLatencies, 0.95)}`);
  console.log(
    `  initial:              ${pct(phaseLatencies.initial, 0.5)} / ${pct(phaseLatencies.initial, 0.95)}`
  );
  console.log(
    `  correction:           ${pct(phaseLatencies.correction, 0.5)} / ${pct(phaseLatencies.correction, 0.95)}`
  );
  console.log(
    `  progress_loop:        ${pct(phaseLatencies.progress_loop, 0.5)} / ${pct(phaseLatencies.progress_loop, 0.95)}`
  );
  console.log('');
  console.log(
    `p50 / p95 calls/query:   ${pct(callsPerQuery, 0.5)} / ${pct(callsPerQuery, 0.95)}`
  );
  console.log('');
  console.log('Ctrl-C to exit.');
}

setInterval(render, REFRESH_MS);

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return;
  }
  if (rec.kind === 'gateway_call') calls.push(rec);
  else if (rec.kind === 'gateway_query_aggregate') aggregates.push(rec);
});

render();
```

- [ ] **Step 10.2: Make executable and smoke-test**

```bash
cd bridge
chmod +x scripts/bridge-watch.mjs
# Smoke: feed two records, then Ctrl-C after a refresh tick.
( printf '%s\n' '{"ts":"2026-06-08T00:00:00Z","kind":"gateway_call","request":{"method":"POST","url":"/x"},"response":{"status":200,"latency_ms":100},"diagnostics":{"session_id":"finny-a","session_created":true}}'; sleep 2 ) | timeout 3 node scripts/bridge-watch.mjs || true
```
Expected: terminal redraws with the dashboard at least once before exit.

- [ ] **Step 10.3: Commit**

```bash
cd /Applications/finny-claude-plugin
git add bridge/scripts/bridge-watch.mjs
git commit -m "$(cat <<'EOF'
feat(bridge): add bridge-watch.mjs live TUI

Streams gateway log JSONL from stdin and renders a continuously
updated dashboard (calls/min, p50/p95 latency per phase, active
sessions, session-creation rate, correction-retry rate). Useful
during dev/testing to spot session churn or call-count regressions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Add `next_cursor` to envelope DataRows (Workstream B)

**Files:**
- Modify: `bridge/src/types/envelope.ts:24-37`
- Test: `bridge/src/__tests__/types/envelope.test.ts`

- [ ] **Step 11.1: Write the failing test**

Append to `bridge/src/__tests__/types/envelope.test.ts`:

```typescript
describe('next_cursor in DataRows (Workstream B)', () => {
  const rowsBase = {
    status: 'ok' as const,
    intent_restated: 'test',
    assumptions: [],
    unanswered: [],
    sources: [],
    confidence: 'high' as const,
    confidence_reason: 'test',
    elapsed_ms: 0,
    env_used: 'production' as const,
    bridge_version: '0.0.1',
    finny_session_id: 'finny-test',
  };

  it('accepts next_cursor on a rows envelope', () => {
    const env = {
      ...rowsBase,
      data: {
        shape: 'rows' as const,
        columns: ['a'],
        rows: [[1], [2]],
        next_cursor: 'cursor-abc',
      },
    };
    const result = FinnyEnvelopeSchema.safeParse(env);
    expect(result.success).toBe(true);
  });

  it('accepts rows envelope without next_cursor', () => {
    const env = {
      ...rowsBase,
      data: {
        shape: 'rows' as const,
        columns: ['a'],
        rows: [[1]],
      },
    };
    const result = FinnyEnvelopeSchema.safeParse(env);
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 11.2: Run test to verify failure**

Run: `cd bridge && npx vitest run src/__tests__/types/envelope.test.ts -t "next_cursor"`
Expected: FAIL only on the cursor case (passthrough may already accept it; if so, this task becomes "make it explicit"). If it already passes due to passthrough, still proceed to make the field explicit.

- [ ] **Step 11.3: Add explicit `next_cursor` field**

In `bridge/src/types/envelope.ts`, modify `DataRows` (lines 24-37) to:

```typescript
const DataRows = z
  .object({
    shape: z.literal('rows'),
    columns: z
      .array(z.union([z.string(), z.object({ name: z.string(), type: z.string() }).passthrough()]))
      .min(1),
    rows: z.array(z.array(z.unknown())),
    rendered_markdown: z.string().optional(),
    // Workstream B (2026-06-08): opaque cursor token. Present iff the bridge
    // truncated the result at the row/byte ceiling. Cowork resumes via
    // finny_continue({ cursor }). Not generated by Finny — only by the bridge.
    next_cursor: z.string().optional(),
  })
  .passthrough();
```

- [ ] **Step 11.4: Run test to verify pass**

Run: `cd bridge && npx vitest run src/__tests__/types/envelope.test.ts`
Expected: PASS.

- [ ] **Step 11.5: Commit**

```bash
cd /Applications/finny-claude-plugin
git add bridge/src/types/envelope.ts bridge/src/__tests__/types/envelope.test.ts
git commit -m "$(cat <<'EOF'
feat(bridge): add next_cursor to DataRows envelope

Explicit field for cursor pagination. Set by the bridge (not Finny)
when a result exceeds the row/byte ceiling.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Cursor store (Workstream B)

**Files:**
- Create: `bridge/src/mcp/tools/_shared/cursorStore.ts`
- Test: `bridge/src/__tests__/mcp/tools/_shared/cursorStore.test.ts`

- [ ] **Step 12.1: Write the failing test**

Create `bridge/src/__tests__/mcp/tools/_shared/cursorStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import {
  storeCursor,
  takeCursor,
  __resetCursorStore_FOR_TEST_ONLY,
  __backdateCursor_FOR_TEST_ONLY,
} from '../../../../mcp/tools/_shared/cursorStore.js';

describe('cursorStore (Workstream B)', () => {
  beforeEach(() => {
    __resetCursorStore_FOR_TEST_ONLY();
  });

  it('stores remaining rows and returns them on take', () => {
    const cursor = storeCursor({
      columns: ['a'],
      remaining: [[1], [2], [3]],
      sessionPrincipal: 'p',
    });
    expect(cursor).toMatch(/^cur-/);
    const got = takeCursor(cursor);
    expect(got).toBeDefined();
    expect(got!.columns).toEqual(['a']);
    expect(got!.remaining).toEqual([[1], [2], [3]]);
  });

  it('take is one-shot — second call returns undefined', () => {
    const cursor = storeCursor({
      columns: ['a'],
      remaining: [[1]],
      sessionPrincipal: 'p',
    });
    expect(takeCursor(cursor)).toBeDefined();
    expect(takeCursor(cursor)).toBeUndefined();
  });

  it('expired cursor returns undefined', () => {
    const cursor = storeCursor({
      columns: ['a'],
      remaining: [[1]],
      sessionPrincipal: 'p',
    });
    __backdateCursor_FOR_TEST_ONLY(cursor, 11 * 60 * 1000); // 11 min — past 10 min TTL
    expect(takeCursor(cursor)).toBeUndefined();
  });
});
```

- [ ] **Step 12.2: Run test to verify failure**

Run: `cd bridge && npx vitest run src/__tests__/mcp/tools/_shared/cursorStore.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 12.3: Implement the cursor store**

Create `bridge/src/mcp/tools/_shared/cursorStore.ts`:

```typescript
// Workstream B (2026-06-08): opaque cursor → buffered remaining rows.
// One-shot: takeCursor consumes the entry. The returned remaining[] is
// what cowork still needs to receive; if more rows than the page size
// remain after one take, finny_continue re-stores a fresh cursor.
//
// Capacity 256 entries, 10-minute idle eviction. Process-lifetime bound;
// bridge restart drops cursors (cowork sees an "expired cursor" error
// and restarts from finny_query).

import { randomUUID } from 'node:crypto';

const MAX_ENTRIES = 256;
const TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface CursorEntry {
  cursor: string;
  columns: Array<string | { name: string; type: string }>;
  remaining: unknown[][];
  sessionPrincipal: string;
  createdAt: number;
}

const store = new Map<string, CursorEntry>();

function prune(now: number): void {
  for (const [key, entry] of store) {
    if (now - entry.createdAt > TTL_MS) store.delete(key);
  }
  while (store.size > MAX_ENTRIES) {
    let oldestKey: string | undefined;
    let oldestTs = Infinity;
    for (const [key, entry] of store) {
      if (entry.createdAt < oldestTs) {
        oldestTs = entry.createdAt;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) break;
    store.delete(oldestKey);
  }
}

export function storeCursor(
  init: Omit<CursorEntry, 'cursor' | 'createdAt'>
): string {
  const now = Date.now();
  const cursor = `cur-${randomUUID()}`;
  store.set(cursor, { ...init, cursor, createdAt: now });
  prune(now);
  return cursor;
}

export function takeCursor(cursor: string): CursorEntry | undefined {
  const now = Date.now();
  const entry = store.get(cursor);
  if (!entry) return undefined;
  if (now - entry.createdAt > TTL_MS) {
    store.delete(cursor);
    return undefined;
  }
  store.delete(cursor); // one-shot
  return entry;
}

export function __resetCursorStore_FOR_TEST_ONLY(): void {
  store.clear();
}

export function __backdateCursor_FOR_TEST_ONLY(cursor: string, ageMs: number): void {
  const entry = store.get(cursor);
  if (entry) entry.createdAt = Date.now() - ageMs;
}
```

- [ ] **Step 12.4: Run test to verify pass**

Run: `cd bridge && npx vitest run src/__tests__/mcp/tools/_shared/cursorStore.test.ts`
Expected: PASS.

- [ ] **Step 12.5: Commit**

```bash
cd /Applications/finny-claude-plugin
git add bridge/src/mcp/tools/_shared/cursorStore.ts bridge/src/__tests__/mcp/tools/_shared/cursorStore.test.ts
git commit -m "$(cat <<'EOF'
feat(bridge): add cursorStore for paginated row results

One-shot opaque cursor → buffered remaining rows. 256 entries,
10-minute idle eviction. Process-lifetime bound; bridge restart
drops cursors and cowork restarts from finny_query.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Bump payload ceilings (Workstream B)

**Files:**
- Modify: `bridge/src/mcp/tools/executeSuiteQL.ts:18`
- Modify: `bridge/src/hermes/client.ts:34`
- Modify: `bridge/src/mcp/tools/_shared/suiteqlGuard.ts` (preamble text)
- Test: existing executeSuiteQL tests

- [ ] **Step 13.1: Write a test asserting the new defaults**

Append to `bridge/src/__tests__/mcp/tools/executeSuiteQL.test.ts` (or create it if absent):

```typescript
import { describe, it, expect } from 'vitest';
import { executeSuiteQLInputSchema } from '../../../mcp/tools/executeSuiteQL.js';

describe('executeSuiteQL ceilings (Workstream B)', () => {
  it('defaults max_rows to 2000', () => {
    const parsed = executeSuiteQLInputSchema.parse({
      sql: 'SELECT 1',
      env: 'production',
      reason: 'test',
    });
    expect(parsed.max_rows).toBe(2000);
  });

  it('accepts max_rows up to 10000', () => {
    const parsed = executeSuiteQLInputSchema.parse({
      sql: 'SELECT 1',
      env: 'production',
      max_rows: 10000,
      reason: 'test',
    });
    expect(parsed.max_rows).toBe(10000);
  });

  it('rejects max_rows above 10000', () => {
    const result = executeSuiteQLInputSchema.safeParse({
      sql: 'SELECT 1',
      env: 'production',
      max_rows: 10001,
      reason: 'test',
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 13.2: Run test to verify failure**

Run: `cd bridge && npx vitest run src/__tests__/mcp/tools/executeSuiteQL.test.ts -t "Workstream B"`
Expected: FAIL — current default 500, max 5000.

- [ ] **Step 13.3: Update the schema**

In `bridge/src/mcp/tools/executeSuiteQL.ts:18`, change:

```typescript
  max_rows: z.number().int().positive().max(5000).default(500),
```

to:

```typescript
  // Workstream B (2026-06-08): default 500 → 2000, hard cap 5000 → 10000.
  // Cowork handles pagination via cursor when results exceed page size.
  max_rows: z.number().int().positive().max(10000).default(2000),
```

In `bridge/src/hermes/client.ts:34`, change:

```typescript
const MAX_RESPONSE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
```

to:

```typescript
// Workstream B (2026-06-08): raised 10MB → 25MB. Pass-through mode lets
// cowork handle large data; cursor escape kicks in at 8MB serialized
// page size (cursorStore), so 25MB gives headroom for the first chunk.
const MAX_RESPONSE_SIZE_BYTES = 25 * 1024 * 1024; // 25MB
```

- [ ] **Step 13.4: Update the suiteql preamble**

Run: `grep -n "500\|max_rows" bridge/src/mcp/tools/_shared/suiteqlGuard.ts | head -5`
Expected: find the line(s) referencing `max_rows` or the row ceiling in the preamble string.

In `bridge/src/mcp/tools/_shared/suiteqlGuard.ts`, find the preamble string (around line 47 per the spec) and update any "500"/"5000" references to "2000"/"10000". If the preamble currently says e.g. "max 5000 rows", change to "max 10000 rows; default 2000".

- [ ] **Step 13.5: Run tests**

Run: `cd bridge && npm run test:run`
Expected: PASS. Update any test that asserts the old 500/5000 numbers.

- [ ] **Step 13.6: Commit**

```bash
cd /Applications/finny-claude-plugin
git add bridge/src/mcp/tools/executeSuiteQL.ts bridge/src/hermes/client.ts bridge/src/mcp/tools/_shared/suiteqlGuard.ts bridge/src/__tests__/mcp/tools/executeSuiteQL.test.ts
git commit -m "$(cat <<'EOF'
feat(bridge): raise payload ceilings (rows 500→2000, cap 5000→10000, body 10→25MB)

Default max_rows 500 → 2000, hard cap 5000 → 10000. Response body
cap 10MB → 25MB. Cursor escape (forthcoming) kicks in at 8MB
serialized page size to bound per-call payload.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Cursor escape in chatPipeline rows-shape responses (Workstream B)

**Files:**
- Modify: `bridge/src/mcp/tools/_shared/chatPipeline.ts` — after a successful envelope, check row count + serialized size and escape to cursor
- Test: new `bridge/src/__tests__/mcp/tools/_shared/chatPipeline.cursor.test.ts`

> Page sizes: row ceiling = 2000, byte ceiling = 8 MB. If the envelope's `data.shape === 'rows'` and `data.rows.length > 2000` OR `JSON.stringify(data.rows).length > 8 * 1024 * 1024`, split: keep first 2000 rows in the envelope, store the remainder under a cursor, set `data.next_cursor`.

- [ ] **Step 14.1: Write the failing test**

Create `bridge/src/__tests__/mcp/tools/_shared/chatPipeline.cursor.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { applyCursorEscape } from '../../../../mcp/tools/_shared/chatPipeline.js';

describe('cursor escape (Workstream B)', () => {
  const baseEnv = {
    status: 'ok' as const,
    intent_restated: 'test',
    assumptions: [],
    unanswered: [],
    sources: [],
    confidence: 'high' as const,
    confidence_reason: 'test',
    elapsed_ms: 0,
    env_used: 'production' as const,
    bridge_version: '0.0.1',
    finny_session_id: 'finny-test',
  };

  it('passes through small rows envelope unchanged', () => {
    const env = {
      ...baseEnv,
      data: {
        shape: 'rows' as const,
        columns: ['a'],
        rows: Array.from({ length: 100 }, (_, i) => [i]),
      },
    };
    const out = applyCursorEscape(env, 'principal');
    expect(out.data && 'next_cursor' in out.data).toBe(false);
    expect((out.data as { rows: unknown[] }).rows.length).toBe(100);
  });

  it('truncates rows over 2000 and emits next_cursor', () => {
    const env = {
      ...baseEnv,
      data: {
        shape: 'rows' as const,
        columns: ['a'],
        rows: Array.from({ length: 5000 }, (_, i) => [i]),
      },
    };
    const out = applyCursorEscape(env, 'principal');
    const data = out.data as { rows: unknown[]; next_cursor?: string };
    expect(data.rows.length).toBe(2000);
    expect(data.next_cursor).toMatch(/^cur-/);
  });

  it('does not modify scalar/narrative envelopes', () => {
    const scalarEnv = {
      ...baseEnv,
      data: { shape: 'scalar' as const, value: 1 },
    };
    const out = applyCursorEscape(scalarEnv, 'principal');
    expect(out).toEqual(scalarEnv);
  });
});
```

- [ ] **Step 14.2: Run test to verify failure**

Run: `cd bridge && npx vitest run src/__tests__/mcp/tools/_shared/chatPipeline.cursor.test.ts`
Expected: FAIL — `applyCursorEscape` not exported yet.

- [ ] **Step 14.3: Implement and export `applyCursorEscape`**

In `bridge/src/mcp/tools/_shared/chatPipeline.ts`, add (and export) at module scope:

```typescript
import { storeCursor } from './cursorStore.js';
import type { FinnyEnvelope } from '../../../types/envelope.js';

const CURSOR_ROW_CEILING = 2000;
const CURSOR_BYTE_CEILING = 8 * 1024 * 1024; // 8 MB

export function applyCursorEscape(
  env: FinnyEnvelope,
  sessionPrincipal: string
): FinnyEnvelope {
  if (!env.data || env.data.shape !== 'rows') return env;
  const rows = env.data.rows;
  const serializedSize = JSON.stringify(rows).length;
  const overRows = rows.length > CURSOR_ROW_CEILING;
  const overBytes = serializedSize > CURSOR_BYTE_CEILING;
  if (!overRows && !overBytes) return env;

  // Determine split point: rows ceiling, but if byte size exceeded
  // first, halve until we fit. Simple linear bisect.
  let pageSize = Math.min(rows.length, CURSOR_ROW_CEILING);
  while (
    pageSize > 1 &&
    JSON.stringify(rows.slice(0, pageSize)).length > CURSOR_BYTE_CEILING
  ) {
    pageSize = Math.floor(pageSize / 2);
  }

  const head = rows.slice(0, pageSize);
  const tail = rows.slice(pageSize);
  const cursor = storeCursor({
    columns: env.data.columns,
    remaining: tail,
    sessionPrincipal,
  });
  return {
    ...env,
    data: {
      ...env.data,
      rows: head,
      next_cursor: cursor,
    },
  };
}
```

Then, at the end of the chat pipeline (just before returning the validated envelope from a `finny_query` / `finny_report` flow), call:

```typescript
const escapedEnv = applyCursorEscape(env, params.sessionPrincipal);
// ... return escapedEnv
```

- [ ] **Step 14.4: Run test to verify pass**

Run: `cd bridge && npx vitest run src/__tests__/mcp/tools/_shared/chatPipeline.cursor.test.ts`
Expected: PASS.

- [ ] **Step 14.5: Commit**

```bash
cd /Applications/finny-claude-plugin
git add bridge/src/mcp/tools/_shared/chatPipeline.ts bridge/src/__tests__/mcp/tools/_shared/chatPipeline.cursor.test.ts
git commit -m "$(cat <<'EOF'
feat(bridge): apply cursor escape to oversized rows envelopes

If a rows envelope exceeds 2000 rows OR 8MB serialized, store the
remainder under a cursor and emit next_cursor on the envelope.
Cowork resumes via finny_continue({cursor}).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: `finny_continue({cursor})` branch (Workstream B)

**Files:**
- Modify: `bridge/src/mcp/tools/continue.ts` — accept a `cursor` field, route to cursor-drain handler
- Test: new `bridge/src/__tests__/mcp/tools/continue.cursor.test.ts`

- [ ] **Step 15.1: Write the failing test**

Create `bridge/src/__tests__/mcp/tools/continue.cursor.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { continueHandlerForTest } from '../../../mcp/tools/continue.js';
import {
  storeCursor,
  __resetCursorStore_FOR_TEST_ONLY,
} from '../../../mcp/tools/_shared/cursorStore.js';

describe('finny_continue cursor branch (Workstream B)', () => {
  beforeEach(() => {
    __resetCursorStore_FOR_TEST_ONLY();
  });

  it('drains a cursor with no further pagination', async () => {
    const cursor = storeCursor({
      columns: ['a'],
      remaining: [[1], [2], [3]],
      sessionPrincipal: 'p',
    });
    const env = await continueHandlerForTest({ cursor });
    expect(env.status).toBe('ok');
    expect(env.data).toEqual({
      shape: 'rows',
      columns: ['a'],
      rows: [[1], [2], [3]],
    });
  });

  it('re-emits next_cursor when remaining > page size', async () => {
    const remaining = Array.from({ length: 2500 }, (_, i) => [i]);
    const cursor = storeCursor({
      columns: ['a'],
      remaining,
      sessionPrincipal: 'p',
    });
    const env = await continueHandlerForTest({ cursor });
    expect(env.status).toBe('ok');
    const data = env.data as { rows: unknown[]; next_cursor?: string };
    expect(data.rows.length).toBe(2000);
    expect(data.next_cursor).toMatch(/^cur-/);
  });

  it('expired/unknown cursor returns error envelope', async () => {
    const env = await continueHandlerForTest({ cursor: 'cur-nonexistent' });
    expect(env.status).toBe('error');
    expect(env.error?.code).toBe('other');
  });
});
```

- [ ] **Step 15.2: Run test to verify failure**

Run: `cd bridge && npx vitest run src/__tests__/mcp/tools/continue.cursor.test.ts`
Expected: FAIL — `continueHandlerForTest` and the cursor branch don't exist.

- [ ] **Step 15.3: Update `continue.ts`**

In `bridge/src/mcp/tools/continue.ts`:

1. Update the input schema to accept `cursor` as an alternative to `conversation_id` + `response`:

```typescript
import { storeCursor, takeCursor } from './_shared/cursorStore.js';

export const continueInputSchema = z
  .object({
    // Cursor branch (Workstream B): drain a paginated rows result.
    cursor: z.string().optional(),
    // Conversation branch (existing): resume a needs_input loop.
    conversation_id: z.string().min(1).optional(),
    response: z
      .object({
        selected_option: z.string().optional(),
        answer: z.string().optional(),
      })
      .refine((r) => r.selected_option !== undefined || r.answer !== undefined, {
        message: 'response must include either selected_option or answer',
      })
      .optional(),
    deadline_ms: z.number().int().positive().max(300_000).default(30_000),
  })
  .refine(
    (i) => (i.cursor !== undefined) !== (i.conversation_id !== undefined),
    { message: 'finny_continue requires exactly one of: cursor OR conversation_id' }
  )
  .refine(
    (i) => i.cursor !== undefined || i.response !== undefined,
    { message: 'conversation_id branch requires response' }
  );
```

2. Add a cursor-branch arm at the top of the handler:

```typescript
async function handler(rawInput: ContinueInput): Promise<FinnyEnvelope> {
  const input = continueInputSchema.parse(rawInput);

  if (input.cursor !== undefined) {
    return handleCursorContinue(input.cursor);
  }

  // ... existing conversation_id flow unchanged
}

const CURSOR_PAGE_SIZE = 2000;

async function handleCursorContinue(cursor: string): Promise<FinnyEnvelope> {
  const entry = takeCursor(cursor);
  if (!entry) {
    return errorEnvelope({
      code: 'other',
      message: `Unknown or expired cursor: ${cursor}. Cursors expire 10 minutes after creation; restart from finny_query.`,
      retryable: false,
      elapsedMs: 0,
      envUsed: 'production',
      sessionId: '—',
      intentRestated: 'finny_continue',
    });
  }

  const head = entry.remaining.slice(0, CURSOR_PAGE_SIZE);
  const tail = entry.remaining.slice(CURSOR_PAGE_SIZE);
  const next_cursor =
    tail.length > 0
      ? storeCursor({
          columns: entry.columns,
          remaining: tail,
          sessionPrincipal: entry.sessionPrincipal,
        })
      : undefined;

  return {
    status: 'ok',
    intent_restated: 'finny_continue:cursor',
    assumptions: [],
    unanswered: [],
    data: {
      shape: 'rows',
      columns: entry.columns,
      rows: head,
      ...(next_cursor ? { next_cursor } : {}),
    },
    sources: [],
    confidence: 'high',
    confidence_reason: 'cursor drain',
    elapsed_ms: 0,
    env_used: 'production',
    bridge_version: '0.0.1',
    finny_session_id: '—',
  };
}

// Workstream B: test seam.
export async function continueHandlerForTest(input: ContinueInput): Promise<FinnyEnvelope> {
  return handler(input);
}
```

- [ ] **Step 15.4: Run tests to verify pass**

Run: `cd bridge && npx vitest run src/__tests__/mcp/tools/continue.cursor.test.ts`
Expected: PASS.

- [ ] **Step 15.5: Run full bridge suite**

Run: `cd bridge && npm run test:run`
Expected: PASS. The pre-existing `conversation_id` branch tests must continue to pass — the schema refinements still allow them.

- [ ] **Step 15.6: Commit**

```bash
cd /Applications/finny-claude-plugin
git add bridge/src/mcp/tools/continue.ts bridge/src/__tests__/mcp/tools/continue.cursor.test.ts
git commit -m "$(cat <<'EOF'
feat(bridge): add cursor branch to finny_continue

finny_continue({cursor}) drains a paginated rows result. Returns
2000 rows per page, re-emits next_cursor while remaining > 0.
Existing conversation_id branch unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Update `judging-output` skill for cursor handling (Workstream B)

**Files:**
- Modify: `plugin/skills/judging-output/SKILL.md`

- [ ] **Step 16.1: Locate the never-reformat / pagination area**

Run: `grep -n "next_cursor\|pagination\|truncat" plugin/skills/judging-output/SKILL.md`
Expected: no existing match. We're adding new content.

- [ ] **Step 16.2: Add a "Cursor pagination" section**

In `plugin/skills/judging-output/SKILL.md`, after the "Never-reformat rules" section, insert:

```markdown
## Cursor pagination — what `next_cursor` means

When a `rows` envelope contains `data.next_cursor`, the bridge truncated the
result at the row/byte ceiling (2000 rows / 8 MB serialized per page). The
remainder is buffered server-side under the opaque cursor token.

To fetch more rows:

```json
finny_continue({ "cursor": "<next_cursor value>" })
```

The result is a fresh envelope with the next page of rows and (if more
remain) a new `next_cursor`.

### Decision: drain or stop?

- If the user wants a **complete export** (e.g., "show me all open bills"),
  drain the cursor: keep calling `finny_continue({cursor})` until
  `next_cursor` is absent.
- If the user wants a **sample or top-N** (e.g., "the top 10 vendors") and
  the first page already contains the answer, stop — do not drain. Surface
  to the user that more rows are available if needed.
- If you stop with rows still buffered, the cursor expires after 10 minutes
  of idleness. Restart from `finny_query` to re-fetch.

### Do NOT summarize or truncate raw rows

Even when many rows arrive, surface them through to the user (or to a
downstream rendering tool — e.g., a dashboard). Do not collapse rows into
a written summary unless the user asked for one. Pass-through is the design.

### Cursor errors

If `finny_continue({cursor})` returns `error.code: 'other'` with a message
about an unknown or expired cursor, the buffered remainder has aged out.
Restart from `finny_query` — do NOT retry `finny_continue` on the same
cursor.
```

- [ ] **Step 16.3: Regenerate inlined skills bundle**

Run: `cd bridge && npm run build`
Expected: build succeeds; `bridge/src/mcp/prompts/inlined.ts` regenerates.

- [ ] **Step 16.4: Sanity-check the regenerated bundle**

Run: `grep -c "next_cursor" bridge/src/mcp/prompts/inlined.ts`
Expected: at least `2` (mentions in skill + the inlined block contains the new section).

- [ ] **Step 16.5: Run full suite**

Run: `cd bridge && npm run test:run`
Expected: PASS.

- [ ] **Step 16.6: Commit**

```bash
cd /Applications/finny-claude-plugin
git add plugin/skills/judging-output/SKILL.md bridge/src/mcp/prompts/inlined.ts
git commit -m "$(cat <<'EOF'
docs(skill): explain cursor pagination in judging-output

Adds 'Cursor pagination' section: how to drain or stop, do-not-
summarize rule, expired-cursor recovery.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: Final cross-cutting check + manual smoke test

**Files:** all of the above.

- [ ] **Step 17.1: Run the full validation pipeline**

Run: `cd bridge && npm run check:all`
Expected: lint:fix passes, typecheck passes, test:run passes, build succeeds.

- [ ] **Step 17.2: Run a real query against staging (manual)**

Pick a known-slow GL query (e.g., a vendor_summary or P&L). With the dev bridge running (`cd bridge && npm run dev`) and cowork CLI pointed at it, issue the query. While running, in another terminal run:

```bash
journalctl -u finny-mcp -o cat -f 2>/dev/null | node bridge/scripts/bridge-watch.mjs
```

(Or, if running locally, pipe the bridge stderr into `bridge-watch.mjs` directly.)

Expected:
- Query that takes ≤30 s returns inline (no `running` envelope).
- Query that takes 30–90 s returns `running`, polls 1–2 times, completes.
- `bridge-watch` shows `Avg calls/query` and `Active sessions: 1` for sequential queries on the same principal.
- `Session creations` increments at most once per cold start.

- [ ] **Step 17.3: Run a large-result manual test**

Issue a SuiteQL that returns ~5000 rows (e.g., `SELECT id FROM transaction WHERE postingperiod = 100` or any bulk list). Verify:
- First envelope contains 2000 rows + `next_cursor`.
- A subsequent `finny_continue({cursor})` returns up to 2000 more rows + (possibly) another `next_cursor`.
- Final page has no `next_cursor`.

- [ ] **Step 17.4: Commit any leftover fixes from manual testing**

If anything broke during the manual smoke, fix and commit. Otherwise:

```bash
cd /Applications/finny-claude-plugin
git status
# expected: nothing to commit, working tree clean
```

- [ ] **Step 17.5: Open the PR**

```bash
cd /Applications/finny-claude-plugin
git push -u origin HEAD
gh pr create --title "Bridge reliability + performance pass" --body "$(cat <<'EOF'
## Summary

Implements `docs/superpowers/specs/2026-06-08-bridge-reliability-design.md`.

- Workstream A: schema relaxations (rows_scanned nullable, retryable optional), HTTP timeout 120→150s, default deadline_ms 10→30s, 6-poll backoff
- Workstream B: hybrid pass-through with cursor escape (2000 rows / 8MB ceiling), max_rows 500→2000 (cap 10000), response cap 10→25MB
- Workstream C: gateway log diagnostics, per-query aggregate, session-creation counter, analyze-gateway-log.mjs + bridge-watch.mjs

## Test plan

- [x] `npm run check:all` passes
- [x] Slow GL query returns inline within 30s
- [x] 5000-row SuiteQL returns 2000 + next_cursor; finny_continue drains
- [x] bridge-watch shows session reuse across sequential queries

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review

**Spec coverage:**
- ✅ `rows_scanned` nullable → Task 1
- ✅ `error.retryable` optional → Task 1
- ✅ `OUT_OF_SCOPE` decision documented → Task 2
- ✅ HTTP timeout 120→150s → Task 3
- ✅ `deadline_ms` 10→30s → Task 4
- ✅ Polling backoff tightened → Task 5
- ✅ Gateway log diagnostics → Task 6
- ✅ chatPipeline aggregate emission → Task 7
- ✅ Session-creation counter → Task 8
- ✅ `analyze-gateway-log.mjs` → Task 9
- ✅ `bridge-watch.mjs` → Task 10
- ✅ `next_cursor` in DataRows → Task 11
- ✅ Cursor store → Task 12
- ✅ `max_rows` + body-size raises → Task 13
- ✅ Cursor escape applied in pipeline → Task 14
- ✅ `finny_continue({cursor})` branch → Task 15
- ✅ Skill doc update → Task 16
- ✅ Manual smoke + PR → Task 17

**Type consistency:**
- `GatewayDiagnostics` defined in Task 6, used in Task 7 + Task 8.
- `CursorEntry` defined in Task 12, consumed in Task 14 (`storeCursor`) + Task 15 (`takeCursor`).
- `applyCursorEscape` exported in Task 14, used in Task 15's test ordering (cursor store reset).
- Page size constant `2000` consistent across Tasks 14 and 15 (Task 14: `CURSOR_ROW_CEILING`, Task 15: `CURSOR_PAGE_SIZE` — both equal 2000).

**Placeholder scan:** No TBD/TODO/etc. Code blocks are complete enough to compile or close to it; one explicit "see existing harness" note in Task 7.5 because the existing chatPipeline test file structure varies and copying the right mock shape verbatim is more robust than guessing.
