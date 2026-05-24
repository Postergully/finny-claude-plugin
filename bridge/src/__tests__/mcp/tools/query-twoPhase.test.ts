import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FinnyEnvelopeSchema, type FinnyEnvelope } from '../../../types/envelope.js';

// ─── Two-phase finny_query tests (Track E) ──────────────────────────
//
// Two layers of mocking, depending on what we're asserting:
//
// 1. `runQuery` is mocked when we test the handler-level wiring (bless-list
//    scope rejects, phase routing, params plumbing). These assertions don't
//    need the chat pipeline.
//
// 2. The gateway `HermesClient.chat` is mocked when we want to assert
//    that the SYSTEM PROMPT Finny receives carries the right content for
//    the requested phase. This is a separate test file (chatPipeline.test.ts
//    extension below) so we don't have to choose between runQuery-mock and
//    chat-mock in one file.

const runQueryMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<FinnyEnvelope>>());
vi.mock('../../../mcp/tools/_shared/chatPipeline.js', () => ({
  runQuery: runQueryMock,
}));

const { queryTool } = await import('../../../mcp/tools/query.js');

function makeOkRows(): FinnyEnvelope {
  return {
    status: 'ok',
    intent_restated: 'mocked',
    assumptions: [],
    unanswered: [],
    data: {
      shape: 'rows',
      columns: [{ name: 'account', type: 'string' }],
      rows: [['mock', 1]],
    },
    sources: [],
    confidence: 'high',
    confidence_reason: 'mock',
    elapsed_ms: 1,
    env_used: 'production',
    bridge_version: '0.0.1',
    finny_session_id: 'sess',
  };
}

function makeOkNarrative(): FinnyEnvelope {
  return {
    status: 'ok',
    intent_restated: 'discovery for p&l_statement',
    assumptions: [],
    unanswered: [],
    data: { shape: 'narrative', narrative: 'discovery answer text' },
    sources: [],
    confidence: 'high',
    confidence_reason: 'discovery',
    elapsed_ms: 1,
    env_used: 'production',
    bridge_version: '0.0.1',
    finny_session_id: 'sess',
  };
}

beforeEach(() => runQueryMock.mockReset());

describe('Track E — bless-list scope enforcement on execute phase', () => {
  it('blessed intent + execute + missing scope → error.code wrong_tool, ZERO gateway calls', async () => {
    const res = await queryTool.handler({
      intent: 'p&l_statement',
      phase: 'execute',
      scope: {},
      expected_shape: 'rows',
      max_tokens: 2000,
      deadline_ms: 5_000,
      clarifications_resolved: [],
    });

    expect(res.status).toBe('error');
    expect(res.error?.code).toBe('wrong_tool');
    expect(res.error?.retryable).toBe(true);
    // All four required scope vars are named.
    expect(res.error?.message).toContain('entity');
    expect(res.error?.message).toContain('consolidated');
    expect(res.error?.message).toContain('period');
    expect(res.error?.message).toContain('env');
    // The hint to drop back to discover.
    expect(res.error?.message).toMatch(/phase: 'discover'/);
    expect(res.intent_restated).toBe('p&l_statement');

    // Critical: no gateway call was made.
    expect(runQueryMock).not.toHaveBeenCalled();
    expect(FinnyEnvelopeSchema.safeParse(res).success).toBe(true);
  });

  it('blessed intent + execute + partial scope → wrong_tool naming only the missing vars', async () => {
    const res = await queryTool.handler({
      intent: 'p&l_statement',
      phase: 'execute',
      scope: {
        entity: 'sharechat',
        period: { from: '2026-04-01', to: '2026-04-30' },
      },
      expected_shape: 'rows',
      max_tokens: 2000,
      deadline_ms: 5_000,
      clarifications_resolved: [],
    });

    expect(res.error?.code).toBe('wrong_tool');
    expect(res.error?.message).toContain('consolidated');
    expect(res.error?.message).toContain('env');
    expect(res.error?.message).not.toContain('entity,');
    expect(res.error?.message).not.toContain('period,');
    expect(runQueryMock).not.toHaveBeenCalled();
  });

  it('blessed intent + execute + strict_nonempty empty string → wrong_tool', async () => {
    // entity has strict_nonempty: true; whitespace-only string is rejected.
    const res = await queryTool.handler({
      intent: 'vendor_balance',
      phase: 'execute',
      scope: {
        vendor_ref: '   ',
        env: 'production',
      },
      expected_shape: 'scalar',
      max_tokens: 2000,
      deadline_ms: 5_000,
      clarifications_resolved: [],
    });

    expect(res.error?.code).toBe('wrong_tool');
    expect(res.error?.message).toContain('vendor_ref');
    expect(runQueryMock).not.toHaveBeenCalled();
  });

  it('blessed intent + execute + complete scope → reaches runQuery (no rejection)', async () => {
    runQueryMock.mockResolvedValue(makeOkRows());

    const res = await queryTool.handler({
      intent: 'p&l_statement',
      phase: 'execute',
      scope: {
        entity: 'sharechat',
        consolidated: false,
        period: { from: '2026-04-01', to: '2026-04-30' },
        env: 'production',
      },
      clarifications_resolved: ['User confirmed standalone ShareChat'],
      expected_shape: 'rows',
      max_tokens: 2000,
      deadline_ms: 5_000,
    });

    expect(res.status).toBe('ok');
    expect(runQueryMock).toHaveBeenCalledTimes(1);
    const callParams = runQueryMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callParams.intent_string).toBe('p&l_statement');
    expect(callParams.phase).toBe('execute');
    expect((callParams.scope as Record<string, unknown>).entity).toBe('sharechat');
    expect((callParams.clarifications_resolved as string[])[0]).toContain('standalone');
    // The bless-list entry was forwarded.
    expect((callParams.blessed as { id: string }).id).toBe('p&l_statement');
  });
});

