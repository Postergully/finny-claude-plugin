import { describe, it, expect } from 'vitest';
import {
  errorEnvelope,
  runningEnvelope,
  refusedEnvelope,
} from '../../../../mcp/tools/_shared/envelopeBuilders.js';
import { LollyEnvelopeSchema } from '../../../../types/envelope.js';

describe('envelopeBuilders', () => {
  it('errorEnvelope produces a schema-valid error envelope', () => {
    const env = errorEnvelope({
      code: 'gateway_unreachable',
      message: 'Failed to connect',
      retryable: true,
      elapsedMs: 123,
      envUsed: 'production',
      sessionId: 'sess-1',
      intentRestated: 'test',
    });
    const parsed = LollyEnvelopeSchema.safeParse(env);
    expect(parsed.success).toBe(true);
    expect(env.status).toBe('error');
    expect(env.error?.code).toBe('gateway_unreachable');
  });

  it('errorEnvelope supports the new `other` escape valve', () => {
    const env = errorEnvelope({
      code: 'other',
      message: 'approval_required',
      retryable: false,
      elapsedMs: 0,
      envUsed: 'production',
      sessionId: 'sess-x',
    });
    const parsed = LollyEnvelopeSchema.safeParse(env);
    expect(parsed.success).toBe(true);
    expect(env.error?.code).toBe('other');
    expect(env.error?.message).toBe('approval_required');
  });

  it('runningEnvelope puts task_id in data.value and satisfies schema', () => {
    const env = runningEnvelope({
      intentRestated: 'slow question',
      taskId: 'task_abc_0001',
      elapsedMs: 10_000,
      envUsed: 'production',
      sessionId: 'sess-2',
      deadlineExceededMs: 10_000,
    });
    const parsed = LollyEnvelopeSchema.safeParse(env);
    expect(parsed.success).toBe(true);
    expect(env.status).toBe('running');
    // Canonical location per §2.4: data.value carries the task_id
    expect(env.data?.shape).toBe('scalar');
    if (env.data?.shape === 'scalar') {
      expect(env.data.value).toBe('task_abc_0001');
      expect(env.data.rendered_markdown).toContain('task_abc_0001');
      expect(env.data.rendered_markdown).toContain('deadline_exceeded_ms');
    }
    // Top-level task_id also populated to satisfy the schema's
    // status=running refinement.
    expect(env.task_id).toBe('task_abc_0001');
  });

  it('refusedEnvelope produces a schema-valid refused envelope', () => {
    const env = refusedEnvelope({
      intentRestated: 'DROP TABLE vendor',
      reason: "SQL contains write verb 'DROP'",
      elapsedMs: 0,
      envUsed: 'production',
      sessionId: '—',
    });
    const parsed = LollyEnvelopeSchema.safeParse(env);
    expect(parsed.success).toBe(true);
    expect(env.status).toBe('refused');
    expect(env.confidence_reason).toContain('DROP');
  });
});
