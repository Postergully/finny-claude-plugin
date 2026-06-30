// Shared transport for eval scripts. Both `cli.ts` (the runner) and `capture-oracle.ts`
// (the oracle capture helper) POST a query's `input` to `<target>/tools/<tool>` and parse
// the JSON response as an envelope. Keeping this in one place means the route convention
// and the transport-error fallback shape stay in sync.
//
// The bridge contract: each MCP tool is exposed at `<target>/tools/<tool-name>`, with
// `Authorization: Bearer <token>` carrying the sealed identity. Identity is NEVER injected
// into the request body — bridge derives tenant/user/bank from the JWT.

import type { EvalQuery, EvalEnvelope } from './run-eval.ts';

export type FetchEnvelope = (q: EvalQuery) => Promise<EvalEnvelope>;

export function makeFetchEnvelope(target: string, token: string | undefined): FetchEnvelope {
  return async (q: EvalQuery): Promise<EvalEnvelope> => {
    const url = `${target.replace(/\/$/, '')}/tools/${encodeURIComponent(q.tool)}`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers['authorization'] = `Bearer ${token}`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ input: q.input }),
    });
    const body = await res.text();
    try {
      return JSON.parse(body) as EvalEnvelope;
    } catch {
      // Non-JSON response → synthesize a transport_error envelope so callers see a real
      // shape they can serialize/diff against. The runner treats this as a shape mismatch;
      // the oracle capturer writes it to disk so the operator can see what the bridge
      // actually returned (HTML error page, plain-text 502, etc).
      return { shape: 'transport_error', data: { http_status: res.status, body: body.slice(0, 500) } };
    }
  };
}
