# Debug: CoWork + OneLogin `invalid_target` Error

## Problem

CoWork (Claude Desktop) fails to connect to our MCP bridge when using OneLogin as the OIDC provider. The error is `invalid_target` with `mcp_token_exchange_failed`.

## Root Cause (confirmed)

CoWork sends a `resource` parameter (RFC 8707 Resource Indicators) in the token exchange POST to OneLogin. OneLogin does not support RFC 8707 and rejects the request.

## What we've tried (all failed to fix for CoWork)

1. **Token proxy** (`/oauth/token`) — strips `resource` and forwards to OneLogin. Works when tested with curl. But CoWork never hits it.
2. **Changed `issuer` in metadata** to our own base URL — so RFC 8414 issuer matches fetch origin.
3. **Changed `authorization_servers` in protected resource metadata** to point to ourselves.
4. **Removed `registration_endpoint`** — didn't help.
5. **Re-added `registration_endpoint`** pointing to our DCR proxy (`/oauth/register`) that returns static client_id — works with curl.
6. **Set `token_endpoint_auth_methods_supported: ['none']`** — for PKCE/public client.

## Key finding

CoWork fetches our `/.well-known/oauth-authorization-server` and uses the `authorization_endpoint` (OneLogin's). But for the **token exchange**, it appears to derive the token endpoint from the `authorization_endpoint`'s origin (OneLogin) rather than using our advertised `token_endpoint`. Our `/oauth/token` proxy is NEVER hit by CoWork — confirmed via logs.

## Our auth-test page works fine

The `/auth-test` HTML page (which does the same PKCE flow manually) works perfectly — because it sends the token request directly to OneLogin's `/token` without the `resource` parameter.

## What works

- `https://lolly.staging.11mirror.com/auth-test` — full flow works
- curl to our `/oauth/token` proxy — correctly strips `resource`, OneLogin responds
- curl to our `/oauth/register` — returns static client_id

## Current deployment state (lolly staging)

- **Instance:** `i-0fd9f8c24882a9eb4`
- **Bridge path:** `/home/ubuntu/workspace/lolly-claude-plugin/bridge/`
- **Service:** `lolly-mcp` (systemd)
- **OIDC Issuer:** `https://neuu.onelogin.com/oidc/2`
- **Client ID:** `4ec719b0-4d4f-013f-d6b4-272ff75a1f75263618`
- **Audience:** `4ec719b0-4d4f-013f-d6b4-272ff75a1f75263618`

## Env vars (.env on staging)

```
AUTH_MODE=oidc
OIDC_ISSUER=https://neuu.onelogin.com/oidc/2
OIDC_AUDIENCE=4ec719b0-4d4f-013f-d6b4-272ff75a1f75263618
OIDC_CLIENT_ID=4ec719b0-4d4f-013f-d6b4-272ff75a1f75263618
ENV=staging
```

## Current authorization server metadata served (after fix)

```json
{
  "issuer": "https://lolly.staging.11mirror.com",
  "authorization_endpoint": "https://lolly.staging.11mirror.com/oauth/authorize",
  "token_endpoint": "https://lolly.staging.11mirror.com/oauth/token",
  "registration_endpoint": "https://lolly.staging.11mirror.com/oauth/register",
  "jwks_uri": "https://neuu.onelogin.com/oidc/2/certs",
  "scopes_supported": ["openid", "profile", "email", ...],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none"]
}
```

## Fix (deployed 2026-06-18 to lolly staging)

**Root cause confirmed:** CoWork follows the MCP Authorization spec (RFC 8414 + RFC 9728). When `authorization_endpoint` points to OneLogin's origin, CoWork fetches OneLogin's own `/.well-known/openid-configuration` to resolve the `token_endpoint`, ignoring our metadata's `token_endpoint`. This is spec-compliant: the authorization server metadata from the `authorization_endpoint`'s origin is authoritative.

**Fix:** Proxy the `authorization_endpoint` through our bridge too — `GET /oauth/authorize` does a 302 redirect to OneLogin with all query params. Now all OAuth endpoints (`authorization_endpoint`, `token_endpoint`, `registration_endpoint`) are on our origin, so CoWork has no reason to re-discover from OneLogin.

**Flow after fix:**
1. CoWork → `GET /.well-known/oauth-protected-resource/mcp` → `authorization_servers: ["https://lolly.staging.11mirror.com"]`
2. CoWork → `GET /.well-known/oauth-authorization-server` → all endpoints on our origin
3. CoWork → `POST /oauth/register` → static client_id
4. CoWork → `GET /oauth/authorize?...` → 302 to OneLogin → user logs in → callback with code
5. CoWork → `POST /oauth/token` (with `resource` stripped) → OneLogin returns tokens

**Changed file:** `bridge/src/server/http.ts` — added `GET /oauth/authorize` route, changed `authorization_endpoint` in metadata from OneLogin URL to `${baseUrl}/oauth/authorize`.

## OneLogin details

- Issuer: `https://neuu.onelogin.com/oidc/2`
- Token endpoint: `https://neuu.onelogin.com/oidc/2/token`
- Authorize endpoint: `https://neuu.onelogin.com/oidc/2/auth`
- JWKS: `https://neuu.onelogin.com/oidc/2/certs`
- Userinfo: `https://neuu.onelogin.com/oidc/2/me`
- Does NOT support RFC 8707 `resource` parameter
- Token Endpoint Auth: None (PKCE)
- App name: configured in neuu OneLogin admin

## Also affected: finny prod (sharechat OneLogin)

- Instance: `i-0ef58962b09d490ee`
- Issuer: `https://sharechat.onelogin.com/oidc/2`
- Client ID: `321aa180-4b7c-013f-d304-0d75640e303e246541`
- Same `invalid_target` error from CoWork

## Reference

- Claude auth docs: https://claude.com/docs/connectors/building/authentication
- OneLogin OIDC token endpoint docs: https://developers.onelogin.com/openid-connect/api/authorization-code-grant
- Bridge source: `reference-files/lolly-claude-plugin/bridge/src/server/http.ts`
- OIDC verifier: `reference-files/lolly-claude-plugin/bridge/src/auth/oidc.ts`
