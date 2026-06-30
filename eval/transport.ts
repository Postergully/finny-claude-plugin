// Shared transport for eval scripts. Both `cli.ts` (the runner) and
// `capture-oracle.ts` invoke MCP tools against the bridge via the Streamable
// HTTP transport at `POST <target>`. Keeping this in one place means the
// MCP wire contract and transport-error fallback stay in sync.
//
// The bridge contract (per bridge/src/server/http.ts:443-444):
//   - `POST /mcp` accepts JSON-RPC 2.0 requests; ALL MCP traffic is here.
//   - First call MUST be `initialize`; server returns `mcp-session-id`
//     header that subsequent calls in the same logical session echo back.
//   - Tool invocations are `tools/call` with `{ name, arguments }` per
//     the MCP spec (https://spec.modelcontextprotocol.io).
//   - `Authorization: Bearer <token>` carries the sealed identity.
//     Identity is NEVER injected into the request body — bridge derives
//     tenant/user/bank from the JWT.
//   - Streamable HTTP requires `Accept: application/json, text/event-stream`.
//   - For single request/response (no notifications) the server replies
//     with `application/json`; we only need to handle that path.

import type { EvalQuery, EvalEnvelope } from './run-eval.ts';

export type FetchEnvelope = (q: EvalQuery) => Promise<EvalEnvelope>;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: {
    content?: Array<{ type: 'text'; text: string } | Record<string, unknown>>;
    isError?: boolean;
    [k: string]: unknown;
  };
  error?: { code: number; message: string; data?: unknown };
}

interface SessionState {
  sessionId?: string;
  initialized: boolean;
  nextId: number;
}

/**
 * Build a fetch function that:
 *   1. Initializes the MCP session lazily on first call (one round-trip).
 *   2. Sends each query as a `tools/call` JSON-RPC request.
 *   3. Unwraps the MCP `content[0].text` JSON into an `EvalEnvelope`.
 *   4. Falls back to a `transport_error` envelope on any non-JSON or
 *      protocol failure so the runner / oracle capturer can still
 *      record what the bridge actually returned.
 *
 * Each EvalQuery gets a fresh sessionState — sessions don't survive across
 * the 20-query batch, and re-initializing per query is cheap (~50ms) and
 * keeps each query independent for fail-fast debugging.
 */
export function makeFetchEnvelope(target: string, token: string | undefined): FetchEnvelope {
  const mcpUrl = target.replace(/\/$/, '');

  return async (q: EvalQuery): Promise<EvalEnvelope> => {
    const state: SessionState = { initialized: false, nextId: 1 };
    try {
      await initialize(mcpUrl, token, state);
      const env = await callTool(mcpUrl, token, state, q);
      return env;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        shape: 'transport_error',
        data: { error: message.slice(0, 500) },
      };
    }
  };
}

async function initialize(
  mcpUrl: string,
  token: string | undefined,
  state: SessionState,
): Promise<void> {
  const id = state.nextId++;
  const res = await mcpFetch(mcpUrl, token, state, {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'finny-eval', version: '0.1' },
    },
  });
  if (res.error) {
    throw new Error(`initialize failed: ${res.error.code} ${res.error.message}`);
  }
  // Notifications/initialized — MCP spec requires this after a successful initialize.
  // No response expected; the bridge returns 202 Accepted.
  await mcpFetch(mcpUrl, token, state, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
  state.initialized = true;
}

async function callTool(
  mcpUrl: string,
  token: string | undefined,
  state: SessionState,
  q: EvalQuery,
): Promise<EvalEnvelope> {
  const id = state.nextId++;
  const res = await mcpFetch(mcpUrl, token, state, {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: q.tool,
      arguments: q.input as Record<string, unknown>,
    },
  });
  if (res.error) {
    return {
      shape: 'transport_error',
      data: {
        jsonrpc_error_code: res.error.code,
        jsonrpc_error_message: res.error.message,
      },
    };
  }
  // MCP tool result shape: { content: [{ type: 'text', text: '<json>' }], isError? }
  // Finny tools always reply with a single text part containing the JSON envelope.
  const content = res.result?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return {
      shape: 'transport_error',
      data: { error: 'tools/call returned empty content array' },
    };
  }
  const part = content[0] as { type?: string; text?: string };
  if (part.type !== 'text' || typeof part.text !== 'string') {
    return {
      shape: 'transport_error',
      data: {
        error: `unexpected content[0] shape: type=${String(part.type)}`,
      },
    };
  }
  try {
    return JSON.parse(part.text) as EvalEnvelope;
  } catch (parseErr) {
    return {
      shape: 'transport_error',
      data: {
        error: 'envelope JSON.parse failed',
        body_preview: part.text.slice(0, 500),
        parse_error: parseErr instanceof Error ? parseErr.message : String(parseErr),
      },
    };
  }
}

/**
 * Single HTTP roundtrip to the MCP endpoint. Handles session header
 * capture on initialize and replay on subsequent calls. Returns the
 * parsed JSON-RPC response (or throws on transport-level failure).
 *
 * Notifications (no `id` field) get no body back; we synthesize an empty
 * success response so the caller doesn't have to special-case them.
 */
async function mcpFetch(
  mcpUrl: string,
  token: string | undefined,
  state: SessionState,
  rpcPayload: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (state.sessionId) headers['mcp-session-id'] = state.sessionId;

  const httpRes = await fetch(mcpUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(rpcPayload),
  });

  // Capture session id on initialize.
  const sid = httpRes.headers.get('mcp-session-id');
  if (sid && !state.sessionId) {
    state.sessionId = sid;
  }

  const isNotification = !('id' in rpcPayload);
  if (httpRes.status === 202 || (isNotification && (httpRes.status === 204 || httpRes.status === 200))) {
    return { jsonrpc: '2.0', id: 0 };
  }

  if (!httpRes.ok) {
    const body = await httpRes.text().catch(() => '');
    throw new Error(
      `MCP HTTP ${httpRes.status} ${httpRes.statusText} — ${body.slice(0, 200)}`,
    );
  }

  const ct = httpRes.headers.get('content-type') ?? '';
  const body = await httpRes.text();

  if (ct.includes('text/event-stream')) {
    // SSE framing: parse the first `data: ...` line. The bridge uses SSE
    // only for streaming notifications; for tools/call it usually replies
    // application/json. Defensive handling either way.
    const dataLine = body.split('\n').find((l) => l.startsWith('data: '));
    if (!dataLine) {
      throw new Error(`SSE response had no data line: ${body.slice(0, 200)}`);
    }
    return JSON.parse(dataLine.slice('data: '.length)) as JsonRpcResponse;
  }

  if (!ct.includes('application/json')) {
    throw new Error(`unexpected content-type: ${ct} — body: ${body.slice(0, 200)}`);
  }
  return JSON.parse(body) as JsonRpcResponse;
}
