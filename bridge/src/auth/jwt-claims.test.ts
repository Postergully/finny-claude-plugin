/**
 * Task 4.3 verifier-rubric tests for verifyJwt (Zitadel JWKS-verify path).
 *
 * Mirrors the mint-then-override pattern used in
 * finny-hermes-dashboard/src/server/__tests__/capabilities-store.test.ts.
 * Tests never hit the real Zitadel JWKS URL — every case that expects
 * verification success installs an in-memory key via
 * `_setJwksOverrideForTesting`.
 *
 * Cases (verifier rubric line "verifyJwt unit test covers ..."):
 *   1. valid JWT with role → resolves claims
 *   2. missing token → null
 *   3. invalid signature → null
 *   4. expired → null
 *   5. bank_acl claim parsed correctly into { read, write }
 *   Additional: missing config → null; missing tenant_id → null.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, importJWK, type JWK } from 'jose';
import { verifyJwt, _setJwksOverrideForTesting, _resetJwksCacheForTesting } from './jwt-claims.js';

const TEST_ISSUER = 'https://zitadel.test';
const TEST_AUDIENCE = 'finny-bridge';
const TEST_ROLES_CLAIM = 'urn:zitadel:iam:org:project:roles';

interface MintOpts {
  sub?: string;
  tenant_id?: string;
  roles?: Record<string, Record<string, string>>;
  bank_acl?: { read?: string[]; write?: string[] };
  issuer?: string;
  audience?: string;
  expOffsetSec?: number;
  wrongKey?: boolean;
}

async function mintJwt(opts: MintOpts = {}): Promise<string> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk: JWK = await exportJWK(publicKey);
  jwk.kid = 'test-key-1';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const keyForVerify = await importJWK(jwk, 'RS256');

  if (opts.wrongKey) {
    // Install a DIFFERENT key as the JWKS resolver so signature verification fails.
    const { publicKey: otherPub } = await generateKeyPair('RS256');
    const otherJwk: JWK = await exportJWK(otherPub);
    otherJwk.kid = 'test-key-1';
    otherJwk.alg = 'RS256';
    otherJwk.use = 'sig';
    const otherKey = await importJWK(otherJwk, 'RS256');
    _setJwksOverrideForTesting(
      (async () => otherKey) as unknown as ReturnType<typeof import('jose').createRemoteJWKSet>
    );
  } else {
    _setJwksOverrideForTesting(
      (async () => keyForVerify) as unknown as ReturnType<typeof import('jose').createRemoteJWKSet>
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const exp = now + (opts.expOffsetSec ?? 3600);
  const payload: Record<string, unknown> = {};
  if (opts.tenant_id !== undefined) payload.tenant_id = opts.tenant_id;
  if (opts.roles) payload[TEST_ROLES_CLAIM] = opts.roles;
  if (opts.bank_acl) payload.bank_acl = opts.bank_acl;

  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setSubject(opts.sub ?? 'u_01HXY')
    .setIssuer(opts.issuer ?? TEST_ISSUER)
    .setAudience(opts.audience ?? TEST_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(privateKey);
}

describe('verifyJwt', () => {
  const origIss = process.env.ZITADEL_ISSUER;
  const origAud = process.env.ZITADEL_AUDIENCE;
  const origJwks = process.env.ZITADEL_JWKS_URL;
  const origRoles = process.env.ZITADEL_ROLES_CLAIM;
  const origTenant = process.env.ZITADEL_TENANT_CLAIM;

  beforeEach(() => {
    process.env.ZITADEL_ISSUER = TEST_ISSUER;
    process.env.ZITADEL_AUDIENCE = TEST_AUDIENCE;
    process.env.ZITADEL_JWKS_URL = 'https://zitadel.test/oauth/v2/keys';
    delete process.env.ZITADEL_ROLES_CLAIM;
    delete process.env.ZITADEL_TENANT_CLAIM;
    _resetJwksCacheForTesting();
  });

  afterEach(() => {
    _setJwksOverrideForTesting(null);
    _resetJwksCacheForTesting();
    if (origIss === undefined) delete process.env.ZITADEL_ISSUER;
    else process.env.ZITADEL_ISSUER = origIss;
    if (origAud === undefined) delete process.env.ZITADEL_AUDIENCE;
    else process.env.ZITADEL_AUDIENCE = origAud;
    if (origJwks === undefined) delete process.env.ZITADEL_JWKS_URL;
    else process.env.ZITADEL_JWKS_URL = origJwks;
    if (origRoles === undefined) delete process.env.ZITADEL_ROLES_CLAIM;
    else process.env.ZITADEL_ROLES_CLAIM = origRoles;
    if (origTenant === undefined) delete process.env.ZITADEL_TENANT_CLAIM;
    else process.env.ZITADEL_TENANT_CLAIM = origTenant;
  });

  it('resolves claims from a valid JWT (sub + tenant_id + role + bank_acl)', async () => {
    const token = await mintJwt({
      sub: 'u_01HXY',
      tenant_id: 'sharechat',
      roles: { user: { org1: 'org1.example.com' } },
      bank_acl: {
        read: ['client-sharechat-user-u_01HXY', 'client-sharechat-docs'],
        write: ['client-sharechat-user-u_01HXY'],
      },
    });
    const claims = await verifyJwt(token);
    expect(claims).toEqual({
      sub: 'u_01HXY',
      tenant_id: 'sharechat',
      role: 'user',
      bank_acl: {
        read: ['client-sharechat-user-u_01HXY', 'client-sharechat-docs'],
        write: ['client-sharechat-user-u_01HXY'],
      },
    });
  });

  it('picks the highest-precedence role when multiple present', async () => {
    const token = await mintJwt({
      tenant_id: 'sharechat',
      roles: {
        user: { org1: 'org1.example.com' },
        neuu_admin: { org1: 'org1.example.com' },
      },
    });
    const claims = await verifyJwt(token);
    expect(claims?.role).toBe('neuu_admin');
  });

  it('returns null on missing token', async () => {
    expect(await verifyJwt(null)).toBeNull();
    expect(await verifyJwt(undefined)).toBeNull();
    expect(await verifyJwt('')).toBeNull();
  });

  it('returns null on invalid signature', async () => {
    const token = await mintJwt({
      tenant_id: 'sharechat',
      roles: { user: { org1: 'org1.example.com' } },
      wrongKey: true,
    });
    expect(await verifyJwt(token)).toBeNull();
  });

  it('returns null on expired token', async () => {
    const token = await mintJwt({
      tenant_id: 'sharechat',
      roles: { user: { org1: 'org1.example.com' } },
      expOffsetSec: -3600,
    });
    expect(await verifyJwt(token)).toBeNull();
  });

  it('returns null on wrong audience', async () => {
    const token = await mintJwt({
      tenant_id: 'sharechat',
      roles: { user: { org1: 'org1.example.com' } },
      audience: 'wrong-audience',
    });
    expect(await verifyJwt(token)).toBeNull();
  });

  it('returns null on missing tenant_id claim', async () => {
    const token = await mintJwt({
      roles: { user: { org1: 'org1.example.com' } },
    });
    expect(await verifyJwt(token)).toBeNull();
  });

  it('returns null on missing role claim', async () => {
    const token = await mintJwt({
      tenant_id: 'sharechat',
    });
    expect(await verifyJwt(token)).toBeNull();
  });

  it('returns empty bank_acl arrays when claim absent', async () => {
    const token = await mintJwt({
      tenant_id: 'sharechat',
      roles: { user: { org1: 'org1.example.com' } },
    });
    const claims = await verifyJwt(token);
    expect(claims?.bank_acl).toEqual({ read: [], write: [] });
  });

  it('returns empty bank_acl arrays when claim malformed (not object)', async () => {
    // Signed with bank_acl set to a string — extractBankAcl treats non-object as empty.
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk: JWK = await exportJWK(publicKey);
    jwk.kid = 'test-key-1';
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    const key = await importJWK(jwk, 'RS256');
    _setJwksOverrideForTesting(
      (async () => key) as unknown as ReturnType<typeof import('jose').createRemoteJWKSet>
    );
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      tenant_id: 'sharechat',
      [TEST_ROLES_CLAIM]: { user: { org1: 'x' } },
      bank_acl: 'not-an-object',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setSubject('u_01HXY')
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);
    const claims = await verifyJwt(token);
    expect(claims?.bank_acl).toEqual({ read: [], write: [] });
  });

  it('returns null when Zitadel config missing (ZITADEL_ISSUER unset)', async () => {
    delete process.env.ZITADEL_ISSUER;
    const token = await mintJwt({
      tenant_id: 'sharechat',
      roles: { user: { org1: 'org1.example.com' } },
    });
    expect(await verifyJwt(token)).toBeNull();
  });
});
