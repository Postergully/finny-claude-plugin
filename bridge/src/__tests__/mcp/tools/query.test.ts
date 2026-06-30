import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FinnyEnvelopeSchema, type FinnyEnvelope } from '../../../types/envelope.js';

// Mock chatPipeline.runQuery so the worker doesn't hit the real gateway.
// This is the seam Task 2 introduces: the handler creates a task and the
// worker drains via runQuery. By controlling runQuery we can exercise
// fast-path (task completes inside deadline) and slow-path (task still
// running when deadline elapses) behavior deterministically.
const runQueryMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<FinnyEnvelope>>());
vi.mock('../../../mcp/tools/_shared/chatPipeline.js', () => ({
  runQuery: runQueryMock,
}));

// Import AFTER mock registration so the module graph picks up the mock.
const { queryTool } = await import('../../../mcp/tools/query.js');

function makeOkEnvelope(): FinnyEnvelope {
  return {
    status: 'ok',
    intent_restated: 'mocked',
    assumptions: [],
    unanswered: [],
    data: { shape: 'scalar', value: 42 },
    sources: [],
    confidence: 'high',
    confidence_reason: 'deterministic',
    elapsed_ms: 10,
    env_used: 'production',
    bridge_version: '0.0.1',
    finny_session_id: 'sess-test',
  };
}

describe('finny_query — async handler (Task 2 rewrite)', () => {
  beforeEach(() => {
    runQueryMock.mockReset();
  });

  it('fast path: task completes inside deadline → returns completed envelope', async () => {
    runQueryMock.mockImplementation(async () => {
      // Resolve fast enough that the wait-loop picks it up.
      return makeOkEnvelope();
    });

    const res = await queryTool.handler({
      question: 'trivial',
      expected_shape: 'scalar',
      max_tokens: 2000,
      deadline_ms: 5_000,
    });

    const parsed = FinnyEnvelopeSchema.safeParse(res);
    expect(parsed.success).toBe(true);
    expect(res.status).toBe('ok');
    expect(res.data?.shape).toBe('scalar');
    if (res.data?.shape === 'scalar') {
      expect(res.data.value).toBe(42);
    }
    expect(runQueryMock).toHaveBeenCalledTimes(1);
  });

  it('slow path: deadline elapses before task completes → running envelope with task_id in data.value', async () => {
    let resolveChat: (e: FinnyEnvelope) => void = () => undefined;
    runQueryMock.mockImplementation(
      () =>
        new Promise<FinnyEnvelope>((resolve) => {
          resolveChat = resolve;
        })
    );

    const resPromise = queryTool.handler({
      question: 'slow question',
      expected_shape: 'scalar',
      max_tokens: 2000,
      deadline_ms: 300, // very short wait budget
    });

    const res = await resPromise;
    expect(res.status).toBe('running');
    expect(res.task_id).toBeTruthy();
    // Canonical slot: data.value carries task_id (§2.4).
    expect(res.data?.shape).toBe('scalar');
    if (res.data?.shape === 'scalar') {
      expect(res.data.value).toBe(res.task_id);
      expect(res.data.rendered_markdown).toContain(String(res.task_id));
      expect(res.data.rendered_markdown).toContain('deadline_exceeded_ms');
    }
    expect(FinnyEnvelopeSchema.safeParse(res).success).toBe(true);

    // Release the pending chat so the background worker doesn't leak.
    resolveChat(makeOkEnvelope());
  });

  it('rejects invalid input via Zod', async () => {
    await expect(
      queryTool.handler({
        // missing required `question`
        expected_shape: 'scalar',
      } as unknown as Parameters<typeof queryTool.handler>[0])
    ).rejects.toThrow();
  });
});

// ─── Issue #40 — deterministic discover short-circuit ─────────────────
//
// When phase=discover AND intent is blessed, the bridge synthesizes a
// needs_input envelope from entry.required_scope and returns synchronously.
// No LLM call, no gateway round-trip. This removes the non-determinism
// that surfaced as q01 eval drift.
describe('finny_query — discover short-circuit (Issue #40)', () => {
  beforeEach(() => {
    runQueryMock.mockReset();
  });

  it('blessed intent + discover → synthesized needs_input envelope, ZERO gateway calls', async () => {
    const res = await queryTool.handler({
      intent: 'vendor_balance',
      phase: 'discover',
      expected_shape: 'scalar',
      max_tokens: 2000,
      deadline_ms: 5_000,
      clarifications_resolved: [],
    });

    expect(res.status).toBe('needs_input');
    expect(res.data).toBeNull();
    expect(res.intent_restated).toBe('vendor_balance');
    expect(res.confidence).toBe('high');
    expect(res.needs_input).toBeDefined();
    expect(res.needs_input?.round).toBe(1);
    expect(typeof res.needs_input?.conversation_id).toBe('string');
    expect(res.needs_input?.question).toContain('vendor_balance');

    // required_vars must come from the bless-list entry, not be invented.
    // vendor_balance v1.0 declares required_scope = [vendor_ref, env].
    expect(res.unanswered).toEqual(['vendor_ref', 'env']);

    // Critical: NO gateway dispatch on the short-circuit path.
    expect(runQueryMock).not.toHaveBeenCalled();

    // Envelope must validate against the wire schema.
    expect(FinnyEnvelopeSchema.safeParse(res).success).toBe(true);
  });

  it('non-blessed intent + discover → falls through to runQuery (no short-circuit)', async () => {
    runQueryMock.mockResolvedValue({
      status: 'ok',
      intent_restated: 'open-string',
      assumptions: [],
      unanswered: [],
      data: { shape: 'narrative', narrative: 'open intent discover answer' },
      sources: [],
      confidence: 'medium',
      confidence_reason: 'open',
      elapsed_ms: 1,
      env_used: 'production',
      bridge_version: '0.0.1',
      finny_session_id: 'sess',
    });

    const res = await queryTool.handler({
      intent: 'reconciliation_helper', // not in bless-list
      phase: 'discover',
      user_question: 'help me reconcile',
      expected_shape: 'narrative',
      max_tokens: 2000,
      deadline_ms: 5_000,
      clarifications_resolved: [],
    });

    expect(res.status).toBe('ok');
    expect(runQueryMock).toHaveBeenCalledTimes(1);
    const callParams = runQueryMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callParams.phase).toBe('discover');
    expect(callParams.blessed).toBeUndefined();
  });

  it('blessed intent + execute (complete scope) → dispatches normally, NOT short-circuited', async () => {
    runQueryMock.mockResolvedValue(makeOkEnvelope());

    const res = await queryTool.handler({
      intent: 'vendor_balance',
      phase: 'execute',
      scope: { vendor_ref: 'Acme Corp', env: 'production' },
      expected_shape: 'scalar',
      max_tokens: 2000,
      deadline_ms: 5_000,
      clarifications_resolved: [],
    });

    expect(res.status).toBe('ok');
    expect(runQueryMock).toHaveBeenCalledTimes(1);
    const callParams = runQueryMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callParams.phase).toBe('execute');
    expect((callParams.blessed as { id: string }).id).toBe('vendor_balance');
  });
});
