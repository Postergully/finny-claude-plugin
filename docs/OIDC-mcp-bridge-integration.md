# Zitadel → MCP Bridge Integration — Technical Runbook

**Date:** 2026-06-13
**Status:** Design reference for implementation session
**Repos affected:** `reference-files/lolly-claude-plugin/bridge/`, `reference-files/finny-claude-plugin/bridge/`

## Goal

Replace the built-in OAuth server in both MCP bridges with Zitadel as an external authorization server. The bridge becomes a stateless resource server that validates Zitadel-issued JWTs.

## Current Architecture (what we have today)

```
Claude Desktop (CoWork)
  │
  │  OAuth 2.1 PKCE (handled ENTIRELY by our bridge)
  │  /authorize → auto-approve → /token → bearer for /mcp
  │
  ▼
MCP Bridge (:3000)  ← owns: client store, auth codes, tokens, refresh tokens, sessions
  │
  ▼
Agent (OpenClaw :18789 or Hermes :8642)
```

The bridge implements `OAuthServerProvider` from `@modelcontextprotocol/sdk` which provides:
- `/authorize` — authorization endpoint (currently auto-approves)
- `/token` — token exchange (auth code → access token, refresh token → new access token)
- `/.well-known/oauth-authorization-server` — metadata discovery
- `requireBearerAuth` middleware — validates tokens on `/mcp`

ALL token state is in-memory (Maps). Restarts kill all sessions.

## Target Architecture (what we want)

```
Claude Desktop (CoWork)
  │
  │  OAuth 2.1 PKCE
  │  /authorize → REDIRECT TO ZITADEL → user logs in (Google/GitHub/SSO)
  │  /token → PROXY TO ZITADEL (or Zitadel issues directly)
  │
  ▼
Zitadel (client VPC)  ← owns: users, sessions, tokens, refresh tokens, social login, SSO
  │  issues JWT (signed, with user claims: email, sub, roles)
  │
  ▼
MCP Bridge (:3000)  ← owns: NOTHING auth-related, only validates JWT via JWKS
  │  extracts: email, sub, scopes from JWT claims
  │
  ▼
Agent
```

## Key Design Decisions

### 1. How CoWork discovers Zitadel

The MCP SDK's OAuth client (inside Claude Desktop) performs discovery via:
1. `POST /mcp` → gets 401 with `WWW-Authenticate: Bearer resource_metadata="..."` 
2. Fetches `/.well-known/oauth-protected-resource/mcp` → gets `authorization_servers: [...]`
3. Fetches `/.well-known/oauth-authorization-server` from that URL → gets `authorization_endpoint`, `token_endpoint`, etc.

**Two integration patterns:**

**Pattern A — Bridge proxies metadata to Zitadel (recommended):**
- Bridge serves `/.well-known/oauth-authorization-server` but returns Zitadel's endpoints
- `authorization_endpoint` → `https://zitadel.client.vpc/oauth/v2/authorize`
- `token_endpoint` → `https://zitadel.client.vpc/oauth/v2/token`
- Bridge still serves `/.well-known/oauth-protected-resource/mcp` (points to Zitadel as authorization server)
- Bridge's `/mcp` validates Zitadel-issued JWTs via JWKS at `https://zitadel.client.vpc/oauth/v2/keys`

**Pattern B — Bridge's authorize() redirects to Zitadel:**
- Bridge keeps `mcpAuthRouter` but the `authorize()` method redirects to Zitadel
- Bridge's `/token` proxies to Zitadel's token endpoint
- More invasive but keeps MCP SDK's routing intact

**Decision: We use Pattern A.** The bridge serves discovery metadata pointing to the external OIDC provider and only validates JWTs on `/mcp`. It does not mount `mcpAuthRouter` or handle `/authorize`/`/token` itself.

### 2. Token validation on /mcp

Replace `requireBearerAuth({ verifier: provider })` with a custom verifier that:
- Fetches Zitadel's JWKS from `/.well-known/openid-configuration` → `jwks_uri`
- Validates JWT signature (RS256)
- Checks `exp`, `iss`, `aud` claims
- Extracts `sub`, `email`, `roles` into `AuthInfo`

The MCP SDK already supports `OAuthTokenVerifier` interface (just `verifyAccessToken`).

### 3. What to do with existing OAuth code

**Do NOT delete it.** Bypass it with an env var toggle:
- `AUTH_MODE=oidc` → use external OIDC provider (Zitadel, OneLogin, Okta, etc.)
- `AUTH_MODE=builtin` or absent → use existing `OAuthServerProvider` (current flow)

This allows safe rollback.

**Env vars for OIDC mode — OneLogin (`.env`):**
```bash
AUTH_MODE=oidc
OIDC_ISSUER=https://<client-subdomain>.onelogin.com/oidc/2
OIDC_AUDIENCE=<client-id-from-onelogin>
OIDC_CLIENT_ID=<client-id-from-onelogin>
# OIDC_JWKS_URI=                                     # Optional override, skips discovery for JWKS
```

