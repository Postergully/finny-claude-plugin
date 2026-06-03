# Finny MCP — First-Run Google SSO Login (Design)

**Date:** 2026-06-03
**Status:** Approved (brainstorming)
**Scope:** HTTP/SSE transport (browser cowork) only. Stdio is out of scope.

## Problem

When a user first connects the Finny MCP from Claude.ai, the bridge knows the OAuth `clientId` (per Claude.ai connector install) but has no human identity. We want a lightweight first-run login that:

1. Binds a verified company email (`@sharechat.com`) to the calling MCP `clientId`.
2. Requires no SMTP, DKIM, or magic-link state machine on the bridge.
3. Is enforced server-side so a buggy or hostile skill can't bypass it.
4. Stays around ~125 LOC bridge + ~15 LOC plugin.

## Approach: Google OAuth with `hd` claim

Delegate identity entirely to Google. The bridge:

- Adds one MCP tool, `finny_whoami`, that reports login state and a `login_url`.
- Adds two HTTP routes, `GET /login` and `GET /login/callback`, implementing a stock OAuth 2.0 authorization-code flow against Google.
- Uses Google's `hd` (hosted-domain) claim to enforce `@sharechat.com` Workspace accounts. Google does the domain enforcement on its side; the bridge re-verifies the claim defensively.
- Stores `clientId → {email, loggedInAt}` in a sticky in-memory `Map`. Lost on restart; users re-login once.

State that **does not** exist in this design: pending-login tokens, expiry reapers for login state, email transport, login HTML forms, password handling.

## Architecture

```
Claude.ai ──(MCP /w OAuth Bearer)──► finny-mcp bridge
                                       │
                                       ├─ requireBearerAuth → authInfo.clientId
                                       │
                                       ├─ tools/whoami.ts ─────► loggedInUsers.get(clientId)
                                       │
                                       ├─ all other finny_* tools ──► same lookup; on miss
                                       │      return {logged_in:false, login_url}
                                       │
                                       └─ routes/login.ts
                                              ├─ GET /login          → 302 to Google
                                              └─ GET /login/callback → verify + recordLogin

loggedInUsers : Map<clientId, {email, loggedInAt}>   (sticky, in-memory)
```

## Components

### New files (`bridge/src/`)

| File | Purpose | LOC |
|---|---|---|
| `mcp/tools/whoami.ts` | Zod-validated `finny_whoami` tool. Reads `extra.authInfo.clientId`, returns `{logged_in, user?, login_url?}`. | ~25 |
| `auth/loginStore.ts` | Exports `loggedInUsers` Map + `recordLogin(cid, email)` + `getUser(cid)`. | ~15 |
| `auth/google.ts` | `buildAuthUrl(cid)` and `exchangeCode(code)` — direct `fetch` calls to Google endpoints; no SDK. | ~35 |
| `server/loginRoutes.ts` | `GET /login` and `GET /login/callback`; inline success/error HTML. | ~40 |

### Modified files

| File | Change | LOC |
|---|---|---|
| `bridge/src/server/sse.ts` (or wherever Express app is built) | Mount `loginRoutes`. | ~3 |
| `bridge/src/mcp/tools/index.ts` | Export `whoamiTool`. | ~1 |
| `bridge/src/server/tools-registration.ts` | Register `whoamiTool` in `ALL_TOOLS`. | ~1 |
| `bridge/src/intents/bless-list.json` | Add `finny_whoami` entry, no scope. | ~10 |
| `bridge/.env.example` | Add 5 new env vars (see Config). | ~5 |
| Each existing finny_* tool handler | Call `getUser(cid)`; on miss, short-circuit with login envelope. | ~3 each × 5 |

### Plugin changes

| File | Change |
|---|---|
| `plugin/skills/finny-usage/SKILL.md` | Add "Login gate" section: on first finny_* of a session, call `finny_whoami` first; if `logged_in:false`, surface the link and pause until the user confirms. |
| `plugin/hooks/hooks.json` | Add `mcp__finny__finny_whoami` to the PreToolUse auto-approve allowlist. |

**Total: ~125 LOC bridge + ~15 lines plugin.**

## Data flow

### First call (not logged in)

1. Agent calls `finny_whoami` (per skill instruction). Handler reads `extra.authInfo.clientId = "claude-ai-xyz"`. Map miss.
2. Returns envelope: `{ logged_in: false, login_url: "${FINNY_PUBLIC_BASE_URL}/login?cid=claude-ai-xyz" }`.
3. Skill instructs agent to surface the link to the user with copy along the lines of "Sign in with your @sharechat.com Google account to continue."

### Login

4. User clicks the link → `GET /login?cid=claude-ai-xyz`.
5. Bridge computes `state = HMAC_SHA256(cid, FINNY_LOGIN_STATE_SECRET) + ":" + cid`. The `cid` round-trips inside `state`; the HMAC is the only authentication required since we never store pending state on the bridge.
6. Bridge `302`s to:
   ```
   https://accounts.google.com/o/oauth2/v2/auth
     ?client_id=${GOOGLE_CLIENT_ID}
     &redirect_uri=${FINNY_PUBLIC_BASE_URL}/login/callback
     &response_type=code
     &scope=openid email
     &hd=${FINNY_ALLOWED_LOGIN_DOMAIN}
     &state=<state>
   ```
