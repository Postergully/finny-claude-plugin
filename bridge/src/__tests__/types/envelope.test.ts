import { describe, it, expect } from 'vitest';
import { FinnyEnvelopeSchema } from '../../types/envelope.js';

const valid = {
  status: 'ok',
  intent_restated: 'test',
  assumptions: [],
  unanswered: [],
  data: { shape: 'scalar', value: 42 },
  sources: [],
  confidence: 'high',
  confidence_reason: 'direct match',
  elapsed_ms: 100,
  env_used: 'production',
  bridge_version: '0.0.1',
  finny_session_id: 'abc',
};

describe('FinnyEnvelopeSchema', () => {
  it('accepts a valid minimal ok envelope', () => {
    expect(() => FinnyEnvelopeSchema.parse(valid)).not.toThrow();
  });

  it('rejects missing intent_restated', () => {
    const bad = { ...valid, intent_restated: undefined };
    expect(() => FinnyEnvelopeSchema.parse(bad)).toThrow();
  });

  it('rejects status=ok with data=null', () => {
    const bad = { ...valid, data: null };
    expect(() => FinnyEnvelopeSchema.parse(bad)).toThrow();
  });

  it('accepts status=running with data=null', () => {
    const running = {
      ...valid,
      status: 'running',
      data: null,
      task_id: 't-1',
    };
    expect(() => FinnyEnvelopeSchema.parse(running)).not.toThrow();
  });

  it('rejects rows shape missing columns/rows', () => {
    const bad = { ...valid, data: { shape: 'rows', value: 1 } };
    expect(() => FinnyEnvelopeSchema.parse(bad)).toThrow();
  });

  it('rejects unknown status enum', () => {
    const bad = { ...valid, status: 'nope' };
    expect(() => FinnyEnvelopeSchema.parse(bad)).toThrow();
  });

  it('accepts status=error with a known error.code [P0-§6.2]', () => {
    const err = {
      ...valid,
      status: 'error',
      data: null,
      error: { code: 'gateway_rejected', message: 'HTTP 400', retryable: true },
    };
    expect(() => FinnyEnvelopeSchema.parse(err)).not.toThrow();
  });

  it('rejects status=error with a bogus error.code', () => {
    const err = {
      ...valid,
      status: 'error',
      data: null,
      error: { code: 'kaboom', message: 'oops', retryable: false },
    };
    expect(() => FinnyEnvelopeSchema.parse(err)).toThrow();
  });

  it("accepts error.code='other' with semantic code in message [§10.3]", () => {
    const err = {
      ...valid,
      status: 'error',
      data: null,
      error: {
        code: 'other',
        message: 'approval_required: vendor match is ambiguous, need user confirmation',
        retryable: false,
      },
    };
    expect(() => FinnyEnvelopeSchema.parse(err)).not.toThrow();
  });

  it("rejects error.code='approval_required' directly (must ride in message under 'other') [§10.3]", () => {
    const err = {
      ...valid,
      status: 'error',
      data: null,
      error: { code: 'approval_required', message: 'needs user nod', retryable: false },
    };
    expect(() => FinnyEnvelopeSchema.parse(err)).toThrow();
  });

  it('accepts rows envelope with bare-string columns (Finny natural emission)', () => {
    const envelope = {
      status: 'ok',
      intent_restated: 'P&L for MTPL April 2026',
      assumptions: [],
      unanswered: [],
      data: {
        shape: 'rows',
        columns: ['p1_category', 'p2_bucket', 'amount_lakhs'],
        rows: [
          ['Revenue from Operations', 'Advertising', 2285.5],
          ['Revenue from Operations', 'Premium', 5571.88],
        ],
      },
      sources: [],
      confidence: 'high',
      confidence_reason: 'production query',
      elapsed_ms: 42000,
      env_used: 'production',
      bridge_version: '0.0.1',
      finny_session_id: 'sess_test',
    };

    const result = FinnyEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
    if (result.success && result.data.data?.shape === 'rows') {
      expect(result.data.data.columns).toEqual(['p1_category', 'p2_bucket', 'amount_lakhs']);
    }
  });

  it('accepts running envelope with progress field', () => {
    const envelope = {
      status: 'running',
      intent_restated: 'P&L for MTPL April 2026',
      assumptions: [],
      unanswered: [],
      data: null,
      sources: [],
      confidence: 'low',
      confidence_reason: 'in flight',
      task_id: 'task_abc',
      progress: 'querying NetSuite for posted P&L lines',
      elapsed_ms: 30000,
      env_used: 'production',
      bridge_version: '0.0.1',
      finny_session_id: 'sess_test',
    };

    const result = FinnyEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.progress).toBe('querying NetSuite for posted P&L lines');
    }
  });

  it('accepts running envelope without progress field (backward compat)', () => {
    const envelope = {
      status: 'running',
      intent_restated: 'P&L for MTPL April 2026',
      assumptions: [],
      unanswered: [],
      data: null,
      sources: [],
      confidence: 'low',
      confidence_reason: 'in flight',
      task_id: 'task_abc',
      elapsed_ms: 30000,
      env_used: 'production',
      bridge_version: '0.0.1',
      finny_session_id: 'sess_test',
    };

    const result = FinnyEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.progress).toBeUndefined();
    }
  });

  it('preserves arbitrary extra fields on data interiors (e.g. summary)', () => {
    const envelope = {
      status: 'ok',
      intent_restated: 'P&L for MTPL April 2026',
      assumptions: [],
      unanswered: [],
      data: {
        shape: 'rows',
        columns: ['p1', 'p2', 'amt'],
        rows: [['a', 'b', 100]],
        summary: {
          total_revenue_lakhs: 11401.04,
          operating_loss_lakhs: -3883.3,
        },
      },
      sources: [],
      confidence: 'high',
      confidence_reason: 'authoritative',
      elapsed_ms: 1000,
      env_used: 'production',
      bridge_version: '0.0.1',
      finny_session_id: 'sess_test',
    };

    const result = FinnyEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
    if (result.success && result.data.data?.shape === 'rows') {
      const data = result.data.data as typeof result.data.data & {
        summary?: { total_revenue_lakhs: number; operating_loss_lakhs: number };
      };
      expect(data.summary).toEqual({
        total_revenue_lakhs: 11401.04,
        operating_loss_lakhs: -3883.3,
      });
    }
  });
});
