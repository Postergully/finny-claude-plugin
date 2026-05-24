import { describe, it, expect, beforeEach } from 'vitest';

import {
  createConversation,
  getConversation,
  advanceConversation,
  deleteConversation,
  __resetConversationStore_FOR_TEST_ONLY,
  __conversationStoreSize_FOR_TEST_ONLY,
  __backdateConversation_FOR_TEST_ONLY,
} from '../../../../mcp/tools/_shared/conversationStore.js';

beforeEach(() => __resetConversationStore_FOR_TEST_ONLY());

describe('conversationStore', () => {
  it('createConversation returns a unique conv-* id and stores at round 1', () => {
    const id = createConversation({
      intent_string: 'vendor_balance',
      user_question: 'balance for Acme',
      expected_shape: 'scalar',
      scope: { env: 'production' },
      clarifications_resolved: [],
      sessionPrincipal: 'm2-default:production',
    });
    expect(id).toMatch(/^conv-/);
    const entry = getConversation(id);
    expect(entry?.round).toBe(1);
    expect(entry?.user_question).toBe('balance for Acme');
  });

  it('two createConversation calls produce distinct ids', () => {
    const a = createConversation({
      user_question: 'q1',
      expected_shape: 'narrative',
      clarifications_resolved: [],
      sessionPrincipal: 'p',
    });
    const b = createConversation({
      user_question: 'q2',
      expected_shape: 'narrative',
      clarifications_resolved: [],
      sessionPrincipal: 'p',
    });
    expect(a).not.toBe(b);
  });

  it('getConversation returns undefined for unknown ids', () => {
    expect(getConversation('conv-does-not-exist')).toBeUndefined();
  });

  it('advanceConversation increments round and applies the mutation', () => {
    const id = createConversation({
      user_question: 'q',
      expected_shape: 'narrative',
      clarifications_resolved: [],
      sessionPrincipal: 'p',
    });
    const updated = advanceConversation(id, (e) => {
      e.clarifications_resolved.push('round 2 answer');
    });
    expect(updated?.round).toBe(2);
    expect(updated?.clarifications_resolved).toEqual(['round 2 answer']);

    const updated2 = advanceConversation(id, (e) => {
      e.clarifications_resolved.push('round 3 answer');
    });
    expect(updated2?.round).toBe(3);
    expect(updated2?.clarifications_resolved).toEqual(['round 2 answer', 'round 3 answer']);
  });

  it('advanceConversation returns undefined for unknown ids', () => {
    expect(advanceConversation('conv-nope', () => undefined)).toBeUndefined();
  });

  it('deleteConversation drops the entry', () => {
    const id = createConversation({
      user_question: 'q',
      expected_shape: 'narrative',
      clarifications_resolved: [],
      sessionPrincipal: 'p',
    });
    expect(getConversation(id)).toBeDefined();
    deleteConversation(id);
    expect(getConversation(id)).toBeUndefined();
  });

  it('idle eviction: getConversation returns undefined after 30+ min idle', () => {
    const id = createConversation({
      user_question: 'q',
      expected_shape: 'narrative',
      clarifications_resolved: [],
      sessionPrincipal: 'p',
    });
    // Backdate the entry beyond the 30-minute TTL.
    __backdateConversation_FOR_TEST_ONLY(id, 31 * 60 * 1000);
    expect(getConversation(id)).toBeUndefined();
  });

  it('LRU prune: store stays bounded at 1000 entries', () => {
    // Stress: insert 1100 conversations and confirm the store self-trims.
    for (let i = 0; i < 1100; i++) {
      createConversation({
        user_question: `q${i}`,
        expected_shape: 'narrative',
        clarifications_resolved: [],
        sessionPrincipal: `p${i}`,
      });
    }
    expect(__conversationStoreSize_FOR_TEST_ONLY()).toBeLessThanOrEqual(1000);
  });
});
