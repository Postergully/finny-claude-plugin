import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseArguments } from '../cli.js';

// parseArguments reads from process.argv + process.env. Snapshot and restore.
const ORIGINAL_ARGV = process.argv;
const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  process.argv = ['node', 'bridge'];
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith('AUTH_') ||
      key.startsWith('OAUTH_') ||
      key.startsWith('MCP_') ||
      key.startsWith('OPENCLAW_') ||
      key === 'PORT' ||
      key === 'HOST' ||
      key === 'DEBUG' ||
      key === 'NODE_ENV'
    ) {
      delete process.env[key];
    }
  }
}

beforeEach(() => {
  resetEnv();
});

afterEach(() => {
  process.argv = ORIGINAL_ARGV;
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
});

describe('parseArguments — transport handling', () => {
  it("defaults to 'stdio' when no --transport given", () => {
    const args = parseArguments('0.0.1');
    expect(args.transport).toBe('stdio');
    expect(args.authEnabled).toBe(false);
  });

  it("routes --transport sse to 'http' (deprecation alias)", () => {
    process.argv = ['node', 'bridge', '--transport', 'sse'];
    const args = parseArguments('0.0.1');
    expect(args.transport).toBe('http');
  });

  it("keeps --transport http as 'http'", () => {
    process.argv = ['node', 'bridge', '--transport', 'http'];
    const args = parseArguments('0.0.1');
    expect(args.transport).toBe('http');
  });
});

describe('parseArguments — auto-enable auth', () => {
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
    /* silent */
  });

  afterEach(() => {
    consoleErrorSpy.mockClear();
  });

  it('flips authEnabled=true when --transport http + --issuer-url and creds present', () => {
    process.argv = [
      'node',
      'bridge',
      '--transport',
      'http',
      '--issuer-url',
      'https://example.ngrok-free.dev',
      '--client-id',
      'cid',
      '--client-secret',
      'csecret',
    ];
    const args = parseArguments('0.0.1');
    expect(args.authEnabled).toBe(true);
  });

  it('leaves authEnabled=false when --transport http but no --issuer-url', () => {
    process.argv = ['node', 'bridge', '--transport', 'http'];
    const args = parseArguments('0.0.1');
    expect(args.authEnabled).toBe(false);
  });

  it('does not auto-enable for stdio transport', () => {
    process.argv = ['node', 'bridge', '--issuer-url', 'https://example.ngrok-free.dev'];
    const args = parseArguments('0.0.1');
    expect(args.transport).toBe('stdio');
    expect(args.authEnabled).toBe(false);
  });

  it('respects explicit --no-auth override even with issuer-url', () => {
    process.argv = [
      'node',
      'bridge',
      '--transport',
      'http',
      '--issuer-url',
      'https://example.ngrok-free.dev',
      '--no-auth',
    ];
    const args = parseArguments('0.0.1');
    expect(args.authEnabled).toBe(false);
  });
});

describe('parseArguments — http+auth credential validation', () => {
  it('throws when --transport http --auth but no client-id', () => {
    process.argv = ['node', 'bridge', '--transport', 'http', '--auth'];
    expect(() => parseArguments('0.0.1')).toThrow(/--client-id/);
  });

  it('throws when --transport http --auth with only client-id (no secret)', () => {
    process.argv = ['node', 'bridge', '--transport', 'http', '--auth', '--client-id', 'cid'];
    expect(() => parseArguments('0.0.1')).toThrow(/client-secret/);
  });

  it('passes when --transport http --auth with both credentials', () => {
    process.argv = [
      'node',
      'bridge',
      '--transport',
      'http',
      '--auth',
      '--client-id',
      'cid',
      '--client-secret',
      'csecret',
    ];
    const args = parseArguments('0.0.1');
    expect(args.authEnabled).toBe(true);
    expect(args.clientId).toBe('cid');
    expect(args.clientSecret).toBe('csecret');
  });

  it('does not require credentials in stdio mode even without them', () => {
    process.argv = ['node', 'bridge'];
    const args = parseArguments('0.0.1');
    expect(args.transport).toBe('stdio');
    expect(args.authEnabled).toBe(false);
    expect(args.clientId).toBeUndefined();
  });
});
