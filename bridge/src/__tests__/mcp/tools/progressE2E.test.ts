import { describe, it, expect, vi, beforeEach } from 'vitest';
import { taskManager } from '../../../mcp/tasks/manager.js';
import { runQuery } from '../../../mcp/tools/_shared/chatPipeline.js';
import { taskStatusTool } from '../../../mcp/tools/taskStatus.js';
import { HermesClient } from '../../../hermes/client.js';

// E2E: runQuery (with taskId) → toolDispatcher → applyProgress → taskManager
//   → taskStatusTool surfaces `progress` on the running envelope.
// Mocks HermesClient.chat at the boundary; everything in between is real.
describe('finny_progress end-to-end', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Best-effort cleanup of any tasks from prior tests.
    for (const t of taskManager.list()) {
      taskManager.delete(t.id);
    }
  });

  it('progress strings flow from tool_call to running envelope', async () => {
    const chatSpy = vi
      .spyOn(HermesClient.prototype, 'chat')
      .mockResolvedValueOnce({
        response: '',
        model: 'finny',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: {
              name: 'finny_progress',
              arguments: '{"text":"querying NetSuite VendBill"}',
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        response: JSON.stringify({
          status: 'ok',
          intent_restated: 'vendor balance for MTPL',
          assumptions: [],
          unanswered: [],
          data: { shape: 'scalar', value: '₹1,234', rendered_markdown: '₹1,234' },
          sources: [{ kind: 'memory', ref: 'gl_map' }],
          confidence: 'high',
          confidence_reason: 'direct lookup',
        }),
        model: 'finny',
      });

    const task = taskManager.create({
      type: 'chat',
      input: { question: 'open balance MTPL' },
      sessionId: 'm2-default:production',
    });
    const id = task.id;
    taskManager.updateStatus(id, 'running');

    const env = await runQuery({
      question: 'open balance MTPL',
      expected_shape: 'scalar',
      sessionPrincipal: 'm2-default:production',
      deadlineMs: 30_000,
      taskId: id,
    });

    expect(env.status).toBe('ok');
    expect(chatSpy).toHaveBeenCalledTimes(2);

    const stored = taskManager.get(id);
    expect(stored?.progress).toBe('querying NetSuite VendBill');

    // taskStatusTool reads task state; flip back to running so it returns a
    // running envelope (runQuery doesn't mutate task status — that's the
    // worker's job; we simulate the still-in-flight poll here).
    taskManager.updateStatus(id, 'running');
    const statusEnv = await taskStatusTool.handler({ task_id: id });
    expect(statusEnv.status).toBe('running');
    expect(statusEnv.progress).toBe('querying NetSuite VendBill');
    expect(JSON.stringify(statusEnv)).toContain('querying NetSuite VendBill');
  });
});
