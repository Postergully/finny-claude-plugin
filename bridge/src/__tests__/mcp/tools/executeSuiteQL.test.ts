import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LollyEnvelopeSchema } from '../../../types/envelope.js';

// Mock the OpenClawClient constructor + chat() so the happy path doesn't
// touch the real gateway. Hoisted so the mock is registered before the
// module under test is imported.
const chatMock = vi.hoisted(() =>
  vi.fn<(message: string, sessionId?: string) => Promise<{ response: string; model: string }>>()
);
vi.mock('../../../openclaw/client.js', () => ({
  OpenClawClient: vi.fn().mockImplementation(() => ({
    chat: chatMock,
  })),
}));

// Spy on gatewayLog so we can assert the reason rides in the log record
// and rows are never logged.
const logGatewayMock = vi.hoisted(() => vi.fn<(req: unknown, res: unknown) => void>());
vi.mock('../../../mcp/tools/_shared/gatewayLog.js', () => ({
  logGatewayCall: logGatewayMock,
}));

const { executeSuiteQLTool } = await import('../../../mcp/tools/executeSuiteQL.js');

const BLOCKED_VERBS = [
  'DROP',
  'DELETE',
  'UPDATE',
  'INSERT',
  'ALTER',
  'TRUNCATE',
  'CREATE',
  'GRANT',
  'REVOKE',
  'MERGE',
  'REPLACE',
] as const;

describe('lolly_executeSuiteQL — write-verb guard', () => {
  beforeEach(() => {
    chatMock.mockReset();
    logGatewayMock.mockReset();
  });

  for (const verb of BLOCKED_VERBS) {
    it(`rejects ${verb} (uppercase) with status:"refused" before any gateway call`, async () => {
      const res = await executeSuiteQLTool.handler({
        sql: `${verb} TABLE vendor`,
        env: 'sandbox',
        max_rows: 100,
        reason: 'attempted write',
      });
      expect(res.status).toBe('refused');
      expect(res.confidence_reason).toContain(verb);
      expect(chatMock).not.toHaveBeenCalled();
      expect(logGatewayMock).not.toHaveBeenCalled();
      expect(LollyEnvelopeSchema.safeParse(res).success).toBe(true);
    });

    it(`rejects ${verb.toLowerCase()} (lowercase)`, async () => {
      const res = await executeSuiteQLTool.handler({
        sql: `${verb.toLowerCase()} table vendor`,
        env: 'sandbox',
        max_rows: 100,
        reason: 'attempted write',
      });
      expect(res.status).toBe('refused');
      expect(chatMock).not.toHaveBeenCalled();
    });
  }

  it('rejects mixed-case variants like Drop/Insert', async () => {
    const res1 = await executeSuiteQLTool.handler({
      sql: 'Drop table vendor',
      env: 'sandbox',
      max_rows: 100,
      reason: 'x',
    });
    expect(res1.status).toBe('refused');

    const res2 = await executeSuiteQLTool.handler({
      sql: 'Insert Into vendor VALUES (1)',
      env: 'sandbox',
      max_rows: 100,
      reason: 'x',
    });
    expect(res2.status).toBe('refused');
  });

  it('UPDATE_TS as column name is rejected (conservative false-positive posture)', async () => {
    // Documented tradeoff: \bUPDATE\b matches at the underscore boundary,
    // so UPDATE_TS as a column literally named that will be refused. Users
    // alias the column. This test locks in the behavior so an accidental
    // loosening of the regex is caught.
    const res = await executeSuiteQLTool.handler({
      sql: 'SELECT id, UPDATE_TS FROM vendor',
      env: 'production',
      max_rows: 50,
      reason: 'inspect update timestamps',
    });
    expect(res.status).toBe('refused');
    expect(res.confidence_reason).toContain('UPDATE');
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('rejects the comment trick: SELECT * FROM t -- DROP TABLE u', async () => {
    const res = await executeSuiteQLTool.handler({
      sql: 'SELECT * FROM vendor -- DROP TABLE customer',
      env: 'production',
      max_rows: 100,
      reason: 'comment smuggle',
    });
    expect(res.status).toBe('refused');
    expect(res.confidence_reason).toContain('DROP');
    expect(chatMock).not.toHaveBeenCalled();
  });
});

describe('lolly_executeSuiteQL — happy path + logging', () => {
  beforeEach(() => {
    chatMock.mockReset();
    logGatewayMock.mockReset();
  });

  it('valid SELECT → client.chat invoked, envelope passes through, rows never logged', async () => {
    const rowsEnvelope = {
      status: 'ok',
      intent_restated: 'SELECT count',
      assumptions: [],
      unanswered: [],
      data: {
        shape: 'rows',
        columns: [{ name: 'total', type: 'number' }],
        rows: [[1234]],
      },
      sources: [{ kind: 'suiteql', ref: 'SELECT COUNT(*) FROM vendor' }],
      confidence: 'high',
      confidence_reason: 'query ran cleanly',
    };
    chatMock.mockResolvedValueOnce({
      response: '```json\n' + JSON.stringify(rowsEnvelope) + '\n```',
      model: 'openclaw',
    });

    const res = await executeSuiteQLTool.handler({
      sql: 'SELECT COUNT(*) FROM vendor',
      env: 'production',
      max_rows: 500,
      reason: 'weekly vendor count',
    });

    expect(res.status).toBe('ok');
    if (res.data?.shape === 'rows') {
      expect(res.data.rows).toEqual([[1234]]);
    }
    expect(res.env_used).toBe('production');
    expect(LollyEnvelopeSchema.safeParse(res).success).toBe(true);

    // Gateway logger was called with a request-shape record — verify the
    // logged payload does NOT include any rows from data.rows.
    expect(logGatewayMock).toHaveBeenCalledTimes(1);
    const [reqArg, resArg] = logGatewayMock.mock.calls[0] as [
      { method: string; url: string; body_shape?: unknown },
      { status: number; latency_ms: number; response_chars?: number },
    ];
    expect(reqArg.method).toBe('POST');
    expect(resArg.status).toBe(200);
    // Sanity: the logged object stringified does not contain the data-row value.
    const serialised = JSON.stringify({ req: reqArg, res: resArg });
    expect(serialised).not.toContain('1234');
  });

  it('client.chat throws → error envelope with classified code, logged with non-200 status', async () => {
    const boom = Object.assign(new Error('Request to OpenClaw timed out after 60000ms'), {
      status: 0,
    });
    chatMock.mockRejectedValueOnce(boom);

    const res = await executeSuiteQLTool.handler({
      sql: 'SELECT 1 FROM dual',
      env: 'sandbox',
      max_rows: 10,
      reason: 'timeout test',
    });

    expect(res.status).toBe('error');
    expect(res.error?.code).toBe('timeout');
    expect(logGatewayMock).toHaveBeenCalledTimes(1);
  });

  it('response without parseable JSON → envelope_parse_failed', async () => {
    chatMock.mockResolvedValueOnce({
      response: 'I cannot structure this as JSON sorry',
      model: 'openclaw',
    });
    const res = await executeSuiteQLTool.handler({
      sql: 'SELECT 1 FROM dual',
      env: 'sandbox',
      max_rows: 10,
      reason: 'parse test',
    });
    expect(res.status).toBe('error');
    expect(res.error?.code).toBe('envelope_parse_failed');
  });
});
