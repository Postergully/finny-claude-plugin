import { describe, it, expect, beforeEach } from 'vitest';
import { continueHandlerForTest } from '../../../mcp/tools/continue.js';
import {
  storeCursor,
  __resetCursorStore_FOR_TEST_ONLY,
} from '../../../mcp/tools/_shared/cursorStore.js';

describe('finny_continue cursor branch (Workstream B)', () => {
  beforeEach(() => {
    __resetCursorStore_FOR_TEST_ONLY();
  });

  it('drains a cursor with no further pagination', async () => {
    const cursor = storeCursor({
      columns: ['a'],
      remaining: [[1], [2], [3]],
      sessionPrincipal: 'p',
    });
    const env = await continueHandlerForTest({ cursor, sessionId: 'p' });
    expect(env.status).toBe('ok');
    expect(env.data).toEqual({
      shape: 'rows',
      columns: ['a'],
      rows: [[1], [2], [3]],
    });
  });

  it('re-emits next_cursor when remaining > page size', async () => {
    const remaining = Array.from({ length: 2500 }, (_, i) => [i]);
    const cursor = storeCursor({
      columns: ['a'],
      remaining,
      sessionPrincipal: 'p',
    });
    const env = await continueHandlerForTest({ cursor, sessionId: 'p' });
    expect(env.status).toBe('ok');
    const data = env.data as { rows: unknown[]; next_cursor?: string };
    expect(data.rows.length).toBe(2000);
    expect(data.next_cursor).toMatch(/^cur-/);
  });

  it('expired/unknown cursor returns error envelope', async () => {
    const env = await continueHandlerForTest({
      cursor: 'cur-nonexistent',
      sessionId: 'p',
    });
    expect(env.status).toBe('error');
    expect(env.error?.code).toBe('other');
  });

  it('rejects a cursor owned by a different principal (security)', async () => {
    const cursor = storeCursor({
      columns: ['a'],
      remaining: [[1], [2]],
      sessionPrincipal: 'owner',
    });
    // Attacker calls with their own sessionId — must look identical to "unknown".
    const env = await continueHandlerForTest({ cursor, sessionId: 'attacker' });
    expect(env.status).toBe('error');
    expect(env.error?.code).toBe('other');
    expect(env.error?.message).toMatch(/Unknown or expired cursor/);

    // Owner can still drain it — not consumed by the rejected attempt.
    const ownerEnv = await continueHandlerForTest({ cursor, sessionId: 'owner' });
    expect(ownerEnv.status).toBe('ok');
    expect((ownerEnv.data as { rows: unknown[] }).rows).toEqual([[1], [2]]);
  });
});
