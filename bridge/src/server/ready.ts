/**
 * GET /ready — deep readiness probe for the bridge.
 *
 * Returns 200 if the bridge can reach hermes's /v1/models endpoint
 * (HEAD, 1s timeout), 503 otherwise. Used by the ALB health check
 * to gate traffic.
 *
 * D7/D11 mitigation: /health (sibling) returns 200 as long as the
 * bridge process is up, which lied throughout the D4 spiral. /ready
 * exercises the full bridge → tunnel → gateway path.
 *
 * Response body intentionally omits FINNY_UPSTREAM_URL, tokens, headers,
 * and any topology details that could leak through public ALB.
 */

import type { Express, Request, Response } from 'express';
import type { InstanceRegistry } from '../hermes/registry.js';

export function registerReadyRoute(app: Express, registry: InstanceRegistry): void {
  app.get('/ready', async (_req: Request, res: Response) => {
    const client = registry.getDefault();
    const result = await client.probeReady(1000);

    if (result.ok) {
      res.status(200).json({
        ok: true,
        hermes: 'reachable',
        latency_ms: result.latencyMs,
      });
      return;
    }

    res.status(503).json({
      ok: false,
      hermes: 'unreachable',
      error: result.error ?? 'unknown',
      latency_ms: result.latencyMs,
    });
  });
}
