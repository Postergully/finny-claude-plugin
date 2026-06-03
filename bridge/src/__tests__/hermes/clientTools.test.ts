import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HermesClient } from '../../hermes/client.js';

describe('HermesClient.chat with tools', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let client: HermesClient;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    client = new HermesClient('http://test', 'tok', 5000, 'finny');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function mockJsonResponse(data: unknown, status = 200) {
    const body = JSON.stringify(data);
    fetchSpy.mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers: {
        get: (name: string) => {
          if (name === 'content-length') return String(body.length);
          return null;
        },
      },
      text: () => Promise.resolve(body),
    });
  }

  it('sends messages[] + tools[] and returns tool_calls when present', async () => {
    const openaiResponse = {
      id: 'chatcmpl-tool',
      object: 'chat.completion',
      created: 1234567890,
      model: 'finny',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'finny_progress', arguments: '{"text":"querying"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    mockJsonResponse(openaiResponse);

    const result = await client.chat({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'finny_progress', parameters: {} } }],
      sessionId: 'sess1',
    });

    expect(result.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'finny_progress', arguments: '{"text":"querying"}' },
      },
    ]);
    expect(result.response).toBe('');

    const requestBody = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    expect(requestBody.tools).toBeDefined();
    expect(requestBody.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('preserves single-string compat call shape', async () => {
    const openaiResponse = {
      id: 'chatcmpl-compat',
      object: 'chat.completion',
      created: 1234567890,
      model: 'finny',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    mockJsonResponse(openaiResponse);

    const result = await client.chat('hello', 'sess1');
    expect(result.response).toBe('ok');
    expect(result.tool_calls).toBeUndefined();
  });
});
