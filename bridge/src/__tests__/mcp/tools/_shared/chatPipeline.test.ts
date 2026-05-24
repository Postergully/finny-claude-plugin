import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the gateway client so we can hand-craft Lolly responses turn-by-turn.
const chatMock = vi.hoisted(() =>
  vi.fn<(message: string, sessionId?: string) => Promise<{ response: string; model: string }>>()
);
vi.mock('../../../../openclaw/client.js', () => ({
  OpenClawClient: vi.fn().mockImplementation(() => ({
    chat: chatMock,
  })),
}));

// Silence the access log during tests.
vi.mock('../../../../mcp/tools/_shared/gatewayLog.js', () => ({
  logGatewayCall: vi.fn(),
}));

const { runQuery } = await import('../../../../mcp/tools/_shared/chatPipeline.js');
const { lookupIntent } = await import('../../../../intents/loader.js');

function fenced(json: object): string {
  return '```json\n' + JSON.stringify(json) + '\n```';
}

describe('chatPipeline.runQuery — schema-aware correction retry (Track D)', () => {
  beforeEach(() => {
    chatMock.mockReset();
  });

  it('first response missing required fields → correction prompt names every missing path → second response succeeds', async () => {
    // First turn: Lolly returns a JSON shape with the right top-level status
    // but truncated tail (the realistic deadline-pressure failure mode).
    // Missing: assumptions, unanswered, sources, confidence, confidence_reason.
    chatMock.mockResolvedValueOnce({
      response: fenced({
        status: 'ok',
        intent_restated: 'mocked intent',
        data: { shape: 'scalar', value: 42 },
        env_used: 'production',
      }),
      model: 'mock',
    });

    // Second turn: Lolly returns a complete envelope. We capture the prompt
    // she received to assert the structured-issue paths reached her.
    chatMock.mockResolvedValueOnce({
      response: fenced({
        status: 'ok',
        intent_restated: 'mocked intent',
        assumptions: [],
        unanswered: [],
        data: { shape: 'scalar', value: 42 },
        sources: [],
        confidence: 'high',
        confidence_reason: 'deterministic',
        env_used: 'production',
      }),
      model: 'mock',
    });

    const env = await runQuery({
      question: 'whatever',
      expected_shape: 'scalar',
      sessionPrincipal: 'test:production',
      deadlineMs: 30_000,
    });

    expect(env.status).toBe('ok');
    expect(chatMock).toHaveBeenCalledTimes(2);

    // The second call's combined-prompt argument is the correction prompt.
    // Pull every chat invocation's user-facing combined string.
    const correctionInvocation = chatMock.mock.calls[1]?.[0];
    expect(correctionInvocation).toBeTruthy();
    const correctionText = String(correctionInvocation);

    // Track D's contract: each missing field is named by path on its own
    // bullet line so Lolly has a concrete target to repair.
    expect(correctionText).toMatch(/- assumptions:/);
    expect(correctionText).toMatch(/- unanswered:/);
    expect(correctionText).toMatch(/- sources:/);
    expect(correctionText).toMatch(/- confidence:/);
    expect(correctionText).toMatch(/- confidence_reason:/);

    // Sanity: the correction prompt also instructs Lolly to return a single
    // fenced JSON block.
    expect(correctionText).toMatch(/SINGLE fenced JSON code block/);
  });

  it('first response is non-JSON prose → correction uses the legacy string form (no Zod issues yet)', async () => {
    chatMock.mockResolvedValueOnce({
      response: 'just some prose, no JSON at all',
      model: 'mock',
    });
    chatMock.mockResolvedValueOnce({
      response: fenced({
        status: 'ok',
        intent_restated: 'recovered',
        assumptions: [],
        unanswered: [],
        data: { shape: 'scalar', value: 1 },
        sources: [],
        confidence: 'low',
        confidence_reason: 'recovered after correction',
        env_used: 'production',
      }),
      model: 'mock',
    });

    const env = await runQuery({
      question: 'whatever',
      expected_shape: 'scalar',
      sessionPrincipal: 'test:production',
      deadlineMs: 30_000,
    });

    expect(env.status).toBe('ok');
    expect(chatMock).toHaveBeenCalledTimes(2);
    const correctionText = String(chatMock.mock.calls[1]?.[0]);
    // Static-string path: the legacy "Response did not contain a valid JSON
    // envelope." message is preserved for the no-JSON-at-all case.
    expect(correctionText).toContain('Response did not contain a valid JSON envelope.');
  });
});

