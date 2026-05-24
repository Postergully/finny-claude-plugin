import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  extractEnvelopeJSON,
  buildCorrectionPrompt,
} from '../../../../mcp/tools/_shared/parseEnvelope.js';

describe('extractEnvelopeJSON', () => {
  it('extracts a fenced ```json block', () => {
    const raw = 'Here you go:\n```json\n{"status":"ok"}\n```';
    expect(extractEnvelopeJSON(raw)).toEqual({ status: 'ok' });
  });

  it('extracts a bare JSON object if no fence present', () => {
    const raw = 'prose prose\n{"status":"ok","x":1}\ntrailing';
    expect(extractEnvelopeJSON(raw)).toEqual({ status: 'ok', x: 1 });
  });

  it('returns null when no JSON object can be recovered', () => {
    expect(extractEnvelopeJSON('no json at all, just prose')).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    const raw = '```json\n{not: valid}\n```';
    expect(extractEnvelopeJSON(raw)).toBeNull();
  });
});

describe('buildCorrectionPrompt', () => {
  it('explains what failed and quotes the original output (legacy string form)', () => {
    const p = buildCorrectionPrompt('your raw text', 'invalid JSON: unexpected token');
    expect(p).toMatch(/previous response/i);
    expect(p).toMatch(/invalid JSON/);
    expect(p).toMatch(/single fenced JSON/i);
    expect(p).toContain('your raw text');
  });

  it('renders Zod issue paths and messages as a bulleted list', () => {
    // Build a Zod failure where multiple required fields are missing — the
    // exact shape Finny produces under deadline pressure (truncated JSON
    // tail, M3 Scenario 08 carry-forward).
    const schema = z.object({
      assumptions: z.array(z.string()),
      confidence: z.enum(['high', 'medium', 'low']),
      confidence_reason: z.string(),
    });
    const result = schema.safeParse({});
    if (result.success) throw new Error('expected failure');

    const prompt = buildCorrectionPrompt('garbage', result.error.issues);

    // Each missing field is named by path so Finny has a concrete target.
    expect(prompt).toContain('assumptions:');
    expect(prompt).toContain('confidence:');
    expect(prompt).toContain('confidence_reason:');
    // Bullet rendering preserved.
    expect(prompt).toMatch(/- assumptions:/);
    // Re-correction guidance still present.
    expect(prompt).toMatch(/SINGLE fenced JSON code block/);
    // Original output still quoted for context.
    expect(prompt).toContain('garbage');
  });

  it('handles nested field paths', () => {
    const schema = z.object({
      data: z.object({
        shape: z.literal('rows'),
        rows: z.array(z.unknown()),
      }),
    });
    const result = schema.safeParse({ data: { shape: 'rows' } });
    if (result.success) throw new Error('expected failure');

    const prompt = buildCorrectionPrompt('raw', result.error.issues);
    expect(prompt).toContain('data.rows:');
  });

  it('renders <root> for issues without a path', () => {
    // Zod issues with empty path arise from refinements at the schema root.
    const schema = z.object({ x: z.number() }).refine((v) => v.x > 0, {
      message: 'x must be positive',
    });
    const result = schema.safeParse({ x: -1 });
    if (result.success) throw new Error('expected failure');

    const prompt = buildCorrectionPrompt('raw', result.error.issues);
    expect(prompt).toMatch(/- <root>:/);
  });
});