describe('Track E — discover phase routing', () => {
  it('blessed intent + discover (no scope) → reaches runQuery, NO scope validation', async () => {
    runQueryMock.mockResolvedValue(makeOkNarrative());

    const res = await queryTool.handler({
      intent: 'p&l_statement',
      phase: 'discover',
      user_question: 'give me P&L',
      expected_shape: 'narrative',
      max_tokens: 2000,
      deadline_ms: 5_000,
      clarifications_resolved: [],
    });

    expect(res.status).toBe('ok');
    expect(res.data?.shape).toBe('narrative');
    expect(runQueryMock).toHaveBeenCalledTimes(1);
    const callParams = runQueryMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callParams.phase).toBe('discover');
    expect(callParams.intent_string).toBe('p&l_statement');
    expect(callParams.question).toBe('give me P&L');
    expect((callParams.blessed as { id: string }).id).toBe('p&l_statement');
  });
});

describe('Track E — open-string intents (not in bless-list)', () => {
  it('open intent + execute + no scope → reaches runQuery (no wrong_tool)', async () => {
    runQueryMock.mockResolvedValue(makeOkNarrative());

    const res = await queryTool.handler({
      intent: 'cash_decline_root_cause',
      phase: 'execute',
      user_question: 'why is cash lower this week',
      expected_shape: 'narrative',
      max_tokens: 2000,
      deadline_ms: 5_000,
      clarifications_resolved: [],
    });

    expect(res.status).toBe('ok');
    expect(runQueryMock).toHaveBeenCalledTimes(1);
    const callParams = runQueryMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callParams.intent_string).toBe('cash_decline_root_cause');
    expect(callParams.blessed).toBeUndefined();
  });

  it('open intent + discover → reaches runQuery for narrative', async () => {
    runQueryMock.mockResolvedValue(makeOkNarrative());

    const res = await queryTool.handler({
      intent: 'reconciliation_helper',
      phase: 'discover',
      user_question: 'help me reconcile vendor X',
      expected_shape: 'narrative',
      max_tokens: 2000,
      deadline_ms: 5_000,
      clarifications_resolved: [],
    });

    expect(res.status).toBe('ok');
    const callParams = runQueryMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callParams.intent_string).toBe('reconciliation_helper');
    expect(callParams.phase).toBe('discover');
    expect(callParams.blessed).toBeUndefined();
  });
});

describe('Track E — legacy free-form path (backward compat)', () => {
  it('question without intent → free_form phase, runQuery sees no intent metadata', async () => {
    runQueryMock.mockResolvedValue(makeOkRows());

    const res = await queryTool.handler({
      question: 'What is vendor 12345 balance?',
      expected_shape: 'scalar',
      max_tokens: 2000,
      deadline_ms: 5_000,
      clarifications_resolved: [],
    });

    expect(res.status).toBe('ok');
    const callParams = runQueryMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callParams.intent_string).toBeUndefined();
    expect(callParams.phase).toBe('free_form');
    expect(callParams.scope).toBeUndefined();
    expect(callParams.question).toBe('What is vendor 12345 balance?');
  });
});

describe('Track E — input validation', () => {
  it('rejects when none of question / intent / user_question is provided', async () => {
    await expect(
      queryTool.handler({
        expected_shape: 'narrative',
        max_tokens: 2000,
        deadline_ms: 5_000,
        clarifications_resolved: [],
      } as unknown as Parameters<typeof queryTool.handler>[0])
    ).rejects.toThrow();
  });

  it('phase defaults to execute when intent is set without explicit phase', async () => {
    // Defaulting to execute is the fail-fast principle: cowork must
    // explicitly choose discover. Demonstrate by sending a blessed intent
    // with no phase + no scope and expecting wrong_tool.
    const res = await queryTool.handler({
      intent: 'p&l_statement',
      // phase omitted on purpose
      expected_shape: 'rows',
      max_tokens: 2000,
      deadline_ms: 5_000,
      clarifications_resolved: [],
    } as Parameters<typeof queryTool.handler>[0]);

    expect(res.error?.code).toBe('wrong_tool');
    expect(runQueryMock).not.toHaveBeenCalled();
  });
});