describe('chatPipeline.runQuery — two-phase system prompt content (Track E)', () => {
  beforeEach(() => chatMock.mockReset());

  function okNarrativeFenced(): string {
    return fenced({
      status: 'ok',
      intent_restated: 'discovery for p&l',
      assumptions: [],
      unanswered: [],
      data: { shape: 'narrative', narrative: 'mock discovery narrative' },
      sources: [],
      confidence: 'high',
      confidence_reason: 'mock',
      env_used: 'production',
    });
  }

  function okRowsFenced(): string {
    return fenced({
      status: 'ok',
      intent_restated: 'execute p&l for sharechat',
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
      env_used: 'production',
    });
  }

  it('discover phase: prompt contains DISCOVERY mode marker, intent hint, scope_doc (blessed)', async () => {
    chatMock.mockResolvedValueOnce({ response: okNarrativeFenced(), model: 'mock' });
    const blessed = lookupIntent('p&l_statement')!;

    await runQuery({
      question: 'give me P&L',
      expected_shape: 'narrative',
      sessionPrincipal: 'test:production',
      deadlineMs: 30_000,
      intent_string: 'p&l_statement',
      blessed,
      phase: 'discover',
    });

    const promptSent = String(chatMock.mock.calls[0]?.[0]);
    expect(promptSent).toContain('DISCOVERY mode');
    expect(promptSent).toContain('"p&l_statement"');
    expect(promptSent).toContain('give me P&L');
    expect(promptSent).toContain('bless-list (v1.0)');
    // scope_doc is reproduced for Lolly's reference (wrapped per Track G
    // with a "for reference only" preamble — see prompt-shape test for the
    // exact wording assertions).
    expect(promptSent).toContain('Profit & loss aggregated by GL account');
    // Track G prohibition. The phrasing changed from "Do NOT run any
    // NetSuite query" to capitalized "MUST NOT" with explicit query types,
    // moved from the last line to line 2 of the prompt.
    expect(promptSent).toContain('MUST NOT run any SuiteQL query');
  });

  it('discover phase, open intent: prompt says NOT in bless-list', async () => {
    chatMock.mockResolvedValueOnce({ response: okNarrativeFenced(), model: 'mock' });

    await runQuery({
      question: 'why is cash lower this week',
      expected_shape: 'narrative',
      sessionPrincipal: 'test:production',
      deadlineMs: 30_000,
      intent_string: 'cash_decline_root_cause',
      blessed: undefined,
      phase: 'discover',
    });

    const promptSent = String(chatMock.mock.calls[0]?.[0]);
    expect(promptSent).toContain('DISCOVERY mode');
    expect(promptSent).toContain('NOT in the bless-list');
    expect(promptSent).toContain('cash_decline_root_cause');
    expect(promptSent).toContain('why is cash lower this week');
  });

  it('execute phase, blessed: prompt contains scope JSON + scope_doc + clarifications', async () => {
    chatMock.mockResolvedValueOnce({ response: okRowsFenced(), model: 'mock' });
    const blessed = lookupIntent('p&l_statement')!;

    await runQuery({
      question: 'give me P&L',
      expected_shape: 'rows',
      sessionPrincipal: 'test:production',
      deadlineMs: 30_000,
      intent_string: 'p&l_statement',
      blessed,
      phase: 'execute',
      scope: {
        entity: 'sharechat',
        consolidated: false,
        period: { from: '2026-04-01', to: '2026-04-30' },
        env: 'production',
      },
      clarifications_resolved: ['User confirmed standalone ShareChat'],
    });

    const promptSent = String(chatMock.mock.calls[0]?.[0]);
    expect(promptSent).toContain('caller wants you to RUN');
    expect(promptSent).toContain('"sharechat"');
    expect(promptSent).toContain('"consolidated": false');
    expect(promptSent).toContain('Bless-list scope_doc');
    expect(promptSent).toContain('User confirmed standalone ShareChat');
    expect(promptSent).toContain('Expected output shape: rows');
  });

  it('execute phase, open intent: prompt says not in bless-list, no scope_doc', async () => {
    chatMock.mockResolvedValueOnce({ response: okRowsFenced(), model: 'mock' });

    await runQuery({
      question: 'investigate vendor disbursements',
      expected_shape: 'rows',
      sessionPrincipal: 'test:production',
      deadlineMs: 30_000,
      intent_string: 'investigation',
      blessed: undefined,
      phase: 'execute',
      scope: { hint: 'last week' },
    });

    const promptSent = String(chatMock.mock.calls[0]?.[0]);
    expect(promptSent).toContain('caller wants you to RUN');
    expect(promptSent).toContain('not in the bless-list');
    expect(promptSent).toContain('"investigation"');
    expect(promptSent).not.toContain('Bless-list scope_doc');
  });

  it('Lolly emits needs_input → bridge allocates conversation_id and patches the envelope (Track F)', async () => {
    // Lolly returns a needs_input envelope WITHOUT a conversation_id (or with
    // a placeholder that the bridge should overwrite). Bridge owns the id
    // lifecycle: generate, store, patch envelope.
    const lollyEnvelopeMissingConvId = fenced({
      status: 'needs_input',
      intent_restated: 'three vendors match Acme',
      assumptions: [],
      unanswered: [],
      data: null,
      sources: [],
      confidence: 'low',
      confidence_reason: 'ambiguous',
      needs_input: {
        question: 'Which Acme?',
        options: [
          { id: '12345', label: 'Acme Corp' },
          { id: '12346', label: 'Acme Holdings' },
        ],
        // Lolly's value here gets overwritten by the bridge.
        conversation_id: 'lolly-placeholder',
        round: 99,
      },
      env_used: 'production',
    });
    chatMock.mockResolvedValueOnce({ response: lollyEnvelopeMissingConvId, model: 'mock' });

    const env = await runQuery({
      question: 'balance for Acme',
      expected_shape: 'scalar',
      sessionPrincipal: 'test:production',
      deadlineMs: 30_000,
      intent_string: 'vendor_balance',
      blessed: lookupIntent('vendor_balance')!,
      phase: 'execute',
      scope: { vendor_ref: 'Acme', env: 'production' },
      clarifications_resolved: [],
    });

    expect(env.status).toBe('needs_input');
    expect(env.needs_input).toBeDefined();
    // Bridge overwrites with its own id.
    expect(env.needs_input!.conversation_id).toMatch(/^conv-/);
    expect(env.needs_input!.conversation_id).not.toBe('lolly-placeholder');
    // Bridge resets round to 1 (Lolly's value of 99 is bookkeeping noise).
    expect(env.needs_input!.round).toBe(1);
    // Lolly's question + options reach cowork unchanged.
    expect(env.needs_input!.question).toBe('Which Acme?');
    expect(env.needs_input!.options).toHaveLength(2);
  });

  it('free_form phase (legacy, no intent): prompt is the generic NetSuite-agent preamble', async () => {
    chatMock.mockResolvedValueOnce({ response: okRowsFenced(), model: 'mock' });

    await runQuery({
      question: 'what is vendor 12345 balance',
      expected_shape: 'scalar',
      sessionPrincipal: 'test:production',
      deadlineMs: 30_000,
      // No intent_string; no phase; default behavior.
    });

    const promptSent = String(chatMock.mock.calls[0]?.[0]);
    // Legacy preamble starts with "You are Lolly, a ShareChat NetSuite ERP agent."
    expect(promptSent).toContain('You are Lolly, a ShareChat NetSuite ERP agent');
    // Phase markers should NOT appear in free_form.
    expect(promptSent).not.toContain('DISCOVERY mode');
    expect(promptSent).not.toContain('Bless-list scope_doc');
  });
});

