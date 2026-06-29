// Tests for the eval runner. Mocks fetchEnvelope; never hits a live bridge.
import { describe, it, expect, expectTypeOf } from 'vitest';
import { runEval, type EvalResult, type EvalQuery, type EvalEnvelope } from './run-eval.js';

const q = (id: string, shape = 'ok'): EvalQuery => ({
  id,
  tool: 'finny_query',
  input: {},
  expected_envelope_shape: shape,
});

describe('runEval', () => {
  it('emits pass when envelope matches oracle', async () => {
    const result = await runEval({
      queries: [q('q01')],
      fetchEnvelope: async () => ({ shape: 'ok', data: { value: 1 } }),
      oracle: { q01: { shape: 'ok', data: { value: 1 } } },
    });
    expect(result[0]).toMatchObject({ id: 'q01', status: 'pass' });
  });

  it('emits drift when shape matches but data differs', async () => {
    const result = await runEval({
      queries: [q('q01')],
      fetchEnvelope: async () => ({ shape: 'ok', data: { value: 2 } }),
      oracle: { q01: { shape: 'ok', data: { value: 1 } } },
    });
    expect(result[0].status).toBe('drift');
    expect(result[0].diff).toBeTruthy();
  });

  it('emits fail when shape differs from oracle', async () => {
    const result = await runEval({
      queries: [q('q01', 'ok')],
      fetchEnvelope: async () => ({ shape: 'error', data: { code: 'BOOM' } }),
      oracle: { q01: { shape: 'ok', data: { value: 1 } } },
    });
    expect(result[0].status).toBe('fail');
    // diff should reference the shape mismatch informatively
    expect(String(result[0].diff)).toMatch(/shape/i);
  });

  it('emits fail (not silent skip) when oracle is missing for the query id', async () => {
    const result = await runEval({
      queries: [q('q-missing')],
      fetchEnvelope: async () => ({ shape: 'ok', data: {} }),
      oracle: {},
    });
    expect(result[0].status).toBe('fail');
    expect(String(result[0].diff)).toMatch(/no oracle/i);
  });

  it('diff payload is non-empty on drift', async () => {
    const result = await runEval({
      queries: [q('q01')],
      fetchEnvelope: async () => ({ shape: 'ok', data: { a: 1, b: 2 } }),
      oracle: { q01: { shape: 'ok', data: { a: 1, b: 999 } } },
    });
    expect(result[0].status).toBe('drift');
    // diff must be something a human can act on: array with at least one path, or non-empty string.
    const d = result[0].diff;
    if (Array.isArray(d)) expect(d.length).toBeGreaterThan(0);
    else expect(typeof d === 'string' && d.length > 0).toBe(true);
  });

  it('output structure conforms to the documented EvalResult schema', async () => {
    const result = await runEval({
      queries: [q('q01'), q('q02')],
      fetchEnvelope: async (qq) =>
        qq.id === 'q01'
          ? { shape: 'ok', data: { value: 1 } }
          : { shape: 'ok', data: { value: 99 } },
      oracle: {
        q01: { shape: 'ok', data: { value: 1 } },
        q02: { shape: 'ok', data: { value: 1 } },
      },
    });

    // Type-level structural assertion: result is EvalResult[].
    expectTypeOf(result).toEqualTypeOf<EvalResult[]>();

    // Runtime structural assertion: every entry has the documented keys + status union.
    for (const r of result) {
      expect(r).toHaveProperty('id');
      expect(typeof r.id).toBe('string');
      expect(['pass', 'fail', 'drift']).toContain(r.status);
      // diff is always present (may be empty array on pass).
      expect(r).toHaveProperty('diff');
    }

    // q01 = pass (equal), q02 = drift (data differs).
    expect(result[0].status).toBe('pass');
    expect(result[1].status).toBe('drift');
  });

  it('exported types compile (compile-time check)', () => {
    expectTypeOf<EvalEnvelope>().toMatchTypeOf<{ shape: string; data?: unknown }>();
    expectTypeOf<EvalQuery>().toMatchTypeOf<{
      id: string;
      tool: string;
      input: unknown;
      expected_envelope_shape: string;
    }>();
  });
});
