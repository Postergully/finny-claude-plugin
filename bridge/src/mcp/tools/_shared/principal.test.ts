/**
 * Task 4.3 — derivePrincipal contract tests.
 *
 * Contract:
 *   - Reads ONLY from session.authInfo.token. Tool input is IGNORED for
 *     identity (sealed-identity rule).
 *   - Returns null when Zitadel not configured (transitional).
 *   - Throws PrincipalError when Zitadel IS configured but verification
 *     fails or token is missing.
 *   - Never mutates or reads from tool input.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, importJWK, type JWK } from 'jose';
import {
  derivePrincipal,
  PrincipalError,
  unauthorizedEnvelope,
  bankDeniedEnvelope,
} from './principal.js';
import { _setJwksOverrideForTesting, _resetJwksCacheForTesting } from '../../../auth/jwt-claims.js';

const TEST_ISSUER = 'https://zitadel.test';
const TEST_AUDIENCE = 'finny-bridge';

async function mintValidToken(): Promise<string> {
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
  return new SignJWT({
    tenant_id: 'sharechat',
    'urn:zitadel:iam:org:project:roles': { user: { org1: 'org1.example.com' } },
    bank_acl: { read: ['client-sharechat-docs'], write: [] },
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setSubject('u_01HXY')
    .setIssuer(TEST_ISSUER)
    .setAudience(TEST_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);
}

describe('derivePrincipal', () => {
  const origIss = process.env.ZITADEL_ISSUER;
  const origAud = process.env.ZITADEL_AUDIENCE;
  const origJwks = process.env.ZITADEL_JWKS_URL;

  beforeEach(() => {
    delete process.env.ZITADEL_ISSUER;
    delete process.env.ZITADEL_AUDIENCE;
    delete process.env.ZITADEL_JWKS_URL;
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
  });

  it('returns null when Zitadel not configured (transitional)', async () => {
    const result = await derivePrincipal({
      authInfo: { token: 'anything', clientId: 'c', scopes: [] },
    });
    expect(result).toBeNull();
  });

  it('throws PrincipalError when Zitadel configured but session missing', async () => {
    process.env.ZITADEL_ISSUER = TEST_ISSUER;
    process.env.ZITADEL_AUDIENCE = TEST_AUDIENCE;
    process.env.ZITADEL_JWKS_URL = 'https://zitadel.test/keys';
    await expect(derivePrincipal(undefined)).rejects.toBeInstanceOf(PrincipalError);
  });

  it('throws PrincipalError when Zitadel configured but token missing on session', async () => {
    process.env.ZITADEL_ISSUER = TEST_ISSUER;
    process.env.ZITADEL_AUDIENCE = TEST_AUDIENCE;
    process.env.ZITADEL_JWKS_URL = 'https://zitadel.test/keys';
    await expect(derivePrincipal({})).rejects.toBeInstanceOf(PrincipalError);
  });

  it('throws PrincipalError when token fails verification (bad signature)', async () => {
    process.env.ZITADEL_ISSUER = TEST_ISSUER;
    process.env.ZITADEL_AUDIENCE = TEST_AUDIENCE;
    process.env.ZITADEL_JWKS_URL = 'https://zitadel.test/keys';
    await expect(
      derivePrincipal({
        authInfo: { token: 'not-a-jwt', clientId: 'c', scopes: [] },
      })
    ).rejects.toBeInstanceOf(PrincipalError);
  });

  it('returns VerifiedClaims when Zitadel configured + valid token', async () => {
    process.env.ZITADEL_ISSUER = TEST_ISSUER;
    process.env.ZITADEL_AUDIENCE = TEST_AUDIENCE;
    process.env.ZITADEL_JWKS_URL = 'https://zitadel.test/keys';
    const token = await mintValidToken();
    const result = await derivePrincipal({
      authInfo: { token, clientId: 'c', scopes: [] },
    });
    expect(result).toEqual({
      sub: 'u_01HXY',
      tenant_id: 'sharechat',
      role: 'user',
      bank_acl: { read: ['client-sharechat-docs'], write: [] },
    });
  });
});

describe('unauthorizedEnvelope / bankDeniedEnvelope', () => {
  it('unauthorizedEnvelope returns an error envelope with unauthorized code', () => {
    const env = unauthorizedEnvelope('some_intent');
    expect(env.status).toBe('error');
    expect(env.error?.code).toBe('unauthorized');
    expect(env.error?.message).toBe('not authorized');
    // Generic — internals must not leak into intent_restated.
    expect(env.intent_restated).toBe('some_intent');
  });

  it('bankDeniedEnvelope returns an error envelope with bank_denied message', () => {
    const env = bankDeniedEnvelope('finny_remember');
    expect(env.status).toBe('error');
    expect(env.error?.code).toBe('unauthorized');
    expect(env.error?.message).toBe('bank_denied');
    expect(env.intent_restated).toBe('finny_remember');
  });
});
