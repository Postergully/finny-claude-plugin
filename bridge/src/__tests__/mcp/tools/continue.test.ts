import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LollyEnvelopeSchema, type LollyEnvelope } from '../../../types/envelope.js';

// Mock runQuery to deterministically return needs_input vs ok envelopes —
// we don't want the real chat pipeline running for these flow tests. The
// continue handler delegates to taskManager → background worker → runQuery,
// and the runQuery mock satisfies that chain.
const runQueryMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<LollyEnvelope>>());
vi.mock('../../../mcp/tools/_shared/chatPipeline.js', () => ({
  runQuery: runQueryMock,
  // maybeRegisterNeedsInput is exported from chatPipeline but not used by the
  // continue handler directly. Re-export a passthrough so tests don't blow up
  // if anything else imports this module.
  maybeRegisterNeedsInput: (env: LollyEnvelope) => env,
}));

const { continueTool } = await import('../../../mcp/tools/continue.js');
const conversationStore = await import('../../../mcp/tools/_shared/conversationStore.js');

function makeOk(): LollyEnvelope {
  return {
    status: 'ok',
    intent_restated: 'final answer for vendor 12345',
    assumptions: [],
    unanswered: [],
    data: { shape: 'scalar', value: 125000.5 },
    sources: [],
    confidence: 'high',
    confidence_reason: 'mock',
    elapsed_ms: 10,
    env_used: 'production',
    bridge_version: '0.0.1',
    lolly_session_id: 'sess',
  };
}

function makeNeedsInput(): LollyEnvelope {
  return {
    status: 'needs_input',
    intent_restated: 'still ambiguous',
    assumptions: [],
    unanswered: [],
    data: null,
    sources: [],
    confidence: 'low',
    confidence_reason: 'still need clarification',
    needs_input: {
      question: 'Which option?',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      // The bridge ignores Lolly's conversation_id/round and re-keys; these
      // are placeholders to satisfy Zod.
      conversation_id: 'lolly-supplied',
      round: 1,
    },
    elapsed_ms: 5,
    env_used: 'production',
    bridge_version: '0.0.1',
    lolly_session_id: 'sess',
  };
}

beforeEach(() => {
  runQueryMock.mockReset();
  conversationStore.__resetConversationStore_FOR_TEST_ONLY();
});

describe('lolly_continue — disambiguation flow', () => {
  it('valid conversation_id + selected_option → resumes execute, returns ok envelope', async () => {
    runQueryMock.mockResolvedValueOnce(makeOk());

    // Seed a round-1 conversation as if Lolly had returned needs_input.
    const conversation_id =
      conversationStore.__conversationStoreSize_FOR_TEST_ONLY() === 0
        ? createSeed()
        : 'unreachable';

    const res = await continueTool.handler({
      conversation_id,
      response: { selected_option: 'a' },
      deadline_ms: 5_000,
    });

    expect(res.status).toBe('ok');
    expect(LollyEnvelopeSchema.safeParse(res).success).toBe(true);
    expect(runQueryMock).toHaveBeenCalledTimes(1);

    // The replay should carry the augmented clarifications.
    const replayParams = runQueryMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(replayParams.clarifications_resolved as string[]).toEqual(
      expect.arrayContaining([expect.stringMatching(/Round 2.*selected option "a"/)])
    );
    expect(replayParams.phase).toBe('execute');
  });

  it('valid conversation_id + free-form answer → resumes with answer logged', async () => {
    runQueryMock.mockResolvedValueOnce(makeOk());
    const conversation_id = createSeed();

    const res = await continueTool.handler({
      conversation_id,
      response: { answer: 'the second one' },
      deadline_ms: 5_000,
    });

    expect(res.status).toBe('ok');
    const replayParams = runQueryMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(replayParams.clarifications_resolved as string[]).toEqual(
      expect.arrayContaining([expect.stringMatching(/the second one/)])
    );
  });
});

describe('lolly_continue — round cap', () => {
  it('after 3 successful rounds, the 4th continue forces partial', async () => {
    // Simulate the sequence: original needs_input (round 1) → continue
    // returns needs_input (round 2) → continue returns needs_input (round 3)
    // → 4th continue hits the cap.
    runQueryMock.mockResolvedValueOnce(makeNeedsInput()).mockResolvedValueOnce(makeNeedsInput());

    const conversation_id = createSeed();

    // Round 2 — Lolly still asks back.
    const r2 = await continueTool.handler({
      conversation_id,
      response: { answer: 'first try' },
      deadline_ms: 5_000,
    });
    expect(r2.status).toBe('needs_input');

    // Round 3 — Lolly still asks back.
    const r3 = await continueTool.handler({
      conversation_id,
      response: { answer: 'second try' },
      deadline_ms: 5_000,
    });
    expect(r3.status).toBe('needs_input');

    // Round 4 — bridge caps and returns partial WITHOUT calling runQuery.
    const beforeCallCount = runQueryMock.mock.calls.length;
    const r4 = await continueTool.handler({
      conversation_id,
      response: { answer: 'third try' },
      deadline_ms: 5_000,
    });
    expect(r4.status).toBe('partial');
    expect(r4.unanswered.join(' ')).toMatch(/3 times/);
    expect(r4.confidence).toBe('low');
    // Critical: the cap fires WITHOUT calling runQuery again.
    expect(runQueryMock.mock.calls.length).toBe(beforeCallCount);
  });
});

describe('lolly_continue — unknown / expired conversation_id', () => {
  it('unknown id → error.code gateway_rejected, no gateway call', async () => {
    const res = await continueTool.handler({
      conversation_id: 'conv-fake-does-not-exist',
      response: { answer: 'whatever' },
      deadline_ms: 5_000,
    });

    expect(res.status).toBe('error');
    expect(res.error?.code).toBe('gateway_rejected');
    expect(res.error?.message).toMatch(/Unknown or expired conversation_id/);
    expect(runQueryMock).not.toHaveBeenCalled();
  });
});

describe('lolly_continue — input validation', () => {
  it('rejects when neither selected_option nor answer is present', async () => {
    await expect(
      continueTool.handler({
        conversation_id: 'conv-anything',
        response: {} as { selected_option?: string; answer?: string },
        deadline_ms: 5_000,
      })
    ).rejects.toThrow();
  });

  it('rejects empty conversation_id', async () => {
    await expect(
      continueTool.handler({
        conversation_id: '',
        response: { answer: 'x' },
        deadline_ms: 5_000,
      })
    ).rejects.toThrow();
  });
});

// ─── helpers ────────────────────────────────────────────────────────

function createSeed(): string {
  return conversationStore.createConversation({
    intent_string: 'vendor_balance',
    user_question: 'balance for Acme',
    expected_shape: 'scalar',
    scope: { vendor_ref: 'Acme', env: 'production' },
    clarifications_resolved: [],
    sessionPrincipal: 'm2-default:production',
  });
}
