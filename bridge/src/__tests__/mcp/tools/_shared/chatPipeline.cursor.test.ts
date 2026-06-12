import { describe, it, expect, beforeEach } from 'vitest';
import { applyCursorEscape } from '../../../../mcp/tools/_shared/chatPipeline.js';
import { __resetCursorStore_FOR_TEST_ONLY } from '../../../../mcp/tools/_shared/cursorStore.js';
import type { FinnyEnvelope } from '../../../../types/envelope.js';

describe('cursor escape (Workstream B)', () => {
  beforeEach(() => {
    __resetCursorStore_FOR_TEST_ONLY();
  });

  const baseEnv: FinnyEnvelope = {
    status: 'ok',
    intent_restated: 'test',
    assumptions: [],
    unanswered: [],
    sources: [],
    confidence: 'high',
    confidence_reason: 'test',
    elapsed_ms: 0,
    env_used: 'production',
    bridge_version: '0.0.1',
    finny_session_id: 'finny-test',
    data: { shape: 'scalar', value: 1 },
  };

  it('passes through small rows envelope unchanged', () => {
    const env: FinnyEnvelope = {
      ...baseEnv,
      data: {
        shape: 'rows',
        columns: ['a'],
        rows: Array.from({ length: 100 }, (_, i) => [i]),
      },
    };
    const out = applyCursorEscape(env, 'principal');
    expect(out.data && 'next_cursor' in out.data).toBe(false);
    expect((out.data as { rows: unknown[] }).rows.length).toBe(100);
  });

  it('truncates rows over 2000 and emits next_cursor', () => {
    const env: FinnyEnvelope = {
      ...baseEnv,
      data: {
        shape: 'rows',
        columns: ['a'],
        rows: Array.from({ length: 5000 }, (_, i) => [i]),
      },
    };
    const out = applyCursorEscape(env, 'principal');
    const data = out.data as { rows: unknown[]; next_cursor?: string };
    expect(data.rows.length).toBe(2000);
    expect(data.next_cursor).toMatch(/^cur-/);
  });

  it('does not modify scalar envelopes', () => {
    const out = applyCursorEscape(baseEnv, 'principal');
    expect(out).toEqual(baseEnv);
  });

  it('does not modify narrative envelopes', () => {
    const env: FinnyEnvelope = {
      ...baseEnv,
      data: { shape: 'narrative', narrative: 'some prose' },
    };
    const out = applyCursorEscape(env, 'principal');
    expect(out).toEqual(env);
  });

  it('does not modify rows envelopes when data is null', () => {
    const env: FinnyEnvelope = { ...baseEnv, data: null };
    const out = applyCursorEscape(env, 'principal');
    expect(out).toEqual(env);
  });
});