describe('chatPipeline.runQuery — discover violation surfacing (Track G)', () => {
  beforeEach(() => chatMock.mockReset());

  it('discover envelope with kind:suiteql sources annotates confidence_reason', async () => {
    // Simulate Lolly violating the prompt: she returns a discover narrative
    // but cited a SuiteQL source — proof she ran the query she was told
    // not to run. Bridge must surface this to the access log without
    // stripping the answer.
    const violatingEnvelope = fenced({
      status: 'ok',
      intent_restated: 'discovery for p&l with live data',
      assumptions: [],
      unanswered: [],
      data: {
        shape: 'narrative',
        narrative: '193 GL accounts mapped to MIS categories...',
      },
      sources: [
        { kind: 'suiteql', ref: 'SELECT COUNT(*) FROM Account WHERE...', rows_scanned: 193 },
      ],
      confidence: 'high',
      confidence_reason: 'live SuiteQL aggregate',
      env_used: 'production',
    });
    chatMock.mockResolvedValueOnce({ response: violatingEnvelope, model: 'mock' });

    const env = await runQuery({
      question: 'give me P&L',
      expected_shape: 'narrative',
      sessionPrincipal: 'test:production',
      deadlineMs: 30_000,
      intent_string: 'p&l_statement',
      blessed: lookupIntent('p&l_statement')!,
      phase: 'discover',
    });

    // Envelope is NOT stripped — sources still present so users can audit.
    expect(env.status).toBe('ok');
    expect(env.sources).toHaveLength(1);
    expect(env.sources[0]?.kind).toBe('suiteql');
    // Confidence reason carries the bridge-side annotation that the
    // access-log marker keys on (see summarizeEnvelopeForLog).
    expect(env.confidence_reason).toMatch(/\[bridge: discover phase ran live NetSuite queries/);
  });

  it('discover envelope with kind:rest sources also flagged', async () => {
    const violatingEnvelope = fenced({
      status: 'ok',
      intent_restated: 'discovery for vendor with REST probe',
      assumptions: [],
      unanswered: [],
      data: { shape: 'narrative', narrative: 'looked up vendor record live...' },
      sources: [{ kind: 'rest', ref: '/services/rest/record/v1/vendor/12345' }],
      confidence: 'high',
      confidence_reason: 'live REST',
      env_used: 'production',
    });
    chatMock.mockResolvedValueOnce({ response: violatingEnvelope, model: 'mock' });

    const env = await runQuery({
      question: 'discover vendor balance',
      expected_shape: 'narrative',
      sessionPrincipal: 'test:production',
      deadlineMs: 30_000,
      intent_string: 'vendor_balance',
      blessed: lookupIntent('vendor_balance')!,
      phase: 'discover',
    });

    expect(env.confidence_reason).toMatch(/\[bridge: discover phase ran live NetSuite queries/);
  });

  it('discover envelope with brain-only sources (kind:memory or skill) is NOT flagged', async () => {
    const cleanEnvelope = fenced({
      status: 'ok',
      intent_restated: 'discovery from brain',
      assumptions: [],
      unanswered: [],
      data: {
        shape: 'narrative',
        narrative: 'You usually run this for ShareChat standalone...',
      },
      sources: [
        { kind: 'memory', ref: 'user-defaults' },
        { kind: 'skill', ref: 'lolly-usage' },
      ],
      confidence: 'medium',
      confidence_reason: 'memory + skill',
      env_used: 'production',
    });
    chatMock.mockResolvedValueOnce({ response: cleanEnvelope, model: 'mock' });

    const env = await runQuery({
      question: 'p&l please',
      expected_shape: 'narrative',
      sessionPrincipal: 'test:production',
      deadlineMs: 30_000,
      intent_string: 'p&l_statement',
      blessed: lookupIntent('p&l_statement')!,
      phase: 'discover',
    });

    // No bridge annotation — confidence_reason is whatever Lolly wrote.
    expect(env.confidence_reason).toBe('memory + skill');
  });

  it('execute envelope with suiteql sources is NOT flagged (violation only fires on discover)', async () => {
    const executeEnvelope = fenced({
      status: 'ok',
      intent_restated: 'execute p&l',
      assumptions: [],
      unanswered: [],
      data: {
        shape: 'rows',
        columns: [{ name: 'account', type: 'string' }],
        rows: [['mock', 1]],
      },
      sources: [{ kind: 'suiteql', ref: 'SELECT ... FROM Account', rows_scanned: 100 }],
      confidence: 'high',
      confidence_reason: 'live SuiteQL aggregate',
      env_used: 'production',
    });
    chatMock.mockResolvedValueOnce({ response: executeEnvelope, model: 'mock' });

    const env = await runQuery({
      question: 'p&l for sharechat april',
      expected_shape: 'rows',
      sessionPrincipal: 'test:production',
      deadlineMs: 30_000,
      intent_string: 'p&l_statement',
      blessed: lookupIntent('p&l_statement')!,
      phase: 'execute',
      scope: {
        entity: 'sharechat',
        consolidated: false,
        period: { from: '2026-04-01', to: '2026-04-30' },
        env: 'production',
      },
    });

    // Execute is supposed to query NetSuite — no annotation expected.
    expect(env.confidence_reason).toBe('live SuiteQL aggregate');
  });
});
