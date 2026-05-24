import { describe, it, expect, beforeEach } from 'vitest';
import { reportTool } from '../../../mcp/tools/report.js';
import { taskManager } from '../../../mcp/tasks/manager.js';
import { REPORT_REGISTRY, type ReportDef } from '../../../mcp/tools/_shared/reportRegistry.js';
import { LollyEnvelopeSchema, type LollyEnvelope } from '../../../types/envelope.js';

const REPORT_NAMES = [
  'vendor_balance',
  'open_bills',
  'bill_detail',
  'vendor_summary',
  'gstin_lookup',
  'po_status',
] as const;

function makeStoredEnvelope(intent: string): LollyEnvelope {
  return {
    status: 'ok',
    intent_restated: intent,
    assumptions: [],
    unanswered: [],
    data: { shape: 'scalar', value: 42 },
    sources: [],
    confidence: 'high',
    confidence_reason: 'mocked worker result',
    elapsed_ms: 10,
    env_used: 'production',
    bridge_version: '0.0.1',
    lolly_session_id: 'sess-report-test',
  };
}

describe('REPORT_REGISTRY', () => {
  it('exposes exactly the six M3 reports', () => {
    expect(Object.keys(REPORT_REGISTRY).sort()).toEqual([...REPORT_NAMES].sort());
  });

  for (const name of REPORT_NAMES) {
    it(`${name}: has preamble, expected_shape, required_params`, () => {
      const def: ReportDef = REPORT_REGISTRY[name];
      expect(def).toBeDefined();
      expect(typeof def.preamble).toBe('function');
      expect(['scalar', 'rows', 'narrative', 'mixed']).toContain(def.expected_shape);
      expect(Array.isArray(def.required_params)).toBe(true);
      expect(def.required_params.length).toBeGreaterThan(0);

      // Preamble must actually consume at least the required params (smoke-test
      // that interpolation works and produces a non-empty question).
      const fakeParams: Record<string, string> = { env: 'production' };
      for (const k of def.required_params) fakeParams[k] = `TEST_${k}`;
      const out = def.preamble(fakeParams);
      expect(typeof out).toBe('string');
      expect(out.length).toBeGreaterThan(40);
      for (const k of def.required_params) {
        expect(out).toContain(`TEST_${k}`);
      }
    });
  }
});

describe('lolly_report — live handler (Task 4)', () => {
  beforeEach(() => {
    for (const t of taskManager.list()) {
      taskManager.delete(t.id);
    }
  });

  it('missing required param → error.code "internal" enumerating the missing names', async () => {
    const res = await reportTool.handler({
      report: 'vendor_balance',
      params: {}, // vendor_name missing
      env: 'production',
      deadline_ms: 1000,
    });
    expect(res.status).toBe('error');
    expect(res.error?.code).toBe('internal');
    expect(res.error?.retryable).toBe(false);
    expect(res.error?.message).toContain('vendor_balance');
    expect(res.error?.message).toContain('vendor_name');
    expect(LollyEnvelopeSchema.safeParse(res).success).toBe(true);
  });

  it('missing multiple required params lists them all', async () => {
    // po_status requires po_number; pass wrong key to trigger missing.
    const res = await reportTool.handler({
      report: 'po_status',
      params: { wrong_key: 'x' },
      env: 'production',
      deadline_ms: 1000,
    });
    expect(res.status).toBe('error');
    expect(res.error?.message).toContain('po_number');
  });

  it('empty-string required param counts as missing', async () => {
    const res = await reportTool.handler({
      report: 'gstin_lookup',
      params: { vendor_name: '' },
      env: 'production',
      deadline_ms: 1000,
    });
    expect(res.status).toBe('error');
    expect(res.error?.message).toContain('vendor_name');
  });

  it('happy path: completed task envelope passes through', async () => {
    // Seed the task manager with a "pre-completed" result. The handler calls
    // taskManager.create then awaitTaskOrEscalate which polls until completion.
    // We intercept by monkey-patching taskManager.create to mark the task
    // completed immediately — no chat pipeline, no worker involvement.
    const stored = makeStoredEnvelope('Return the current open balance for vendor "Acme"');
    const originalCreate = taskManager.create.bind(taskManager);
    const spy = (options: Parameters<typeof taskManager.create>[0]) => {
      const task = originalCreate(options);
      // Immediately mark completed with our fixture — bypasses the worker loop
      // so the handler's awaitTaskOrEscalate returns on first poll.
      taskManager.updateStatus(task.id, 'completed', JSON.stringify(stored));
      return task;
    };
    (taskManager as unknown as { create: typeof spy }).create = spy;

    try {
      const res = await reportTool.handler({
        report: 'vendor_balance',
        params: { vendor_name: 'Acme' },
        env: 'production',
        deadline_ms: 2000,
      });
      expect(res).toEqual(stored);
      expect(LollyEnvelopeSchema.safeParse(res).success).toBe(true);
    } finally {
      (taskManager as unknown as { create: typeof originalCreate }).create = originalCreate;
    }
  });

  it('deadline exceeded → status:"running" with task_id in data.value', async () => {
    // Leave the task pending. Worker is ensureTaskWorker()'d but without a
    // live gateway the drain will attempt chat and fail. That's fine — we
    // use a tiny deadline so awaitTaskOrEscalate escalates before the worker
    // (if it even gets scheduled) finishes.
    //
    // To keep this deterministic we stub taskManager.create to NOT enqueue
    // a real pending task for the worker — we create it as pending but the
    // worker's drain will pick it up. So instead, stub create to return a
    // task whose status we force to 'running' (worker treats already-running
    // tasks as taken, and our awaitTaskOrEscalate sees 'running' and waits).
    const originalCreate = taskManager.create.bind(taskManager);
    const spy = (options: Parameters<typeof taskManager.create>[0]) => {
      const task = originalCreate(options);
      taskManager.updateStatus(task.id, 'running');
      return task;
    };
    (taskManager as unknown as { create: typeof spy }).create = spy;

    try {
      const res = await reportTool.handler({
        report: 'gstin_lookup',
        params: { vendor_name: 'SlowVendor' },
        env: 'production',
        deadline_ms: 150,
      });
      expect(res.status).toBe('running');
      expect(res.task_id).toBeTruthy();
      if (res.data?.shape === 'scalar') {
        expect(res.data.value).toBe(res.task_id);
      }
      expect(LollyEnvelopeSchema.safeParse(res).success).toBe(true);
    } finally {
      (taskManager as unknown as { create: typeof originalCreate }).create = originalCreate;
    }
  });

  it('sessionId override is honoured', async () => {
    const stored = makeStoredEnvelope('session override');
    const originalCreate = taskManager.create.bind(taskManager);
    let capturedSessionId: string | undefined;
    const spy = (options: Parameters<typeof taskManager.create>[0]) => {
      capturedSessionId = options.sessionId;
      const task = originalCreate(options);
      taskManager.updateStatus(task.id, 'completed', JSON.stringify(stored));
      return task;
    };
    (taskManager as unknown as { create: typeof spy }).create = spy;

    try {
      await reportTool.handler({
        report: 'vendor_balance',
        params: { vendor_name: 'Acme' },
        env: 'sandbox',
        deadline_ms: 2000,
        sessionId: 'caller-session-xyz',
      });
      expect(capturedSessionId).toBe('caller-session-xyz');
    } finally {
      (taskManager as unknown as { create: typeof originalCreate }).create = originalCreate;
    }
  });
});
