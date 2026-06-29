import * as jose from 'jose';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { recordAccess, type TokenClaims } from './access-db.js';

export interface OidcProviderConfig {
  issuer: string;
  audience: string;
  jwksUri?: string;
}

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  revocation_endpoint?: string;
}

let cachedDiscovery: OidcDiscovery | null = null;
let discoveryFetchedAt = 0;
const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1 hour

async function fetchDiscovery(issuer: string): Promise<OidcDiscovery> {
  const now = Date.now();
  if (cachedDiscovery && now - discoveryFetchedAt < DISCOVERY_TTL_MS) {
    return cachedDiscovery;
  }
  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch OIDC discovery from ${url}: ${res.status}`);
  }
  cachedDiscovery = (await res.json()) as OidcDiscovery;
  discoveryFetchedAt = now;
  return cachedDiscovery;
}

export async function getOidcDiscovery(issuer: string): Promise<OidcDiscovery> {
  return fetchDiscovery(issuer);
}

export async function createOidcVerifier(config: OidcProviderConfig) {
  const discovery = await getOidcDiscovery(config.issuer);
  const jwksUri = config.jwksUri || discovery.jwks_uri;
  const userinfoEndpoint = discovery.userinfo_endpoint || '';
  const jwks = jose.createRemoteJWKSet(new URL(jwksUri));

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      try {
        const { payload } = await jose.jwtVerify(token, jwks, {
          issuer: config.issuer,
          audience: config.audience,
        });

        const sub = (payload.sub as string) || 'unknown';
        const scopes =
          typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [];

        const groups = Array.isArray(payload.groups)
          ? (payload.groups as string[])
          : typeof payload.groups === 'string'
            ? [payload.groups]
            : [];

        let email = payload.email as string | undefined;

        if (userinfoEndpoint) {
          const claims: TokenClaims = {
            sub,
            jti: payload.jti as string | undefined,
            client_id: payload.client_id as string | undefined,
            exp: payload.exp,
          };
          const resolvedEmail = await recordAccess(config.issuer, claims, token, userinfoEndpoint);
          if (resolvedEmail) email = resolvedEmail;
        }

        return {
          token,
          clientId: sub,
          scopes,
          expiresAt: payload.exp,
          extra: {
            email,
            name: payload.name as string | undefined,
            email_verified: payload.email_verified as boolean | undefined,
            sub,
            groups,
          },
          subject: email || sub,
        } as AuthInfo;
      } catch (err) {
        if (err instanceof InvalidTokenError) throw err;
        console.error('[oidc] JWT verify failed:', (err as Error).message || err);
        if (err instanceof jose.errors.JWTExpired) {
          throw new InvalidTokenError('Token expired');
        }
        if (err instanceof jose.errors.JWTClaimValidationFailed) {
          throw new InvalidTokenError('Token claim validation failed');
        }
        if (err instanceof jose.errors.JWSSignatureVerificationFailed) {
          throw new InvalidTokenError('Token signature verification failed');
        }
        throw new InvalidTokenError('Invalid token');
      }
    },
  };
}
