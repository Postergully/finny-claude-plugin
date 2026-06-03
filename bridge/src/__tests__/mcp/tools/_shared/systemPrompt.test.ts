import { describe, it, expect } from 'vitest';
import { buildQuerySystemPrompt } from '../../../../mcp/tools/_shared/systemPrompt.js';

describe('buildQuerySystemPrompt', () => {
  it('includes the envelope schema reminder', () => {
    const p = buildQuerySystemPrompt({ expected_shape: 'rows' });
    expect(p).toMatch(/intent_restated/);
    expect(p).toMatch(/assumptions/);
    expect(p).toMatch(/unanswered/);
    expect(p).toMatch(/confidence/);
    expect(p).toMatch(/JSON/);
  });

  it('injects the expected_shape hint', () => {
    const p = buildQuerySystemPrompt({ expected_shape: 'scalar' });
    expect(p).toMatch(/shape.*scalar/i);
  });

  it('requests a single fenced JSON block', () => {
    const p = buildQuerySystemPrompt({ expected_shape: 'narrative' });
    expect(p).toMatch(/single.*json/i);
  });

  it('includes finny_progress instruction during execute phase', () => {
    const prompt = buildQuerySystemPrompt({
      expected_shape: 'rows',
      phase: 'execute',
      intent_string: 'vendor_balance',
      user_question: 'open balance for MTPL',
    });
    expect(prompt).toContain('finny_progress');
    expect(prompt).toContain('phase boundaries');
  });

  it('does NOT include finny_progress instruction during discover phase', () => {
    const prompt = buildQuerySystemPrompt({
      expected_shape: 'rows',
      phase: 'discover',
      intent_string: 'vendor_balance',
      user_question: 'open balance',
    });
    expect(prompt).not.toContain('finny_progress');
  });
});
