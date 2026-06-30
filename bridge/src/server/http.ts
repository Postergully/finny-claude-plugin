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

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import type { Request, Response, NextFunction } from 'express';
import express from 'express';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';

import { HermesAuthProvider, type AuthProviderConfig } from '../auth/provider.js';
import { createOidcVerifier, getOidcDiscovery, type OidcProviderConfig } from '../auth/oidc.js';
import { initAccessDb } from '../auth/access-db.js';
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
  const env = process.env.ENV;
  if (!env) {
    throw new Error('ENV must be set (e.g., staging, production)');
  }
  initAccessDb(env);

  const authEnabled = !!config.authConfig?.clientId;
  const corsConfig = loadCorsConfig();

  // Active sessions
  const streamableSessions = new Map<string, StreamableSession>();

  // Express app from SDK (includes JSON body parser + DNS rebinding protection)
  const appAllowedHosts = (process.env.MCP_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const app = createMcpExpressApp({
    host: config.host,
    ...(appAllowedHosts.length > 0 ? { allowedHosts: appAllowedHosts } : {}),
  });

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

  // --- Auth mode selection ---
  const authMode = process.env.AUTH_MODE === 'oidc' ? 'oidc' : 'builtin';
  let authMiddleware: ((req: Request, res: Response, next: NextFunction) => void) | undefined;

  if (authMode === 'oidc') {
    const oidcIssuer = process.env.OIDC_ISSUER;
    const oidcAudience = process.env.OIDC_AUDIENCE;
    if (!oidcIssuer || !oidcAudience) {
      throw new Error('AUTH_MODE=oidc requires OIDC_ISSUER and OIDC_AUDIENCE env vars');
    }

    const oidcConfig: OidcProviderConfig = {
      issuer: oidcIssuer,
      audience: oidcAudience,
      jwksUri: process.env.OIDC_JWKS_URI || undefined,
    };
    const verifier = await createOidcVerifier(oidcConfig);

    const issuerUrl = config.issuerUrl
      ? new URL(config.issuerUrl)
      : new URL(`http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
    const baseUrl = issuerUrl.toString().replace(/\/$/, '');

    const tokenProxyPath = '/oauth/token';
    const authorizeProxyPath = '/oauth/authorize';

    // Serve OAuth Authorization Server metadata — all endpoints on OUR origin so CoWork
    // doesn't re-derive endpoints from the authorization_endpoint's origin.
    app.get('/.well-known/oauth-authorization-server', async (_req: Request, res: Response) => {
      try {
        const discovery = await getOidcDiscovery(oidcIssuer);
        res.json({
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}${authorizeProxyPath}`,
          token_endpoint: `${baseUrl}${tokenProxyPath}`,
          registration_endpoint: `${baseUrl}/oauth/register`,
          jwks_uri: discovery.jwks_uri,
          scopes_supported: discovery.scopes_supported || ['openid', 'profile', 'email'],
          response_types_supported: discovery.response_types_supported || ['code'],
          grant_types_supported: discovery.grant_types_supported || [
            'authorization_code',
            'refresh_token',
          ],
          code_challenge_methods_supported: discovery.code_challenge_methods_supported || ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          revocation_endpoint: discovery.revocation_endpoint,
        });
      } catch (err) {
        logError('Failed to fetch OIDC discovery', err);
        res.status(502).json({ error: 'Failed to fetch authorization server metadata' });
      }
    });

    // Authorize proxy — 302 redirects to the real IdP authorize endpoint.
    // Keeps authorization_endpoint on our origin so CoWork uses our token_endpoint.
    // Strips `resource` because OneLogin binds it to the auth code server-side
    // and rejects the token exchange if the resource was present at authorize-time.
    app.get(authorizeProxyPath, async (req: Request, res: Response) => {
      try {
        const discovery = await getOidcDiscovery(oidcIssuer);
        const target = new URL(discovery.authorization_endpoint);
        for (const [key, value] of Object.entries(req.query)) {
          if (key === 'resource' || key === 'audience') continue;
          if (typeof value === 'string') target.searchParams.set(key, value);
        }
        res.redirect(302, target.toString());
      } catch (err) {
        logError('Authorize proxy error', err);
        res.status(502).json({
          error: 'authorize_proxy_error',
          error_description: 'Failed to reach authorization endpoint',
        });
      }
    });

    // Token proxy — strips `resource`/`audience` and forwards to the real token endpoint.
    app.post(
      tokenProxyPath,
      express.urlencoded({ extended: false }),
      express.json(),
      async (req: Request, res: Response) => {
        try {
          const discovery = await getOidcDiscovery(oidcIssuer);
          const body = req.body as Record<string, string> | undefined;
          const params = new URLSearchParams();
          if (body && typeof body === 'object') {
            for (const [key, value] of Object.entries(body)) {
              if (key === 'resource' || key === 'audience') continue;
              if (typeof value === 'string') params.set(key, value);
            }
          }
          const tokenRes = await fetch(discovery.token_endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
          });
          const tokenData = await tokenRes.text();
          res
            .status(tokenRes.status)
            .set('Content-Type', tokenRes.headers.get('content-type') || 'application/json')
            .send(tokenData);
        } catch (err) {
          logError('Token proxy error', err);
          res.status(502).json({
            error: 'token_proxy_error',
            error_description: 'Failed to reach token endpoint',
          });
        }
      }
    );

    // DCR proxy — returns the static client_id for MCP clients that attempt registration
    app.post('/oauth/register', express.json(), (_req: Request, res: Response) => {
      const oidcClientId = process.env.OIDC_CLIENT_ID || '';
      res.status(201).json({
        client_id: oidcClientId,
        client_name: 'MCP Client',
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      });
    });

    // Protected Resource Metadata (RFC 9728)
    app.get('/.well-known/oauth-protected-resource/:path', (_req: Request, res: Response) => {
      res.json({
        resource: `${baseUrl}/${_req.params.path}`,
        authorization_servers: [baseUrl],
        scopes_supported: ['openid', 'profile', 'email'],
      });
    });

    const resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource/mcp`;
    authMiddleware = requireBearerAuth({ verifier, resourceMetadataUrl });

    log(`Auth mode: oidc (issuer: ${oidcIssuer})`);
  } else if (authEnabled) {
    const provider = new HermesAuthProvider(config.authConfig!);
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

    // Bearer auth middleware for protected routes.
    // resourceMetadataUrl is included in WWW-Authenticate per RFC 9728 so
    // clients (Claude.ai, Inspector) can discover the OAuth server from a 401.
    const resourceMetadataUrl = `${issuerUrl.toString().replace(/\/$/, '')}/.well-known/oauth-protected-resource/mcp`;
    authMiddleware = requireBearerAuth({ verifier: provider, resourceMetadataUrl });
  }

  // Eval-only loopback bypass: lets `eval/capture-oracle.ts` reach /mcp from
  // localhost without obtaining a real OAuth bearer. Gated by env so it is
  // strictly opt-in per environment, and by a SHA-256-of-shared-secret header
  // so an attacker who can reach 127.0.0.1 (e.g., a co-located process) still
  // can't bypass without the bridge's FINNY_UPSTREAM_TOKEN. The synthetic
  // AuthInfo matches the in-memory provider's shape so downstream tool
  // handlers see a normal authenticated request. NEVER enable in prod.
  if (authMiddleware && process.env.EVAL_BYPASS_ENABLED === 'true') {
    const upstream = process.env.FINNY_UPSTREAM_TOKEN ?? '';
    if (!upstream) {
      throw new Error('EVAL_BYPASS_ENABLED=true but FINNY_UPSTREAM_TOKEN is empty');
    }
    const expectedDigest = createHash('sha256').update(upstream).digest('hex');
    const wrapped = authMiddleware;
    authMiddleware = (req: Request, res: Response, next: NextFunction): void => {
      const remote = req.ip ?? req.socket.remoteAddress ?? '';
      const isLoopback =
        remote === '127.0.0.1' ||
        remote === '::1' ||
        remote === '::ffff:127.0.0.1' ||
        remote === '';
      const hdr = req.header('x-finny-eval-token') ?? '';
      if (isLoopback && hdr.length === expectedDigest.length) {
        const enc = new TextEncoder();
        const a = enc.encode(hdr);
        const b = enc.encode(expectedDigest);
        if (a.byteLength === b.byteLength && timingSafeEqual(a, b)) {
          // Synthetic auth context. clientId/sub/email are eval-only sentinels;
          // they let access-log and tool handlers see a stable identity without
          // implying a real user.
          (req as Request & { auth?: unknown }).auth = {
            token: 'eval-bypass',
            clientId: 'finny-eval',
            scopes: ['openid', 'profile', 'email'],
            expiresAt: Math.floor(Date.now() / 1000) + 60,
            extra: {
              email: 'finny-eval@local',
              sub: 'finny-eval',
            },
          };
          return next();
        }
      }
      return wrapped(req, res, next);
    };
  }

  // --- Health check (no auth) ---
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      transport: 'http',
      auth: authEnabled || authMode === 'oidc',
      authMode,
    });
  });

  // --- Readiness check (no auth) — D7/D11 mitigation ---
  // Probes hermes to distinguish "bridge up" from "bridge can reach
  // hermes". Wired to ALB target-group health check.
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
    const allowedHosts = (process.env.MCP_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: allowedHosts.length > 0,
      allowedHosts: allowedHosts.length > 0 ? allowedHosts : undefined,
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
    log(`Auth mode: ${authMode}`);
    log(`CORS origins: ${corsConfig.enabled ? corsConfig.origins.join(', ') : 'disabled'}`);

    if (authMode === 'oidc') {
      log('OIDC authentication is REQUIRED for all connections');
      log('Endpoints:');
      log('  GET  /.well-known/oauth-authorization-server          - OIDC provider metadata');
      log('  GET  /.well-known/oauth-protected-resource/mcp        - Protected resource metadata');
    } else if (authEnabled) {
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
    log('  GET  /ready    - Deep readiness check (probes hermes, no auth)');
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
