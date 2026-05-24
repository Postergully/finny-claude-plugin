import { z } from 'zod';
import type { FinnyEnvelope } from '../../types/envelope.js';
import { taskManager } from '../tasks/manager.js';
import { ensureTaskWorker, awaitTaskOrEscalate } from './_shared/taskWorker.js';
import type { RunQueryParams } from './_shared/chatPipeline.js';
import { errorEnvelope } from './_shared/envelopeBuilders.js';
import { REPORT_REGISTRY } from './_shared/reportRegistry.js';

export const reportInputSchema = z.object({
  report: z.enum([
    'vendor_balance',
    'open_bills',
    'bill_detail',
    'vendor_summary',
    'gstin_lookup',
    'po_status',
  ]),
  params: z.record(z.string(), z.string()).default({}),
  env: z.enum(['sandbox', 'production']).default('production'),
  // Mirror finny_query's async knob. The underlying chat task keeps running
  // beyond this deadline; cowork resumes via finny_task_status.
  deadline_ms: z.number().int().positive().max(300_000).default(10_000),
  sessionId: z.string().optional(),
});

export type ReportInput = z.infer<typeof reportInputSchema>;

async function handler(rawInput: ReportInput): Promise<FinnyEnvelope> {
  const input = reportInputSchema.parse(rawInput);
  const envUsed = input.env;
  const principal = input.sessionId ?? `m2-default:${envUsed}`;

  const def = REPORT_REGISTRY[input.report];
  if (!def) {
    // Defensive: Zod already constrains `report` to the registry keys, but
    // if the schema and registry ever drift we fail closed with an infra
    // error rather than calling runQuery with a garbage preamble.
    return errorEnvelope({
      code: 'internal',
      message: `Unknown report: ${input.report}`,
      retryable: false,
      elapsedMs: 0,
      envUsed,
      sessionId: principal,
      intentRestated: `Run report ${input.report}`,
    });
  }

  const missing = def.required_params.filter((k) => {
    const v = input.params[k];
    return v === undefined || v === null || v === '';
  });
  if (missing.length > 0) {
    return errorEnvelope({
      code: 'internal',
      message: `Missing required params for report ${input.report}: ${missing.join(', ')}`,
      retryable: false,
      elapsedMs: 0,
      envUsed,
      sessionId: principal,
      intentRestated: `Run report ${input.report}`,
    });
  }

  const question = def.preamble({ ...input.params, env: envUsed });
  const intentRestated = question.slice(0, 200);

  ensureTaskWorker();

  const params: RunQueryParams = {
    question,
    expected_shape: def.expected_shape === 'mixed' ? 'narrative' : def.expected_shape,
    entity_hints: { env: envUsed },
    sessionPrincipal: principal,
    // Generous chat-pipeline ceiling; caller-facing knob is deadline_ms below.
    deadlineMs: 300_000,
  };

  const task = taskManager.create({
    type: 'chat',
    input: params,
    sessionId: principal,
  });

  return awaitTaskOrEscalate(task.id, input.deadline_ms, envUsed, principal, intentRestated);
}

export const reportTool = {
  name: 'finny_report' as const,
  description:
    'Run a named structured report against Finny. Report name must be one of the registered enum values. Async by default: if the task does not complete within deadline_ms, returns status:"running" with task_id in data.value — poll via finny_task_status.',
  inputSchema: reportInputSchema,
  handler,
};
