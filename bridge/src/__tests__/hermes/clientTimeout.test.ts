import { describe, it, expect } from 'vitest';
import { HermesClient } from '../../hermes/client.js';

describe('HermesClient timeout default (Workstream A)', () => {
  it('uses 150_000ms as the default timeout', () => {
    const client = new HermesClient('http://localhost:18789');
    const timeoutMs = (client as unknown as { timeoutMs: number }).timeoutMs;
    expect(timeoutMs).toBe(150_000);
  });
});
