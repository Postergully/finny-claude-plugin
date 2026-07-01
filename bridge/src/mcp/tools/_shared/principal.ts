/**
 * Derive the caller's verified principal from the MCP session's AuthInfo.
 *
 * Called at the entry of every user-facing tool (finny_query, finny_report,
 * finny_task_status, finny_continue, finny_remember) per Task 4.3.
 *
 * Contract:
 *   - Reads ONLY from `session.authInfo.token` (the raw bearer the MCP
 *     transport captured on the request). Tool input is IGNORED for
 *     identity — sealed-identity rule per finny-core/CLAUDE.md.
 *   - Returns a `VerifiedClaims` on success.
 *   - Throws `PrincipalError` when Zitadel authz is configured
 *     (ZITADEL_ISSUER + ZITADEL_AUDIENCE + ZITADEL_JWKS_URL all present)
 *     and verification fails (missing token, bad signature, expired,
 *     missing required claim). Tool handlers catch and return an
 *     `unauthorized` envelope with a generic message.
 *   - Returns `null` when Zitadel authz is NOT configured on the bridge
 *     (transitional: the bridge issues its own opaque OAuth tokens
 *     today; Zitadel-JWT federation is a follow-on wiring task). Tools
 *     treat a null principal as "no bank check" for now. The moment an
 *     operator sets the three Zitadel env vars on the bridge unit, this
 *     path flips to strict fail-closed.
 *
 * Async because JWKS verification is a network op on cold cache; the
 * downstream `canViewBank` / `canWriteBank` checks over the returned
 * principal are pure and synchronous.
 */

import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { verifyJwt, type VerifiedClaims } from '../../../auth/jwt-claims.js';
import type { FinnyEnvelope } from '../../../types/envelope.js';
import { errorEnvelope } from './envelopeBuilders.js';

export class PrincipalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrincipalError';
  }
}

export interface Session {
  authInfo?: AuthInfo;
}

export type Principal = VerifiedClaims;

function isZitadelConfigured(): boolean {
  return Boolean(
    process.env.ZITADEL_ISSUER && process.env.ZITADEL_AUDIENCE && process.env.ZITADEL_JWKS_URL
  );
}

/**
 * Derive the principal. See file header for full contract.
 */
export async function derivePrincipal(session: Session | undefined): Promise<Principal | null> {
  const zitadelOn = isZitadelConfigured();
  const token = session?.authInfo?.token;

  if (!zitadelOn) {
    return null;
  }

  if (!token) {
    throw new PrincipalError('no bearer token on session');
  }
  const claims = await verifyJwt(token);
  if (!claims) {
    throw new PrincipalError('jwt verification failed');
  }
  return claims;
}

/**
 * Standard `unauthorized` envelope for principal-derivation failures.
 * Generic message so bridge internals never leak to the LLM.
 */
export function unauthorizedEnvelope(intentRestated: string): FinnyEnvelope {
  return errorEnvelope({
    code: 'unauthorized',
    message: 'not authorized',
    retryable: false,
    elapsedMs: 0,
    envUsed: 'production',
    sessionId: '—',
    intentRestated,
  });
}

/**
 * Envelope for bank-access denial. Distinct message tag ('bank_denied')
 * so diagnostics can differentiate without exposing which bank.
 */
export function bankDeniedEnvelope(intentRestated: string): FinnyEnvelope {
  return errorEnvelope({
    code: 'unauthorized',
    message: 'bank_denied',
    retryable: false,
    elapsedMs: 0,
    envUsed: 'production',
    sessionId: '—',
    intentRestated,
  });
}
