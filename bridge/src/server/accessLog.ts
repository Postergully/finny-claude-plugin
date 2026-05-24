/**
 * Per-request access log for /mcp.
 *
 * Emits one JSONL line per request on response finish. Zero PII by
 * construction: we never log envelope data (`data.rows`, `data.narrative`,
 * `intent_restated`), error messages, or assumptions. We DO log shape:
 * tool name, envelope status, confidence, finny_session_id, infra
 * error code (not message), HTTP status, duration.
 *
 * Tool handlers opt in by setting `res.locals.envelopeSummary` before
 * returning. If not set (non-tool calls like `initialize` / `tools/list`),
 * those fields are omitted and the log line still captures HTTP-layer
 * telemetry.
 *
 * Output destination:
 *   - process.env.ACCESS_LOG_PATH if set — append-only JSONL file
 *   - otherwise stderr (visible in nohup logs). NEVER stdout — in stdio
 *     mode stdout IS the MCP protocol stream and we must not corrupt it.
 *     We don't auto-run in stdio mode, but defense in depth.
 */

import type { NextFunction, Request, Response } from 'express';
import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { FinnyEnvelope } from '../types/envelope.js';

export interface EnvelopeSummary {
  tool: string;
  status: FinnyEnvelope['status'];
  confidence: FinnyEnvelope['confidence'];
  finny_session_id?: string;
  error_code?: string;
  // Track G: true when phase: 'discover' returned an envelope with
  // sources[] containing kind 'suiteql' or 'rest'. The bridge surfaces
  // (does not strip) the violation so we can measure rate via log
  // analysis. See finalizeEnvelope in chatPipeline.ts.
  discover_violation?: boolean;
}

export interface AccessLogLine {
  ts: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  auth_subject?: string;
  tool?: string;
  envelope_status?: FinnyEnvelope['status'];
  envelope_confidence?: FinnyEnvelope['confidence'];
  finny_session_id?: string;
  error_code?: string;
  discover_violation?: boolean;
}

/**
 * Per-request context threaded via AsyncLocalStorage so tool handlers
 * (which don't have `res` in scope — they're called through the MCP SDK
 * JSON-RPC layer) can still register their envelope summary for the
 * access log line.
 */
interface RequestContext {
  envelopeSummary?: EnvelopeSummary;
}
const requestContext = new AsyncLocalStorage<RequestContext>();

export function runWithAccessLogContext<T>(fn: () => Promise<T>): Promise<T> {
  const ctx: RequestContext = {};
  return requestContext.run(ctx, fn);
}

export function recordEnvelopeForLog(summary: EnvelopeSummary): void {
  const ctx = requestContext.getStore();
  if (ctx) ctx.envelopeSummary = summary;
}

let _writer: ((line: string) => void) | null = null;

function getWriter(): (line: string) => void {
  if (_writer) return _writer;
  const path = process.env.ACCESS_LOG_PATH;
  if (path && path.length > 0) {
    // Open in append mode; keep the fd alive for the process lifetime.
    const stream = fs.createWriteStream(path, { flags: 'a' });
    _writer = (line) => stream.write(line + '\n');
  } else {
    // Stderr fallback. Stderr is always safe; stdout is reserved for the
    // stdio MCP protocol stream.
    _writer = (line) => process.stderr.write(line + '\n');
  }
  return _writer;
}

/**
 * For tests: reset the memoized writer so a new ACCESS_LOG_PATH takes effect.
 */
export function resetAccessLogWriter(): void {
  _writer = null;
}

/**
 * Serialize an AccessLogLine to JSON. Defensive — guarantees no `data.*`
 * or `error.message` field can leak even if a caller ignores the typed
 * `EnvelopeSummary` contract and passes a full envelope by mistake.
 */
