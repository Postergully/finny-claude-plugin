import { describe, it, expect } from 'vitest';
import { queryTool } from '../../../mcp/tools/query.js';
import { taskManager } from '../../../mcp/tasks/manager.js';
import { LollyEnvelopeSchema, type LollyEnvelope } from '../../../types/envelope.js';

const LIVE = !!process.env.LOLLY_GATEWAY_TOKEN;

describe.skipIf(!LIVE)('lolly_query (LIVE against real gateway)', () => {
  it('returns a valid scalar envelope for a trivial arithmetic question', async () => {
    const res = await queryTool.handler({
      question: 'What is 7 times 8? Respond with the scalar value only.',
      expected_shape: 'scalar',
      max_tokens: 2000,
      deadline_ms: 45_000,
    });
    // With a generous wait budget this should complete in-band.
    if (res.status === 'running') {
      // Fall-through: poll via taskManager directly. Task 3 will replace
      // this with lolly_task_status — for now internal state is OK.
      const taskId = res.task_id!;
      const polled = await pollTaskToTerminal(taskId, 200_000);
      expect(['ok', 'partial']).toContain(polled.status);
    } else {
      expect(['ok', 'partial']).toContain(res.status);
      expect(res.data?.shape).toBe('scalar');
    }
    expect(res.lolly_session_id.length).toBeGreaterThan(0);
    expect(res.bridge_version).toMatch(/^0\./);
  }, 240_000);

  it('async path: short deadline_ms returns running + task_id; taskManager.get eventually completes', async () => {
    const res = await queryTool.handler({
      question: 'How many vendor records exist in production?',
      expected_shape: 'scalar',
      max_tokens: 2000,
      deadline_ms: 2_000,
    });
    // A realistic NetSuite question should not fit in 2s.
    expect(res.status).toBe('running');
    expect(res.task_id).toBeTruthy();
    // Canonical slot check
    expect(res.data?.shape).toBe('scalar');
    if (res.data?.shape === 'scalar') {
      expect(res.data.value).toBe(res.task_id);
    }
    const terminal = await pollTaskToTerminal(res.task_id!, 220_000);
    expect(['ok', 'partial', 'error', 'refused']).toContain(terminal.status);
    expect(LollyEnvelopeSchema.safeParse(terminal).success).toBe(true);
  }, 260_000);
});

async function pollTaskToTerminal(taskId: string, totalMs: number): Promise<LollyEnvelope> {
  const started = Date.now();
  while (Date.now() - started < totalMs) {
    const t = taskManager.get(taskId);
    if (!t) throw new Error(`Task ${taskId} vanished`);
    if (t.status === 'completed' && t.result) {
      return JSON.parse(t.result) as LollyEnvelope;
    }
    if (t.status === 'failed' || t.status === 'cancelled') {
      throw new Error(`Task ${taskId} terminal=${t.status}: ${t.error ?? ''}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Task ${taskId} never reached terminal state in ${totalMs}ms`);
}
