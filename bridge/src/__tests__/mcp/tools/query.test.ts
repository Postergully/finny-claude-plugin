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
