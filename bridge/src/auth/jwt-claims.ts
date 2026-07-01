/**
 * Zitadel JWT verification for the bridge — JWKS-based signature check
 * plus standard iss/aud/exp/nbf validation, and extraction of the four
 * claims the bridge cares about: `sub`, `tenant_id`, `role`, and
 * `bank_acl`. Called by `_shared/principal.ts` at the tool boundary.
 *
 * Spec: finny-core/docs/plan/implementation.md Task 4.3 (post-2026-07-01
 * amendment; bank-authz only, no tool-role map).
 *
 * Contract (mirrors finny-hermes-dashboard/src/server/jwt-verify.ts):
 *   - Reads env at call time: ZITADEL_JWKS_URL, ZITADEL_ISSUER,
 *     ZITADEL_AUDIENCE, ZITADEL_ROLES_CLAIM (optional; defaults to the
 *     legacy generic Zitadel key), ZITADEL_TENANT_CLAIM (optional;
 *     defaults to top-level `tenant_id` per finny-core/CLAUDE.md §Authz
 *     substrate step 4).
 *   - JWKS is cached across calls. On unknown `kid` jose refreshes once.
 *   - Every failure path returns `null`. Never throws into callers.
 *
 * Zitadel roles claim shape (source:
 * https://zitadel.com/docs/guides/integrate/retrieve-user-roles):
 *
 *   "urn:zitadel:iam:org:project:{projectId}:roles": {
 *     "<role_name>": { "<orgId>": "<orgPrimaryDomain>" }
 *   }
 *
 * `bank_acl` claim shape (projected by the Zitadel Action authored in
 * Task 3.2.5, staging id `379837029803884547`):
 *
 *   "bank_acl": { "read": string[], "write": string[] }
 *
 * `tenant_id` claim: top-level string per finny-core/CLAUDE.md §Authz
 * substrate step 4 (JWT example line 63). Path is override-able via
 * ZITADEL_TENANT_CLAIM once the OAuth wiring pins the final claim key.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

/** Fallback Zitadel roles claim key when ZITADEL_ROLES_CLAIM is unset. */
const DEFAULT_ROLES_CLAIM = 'urn:zitadel:iam:org:project:roles';

/** Fallback tenant claim key when ZITADEL_TENANT_CLAIM is unset. */
const DEFAULT_TENANT_CLAIM = 'tenant_id';

/**
 * Role precedence, highest first. Mirrors
 * finny-hermes-dashboard/src/server/jwt-verify.ts:48-52.
 */
export const ROLE_PRECEDENCE = ['neuu_admin', 'client_admin', 'user'] as const;
export type Role = (typeof ROLE_PRECEDENCE)[number];

export interface BankAcl {
  read: string[];
  write: string[];
}

export interface VerifiedClaims {
  sub: string;
  tenant_id: string;
  role: Role;
  bank_acl: BankAcl;
}

interface JwksHandle {
  url: string;
  getKey: ReturnType<typeof createRemoteJWKSet>;
}

let _cachedJwks: JwksHandle | null = null;

function getJwks(url: string): ReturnType<typeof createRemoteJWKSet> {
  if (_cachedJwks && _cachedJwks.url === url) return _cachedJwks.getKey;
  const getKey = createRemoteJWKSet(new URL(url), { cooldownDuration: 30_000 });
  _cachedJwks = { url, getKey };
  return getKey;
}

/** Test seam — clear cached JWKS. Do not call from production code. */
export function _resetJwksCacheForTesting(): void {
  _cachedJwks = null;
}

let _jwksOverride: ReturnType<typeof createRemoteJWKSet> | null = null;
/** Test seam — inject an in-memory key resolver so tests never hit Zitadel. */
export function _setJwksOverrideForTesting(fn: ReturnType<typeof createRemoteJWKSet> | null): void {
  _jwksOverride = fn;
}

function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLE_PRECEDENCE as readonly string[]).includes(v);
}

function extractHighestRole(payload: JWTPayload): Role | null {
  const claimKey = process.env.ZITADEL_ROLES_CLAIM || DEFAULT_ROLES_CLAIM;
  const raw = payload[claimKey];
  if (!raw || typeof raw !== 'object') return null;
  const rolesInClaim = new Set<string>();
  for (const k of Object.keys(raw as Record<string, unknown>)) {
    rolesInClaim.add(k);
  }
  for (const candidate of ROLE_PRECEDENCE) {
    if (rolesInClaim.has(candidate) && isRole(candidate)) return candidate;
  }
  return null;
}

function extractTenantId(payload: JWTPayload): string | null {
  const claimKey = process.env.ZITADEL_TENANT_CLAIM || DEFAULT_TENANT_CLAIM;
  const raw = payload[claimKey];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function extractBankAcl(payload: JWTPayload): BankAcl {
  const raw = payload['bank_acl'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { read: [], write: [] };
  }
  const obj = raw as Record<string, unknown>;
  const read = Array.isArray(obj.read)
    ? obj.read.filter((x): x is string => typeof x === 'string')
    : [];
  const write = Array.isArray(obj.write)
    ? obj.write.filter((x): x is string => typeof x === 'string')
    : [];
  return { read, write };
}

/**
 * Verify a raw JWT string. Returns the four bridge-consumed claims on
 * success, `null` on any failure (bad signature, wrong iss/aud, expired,
 * missing config, missing required claims). Never throws.
 */
export async function verifyJwt(token: string | null | undefined): Promise<VerifiedClaims | null> {
  if (!token || typeof token !== 'string') return null;

  const issuer = process.env.ZITADEL_ISSUER;
  const audience = process.env.ZITADEL_AUDIENCE;
  const jwksUrl = process.env.ZITADEL_JWKS_URL;

  // Missing config → treat as unverifiable. Fail-closed: legitimate calls
  // are denied at the bank check rather than silently accepted.
  if (!issuer || !audience || !jwksUrl) return null;

  const keyResolver = _jwksOverride ?? getJwks(jwksUrl);

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keyResolver, { issuer, audience }));
  } catch {
    return null;
  }

  const sub = typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : null;
  if (!sub) return null;

  const tenant_id = extractTenantId(payload);
  if (!tenant_id) return null;

  const role = extractHighestRole(payload);
  if (!role) return null;

  const bank_acl = extractBankAcl(payload);

  return { sub, tenant_id, role, bank_acl };
}
