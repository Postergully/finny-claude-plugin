import { describe, it, expect } from 'vitest';
import { listTools } from '../../../server/tools-registration.js';

describe('M1 stub tools', () => {
  it('registers exactly the five public lolly_* tools (executeSuiteQL is internal-only)', async () => {
    const tools = await listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'lolly_continue',
      'lolly_query',
      'lolly_remember',
      'lolly_report',
      'lolly_task_status',
    ]);
    expect(names).not.toContain('lolly_executeSuiteQL');
  });

  it('lolly_query is registered and callable', async () => {
    const tools = await listTools();
    const query = tools.find((t) => t.name === 'lolly_query');
    expect(query).toBeDefined();
    // Live invocation is exercised in query.live.test.ts (gated on
    // LOLLY_GATEWAY_TOKEN). Don't call the handler here — would hit the gateway.
  });
});
