import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  formatAccessLogLine,
  summarizeEnvelopeForLog,
  resetAccessLogWriter,
  accessLogMiddleware,
  type AccessLogLine,
} from '../../server/accessLog.js';
import type { LollyEnvelope } from '../../types/envelope.js';

describe('formatAccessLogLine — shape discipline', () => {
  it('emits only allow-listed fields, even if input has extras', () => {
    const line = {
      ts: '2026-05-12T00:00:00Z',
      method: 'POST',
      path: '/mcp',
      status: 200,
      duration_ms: 42,
      tool: 'lolly_query',
      envelope_status: 'ok' as const,
      envelope_confidence: 'high' as const,
      lolly_session_id: 'sess-1',
      // Stray field simulating a caller accidentally passing a full envelope.
      // Cast to AccessLogLine strips the type, proving formatAccessLogLine
      // filters it at runtime regardless of what the caller passes.
      data: { rows: [['secret vendor']] },
    } as unknown as AccessLogLine;
    const out = formatAccessLogLine(line);
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({
      ts: '2026-05-12T00:00:00Z',
      method: 'POST',
      path: '/mcp',
      status: 200,
      duration_ms: 42,
      tool: 'lolly_query',
      envelope_status: 'ok',
      envelope_confidence: 'high',
      lolly_session_id: 'sess-1',
    });
    expect(parsed).not.toHaveProperty('data');
    expect(out).not.toContain('secret vendor');
  });

  it('omits optional fields when undefined', () => {
    const out = formatAccessLogLine({
      ts: '2026-05-12T00:00:00Z',
      method: 'GET',
      path: '/mcp',
      status: 401,
      duration_ms: 1,
    });
    const parsed = JSON.parse(out);
    expect(parsed).not.toHaveProperty('tool');
    expect(parsed).not.toHaveProperty('auth_subject');
    expect(parsed).not.toHaveProperty('lolly_session_id');
  });
});

describe('summarizeEnvelopeForLog — PII exclusion', () => {
  it('strips data, error.message, intent_restated, assumptions, unanswered, sources', () => {
    const env: LollyEnvelope = {
      status: 'error',
      intent_restated: 'What is the balance for vendor XYZ Corp',
      assumptions: ['vendor XYZ is in production NetSuite'],
      unanswered: ['GSTIN field was blocked'],
      data: null,
      sources: [{ kind: 'suiteql', ref: 'SELECT * FROM vendor' }],
      confidence: 'low',
      confidence_reason: 'API request failed: 401 Unauthorized',
      error: {
        code: 'unauthorized',
        message: 'API request failed: 401 Unauthorized — token SECRET_TOKEN_VALUE invalid',
        retryable: false,
      },
      elapsed_ms: 42,
      env_used: 'production',
      bridge_version: '0.0.1',
      lolly_session_id: 'sess-xyz',
    };
    const summary = summarizeEnvelopeForLog('lolly_query', env);
    const json = JSON.stringify(summary);
    expect(summary.tool).toBe('lolly_query');
    expect(summary.status).toBe('error');
    expect(summary.confidence).toBe('low');
    expect(summary.error_code).toBe('unauthorized');
    expect(summary.lolly_session_id).toBe('sess-xyz');
    // Verify NONE of the PII-bearing fields leaked through
    expect(json).not.toContain('SECRET_TOKEN_VALUE');
    expect(json).not.toContain('XYZ Corp');
    expect(json).not.toContain('GSTIN');
    expect(json).not.toContain('SELECT');
    expect(json).not.toContain('API request failed');
    expect(summary).not.toHaveProperty('data');
    expect(summary).not.toHaveProperty('intent_restated');
    expect(summary).not.toHaveProperty('assumptions');
    expect(summary).not.toHaveProperty('unanswered');
    expect(summary).not.toHaveProperty('sources');
  });

  it('preserves the bridge-guard refused signal', () => {
    const env: LollyEnvelope = {
      status: 'refused',
      intent_restated: 'Delete all vendor bills',
      assumptions: [],
      unanswered: [],
      data: null,
      sources: [],
      confidence: 'high',
      confidence_reason: "Refused: destructive verb 'delete' + entity 'bill'",
      elapsed_ms: 0,
      env_used: 'production',
      bridge_version: '0.0.1',
      lolly_session_id: '—',
    };
    const summary = summarizeEnvelopeForLog('lolly_query', env);
    expect(summary.status).toBe('refused');
    expect(summary.confidence).toBe('high');
    expect(summary.error_code).toBeUndefined();
  });

  // Track G: discover_violation flag detection.
  it('flags discover_violation when confidence_reason carries the bridge marker', () => {
    const env: LollyEnvelope = {
      status: 'ok',
      intent_restated: 'discover with violation',
      assumptions: [],
      unanswered: [],
      data: { shape: 'narrative', narrative: 'whatever' },
      sources: [{ kind: 'suiteql', ref: 'SELECT ...' }],
      confidence: 'high',
      confidence_reason:
        'live SuiteQL aggregate [bridge: discover phase ran live NetSuite queries — see bridge log for discover_violation]',
      elapsed_ms: 100,
      env_used: 'production',
      bridge_version: '0.0.1',
      lolly_session_id: 'sess',
    };
    const summary = summarizeEnvelopeForLog('lolly_query', env);
    expect(summary.discover_violation).toBe(true);
  });

  it('does not flag discover_violation on clean envelopes', () => {
    const env: LollyEnvelope = {
      status: 'ok',
      intent_restated: 'clean discover',
      assumptions: [],
      unanswered: [],
      data: { shape: 'narrative', narrative: 'memory-only answer' },
      sources: [{ kind: 'memory', ref: 'user-defaults' }],
      confidence: 'medium',
      confidence_reason: 'memory + skill',
      elapsed_ms: 50,
      env_used: 'production',
      bridge_version: '0.0.1',
      lolly_session_id: 'sess',
    };
    const summary = summarizeEnvelopeForLog('lolly_query', env);
    expect(summary.discover_violation).toBeUndefined();
  });

  it('formatAccessLogLine includes discover_violation when set', () => {
    const line = {
      ts: '2026-05-14T22:00:00.000Z',
      method: 'POST',
      path: '/mcp',
      status: 200,
      duration_ms: 50000,
      tool: 'lolly_query',
      envelope_status: 'ok' as const,
      envelope_confidence: 'high' as const,
      discover_violation: true,
    };
    const json = formatAccessLogLine(line);
    expect(JSON.parse(json).discover_violation).toBe(true);
  });
});

