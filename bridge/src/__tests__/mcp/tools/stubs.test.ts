import { describe, it, expect } from 'vitest';
import { listTools } from '../../../server/tools-registration.js';

describe('M1 stub tools', () => {
  it('registers exactly the five public finny_* tools (executeSuiteQL is internal-only)', async () => {
    const tools = await listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'finny_continue',
      'finny_query',
      'finny_remember',
      'finny_report',
      'finny_task_status',
    ]);
    expect(names).not.toContain('finny_executeSuiteQL');
  });

  it('finny_query is registered and callable', async () => {
    const tools = await listTools();
    const query = tools.find((t) => t.name === 'finny_query');
    expect(query).toBeDefined();
    // Live invocation is exercised in query.live.test.ts (gated on
    // FINNY_GATEWAY_TOKEN). Don't call the handler here — would hit the gateway.
  });
});
