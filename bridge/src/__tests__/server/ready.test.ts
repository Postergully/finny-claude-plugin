/**
 * Tests for GET /ready — bridge deep readiness check (D7/D11 mitigation).
 *
 * /ready probes openclaw via OpenClawClient.probeReady() and returns:
 *   200 {ok:true, openclaw:"reachable", latency_ms} when probe ok
 *   503 {ok:false, openclaw:"unreachable", error, latency_ms} otherwise
 *
 * Distinguishes "bridge process up" (= /health) from "bridge can reach
 * openclaw" (= /ready). Body intentionally omits OPENCLAW_URL + tokens.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import type { Express } from 'express';

import { registerReadyRoute } from '../../server/ready.js';
import type { InstanceRegistry } from '../../openclaw/registry.js';
import type { OpenClawClient } from '../../openclaw/client.js';

type ProbeResult = Awaited<ReturnType<OpenClawClient['probeReady']>>;

function makeRegistryStub(probeResult: ProbeResult): InstanceRegistry {
  const client = {
    probeReady: vi.fn(async () => probeResult),
  };
  return {
    getDefault: () => client as unknown as OpenClawClient,
    resolve: () => ({ name: 'default', client: client as unknown as OpenClawClient }),
  } as unknown as InstanceRegistry;
}

function startApp(app: Express): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;
      const close = () =>
        new Promise<void>((res) => {
          server.close(() => res());
        });
      resolve({ baseUrl, close });
    });
  });
}

describe('GET /ready', () => {
  let close: () => Promise<void>;

  afterEach(async () => {
    if (close) await close();
  });

  it('returns 200 ok=true when probe succeeds', async () => {
    const app = express();
    registerReadyRoute(app, makeRegistryStub({ ok: true, latencyMs: 12, upstreamStatus: 200 }));
    const started = await startApp(app);
    close = started.close;

    const res = await fetch(`${started.baseUrl}/ready`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.openclaw).toBe('reachable');
    expect(typeof body.latency_ms).toBe('number');
  });

  it('returns 200 ok=true when upstream is 401 (listener exists)', async () => {
    const app = express();
    registerReadyRoute(app, makeRegistryStub({ ok: true, latencyMs: 8, upstreamStatus: 401 }));
    const started = await startApp(app);
    close = started.close;

    const res = await fetch(`${started.baseUrl}/ready`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });

  it('returns 503 ok=false on timeout', async () => {
    const app = express();
    registerReadyRoute(app, makeRegistryStub({ ok: false, latencyMs: 1001, error: 'timeout' }));
    const started = await startApp(app);
    close = started.close;

    const res = await fetch(`${started.baseUrl}/ready`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.error).toBe('timeout');
    expect(body.openclaw).toBe('unreachable');
  });

  it('returns 503 with connection_refused error on tunnel down', async () => {
    const app = express();
    registerReadyRoute(
      app,
      makeRegistryStub({ ok: false, latencyMs: 5, error: 'connection_refused' })
    );
    const started = await startApp(app);
    close = started.close;

    const res = await fetch(`${started.baseUrl}/ready`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('connection_refused');
  });

  it('does not echo OPENCLAW_URL or token in body', async () => {
    const app = express();
    registerReadyRoute(
      app,
      makeRegistryStub({ ok: false, latencyMs: 5, error: 'connection_refused' })
    );
    const started = await startApp(app);
    close = started.close;

    const res = await fetch(`${started.baseUrl}/ready`);
    const body = await res.text();
    expect(body).not.toMatch(/Bearer/i);
    expect(body).not.toMatch(/127\.0\.0\.1:18789/);
    expect(body).not.toMatch(/sk-/);
  });
});
