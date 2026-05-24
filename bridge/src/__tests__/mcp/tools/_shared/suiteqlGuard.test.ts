import { describe, it, expect } from 'vitest';
import {
  detectWriteVerb,
  buildSuiteQLPreamble,
} from '../../../../mcp/tools/_shared/suiteqlGuard.js';

const BLOCKED_VERBS = [
  'DROP',
  'DELETE',
  'UPDATE',
  'INSERT',
  'ALTER',
  'TRUNCATE',
  'CREATE',
  'GRANT',
  'REVOKE',
  'MERGE',
  'REPLACE',
] as const;

describe('detectWriteVerb', () => {
  for (const verb of BLOCKED_VERBS) {
    it(`rejects bare ${verb}`, () => {
      expect(detectWriteVerb(`${verb} TABLE foo`)).toBe(verb);
    });
    it(`rejects lowercase ${verb.toLowerCase()}`, () => {
      expect(detectWriteVerb(`${verb.toLowerCase()} table foo`)).toBe(verb);
    });
    it(`rejects mixed-case ${verb[0]}${verb.slice(1).toLowerCase()}`, () => {
      const mixed = verb[0] + verb.slice(1).toLowerCase();
      expect(detectWriteVerb(`${mixed} table foo`)).toBe(verb);
    });
  }

  it('returns null for a plain read-only SELECT', () => {
    expect(detectWriteVerb('SELECT id, tranid FROM vendor WHERE entityid = ?')).toBeNull();
  });

  it('returns null when no verb keyword is present', () => {
    expect(detectWriteVerb('')).toBeNull();
    expect(detectWriteVerb('just some text')).toBeNull();
  });
});

describe('buildSuiteQLPreamble', () => {
  it('contains sql, env, max_rows, and reason in the output', () => {
    const out = buildSuiteQLPreamble({
      sql: 'SELECT COUNT(*) FROM vendor',
      env: 'sandbox',
      max_rows: 250,
      reason: 'verifying vendor count for weekly snapshot',
    });
    expect(out).toContain('SELECT COUNT(*) FROM vendor');
    expect(out).toContain('sandbox');
    expect(out).toContain('250');
    expect(out).toContain('verifying vendor count for weekly snapshot');
    expect(out).toContain('data.shape: "rows"');
    expect(out).toContain('data.columns');
    expect(out).toContain('data.rows');
  });

  it('switches env wording to production when requested', () => {
    const out = buildSuiteQLPreamble({
      sql: 'SELECT 1 FROM dual',
      env: 'production',
      max_rows: 10,
      reason: 'smoke test',
    });
    expect(out).toContain('production');
    expect(out).not.toMatch(/against sandbox/);
  });
});
