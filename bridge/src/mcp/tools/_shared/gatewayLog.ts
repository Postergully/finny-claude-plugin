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

export function logGatewayCall(req: GatewayRequestShape, res: GatewayResponseShape): void {
  const record = {
    ts: new Date().toISOString(),
    kind: 'gateway_call',
    request: {
      method: req.method,
      url: req.url,
      body_shape: req.body_shape,
    },
    response: res,
  };
  try {
    process.stderr.write(JSON.stringify(record) + '\n');
  } catch {
    // Logging must never throw.
  }
}