7. User picks their Workspace account. Google enforces `hd` on its side — `@gmail.com` and other-domain accounts cannot proceed.
8. Google redirects back to `GET /login/callback?code=...&state=...`. Bridge:
   - Splits `state`, recomputes HMAC over `cid`, rejects on mismatch.
   - POSTs the code to `https://oauth2.googleapis.com/token` (form-encoded, includes `client_id`, `client_secret`, `redirect_uri`, `grant_type=authorization_code`). Receives `id_token`.
   - Verifies the ID token signature against Google's JWKS using `jose` (small dep; add explicitly).
   - Re-asserts the verified payload defensively: `aud === GOOGLE_CLIENT_ID`, `iss in {accounts.google.com, https://accounts.google.com}`, `hd === FINNY_ALLOWED_LOGIN_DOMAIN`, `email_verified === true`, `exp > now`.
   - `recordLogin(cid, payload.email)`.
   - Renders inline HTML: "Signed in as `alice@sharechat.com`. You can return to Claude."

### Subsequent calls

9. Any finny_* tool handler first calls `getUser(authInfo.clientId)`. Hit → proceed. Miss → short-circuit with the same `{logged_in:false, login_url}` envelope. Sticky until bridge restart.

## Error handling

| Condition | Response |
|---|---|
| `/login` missing `cid` | 400 inline HTML: "Open Claude and retry." |
| `/login/callback` HMAC mismatch on `state` | 400: "Login link expired or tampered. Retry from Claude." |
| Token exchange HTTP error | 502 + structured log; surface generic "Sign-in failed, retry" page. |
| `hd` mismatch on verified token | 403: "Only @sharechat.com Google accounts may sign in." |
| `email_verified === false` | 403 (defense in depth; Workspace flips this true). |
| `aud` / `iss` mismatch | 403; log loudly — indicates token substitution. |
| Bridge restart | All entries dropped from `loggedInUsers`; users re-login once. No persisted user data on the bridge. |

No stack traces, env values, or upstream URLs leak to the response body. Errors log internally with the `cid` (already present in MCP request logs) for correlation.

## Configuration (env)

Added to `bridge/.env.example`:

| Var | Purpose |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth client ID from Google Cloud Console. |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret (use `openssl rand`–style sensitivity; commit nothing). |
| `FINNY_ALLOWED_LOGIN_DOMAIN` | Comma-separated, e.g. `sharechat.com,mohalla.tech`. Bridge enforces `hd` ∈ this set. |
| `FINNY_PUBLIC_BASE_URL` | Public origin for absolute redirect URIs, e.g. `https://finny.prod.11mirror.com`. |
| `FINNY_LOGIN_STATE_SECRET` | 32-byte hex, used as HMAC key for the `state` parameter. Generate with `openssl rand -hex 32`. |

One-time setup: create an OAuth 2.0 Client ID in Google Cloud Console (type: Web application), add `${FINNY_PUBLIC_BASE_URL}/login/callback` as an authorized redirect URI. No DNS or DKIM changes needed.

## Security notes

- **`state` is stateless and unforgeable** because it's `HMAC(cid) + ":" + cid`. No server-side store, no expiry beyond the OAuth code's own ~10-minute window enforced by Google.
- **Re-verifying `hd`** even though Google enforces it on its side is intentional defense in depth; never trust a single point of enforcement.
- **`getUser(cid)` short-circuit** in every tool handler is the security boundary, not the skill. A rogue or buggy agent that skips `finny_whoami` cannot reach Finny.
- **No CSRF concern** on `/login/callback` — it's an `iframe`-unfriendly endpoint that mutates only the in-memory store, gated by the HMAC'd `state`.
- **DNS-rebinding allowlist** (`MCP_ALLOWED_HOSTS`) already covers the bridge; new routes inherit it.

## Testing

| File | Cases |
|---|---|
| `whoami.test.ts` | Map miss → `login_url`. Map hit → user. Tool input is `{}` (Zod). |
| `loginStore.test.ts` | `recordLogin` → `getUser` round-trip; overwrite same cid. |
| `google.test.ts` | `buildAuthUrl(cid)` includes `hd`, correct redirect URI, valid `state`. `exchangeCode` parses a fixture ID token (mock `fetch` + JWKS). |
| `loginRoutes.test.ts` | supertest: `/login` 302s with expected query string; `/login/callback` writes the store on valid mocked exchange; rejects on `hd` mismatch, `aud` mismatch, bad `state` HMAC. |
| Integration spot check | One existing tool test asserts that an unauthenticated call returns the login envelope instead of the normal payload. |

No live Google calls in tests. Vitest with mocked `fetch` and a JWKS fixture.

## Out of scope (v1)

- Logout. Bridge restart suffices. Add `finny_logout` later if asked.
- Stdio transport. Stdio sessions are local and OAuth-less today; a magic-link flow would be needed there separately.
- Multi-tenant domain configuration beyond the allowlist env var.
- Persistence across restarts. In-memory Map is sufficient for the MVP.
- Per-token (vs per-clientId) binding. clientId is the explicit decision.
