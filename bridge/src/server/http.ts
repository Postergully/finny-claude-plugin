/**
 * HTTP Transport (Streamable HTTP) for remote MCP access.
 *
 * M4 decision: /mcp is the only load-bearing transport. Claude cowork's
 * custom connector uses it; token-by-token streaming works via the
 * Streamable HTTP text/event-stream upgrade path inside /mcp (no
 * separate /sse endpoint needed). The legacy GET /sse + POST /messages
 * handler pair was deleted in Task 3 of the M4 plan — reduces attack
 * surface, CORS surface, and session-map bookkeeping.
 *
 * Provides:
 * - Streamable HTTP transport (ALL /mcp) — the production path
 * - OAuth 2.1 authentication via MCP SDK (mcpAuthRouter + requireBearerAuth)
 * - .well-known discovery endpoints for OAuth metadata
 * - CORS support
 * - Health check endpoint
 * - Graceful shutdown
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import type { Request, Response, NextFunction } from 'express';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';

import { OpenClawAuthProvider, type AuthProviderConfig } from '../auth/provider.js';
import { log, logError } from '../utils/logger.js';
import { createMcpServer, type ToolRegistrationDeps } from './tools-registration.js';
import { registerReadyRoute } from './ready.js';
import { accessLogMiddleware } from './accessLog.js';

export interface HttpServerConfig {
  port: number;
  host: string;
  /** Override the OAuth issuer URL (e.g., https://mcp.example.com behind a reverse proxy) */
  issuerUrl?: string;
  /** Auth is enabled when authConfig is provided */
  authConfig?: AuthProviderConfig;
}

/** @deprecated Use HttpServerConfig. Kept for one release as a rename shim. */
export type SSEServerConfig = HttpServerConfig;

// --- CORS helpers ---

/**
 * Load CORS configuration from environment
 */
export function loadCorsConfig(): { origins: string[]; enabled: boolean } {
  const corsOrigins = process.env.CORS_ORIGINS;

  if (!corsOrigins || corsOrigins === '*') {
    return { origins: ['*'], enabled: true };
  }

  if (corsOrigins.toLowerCase() === 'none' || corsOrigins === '') {
    return { origins: [], enabled: false };
  }

  return {
    origins: corsOrigins
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    enabled: true,
  };
}

/**
 * Check if origin is allowed by CORS config
 */
export function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) return false;
  if (allowedOrigins.includes('*')) return true;
  return allowedOrigins.some((allowed) => {
    if (allowed.startsWith('*.')) {
      const domain = allowed.slice(1); // ".example.com"
      try {
        const originHost = new URL(origin).hostname;
        return originHost === domain.slice(1) || originHost.endsWith(domain);
      } catch {
        return false;
      }
    }
    return origin === allowed || origin === `https://${allowed}` || origin === `http://${allowed}`;
  });
}

// --- Session tracking ---

interface StreamableSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
}

// --- Main server factory ---

/**
 * Create and start the HTTP server with Streamable HTTP transport on /mcp.
 */
