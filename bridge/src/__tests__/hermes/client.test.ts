import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HermesClient } from '../../hermes/client.js';
import { HermesApiError, HermesConnectionError } from '../../utils/errors.js';

describe('HermesClient', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let client: HermesClient;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    client = new HermesClient('https://hermes.example.com', 'test-token');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function mockJsonResponse(data: unknown, status = 200, headers?: Record<string, string>) {
    const body = JSON.stringify(data);
    fetchSpy.mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers: {
        get: (name: string) => {
          if (headers && headers[name]) return headers[name];
          if (name === 'content-length') return String(body.length);
          return null;
        },
      },
      text: () => Promise.resolve(body),
    });
  }

  describe('constructor', () => {
    it('strips trailing slash from baseUrl', async () => {
      const c = new HermesClient('https://example.com/');
      mockJsonResponse({ status: 'ok' });
      await c.health();
      expect(fetchSpy.mock.calls[0][0]).toBe('https://example.com/v1/chat/completions');
    });
  });

  describe('health', () => {
    it('returns ok when gateway responds with 200', async () => {
      fetchSpy.mockResolvedValue({
        status: 200,
        statusText: 'OK',
      });

      const result = await client.health();
      expect(result.status).toBe('ok');
      expect(result.message).toContain('200');
    });

    it('returns ok when gateway responds with 400 (alive, rejected input)', async () => {
      fetchSpy.mockResolvedValue({
        status: 400,
        statusText: 'Bad Request',
      });

      const result = await client.health();
      expect(result.status).toBe('ok');
      expect(result.message).toContain('400');
    });

    it('returns error when gateway responds with 500', async () => {
      fetchSpy.mockResolvedValue({
        status: 500,
        statusText: 'Internal Server Error',
      });

      const result = await client.health();
      expect(result.status).toBe('error');
    });

    it('throws HermesConnectionError on network failure', async () => {
      fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
      await expect(client.health()).rejects.toThrow(HermesConnectionError);
    });

    it('throws HermesConnectionError on timeout', async () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      fetchSpy.mockRejectedValue(abortError);

      const fastClient = new HermesClient('https://hermes.example.com', undefined, 100);
      await expect(fastClient.health()).rejects.toThrow(HermesConnectionError);
      await expect(fastClient.health()).rejects.toThrow(/timed out/);
    });

    it('sends health check to /v1/chat/completions', async () => {
      fetchSpy.mockResolvedValue({ status: 200 });
      await client.health();
      expect(fetchSpy.mock.calls[0][0]).toBe('https://hermes.example.com/v1/chat/completions');
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.model).toBe('health-check');
      expect(body.max_tokens).toBe(1);
    });
  });

  describe('chat', () => {
    it('sends message via OpenAI-compatible endpoint and maps response', async () => {
      const openaiResponse = {
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: 1234567890,
        model: 'claude-opus-4-5',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hello from Hermes!' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
      mockJsonResponse(openaiResponse);

      const result = await client.chat('Hi');
      expect(result.response).toBe('Hello from Hermes!');
      expect(result.model).toBe('claude-opus-4-5');
      expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });

      const callArgs = fetchSpy.mock.calls[0];
      expect(callArgs[0]).toBe('https://hermes.example.com/v1/chat/completions');
      expect(callArgs[1].method).toBe('POST');

      const body = JSON.parse(callArgs[1].body);
      expect(body.model).toBe('hermes');
      expect(body.messages).toEqual([{ role: 'user', content: 'Hi' }]);
      expect(body.max_tokens).toBe(4096);
    });

    it('uses custom model from constructor', async () => {
      const customClient = new HermesClient(
        'https://hermes.example.com',
        'test-token',
        120_000,
        'hermes/my-agent'
      );
      const openaiResponse = {
        id: 'chatcmpl-custom',
        object: 'chat.completion',
        created: 1234567890,
        model: 'hermes/my-agent',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hello!' },
            finish_reason: 'stop',
          },
        ],
      };
      mockJsonResponse(openaiResponse);

      await customClient.chat('Hi');
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.model).toBe('hermes/my-agent');
    });

    it('returns empty string when no choices in response', async () => {
      const openaiResponse = {
        id: 'chatcmpl-456',
        object: 'chat.completion',
        created: 1234567890,
        model: 'claude-opus-4-5',
        choices: [],
      };
      mockJsonResponse(openaiResponse);

      const result = await client.chat('Hi');
      expect(result.response).toBe('');
    });

    it('sends Authorization header when gateway token is set', async () => {
      const openaiResponse = {
        id: 'chatcmpl-789',
        object: 'chat.completion',
        created: 1234567890,
        model: 'claude-opus-4-5',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
      };
      mockJsonResponse(openaiResponse);

      await client.chat('test');
      const headers = fetchSpy.mock.calls[0][1].headers;
      expect(headers['Authorization']).toBe('Bearer test-token');
    });

    it('does not send Authorization header when no token', async () => {
      const noTokenClient = new HermesClient('https://hermes.example.com');
      const openaiResponse = {
        id: 'chatcmpl-000',
        object: 'chat.completion',
        created: 1234567890,
        model: 'claude-opus-4-5',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
      };
      mockJsonResponse(openaiResponse);

      await noTokenClient.chat('test');
      const headers = fetchSpy.mock.calls[0][1].headers;
      expect(headers['Authorization']).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('throws HermesApiError on HTTP 500 for chat', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        headers: { get: () => null },
        text: () => Promise.resolve(''),
      });

      await expect(client.chat('test')).rejects.toThrow(HermesApiError);
      await expect(client.chat('test')).rejects.toThrow(/500/);
    });

    it('throws HermesConnectionError on network failure', async () => {
      fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
      await expect(client.chat('test')).rejects.toThrow(HermesConnectionError);
    });

    it('throws HermesConnectionError on timeout (AbortError)', async () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      fetchSpy.mockRejectedValue(abortError);

      const fastClient = new HermesClient('https://hermes.example.com', undefined, 100);
      await expect(fastClient.chat('test')).rejects.toThrow(HermesConnectionError);
      await expect(fastClient.chat('test')).rejects.toThrow(/timed out/);
    });

    it('rejects responses with Content-Length exceeding 10MB', async () => {
      const oversizeLength = String(11 * 1024 * 1024);
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (name: string) => (name === 'content-length' ? oversizeLength : null),
        },
        text: () => Promise.resolve('{}'),
      });

      await expect(client.chat('test')).rejects.toThrow(HermesApiError);
      await expect(client.chat('test')).rejects.toThrow(/10MB/);
    });

    it('rejects responses with body exceeding 10MB', async () => {
      const largeBody = 'x'.repeat(10 * 1024 * 1024 + 1);
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: () => null,
        },
        text: () => Promise.resolve(largeBody),
      });

      await expect(client.chat('test')).rejects.toThrow(HermesApiError);
      await expect(client.chat('test')).rejects.toThrow(/10MB/);
    });
  });

  describe('token refresh and retry on 401/403', () => {
    function unauthorizedResponse(status: 401 | 403) {
      return {
        ok: false,
        status,
        statusText: status === 401 ? 'Unauthorized' : 'Forbidden',
        headers: { get: () => null },
        text: () => Promise.resolve(''),
      };
    }

    function successChatResponse() {
      const body = JSON.stringify({
        id: 'chatcmpl-retry',
        object: 'chat.completion',
        created: 1,
        model: 'claude-opus-4-5',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'after-refresh' },
            finish_reason: 'stop',
          },
        ],
      });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (name: string) => (name === 'content-length' ? String(body.length) : null),
        },
        text: () => Promise.resolve(body),
      };
    }

    it('401 then 200 with refreshed token returns success', async () => {
      const tokenProvider = vi.fn().mockReturnValue('refreshed-token');
      const c = new HermesClient(
        'https://hermes.example.com',
        'stale-token',
        120_000,
        'hermes',
        tokenProvider
      );

      fetchSpy
        .mockResolvedValueOnce(unauthorizedResponse(401))
        .mockResolvedValueOnce(successChatResponse());

      const result = await c.chat('Hi');
      expect(result.response).toBe('after-refresh');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(tokenProvider).toHaveBeenCalledTimes(1);

      // First attempt used the stale token; retry used the refreshed one.
      expect(fetchSpy.mock.calls[0][1].headers['Authorization']).toBe('Bearer stale-token');
      expect(fetchSpy.mock.calls[1][1].headers['Authorization']).toBe('Bearer refreshed-token');
    });

    it('403 then 200 with refreshed token returns success (parity with 401)', async () => {
      const tokenProvider = vi.fn().mockReturnValue('refreshed-token');
      const c = new HermesClient(
        'https://hermes.example.com',
        'stale-token',
        120_000,
        'hermes',
        tokenProvider
      );

      fetchSpy
        .mockResolvedValueOnce(unauthorizedResponse(403))
        .mockResolvedValueOnce(successChatResponse());

      const result = await c.chat('Hi');
      expect(result.response).toBe('after-refresh');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy.mock.calls[1][1].headers['Authorization']).toBe('Bearer refreshed-token');
    });

    it('401 then 401 throws HermesApiError after exactly one retry', async () => {
      const tokenProvider = vi.fn().mockReturnValue('refreshed-token');
      const c = new HermesClient(
        'https://hermes.example.com',
        'stale-token',
        120_000,
        'hermes',
        tokenProvider
      );

      fetchSpy
        .mockResolvedValueOnce(unauthorizedResponse(401))
        .mockResolvedValueOnce(unauthorizedResponse(401));

      await expect(c.chat('Hi')).rejects.toThrow(HermesApiError);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(tokenProvider).toHaveBeenCalledTimes(1);
    });

    it('200 first try does not invoke tokenProvider', async () => {
      const tokenProvider = vi.fn().mockReturnValue('refreshed-token');
      const c = new HermesClient(
        'https://hermes.example.com',
        'good-token',
        120_000,
        'hermes',
        tokenProvider
      );

      fetchSpy.mockResolvedValueOnce(successChatResponse());

      await c.chat('Hi');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(tokenProvider).not.toHaveBeenCalled();
    });

    it('tokenProvider returns undefined on refresh: throws original error without retry', async () => {
      const tokenProvider = vi.fn().mockReturnValue(undefined);
      const c = new HermesClient(
        'https://hermes.example.com',
        'stale-token',
        120_000,
        'hermes',
        tokenProvider
      );

      fetchSpy.mockResolvedValueOnce(unauthorizedResponse(401));

      await expect(c.chat('Hi')).rejects.toThrow(HermesApiError);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(tokenProvider).toHaveBeenCalledTimes(1);
    });

    it('tokenProvider returns same token: does not retry (avoids token-storm)', async () => {
      const tokenProvider = vi.fn().mockReturnValue('stale-token');
      const c = new HermesClient(
        'https://hermes.example.com',
        'stale-token',
        120_000,
        'hermes',
        tokenProvider
      );

      fetchSpy.mockResolvedValueOnce(unauthorizedResponse(401));

      await expect(c.chat('Hi')).rejects.toThrow(HermesApiError);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('does not retry on non-auth status codes (500)', async () => {
      const tokenProvider = vi.fn().mockReturnValue('refreshed-token');
      const c = new HermesClient(
        'https://hermes.example.com',
        'stale-token',
        120_000,
        'hermes',
        tokenProvider
      );

      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        headers: { get: () => null },
        text: () => Promise.resolve(''),
      });

      await expect(c.chat('Hi')).rejects.toThrow(HermesApiError);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(tokenProvider).not.toHaveBeenCalled();
    });

    it('default tokenProvider re-reads process.env.FINNY_UPSTREAM_TOKEN', async () => {
      const original = process.env.FINNY_UPSTREAM_TOKEN;
      process.env.FINNY_UPSTREAM_TOKEN = 'env-refreshed-token';

      try {
        // No tokenProvider passed → default reads from env.
        const c = new HermesClient('https://hermes.example.com', 'stale-token');

        fetchSpy
          .mockResolvedValueOnce(unauthorizedResponse(401))
          .mockResolvedValueOnce(successChatResponse());

        const result = await c.chat('Hi');
        expect(result.response).toBe('after-refresh');
        expect(fetchSpy.mock.calls[1][1].headers['Authorization']).toBe(
          'Bearer env-refreshed-token'
        );
      } finally {
        if (original === undefined) {
          delete process.env.FINNY_UPSTREAM_TOKEN;
        } else {
          process.env.FINNY_UPSTREAM_TOKEN = original;
        }
      }
    });
  });
});
