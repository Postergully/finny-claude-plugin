import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runChatWithTools } from '../../../mcp/tools/_shared/toolDispatcher.js';
import { taskManager } from '../../../mcp/tasks/manager.js';

describe('runChatWithTools', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns content directly when no tool_calls are emitted', async () => {
    const fakeClient = {
      chat: vi.fn().mockResolvedValue({ response: '{"status":"ok"}', model: 'finny' }),
    };
    const out = await runChatWithTools({
      client: fakeClient as never,
      systemPrompt: 'sys',
      userMessage: 'q',
      sessionId: 'sess',
      taskId: undefined,
    });
    expect(out.content).toBe('{"status":"ok"}');
    expect(fakeClient.chat).toHaveBeenCalledTimes(1);
  });

  it('dispatches finny_progress tool_calls to taskManager.updateProgress', async () => {
    const task = taskManager.create({ type: 'chat', input: { question: 'q' } });
    const id = task.id;
    taskManager.updateStatus(id, 'running');

    const fakeClient = {
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          response: '',
          model: 'finny',
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'finny_progress', arguments: '{"text":"querying NetSuite"}' },
            },
          ],
        })
        .mockResolvedValueOnce({ response: '{"status":"ok"}', model: 'finny' }),
    };

    const out = await runChatWithTools({
      client: fakeClient as never,
      systemPrompt: 'sys',
      userMessage: 'q',
      sessionId: 'sess',
      taskId: id,
    });

    expect(out.content).toBe('{"status":"ok"}');
    expect(fakeClient.chat).toHaveBeenCalledTimes(2);
    const t = taskManager.get(id);
    expect(t?.progress).toBe('querying NetSuite');

    // Second call must include the tool result
    const secondCallParams = fakeClient.chat.mock.calls[1]![0];
    const toolMsg = secondCallParams.messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMsg).toMatchObject({
      role: 'tool',
      tool_call_id: 'c1',
      content: expect.stringContaining('"ok":true'),
    });
  });

  it('caps loop at 10 iterations and returns last content', async () => {
    const fakeClient = {
      chat: vi.fn().mockResolvedValue({
        response: '',
        model: 'finny',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'finny_progress', arguments: '{"text":"loop"}' },
          },
        ],
      }),
    };
    const out = await runChatWithTools({
      client: fakeClient as never,
      systemPrompt: 'sys',
      userMessage: 'q',
      sessionId: 'sess',
      taskId: undefined,
    });
    expect(fakeClient.chat).toHaveBeenCalledTimes(10);
    expect(out.content).toBe(''); // last response had no content, just tool_calls
  });

  it('no-ops finny_progress dispatch when taskId is undefined', async () => {
    const fakeClient = {
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          response: '',
          model: 'finny',
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'finny_progress', arguments: '{"text":"x"}' },
            },
          ],
        })
        .mockResolvedValueOnce({ response: '{"status":"ok"}', model: 'finny' }),
    };
    const out = await runChatWithTools({
      client: fakeClient as never,
      systemPrompt: 'sys',
      userMessage: 'q',
      sessionId: 'sess',
      taskId: undefined,
    });
    expect(out.content).toBe('{"status":"ok"}');
    // Tool result should still be returned (with reason: 'no_task_context')
    const secondCallParams = fakeClient.chat.mock.calls[1]![0];
    const toolMsg = secondCallParams.messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMsg.content).toContain('no_task_context');
  });
});
