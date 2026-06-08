import { describe, it, expect, beforeEach } from 'vitest';
import {
  storeCursor,
  takeCursor,
  __resetCursorStore_FOR_TEST_ONLY,
  __backdateCursor_FOR_TEST_ONLY,
} from '../../../../mcp/tools/_shared/cursorStore.js';

describe('cursorStore (Workstream B)', () => {
  beforeEach(() => {
    __resetCursorStore_FOR_TEST_ONLY();
  });

  it('stores remaining rows and returns them on take', () => {
    const cursor = storeCursor({
      columns: ['a'],
      remaining: [[1], [2], [3]],
      sessionPrincipal: 'p',
    });
    expect(cursor).toMatch(/^cur-/);
    const got = takeCursor(cursor, 'p');
    expect(got).toBeDefined();
    expect(got!.columns).toEqual(['a']);
    expect(got!.remaining).toEqual([[1], [2], [3]]);
  });

  it('take is one-shot — second call returns undefined', () => {
    const cursor = storeCursor({
      columns: ['a'],
      remaining: [[1]],
      sessionPrincipal: 'p',
    });
    expect(takeCursor(cursor, 'p')).toBeDefined();
    expect(takeCursor(cursor, 'p')).toBeUndefined();
  });

  it('expired cursor returns undefined', () => {
    const cursor = storeCursor({
      columns: ['a'],
      remaining: [[1]],
      sessionPrincipal: 'p',
    });
    __backdateCursor_FOR_TEST_ONLY(cursor, 11 * 60 * 1000);
    expect(takeCursor(cursor, 'p')).toBeUndefined();
  });

  it('rejects take from a different principal without consuming the entry', () => {
    const cursor = storeCursor({
      columns: ['a'],
      remaining: [[1], [2]],
      sessionPrincipal: 'owner',
    });
    // Wrong principal: must return undefined.
    expect(takeCursor(cursor, 'attacker')).toBeUndefined();
    // Entry is still there for the legitimate owner.
    const got = takeCursor(cursor, 'owner');
    expect(got).toBeDefined();
    expect(got!.remaining).toEqual([[1], [2]]);
  });
});