export function formatAccessLogLine(line: AccessLogLine): string {
  const cleaned: AccessLogLine = {
    ts: line.ts,
    method: line.method,
    path: line.path,
    status: line.status,
    duration_ms: line.duration_ms,
  };
  if (line.auth_subject !== undefined) cleaned.auth_subject = line.auth_subject;
  if (line.tool !== undefined) cleaned.tool = line.tool;
  if (line.envelope_status !== undefined) cleaned.envelope_status = line.envelope_status;
  if (line.envelope_confidence !== undefined)
    cleaned.envelope_confidence = line.envelope_confidence;
  if (line.finny_session_id !== undefined) cleaned.finny_session_id = line.finny_session_id;
  if (line.error_code !== undefined) cleaned.error_code = line.error_code;
  if (line.discover_violation !== undefined) cleaned.discover_violation = line.discover_violation;
  return JSON.stringify(cleaned);
}

/**
 * Express middleware. Mount on the /mcp path before auth middleware so
 * failed auth attempts are still logged (but without an auth_subject).
 */
export function accessLogMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = Date.now();
    const pathOf = req.path;

    // Only log /mcp requests. Non-MCP paths (/health, /authorize, /token,
    // /.well-known/*) are either noise or ALREADY logged by the SDK.
    if (!pathOf.startsWith('/mcp')) {
      next();
      return;
    }

    // Snapshot the AsyncLocalStorage context reference at middleware entry
    // so the finish handler can read whatever the tool handler wrote.
    const ctx: RequestContext = {};
    res.locals.__accessLogCtx = ctx;

    res.on('finish', () => {
      const duration = Date.now() - started;
      const summary: EnvelopeSummary | undefined =
        ctx.envelopeSummary ?? (res.locals.envelopeSummary as EnvelopeSummary | undefined);
      const authSubject: string | undefined =
        (res.locals.authSubject as string | undefined) ??
        // @ts-expect-error — SDK augments req.auth
        (req.auth?.subject as string | undefined);

      const line: AccessLogLine = {
        ts: new Date().toISOString(),
        method: req.method,
        path: pathOf,
        status: res.statusCode,
        duration_ms: duration,
      };
      if (authSubject) line.auth_subject = authSubject;
      if (summary) {
        line.tool = summary.tool;
        line.envelope_status = summary.status;
        line.envelope_confidence = summary.confidence;
        if (summary.finny_session_id) line.finny_session_id = summary.finny_session_id;
        if (summary.error_code) line.error_code = summary.error_code;
        if (summary.discover_violation) line.discover_violation = true;
      }
      try {
        getWriter()(formatAccessLogLine(line));
      } catch {
        // Log IO must never crash the request path.
      }
    });

    // Wrap downstream handlers inside the AsyncLocalStorage context so
    // anything awaited from here forward can call recordEnvelopeForLog().
    requestContext.run(ctx, () => next());
  };
}

/**
 * Helper for tool handlers: lift a completed envelope into an EnvelopeSummary
 * shape. This is the ONLY approved path from envelope → log line; it enforces
 * the "shape only, never content" rule at the type system level by stripping
 * `data`, `error.message`, `intent_restated`, `assumptions`, `unanswered`,
 * and `sources`.
 */
export function summarizeEnvelopeForLog(tool: string, env: FinnyEnvelope): EnvelopeSummary {
  const summary: EnvelopeSummary = {
    tool,
    status: env.status,
    confidence: env.confidence,
  };
  if (env.finny_session_id) summary.finny_session_id = env.finny_session_id;
  if (env.error?.code) summary.error_code = env.error.code;
  // Track G: detect the bridge-side discover_violation marker from
  // finalizeEnvelope (chatPipeline.ts). Marker is a substring of
  // confidence_reason because that's the only cross-tool field we can
  // annotate without a schema change. Pattern is stable and not
  // user-emittable (the bracketed `[bridge: ...]` namespace is reserved).
  if (env.confidence_reason.includes('[bridge: discover phase ran live NetSuite queries')) {
    summary.discover_violation = true;
  }
  return summary;
}
