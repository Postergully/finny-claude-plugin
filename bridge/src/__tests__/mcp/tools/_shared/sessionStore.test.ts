import { describe, it, expect, beforeEach } from 'vitest';
import {
  getOrCreateSession,
  __resetSessionStore_FOR_TEST_ONLY,
} from '../../../../mcp/tools/_shared/sessionStore.js';

describe('sessionStore', () => {
  beforeEach(() => {
    __resetSessionStore_FOR_TEST_ONLY();
  });

  it('returns the same session id for the same principal across calls', () => {
    const a = getOrCreateSession('alice');
    const b = getOrCreateSession('alice');
    expect(a).toBe(b);
  });

  it('returns different session ids for different principals', () => {
    const a = getOrCreateSession('alice');
    const b = getOrCreateSession('bob');
    expect(a).not.toBe(b);
  });

  it('after reset, the same principal gets a fresh session', () => {
    const a = getOrCreateSession('alice');
    __resetSessionStore_FOR_TEST_ONLY();
    const b = getOrCreateSession('alice');
    expect(b).not.toBe(a);
  });
});