export async function createHttpServer(
  config: HttpServerConfig,
  deps: ToolRegistrationDeps
): Promise<void> {
  const authEnabled = !!config.authConfig?.clientId;
  const corsConfig = loadCorsConfig();

  // Active sessions
  const streamableSessions = new Map<string, StreamableSession>();

  // Express app from SDK (includes JSON body parser + DNS rebinding protection)
  const app = createMcpExpressApp({ host: config.host });

  // Trust the first proxy hop (Cloudflare / ngrok / reverse proxy) so
  // express-rate-limit can read X-Forwarded-For without throwing
  // ERR_ERL_UNEXPECTED_X_FORWARDED_FOR. Controlled via TRUST_PROXY env var:
  //   "1" / "true" → trust 1 hop; "N" → trust N hops; IP/CIDR → literal.
  if (process.env.TRUST_PROXY) {
    const v = process.env.TRUST_PROXY;
    app.set('trust proxy', v === 'true' ? 1 : Number.isNaN(Number(v)) ? v : Number(v));
  }

  // --- CORS middleware (before auth so preflight works) ---
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!corsConfig.enabled) {
      next();
      return;
    }

    const origin = req.headers.origin as string | undefined;
    const allowedOrigin = corsConfig.origins.includes('*')
      ? '*'
      : origin && isOriginAllowed(origin, corsConfig.origins)
        ? origin
        : undefined;

    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, Mcp-Session-Id, mcp-protocol-version'
      );
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  });

  // --- Access log middleware (before auth so rejected requests are logged) ---
  app.use(accessLogMiddleware());

  // --- OAuth routes (if auth enabled) ---
  let authMiddleware: ((req: Request, res: Response, next: NextFunction) => void) | undefined;

  if (authEnabled) {
    const provider = new OpenClawAuthProvider(config.authConfig!);
    const issuerUrl = config.issuerUrl
      ? new URL(config.issuerUrl)
      : new URL(`http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);

    // Install OAuth endpoints: /authorize, /token, /register, /revoke
    // and .well-known discovery metadata
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl,
        scopesSupported: ['mcp:tools'],
      })
    );

    // Protected Resource Metadata (RFC 9728)
    // Tells clients (Inspector, Claude.ai) where the OAuth server is.
    // This is read-only metadata — no security implications.
    app.get('/.well-known/oauth-protected-resource/:path', (req: Request, res: Response) => {
      res.json({
        resource: `${issuerUrl.toString()}${req.params.path}`,
        authorization_servers: [issuerUrl.toString().replace(/\/$/, '')],
        scopes_supported: ['mcp:tools'],
      });
    });

    // Bearer auth middleware for protected routes
    authMiddleware = requireBearerAuth({ verifier: provider });
  }

  // --- Health check (no auth) ---
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      transport: 'http',
      auth: authEnabled,
    });
  });

  // --- Readiness check (no auth) — D7/D11 mitigation ---
  // Probes openclaw to distinguish "bridge up" from "bridge can reach
  // openclaw". Wired to ALB target-group health check.
  registerReadyRoute(app, deps.registry);

  // Helper to conditionally apply auth middleware
  const withAuth = (handler: (req: Request, res: Response) => Promise<void>) => {
    if (authMiddleware) {
      return [authMiddleware, async (req: Request, res: Response) => handler(req, res)] as const;
    }
    return [async (req: Request, res: Response) => handler(req, res)] as const;
  };

  // --- Streamable HTTP transport (ALL /mcp) ---
  //
  // THE production transport. Handles:
  //   POST /mcp  — JSON-RPC request/response; Accept: text/event-stream
  //                upgrades to SSE for token-by-token streaming on the same
  //                connection.
  //   GET  /mcp  — server-initiated event stream for notifications.
  //   DELETE /mcp — explicit session termination.
  // Session identity carried via the Mcp-Session-Id header.

  const handleStreamableRequest = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && streamableSessions.has(sessionId)) {
      // Existing session
      const session = streamableSessions.get(sessionId)!;
      try {
        await session.transport.handleRequest(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
          req.body
        );
      } catch (error) {
        logError(`Error in streamable session ${sessionId}`, error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal server error' });
        }
      }
      return;
    }

    // New session (initialization request)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        streamableSessions.set(newSessionId, { transport, server });
        log(`Streamable session initialized: ${newSessionId}`);
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        streamableSessions.delete(sid);
        log(`Streamable session closed: ${sid}`);
      }
    };

    const server = createMcpServer(deps);

    try {
      await server.connect(transport);
      await transport.handleRequest(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
        req.body
      );
    } catch (error) {
      logError('Failed to initialize streamable session', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  };

  app.get('/mcp', ...withAuth(handleStreamableRequest));
  app.post('/mcp', ...withAuth(handleStreamableRequest));
  app.delete('/mcp', ...withAuth(handleStreamableRequest));

  // --- Start server ---

  const httpServer: HttpServer = app.listen(config.port, config.host, () => {
    log(`HTTP server listening on ${config.host}:${config.port}`);
    log(`Auth enabled: ${authEnabled}`);
    log(`CORS origins: ${corsConfig.enabled ? corsConfig.origins.join(', ') : 'disabled'}`);

    if (authEnabled) {
      log('OAuth 2.1 authentication is REQUIRED for all connections');
      log('Endpoints:');
      log('  GET  /.well-known/oauth-authorization-server          - OAuth metadata');
      log('  GET  /.well-known/oauth-protected-resource/mcp        - Protected resource metadata');
      log('  POST /authorize                                       - Authorization');
      log('  POST /token                                           - Token exchange');
    } else {
      log('WARNING: Auth is DISABLED - server is open to anyone!');
    }

    log('MCP Endpoints:');
    log('  GET  /health   - Health check (no auth)');
    log('  GET  /ready    - Deep readiness check (probes openclaw, no auth)');
    log('  ALL  /mcp      - Streamable HTTP (production transport)');
  });

  // --- Graceful shutdown ---

  const shutdown = async () => {
    log('Shutting down HTTP server...');

    // Close all streamable sessions
    for (const [id, session] of streamableSessions) {
      try {
        await session.server.close();
      } catch (error) {
        logError(`Error closing streamable session ${id}`, error);
      }
    }
    streamableSessions.clear();

    httpServer.close(() => {
      log('HTTP server stopped');
      process.exit(0);
    });

    // Force exit after 5 seconds
    setTimeout(() => {
      logError('Forced shutdown after timeout');
      process.exit(1);
    }, 5000);
  };

  (process as NodeJS.Process).on('SIGTERM', shutdown);
  (process as NodeJS.Process).on('SIGINT', shutdown);
}

/** @deprecated Use createHttpServer. Rename shim kept for one release. */
export const createSSEServer = createHttpServer;