**Env vars for OIDC mode — Zitadel (`.env`):**
```bash
AUTH_MODE=oidc
OIDC_ISSUER=https://auth.staging.11mirror.com
OIDC_AUDIENCE=<zitadel-project-id>
OIDC_CLIENT_ID=<zitadel-oidc-app-client-id>
# OIDC_JWKS_URI=                                     # Optional override, skips discovery for JWKS
```

### 4. User identity propagation

Zitadel JWT contains standard OIDC claims:
- `sub` — unique user ID in Zitadel
- `email` — user's email (from Google/GitHub/SSO)
- `email_verified` — boolean
- `name` — display name
- Custom claims for roles/tenant

These map to `AuthInfo.extra` (the SDK's extension field) and `AuthInfo.clientId` can carry the `sub`.

## MCP SDK Integration Points

### Files that need changes

| File | Current role | Change |
|------|-------------|--------|
| `src/auth/provider.ts` | Full OAuth server (`OAuthServerProvider`) | Add OIDC verifier alongside; toggle via `AUTH_MODE` |
| `src/server/http.ts` | Mounts `mcpAuthRouter`, creates `requireBearerAuth` | Conditionally mount Zitadel metadata + JWKS verifier |
| `src/auth/oidc.ts` | New file | JWKS fetcher + JWT validator implementing `OAuthTokenVerifier` |

### Key SDK interfaces

```typescript
// Slim interface — just token validation (what we need for Zitadel mode)
interface OAuthTokenVerifier {
  verifyAccessToken(token: string): Promise<AuthInfo>;
}

// AuthInfo has an extra field for custom claims
interface AuthInfo {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt?: number;
  resource?: URL;
  extra?: Record<string, unknown>;  // ← put user email, sub, roles here
}

// Full interface (current, used when AUTH_MODE=builtin)
interface OAuthServerProvider extends OAuthTokenVerifier {
  clientsStore: OAuthRegisteredClientsStore;
  authorize(...): Promise<void>;
  challengeForAuthorizationCode(...): Promise<string>;
  exchangeAuthorizationCode(...): Promise<OAuthTokens>;
  exchangeRefreshToken(...): Promise<OAuthTokens>;
  revokeToken?(...): Promise<void>;
  skipLocalPkceValidation?: boolean;
}
```

### requireBearerAuth accepts either interface

```typescript
// Current:
authMiddleware = requireBearerAuth({ verifier: provider, resourceMetadataUrl });

// With Zitadel (same call, different verifier):
authMiddleware = requireBearerAuth({ verifier: zitadelVerifier, resourceMetadataUrl });
```

## Zitadel Endpoints (reference)

| Endpoint | Purpose |
|----------|---------|
| `/.well-known/openid-configuration` | Discovery (issuer, jwks_uri, authorize, token, etc.) |
| `/oauth/v2/authorize` | Authorization endpoint (user login UI) |
| `/oauth/v2/token` | Token endpoint (code→token, refresh) |
| `/oauth/v2/keys` | JWKS (public keys for JWT validation) |
| `/oauth/v2/introspect` | Token introspection (alternative to JWKS) |
| `/oauth/v2/userinfo` | UserInfo endpoint (email, name, etc.) |

## Zitadel Domains

| Environment | Domain | Purpose |
|-------------|--------|---------|
| Production | `https://auth.prod.11mirror.com` | User login, token issuance, admin console |
| Staging | `https://auth.staging.11mirror.com` | Testing/development |

### Caddy configuration for Zitadel

Zitadel runs on loopback `:8080`. Caddy terminates TLS and proxies to it.

**Prod Caddyfile (on the Zitadel host):**
```
auth.prod.11mirror.com {
    reverse_proxy 127.0.0.1:8080
}
```

**Staging Caddyfile (on the Zitadel host):**
```
auth.staging.11mirror.com {
    reverse_proxy 127.0.0.1:8080
}
```

DNS: Route 53 A records for `auth.prod.11mirror.com` and `auth.staging.11mirror.com` pointing to the respective EC2 Elastic IPs. Caddy auto-obtains Let's Encrypt certs.

## Env vars for Zitadel mode

```bash
AUTH_MODE=zitadel                                # Toggle: "zitadel" or "builtin"
ZITADEL_ISSUER=https://auth.prod.11mirror.com    # Prod Zitadel instance
# ZITADEL_ISSUER=https://auth.staging.11mirror.com  # Staging
ZITADEL_CLIENT_ID=<app-client-id>                # Zitadel OIDC app client ID
ZITADEL_AUDIENCE=<resource-api-audience>         # Expected "aud" claim in JWT
```

## Verification checklist

1. `AUTH_MODE=builtin` → old flow works (auto-approve, no external OIDC provider)
2. `AUTH_MODE=oidc` → `/.well-known/oauth-authorization-server` returns OIDC provider's endpoints
3. After OIDC login → token returned to MCP client
4. `/mcp` with valid JWT → 200, `auth_subject` in access log = user email
5. `/mcp` with expired JWT → 401 with proper `WWW-Authenticate`
6. `/mcp` with tampered JWT → 401
7. `/health` → shows `authMode: "oidc"`
