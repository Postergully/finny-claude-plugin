/**
 * Task 4.3 verifier-rubric tests for canViewBank / canWriteBank.
 *
 * Three shapes each per rubric (finny-core/docs/plan/implementation.md
 * Task 4.3, "Verifier rubric" bullet):
 *   (a) private `client-<tenant>-user-<sub>` in bank_acl → allow
 *   (b) shared `client-<tenant>-docs` in bank_acl → allow
 *   (c) cross-tenant `client-OTHER-user-x` injected into bank_acl → DENY
 *       (sealed-tenant prefix guard fires regardless of ACL membership)
 */

import { describe, it, expect } from 'vitest';
import { canViewBank, canWriteBank } from './checks.js';
import type { VerifiedClaims } from './jwt-claims.js';

function principal(overrides: Partial<VerifiedClaims> = {}): VerifiedClaims {
  return {
    sub: 'u_01HXY',
    tenant_id: 'sharechat',
    role: 'user',
    bank_acl: { read: [], write: [] },
    ...overrides,
  };
}

describe('canViewBank', () => {
  it('allows the caller-private bank when listed in bank_acl.read', () => {
    const p = principal({
      bank_acl: {
        read: ['client-sharechat-user-u_01HXY'],
        write: [],
      },
    });
    expect(canViewBank(p, 'client-sharechat-user-u_01HXY')).toBe(true);
  });

  it('allows a shared-docs bank when listed in bank_acl.read', () => {
    const p = principal({
      bank_acl: {
        read: ['client-sharechat-docs'],
        write: [],
      },
    });
    expect(canViewBank(p, 'client-sharechat-docs')).toBe(true);
  });

  it('DENIES a cross-tenant bank even if injected into bank_acl.read (sealed-tenant guard)', () => {
    const p = principal({
      tenant_id: 'sharechat',
      bank_acl: {
        read: ['client-acme-user-attacker'],
        write: [],
      },
    });
    expect(canViewBank(p, 'client-acme-user-attacker')).toBe(false);
  });

  it('denies when bank not in bank_acl.read (missing ACL entry)', () => {
    const p = principal({ bank_acl: { read: [], write: [] } });
    expect(canViewBank(p, 'client-sharechat-user-u_01HXY')).toBe(false);
  });

  it('denies a bank that does not start with `client-<tenant>-`', () => {
    const p = principal({
      bank_acl: { read: ['random-bank-id'], write: [] },
    });
    expect(canViewBank(p, 'random-bank-id')).toBe(false);
  });
});

describe('canWriteBank', () => {
  it('allows the caller-private bank when listed in bank_acl.write', () => {
    const p = principal({
      bank_acl: {
        read: [],
        write: ['client-sharechat-user-u_01HXY'],
      },
    });
    expect(canWriteBank(p, 'client-sharechat-user-u_01HXY')).toBe(true);
  });

  it('allows a shared-docs bank when listed in bank_acl.write', () => {
    const p = principal({
      bank_acl: {
        read: [],
        write: ['client-sharechat-docs'],
      },
    });
    expect(canWriteBank(p, 'client-sharechat-docs')).toBe(true);
  });

  it('DENIES a cross-tenant bank even if injected into bank_acl.write (sealed-tenant guard)', () => {
    const p = principal({
      tenant_id: 'sharechat',
      bank_acl: {
        read: [],
        write: ['client-acme-user-attacker'],
      },
    });
    expect(canWriteBank(p, 'client-acme-user-attacker')).toBe(false);
  });

  it('denies write when bank only in read list (read != write)', () => {
    const p = principal({
      bank_acl: {
        read: ['client-sharechat-user-u_01HXY'],
        write: [],
      },
    });
    expect(canWriteBank(p, 'client-sharechat-user-u_01HXY')).toBe(false);
  });
});
