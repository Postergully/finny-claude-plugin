import { describe, it, expect } from 'vitest';
import { queryInputSchema } from '../../../mcp/tools/query.js';
import { reportInputSchema } from '../../../mcp/tools/report.js';

describe('default deadline_ms (Workstream A)', () => {
  it('finny_query defaults deadline_ms to 30_000', () => {
    const parsed = queryInputSchema.parse({
      question: 'q',
      expected_shape: 'scalar',
    });
    expect(parsed.deadline_ms).toBe(30_000);
  });

  it('finny_report defaults deadline_ms to 30_000', () => {
    const parsed = reportInputSchema.parse({
      report: 'vendor_balance',
      params: { vendor_name: 'Acme' },
      env: 'production',
    });
    expect(parsed.deadline_ms).toBe(30_000);
  });
});
