import { describe, it, expect, beforeEach } from 'vitest';
import { taskStatusTool } from '../../../mcp/tools/taskStatus.js';
import { taskManager } from '../../../mcp/tasks/manager.js';
import { LollyEnvelopeSchema, type LollyEnvelope } from '../../../types/envelope.js';

function makeStoredEnvelope(): LollyEnvelope {
  return {
    status: 'ok',
    intent_restated: 'stored answer',
    assumptions: [],
    unanswered: [],
    data: { shape: 'scalar', value: 7 },
    sources: [],
    confidence: 'high',
    confidence_reason: 'mock',
    elapsed_ms: 1234,
    env_used: 'production',
    bridge_version: '0.0.1',
    lolly_session_id: 'sess-stored',
  };
}

describe('lolly_task_status — live handler (Task 3)', () => {
  beforeEach(() => {
    // Best-effort cleanup of any tasks from prior tests.
    for (const t of taskManager.list()) {
      taskManager.delete(t.id);
    }
  });

  it('unknown task_id → error.code "internal"', async () => {
    const res = await taskStatusTool.handler({ task_id: 'task_does_not_exist' });
    expect(res.status).toBe('error');
    expect(res.error?.code).toBe('internal');
    expect(res.error?.retryable).toBe(false);
    expect(res.error?.message).toContain('task_does_not_exist');
    expect(LollyEnvelopeSchema.safeParse(res).success).toBe(true);
  });

  it('running task → status:"running" with elapsed_ms measured from startedAt', async () => {
    const task = taskManager.create({
      type: 'chat',
      input: { question: 'x' },
      sessionId: 'sess-run',
    });
    taskManager.updateStatus(task.id, 'running');

    // Wait a tiny bit so elapsed_ms is non-zero-ish.
    await new Promise((r) => setTimeout(r, 20));

    const res = await taskStatusTool.handler({ task_id: task.id });
    expect(res.status).toBe('running');
    expect(res.task_id).toBe(task.id);
    expect(res.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(res.lolly_session_id).toBe('sess-run');
    if (res.data?.shape === 'scalar') {
      expect(res.data.value).toBe(task.id);
    }
    expect(LollyEnvelopeSchema.safeParse(res).success).toBe(true);
  });

  it('completed task → stored envelope returned verbatim (passthrough, no re-stamp)', async () => {
    const task = taskManager.create({
      type: 'chat',
      input: { question: 'x' },
      sessionId: 'sess-done',
    });
    const stored = makeStoredEnvelope();
    taskManager.updateStatus(task.id, 'completed', JSON.stringify(stored));

    const res = await taskStatusTool.handler({ task_id: task.id });
    expect(res).toEqual(stored);
    // Operational fields preserved exactly — not re-stamped.
    expect(res.elapsed_ms).toBe(1234);
    expect(res.lolly_session_id).toBe('sess-stored');
  });

  it('failed task → status:"error", retryable, error message from task.error', async () => {
    const task = taskManager.create({
      type: 'chat',
      input: { question: 'x' },
      sessionId: 'sess-fail',
    });
    taskManager.updateStatus(task.id, 'failed', undefined, 'worker exploded');

    const res = await taskStatusTool.handler({ task_id: task.id });
    expect(res.status).toBe('error');
    expect(res.error?.code).toBe('internal');
    expect(res.error?.message).toBe('worker exploded');
    expect(res.error?.retryable).toBe(true);
    expect(res.lolly_session_id).toBe('sess-fail');
    expect(LollyEnvelopeSchema.safeParse(res).success).toBe(true);
  });

  it('cancelled task → status:"refused"', async () => {
    const task = taskManager.create({
      type: 'chat',
      input: { question: 'x' },
      sessionId: 'sess-cancel',
    });
    taskManager.cancel(task.id);

    const res = await taskStatusTool.handler({ task_id: task.id });
    expect(res.status).toBe('refused');
    expect(res.confidence_reason).toContain('cancelled');
    expect(res.lolly_session_id).toBe('sess-cancel');
    expect(LollyEnvelopeSchema.safeParse(res).success).toBe(true);
  });
});