describe('accessLogMiddleware — path filtering + file output', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lolly-accesslog-'));
    logPath = path.join(tmpDir, 'access.jsonl');
    process.env.ACCESS_LOG_PATH = logPath;
    resetAccessLogWriter();
  });

  afterEach(() => {
    delete process.env.ACCESS_LOG_PATH;
    resetAccessLogWriter();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function mockRes() {
    const finishHandlers: Array<() => void> = [];
    const res: {
      statusCode: number;
      locals: Record<string, unknown>;
      on: (evt: string, cb: () => void) => void;
      _fire: () => void;
    } = {
      statusCode: 200,
      locals: {},
      on: (evt, cb) => {
        if (evt === 'finish') finishHandlers.push(cb);
      },
      _fire: () => {
        for (const cb of finishHandlers) cb();
      },
    };
    return res;
  }

  it('short-circuits for non-/mcp paths', async () => {
    const mw = accessLogMiddleware();
    const res = mockRes();
    const next = vi.fn();
    mw({ method: 'GET', path: '/health' } as never, res as never, next);
    res._fire();
    expect(next).toHaveBeenCalled();
    // wait a tick for async write
    await new Promise((r) => setTimeout(r, 20));
    const content = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    expect(content).toBe('');
  });

  it('writes one JSONL line per /mcp request on finish', async () => {
    const mw = accessLogMiddleware();
    const res = mockRes();
    res.statusCode = 200;
    // Simulate tool handler recording the envelope summary via the shared
    // res.locals fallback path (since the AsyncLocalStorage context flows
    // through next(), not available in the middleware-direct test path).
    res.locals.envelopeSummary = {
      tool: 'lolly_query',
      status: 'ok',
      confidence: 'high',
      lolly_session_id: 'sess-1',
    };
    const next = vi.fn();
    mw({ method: 'POST', path: '/mcp' } as never, res as never, next);
    res._fire();
    // Give fs.createWriteStream time to flush
    await new Promise((r) => setTimeout(r, 50));
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.method).toBe('POST');
    expect(parsed.path).toBe('/mcp');
    expect(parsed.status).toBe(200);
    expect(parsed.tool).toBe('lolly_query');
    expect(parsed.envelope_status).toBe('ok');
    expect(parsed.envelope_confidence).toBe('high');
    expect(parsed.lolly_session_id).toBe('sess-1');
  });

  it('logs rejected requests even without envelopeSummary (e.g., 401)', async () => {
    const mw = accessLogMiddleware();
    const res = mockRes();
    res.statusCode = 401;
    // res.locals.envelopeSummary deliberately unset
    const next = vi.fn();
    mw({ method: 'POST', path: '/mcp' } as never, res as never, next);
    res._fire();
    await new Promise((r) => setTimeout(r, 50));
    const content = fs.readFileSync(logPath, 'utf8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.status).toBe(401);
    expect(parsed.tool).toBeUndefined();
  });
});
