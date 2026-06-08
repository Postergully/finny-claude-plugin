// Gateway-side diagnostic logger: JSONL to stderr.
// Never logs Authorization header, request/response bodies, or token material.
// Response body preview (<=512 chars) only recorded on non-2xx responses.

export type GatewayRequestShape = {
  method: string;
  url: string;
  body_shape?: {
    model?: string;
    messages_count?: number;
    max_tokens?: number;
    has_session?: boolean;
  };
};

export type GatewayResponseShape = {
  status: number;
  latency_ms: number;
  response_chars?: number;
  body_preview?: string;
  error?: string;
};

// Workstream C (2026-06-08): per-call diagnostics. All fields optional so
// callers can populate what they know. Used by analyze-gateway-log.mjs and
// bridge-watch.mjs to attribute latency and detect session churn.
export type GatewayDiagnostics = {
  session_id?: string;
  session_created?: boolean;
  correction_retry?: boolean;
  tool_loop_iter?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
};

export function logGatewayCall(
  req: GatewayRequestShape,
  res: GatewayResponseShape,
  diagnostics?: GatewayDiagnostics
): void {
  const record = {
    ts: new Date().toISOString(),
    kind: 'gateway_call',
    request: {
      method: req.method,
      url: req.url,
      body_shape: req.body_shape,
    },
    response: res,
    ...(diagnostics ? { diagnostics } : {}),
  };
  try {
    process.stderr.write(JSON.stringify(record) + '\n');
  } catch {
    // Logging must never throw.
  }
}

export type GatewayQueryAggregate = {
  session_id: string;
  total_calls: number;
  total_latency_ms: number;
  phases: {
    initial: { calls: number; latency_ms: number };
    correction: { calls: number; latency_ms: number };
    progress_loop: { calls: number; latency_ms: number };
  };
};

// Workstream C: emit one summary record per logical query (after all
// gateway calls for that query are done). Distinct kind so the analyzer
// can separate per-call from per-query records.
export function logGatewayQueryAggregate(agg: GatewayQueryAggregate): void {
  const record = {
    ts: new Date().toISOString(),
    kind: 'gateway_query_aggregate',
    aggregate: agg,
  };
  try {
    process.stderr.write(JSON.stringify(record) + '\n');
  } catch {
    // Logging must never throw.
  }
}
