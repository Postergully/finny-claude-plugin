import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logGatewayCall } from '../../../../mcp/tools/_shared/gatewayLog.js';

describe('gatewayLog extended fields (Workstream C)', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  const captured: string[] = [];

  beforeEach(() => {
    captured.length = 0;
    writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      captured.push(typeof chunk === 'string' ? chunk : (chunk as Buffer).toString());
      return true;
    }) as never);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('records session_id, correction_retry, tool_loop_iter, prompt/completion tokens', () => {
    logGatewayCall(
      {
        method: 'POST',
        url: 'http://localhost:18789/v1/chat/completions',
        body_shape: { messages_count: 3, has_session: true },
      },
      {
        status: 200,
        latency_ms: 1234,
        response_chars: 5678,
      },
      {
        session_id: 'finny-abc',
        session_created: false,
        correction_retry: false,
        tool_loop_iter: 2,
        prompt_tokens: 1000,
        completion_tokens: 500,
      }
    );

    expect(captured.length).toBe(1);
    const record = JSON.parse(captured[0]);
    expect(record.kind).toBe('gateway_call');
    expect(record.diagnostics).toEqual({
      session_id: 'finny-abc',
      session_created: false,
      correction_retry: false,
      tool_loop_iter: 2,
      prompt_tokens: 1000,
      completion_tokens: 500,
    });
  });

  it('still works when diagnostics arg is omitted (back-compat)', () => {
    logGatewayCall(
      { method: 'POST', url: '/x' },
      { status: 200, latency_ms: 1 }
    );
    expect(captured.length).toBe(1);
    const record = JSON.parse(captured[0]);
    expect(record.diagnostics).toBeUndefined();
  });
});
