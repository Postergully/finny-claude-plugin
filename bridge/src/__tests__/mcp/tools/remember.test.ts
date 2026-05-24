import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FinnyEnvelopeSchema } from '../../../types/envelope.js';

// Mock the gateway client — we don't need a real chat round-trip; the
// remember tool synthesizes its own success envelope after Finny
// acknowledges. The mock just controls success vs failure of that call.
const chatMock = vi.hoisted(() =>
  vi.fn<(message: string, sessionId?: string) => Promise<{ response: string; model: string }>>()
);
vi.mock('../../../hermes/client.js', () => ({
  HermesClient: vi.fn().mockImplementation(() => ({
    chat: chatMock,
  })),
}));

// Silence the access log.
vi.mock('../../../mcp/tools/_shared/gatewayLog.js', () => ({
  logGatewayCall: vi.fn(),
}));

const { rememberTool, rememberInputSchema } = await import('../../../mcp/tools/remember.js');

beforeEach(() => {
  chatMock.mockReset();
});

describe('finny_remember — happy path', () => {
  it('valid input → returns ok envelope with data.shape: scalar, value: ok', async () => {
    chatMock.mockResolvedValueOnce({
      response: '```json\n{"status":"ok","data":{"shape":"scalar","value":"ok"}}\n```',
      model: 'mock',
    });

    const res = await rememberTool.handler({
      content: 'Today: vendor_balance asked 4×; one drift event on env=sandbox.',
      tags: ['day_dream', '2026-05-15'],
      source: 'cowork',
    });

    expect(res.status).toBe('ok');
    expect(res.data).toEqual({ shape: 'scalar', value: 'ok' });
    expect(FinnyEnvelopeSchema.safeParse(res).success).toBe(true);
    expect(chatMock).toHaveBeenCalledTimes(1);
  });
});

describe('finny_remember — input validation', () => {
  it('content over 8000 chars is rejected by inputSchema', () => {
    const result = rememberInputSchema.safeParse({
      content: 'x'.repeat(8001),
      tags: [],
      source: 'cowork',
    });
    expect(result.success).toBe(false);
  });

  it('source outside the cowork|manual enum is rejected', () => {
    const result = rememberInputSchema.safeParse({
      content: 'hi',
      tags: [],
      source: 'random',
    });
    expect(result.success).toBe(false);
  });
});

describe('finny_remember — gateway error', () => {
  it('gateway throws → handler returns errorEnvelope with code: internal', async () => {
    chatMock.mockRejectedValueOnce(new Error('gateway boom'));

    const res = await rememberTool.handler({
      content: 'note',
      tags: [],
      source: 'manual',
    });

    expect(res.status).toBe('error');
    expect(res.error?.code).toBe('internal');
    expect(res.error?.message).toMatch(/gateway boom/);
    expect(FinnyEnvelopeSchema.safeParse(res).success).toBe(true);
  });
});
