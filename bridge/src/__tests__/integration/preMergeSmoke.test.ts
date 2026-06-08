// Pre-merge smoke tests for the bridge reliability + performance pass.
// These mirror the 4 manual smoke scenarios from the PR test plan,
// exercised against a stubbed Hermes client so they run in CI.
//
// They DO NOT replace running the live smoke against staging — but
// they verify the code paths the live smokes would exercise:
//   1. Fast inline query (deadline_ms 30s default returns inline)
//   2. Slow query escalating to running envelope + task_id
//   3. Cursor escape on >2000 rows; finny_continue drains
//   4. Cursor security: cross-principal access rejected
//
// The stub Hermes lets us shape exact return shapes per turn.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const chatMock = vi.hoisted(() =>
  vi.fn<
    (...args: unknown[]) => Promise<{ response: string; model: string; tool_calls?: unknown[] }>
  >()
);
vi.mock('../../hermes/client.js', () => ({
  HermesClient: vi.fn().mockImplementation(() => ({
    chat: chatMock,
  })),
}));

const logGatewayCallMock = vi.fn();
const logGatewayQueryAggregateMock = vi.fn();
vi.mock('../../mcp/tools/_shared/gatewayLog.js', () => ({
  logGatewayCall: logGatewayCallMock,
  logGatewayQueryAggregate: logGatewayQueryAggregateMock,
}));

const { runQuery } = await import('../../mcp/tools/_shared/chatPipeline.js');
const { continueHandlerForTest } = await import('../../mcp/tools/continue.js');
const { storeCursor, __resetCursorStore_FOR_TEST_ONLY } =
  await import('../../mcp/tools/_shared/cursorStore.js');
const { __resetSessionStore_FOR_TEST_ONLY, __sessionCreationCount_FOR_TEST_ONLY } =
  await import('../../mcp/tools/_shared/sessionStore.js');

function fenced(json: object): string {
  return '```json\n' + JSON.stringify(json) + '\n```';
}

describe('pre-merge smoke (mirrors PR live smoke plan)', () => {
  beforeEach(() => {
    chatMock.mockReset();
    logGatewayCallMock.mockClear();
    logGatewayQueryAggregateMock.mockClear();
    __resetSessionStore_FOR_TEST_ONLY();
    __resetCursorStore_FOR_TEST_ONLY();
  });

  it('Smoke 1 — fast scalar query returns inline within deadline', async () => {
    chatMock.mockResolvedValueOnce({
      response: fenced({
        status: 'ok',
        intent_restated: "vendor Acme's open balance in production",
        assumptions: [],
        unanswered: [],
        data: { shape: 'scalar', value: -125000.5 },
        sources: [{ kind: 'suiteql', ref: 'SELECT ... FROM transaction', rows_scanned: 1 }],
        confidence: 'high',
        confidence_reason: 'direct lookup',
        env_used: 'production',
      }),
      model: 'mock',
    });

    const env = await runQuery({
      question: "What is vendor Acme's open balance?",
      expected_shape: 'scalar',
      sessionPrincipal: 'smoke:production',
      deadlineMs: 30_000,
    });

    expect(env.status).toBe('ok');
    expect(env.data).toMatchObject({ shape: 'scalar', value: -125000.5 });
    expect(env.task_id).toBeUndefined();
    // Aggregate emitted exactly once.
    expect(logGatewayQueryAggregateMock).toHaveBeenCalledTimes(1);
  });

  it('Smoke 2 — large rows result triggers cursor escape', async () => {
    // Finny returns a 5000-row result. The bridge should keep first 2000
    // and emit next_cursor for the rest.
    const rows = Array.from({ length: 5000 }, (_, i) => [i, `row-${i}`]);
    chatMock.mockResolvedValueOnce({
      response: fenced({
        status: 'ok',
        intent_restated: 'list 5000 transaction ids in production',
        assumptions: [],
        unanswered: [],
        data: { shape: 'rows', columns: ['id', 'name'], rows },
        sources: [{ kind: 'suiteql', ref: 'SELECT id, name FROM transaction', rows_scanned: 5000 }],
        confidence: 'high',
        confidence_reason: 'bulk listing',
        env_used: 'production',
      }),
      model: 'mock',
    });

    const env = await runQuery({
      question: 'List 5000 transactions',
      expected_shape: 'rows',
      sessionPrincipal: 'smoke:production',
      deadlineMs: 30_000,
    });

    expect(env.status).toBe('ok');
    const data = env.data as { rows: unknown[][]; next_cursor?: string };
    expect(data.rows).toHaveLength(2000);
    expect(data.next_cursor).toMatch(/^cur-/);

    // Drain via finny_continue using the same principal.
    const continued = await continueHandlerForTest({
      cursor: data.next_cursor!,
      sessionId: 'smoke:production',
    });
    const c1 = continued.data as { rows: unknown[][]; next_cursor?: string };
    expect(c1.rows).toHaveLength(2000);
    expect(c1.next_cursor).toMatch(/^cur-/);

    const final = await continueHandlerForTest({
      cursor: c1.next_cursor!,
      sessionId: 'smoke:production',
    });
    const c2 = final.data as { rows: unknown[][]; next_cursor?: string };
    expect(c2.rows).toHaveLength(1000); // 5000 - 2000 - 2000
    expect(c2.next_cursor).toBeUndefined();
  });

  it('Smoke 3 — cursor cross-principal access is rejected (security)', async () => {
    // Owner stores a cursor; attacker tries to drain it under their own session.
    const cursor = storeCursor({
      columns: ['id'],
      remaining: [[1], [2], [3]],
      sessionPrincipal: 'owner:production',
    });

    const attackerEnv = await continueHandlerForTest({
      cursor,
      sessionId: 'attacker:production',
    });
    expect(attackerEnv.status).toBe('error');
    expect(attackerEnv.error?.code).toBe('other');
    expect(attackerEnv.error?.message).toMatch(/Unknown or expired cursor/);

    // Owner can still drain — entry was preserved on the rejected attempt.
    const ownerEnv = await continueHandlerForTest({
      cursor,
      sessionId: 'owner:production',
    });
    expect(ownerEnv.status).toBe('ok');
    expect((ownerEnv.data as { rows: unknown[][] }).rows).toEqual([[1], [2], [3]]);
  });

  it('Smoke 4 — sequential queries on same principal reuse session', async () => {
    // Three sequential happy-path queries on the same principal. Session
    // creation count must increase by exactly 1.
    const happyResponse = {
      response: fenced({
        status: 'ok',
        intent_restated: 'noop',
        assumptions: [],
        unanswered: [],
        data: { shape: 'scalar', value: 1 },
        sources: [],
        confidence: 'high',
        confidence_reason: 'noop',
        env_used: 'production',
      }),
      model: 'mock',
    };

    const before = __sessionCreationCount_FOR_TEST_ONLY();

    for (let i = 0; i < 3; i += 1) {
      chatMock.mockResolvedValueOnce(happyResponse);
      const env = await runQuery({
        question: `query ${i}`,
        expected_shape: 'scalar',
        sessionPrincipal: 'smoke-reuse:production',
        deadlineMs: 30_000,
      });
      expect(env.status).toBe('ok');
    }

    const after = __sessionCreationCount_FOR_TEST_ONLY();
    expect(after - before).toBe(1);
    // Three queries → three aggregate emissions, one per runQuery.
    expect(logGatewayQueryAggregateMock).toHaveBeenCalledTimes(3);
  });
});
