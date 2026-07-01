import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { FinnyEnvelope } from '../../types/envelope.js';
import { taskManager } from '../tasks/manager.js';
import { ensureTaskWorker, awaitTaskOrEscalate } from './_shared/taskWorker.js';
import type { RunQueryParams } from './_shared/chatPipeline.js';
import { detectDestructiveIntent } from './_shared/destructiveIntentGuard.js';
import { errorEnvelope, refusedEnvelope } from './_shared/envelopeBuilders.js';
import { lookupIntent } from '../../intents/loader.js';
import { validateScope } from '../../intents/validateScope.js';
import type { BlessListEntry } from '../../intents/types.js';
import {
  derivePrincipal,
  PrincipalError,
  unauthorizedEnvelope,
  type Session,
} from './_shared/principal.js';

const BRIDGE_VERSION = '0.0.1';

// Synthesize a deterministic `needs_input` envelope from a blessed intent's
// required_scope. Used by the discover short-circuit (Issue #40): when cowork
// calls discover for a blessed intent we already know the variables it needs
// to gather, so we return them directly without round-tripping through
// Finny's LLM. Removes the q01 eval drift that was caused by Finny's
// non-deterministic discover output (partial/running/error rotation).
function synthesizeDiscoverNeedsInput(
  entry: BlessListEntry,
  envUsed: 'sandbox' | 'production',
  sessionId: string
): FinnyEnvelope {
  const requiredNames = entry.required_scope.map((v) => v.name);
  const question =
    `To run intent '${entry.id}' (v${entry.version}), the following variables are required: ` +
    `${requiredNames.join(', ')}. Resolve these with the user, then re-call finny_query ` +
    `with phase: 'execute' and the scope populated.`;
  return {
    status: 'needs_input',
    intent_restated: entry.id,
    assumptions: [],
    unanswered: requiredNames,
    data: null,
    sources: [],
    confidence: 'high',
    confidence_reason:
      'Deterministic discover short-circuit from bless-list required_scope; no LLM call.',
    needs_input: {
      question,
      conversation_id: randomUUID(),
      round: 1,
    },
    elapsed_ms: 0,
    env_used: envUsed,
    bridge_version: BRIDGE_VERSION,
    finny_session_id: sessionId,
  };
}

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

async function handler(rawInput: QueryInput, session?: Session): Promise<FinnyEnvelope> {
  const input = queryInputSchema.parse(rawInput);
  const envUsed: 'sandbox' | 'production' = input.entity_hints?.env ?? 'production';

  // Task 4.3 — sealed identity: derive verified principal from session
  // (JWT), never from input. When Zitadel authz is configured on the
  // bridge, verification failure returns unauthorized. When not yet
  // configured (transitional), principal is null. Per-bank read
  // enforcement (canViewBank) fires at the point of bank access —
  // today that point is downstream in Finny, not in the bridge; when
  // a future task hoists the bank ID into the bridge dispatcher, add
  // the canViewBank call at that exact site.
  try {
    await derivePrincipal(session);
  } catch (e) {
    if (e instanceof PrincipalError) {
      return unauthorizedEnvelope(input.intent ?? 'finny_query');
    }
    throw e;
  }

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

  // Gate 1a — deterministic discover short-circuit (Issue #40).
  // For blessed intents in discover phase, we already know the required
  // scope from the bless-list entry. Synthesize a needs_input envelope
  // synchronously and return — no LLM call, no gateway round-trip. This
  // removes the non-determinism that surfaced as q01 eval drift (Finny's
  // discover output rotates between partial/running/error). Non-blessed
  // discover still falls through to taskManager so Finny answers free-form.
  if (blessed && input.phase === 'discover') {
    return synthesizeDiscoverNeedsInput(blessed, envUsed, principal);
  }

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
