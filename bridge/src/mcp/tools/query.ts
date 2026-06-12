import { z } from 'zod';
import type { FinnyEnvelope } from '../../types/envelope.js';
import { taskManager } from '../tasks/manager.js';
import { ensureTaskWorker, awaitTaskOrEscalate } from './_shared/taskWorker.js';
import type { RunQueryParams } from './_shared/chatPipeline.js';
import { detectDestructiveIntent } from './_shared/destructiveIntentGuard.js';
import { errorEnvelope, refusedEnvelope } from './_shared/envelopeBuilders.js';
import { lookupIntent } from '../../intents/loader.js';
import { validateScope } from '../../intents/validateScope.js';

export const queryInputSchema = z
  .object({
    // Legacy free-form path. Required when neither `intent` nor `user_question`
    // is supplied. Preserved for operator manual queries via Claude Desktop /
    // debug sessions and for backward compat with existing callers.
    question: z.string().min(1).optional(),

    // New: intent-driven path. Open string — bless-list match is checked at
    // runtime in the handler, NOT via z.enum. Cowork (or Finny herself) can
    // name new intents without a bridge release.
    intent: z.string().min(1).optional(),
    phase: z.enum(['discover', 'execute']).default('execute'),
    scope: z.record(z.unknown()).optional(),
    clarifications_resolved: z.array(z.string()).default([]),
    user_question: z.string().optional(),

    // Existing.
    entity_hints: z
      .object({
        vendor_id: z.string().optional(),
        vendor_name: z.string().optional(),
        period: z.object({ from: z.string(), to: z.string() }).optional(),
        env: z.enum(['sandbox', 'production']).default('production'),
        gstin: z.string().optional(),
      })
      .optional(),
    expected_shape: z.enum(['scalar', 'rows', 'narrative']),
    max_tokens: z.number().int().positive().max(8000).default(2000),
    // Async-by-default (§10.1/§10.2): deadline_ms is the *wait* budget the
    // bridge blocks before returning a `running` envelope with task_id.
    deadline_ms: z.number().int().positive().max(300_000).default(30_000),
    sessionId: z.string().optional(),
  })
  .refine(
    (input) =>
      input.question !== undefined ||
      input.intent !== undefined ||
      input.user_question !== undefined,
    { message: 'at least one of `question`, `intent`, `user_question` must be provided' }
  );

export type QueryInput = z.infer<typeof queryInputSchema>;

async function handler(rawInput: QueryInput): Promise<FinnyEnvelope> {
  const input = queryInputSchema.parse(rawInput);
  const envUsed: 'sandbox' | 'production' = input.entity_hints?.env ?? 'production';
  const principal = input.sessionId ?? `m2-default:${envUsed}`;

  // The textual question carried into Finny's prompt: prefer user_question
  // (verbatim user phrasing the cowork plugin captured), fall back to legacy
  // question, finally to the intent string itself if neither is present.
  const questionText = input.user_question ?? input.question ?? input.intent ?? '';

  // Gate 0 — destructive-intent guard. Refuse-before-delegation analogous to
  // the SuiteQL write-verb guard. Fires in-bridge, no taskManager.create(),
  // no gateway call.
  const destructive = detectDestructiveIntent(questionText);
  if (destructive) {
    return refusedEnvelope({
      intentRestated: questionText.slice(0, 200),
      reason:
        `Refused: question names destructive verb '${destructive.verb}' applied to ` +
        `NetSuite entity '${destructive.entity}'. Finny is read-only against NetSuite; ` +
        `write operations require a separate governance review. Rephrase as a read-only ` +
        `question (e.g. "list overdue vendor bills") or escalate via a workflow that ` +
        `supports writes.`,
      envUsed,
      sessionId: '—',
      elapsedMs: 0,
      // Deterministic regex match — the judge should trust this absolutely.
      confidence: 'high',
    });
  }

  // Gate 1 — bless-list scope enforcement on execute phase.
  // Open intents (lookupIntent returns null) skip this gate entirely; Finny
  // handles missing scope downstream via needs_input (Track F) or partial.
  const blessed = lookupIntent(input.intent);
  if (blessed && input.phase === 'execute') {
    const result = validateScope(blessed, input.scope);
    if (!result.ok) {
      return errorEnvelope({
        code: 'wrong_tool',
        message:
          `Missing required scope for intent '${input.intent}' (v${blessed.version}): ` +
          `${result.missing.join(', ')}. ` +
          `Call finny_query again with phase: 'discover' for guidance on these variables.`,
        retryable: true,
        elapsedMs: 0,
        envUsed,
        sessionId: '—',
        intentRestated: input.intent,
      });
    }
  }

  ensureTaskWorker();

  const params: RunQueryParams = {
    question: questionText,
    expected_shape: input.expected_shape,
    entity_hints: input.entity_hints,
    sessionPrincipal: principal,
    // Generous ceiling — wait budget (input.deadline_ms) is a separate knob.
    deadlineMs: 300_000,
    intent_string: input.intent,
    blessed: blessed ?? undefined,
    // free_form when no intent supplied; otherwise honor the caller's phase.
    phase: input.intent ? input.phase : 'free_form',
    scope: input.scope,
    clarifications_resolved: input.clarifications_resolved,
  };

  const task = taskManager.create({
    type: 'chat',
    input: params,
    sessionId: principal,
  });

  return awaitTaskOrEscalate(
    task.id,
    input.deadline_ms,
    envUsed,
    principal,
    (input.intent ?? questionText).slice(0, 200)
  );
}

export const queryTool = {
  name: 'finny_query' as const,
  description:
    'Ask Finny a ShareChat/NetSuite question. Two modes:\n' +
    "(1) Intent-driven (recommended): pass `intent` as a free-form string + `phase`. Use `phase: 'discover'` first when you don't know what variables matter — Finny returns a narrative envelope listing the variables to gather + brain-derived hints + example clarifying questions. Use `phase: 'execute'` once cowork has resolved scope with the user. A small set of canonical intents (p&l_statement, vendor_balance, cash_position, transaction_lookup) have required scope enforced at the bridge edge — calling `phase: 'execute'` for these without resolving scope returns `error.code: 'wrong_tool'` with the missing variables. Other `intent` values pass through; Finny handles them.\n" +
    '(2) Free-form (legacy): pass `question: string`. Finny answers as best she can.\n' +
    "Async by default: if work exceeds `deadline_ms`, returns `status: 'running'` with `task_id` in `data.value` — poll via `finny_task_status`.",
  inputSchema: queryInputSchema,
  handler,
};
