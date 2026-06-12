import { describe, it, expect, beforeEach } from 'vitest';
import {
  getOrCreateSession,
  __resetSessionStore_FOR_TEST_ONLY,
  __sessionCreationCount_FOR_TEST_ONLY,
} from '../../../../mcp/tools/_shared/sessionStore.js';

describe('sessionStore creation counter (Workstream C)', () => {
  beforeEach(() => {
    __resetSessionStore_FOR_TEST_ONLY();
  });

  it('increments creation count on new session, not on reuse', () => {
    const before = __sessionCreationCount_FOR_TEST_ONLY();
    const a = getOrCreateSession('m2-default:production');
    const after1 = __sessionCreationCount_FOR_TEST_ONLY();
    expect(after1 - before).toBe(1);

    const b = getOrCreateSession('m2-default:production');
    expect(b).toBe(a);
    const after2 = __sessionCreationCount_FOR_TEST_ONLY();
    expect(after2 - before).toBe(1);

    const c = getOrCreateSession('different-principal:production');
    expect(c).not.toBe(a);
    const after3 = __sessionCreationCount_FOR_TEST_ONLY();
    expect(after3 - before).toBe(2);
  });
});
