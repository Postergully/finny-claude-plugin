/**
 * Bank-authz wrappers over a verified Zitadel JWT principal.
 *
 * v1 policy per finny-core/CLAUDE.md §Authz substrate step 5 and
 * finny-core/docs/plan/implementation.md Task 4.3 (post-2026-07-01
 * amendment). Bank access is a claim-read plus a sealed-tenant string
 * prefix guard. **Synchronous** — no external authz SDK, no network
 * round-trip.
 *
 * Bridge-level per-tool enforcement is intentionally omitted here.
 * Tool-level enforcement lives at the downstream per-UID profile
 * layer (a tool the user has not been assigned literally can't run
 * under their UID). See Phase 4 preamble "Tool-assignment cascade" in
 * the plan for the full rationale.
 *
 * When the Phase 3.5 authz-substrate trigger fires, only these bodies
 * swap; the call sites in tools stay identical.
 */

import type { VerifiedClaims } from './jwt-claims.js';

/**
 * Sealed-tenant prefix guard (defense-in-depth): the bank ID string
 * MUST be prefixed with the caller's tenant. This holds even if
 * `bank_acl.read` / `bank_acl.write` is somehow populated with a
 * foreign-tenant ID via a compromised or malformed token — the guard
 * denies regardless.
 */
function withinTenant(principal: VerifiedClaims, bankId: string): boolean {
  return bankId.startsWith(`client-${principal.tenant_id}-`);
}

export function canViewBank(principal: VerifiedClaims, bankId: string): boolean {
  if (!withinTenant(principal, bankId)) return false;
  return principal.bank_acl.read.includes(bankId);
}

export function canWriteBank(principal: VerifiedClaims, bankId: string): boolean {
  if (!withinTenant(principal, bankId)) return false;
  return principal.bank_acl.write.includes(bankId);
}
