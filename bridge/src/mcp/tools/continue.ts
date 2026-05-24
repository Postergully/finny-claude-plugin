import { z } from 'zod';

import type { FinnyEnvelope } from '../../types/envelope.js';
import { taskManager } from '../tasks/manager.js';
import { ensureTaskWorker, awaitTaskOrEscalate } from './_shared/taskWorker.js';
import type { RunQueryParams } from './_shared/chatPipeline.js';
import { errorEnvelope } from './_shared/envelopeBuilders.js';
import {
  advanceConversation,
  deleteConversation,
  getConversation,
} from './_shared/conversationStore.js';

// Cap the number of needs_input rounds before forcing a partial envelope.
// Three rounds is the v1 default per spec §8 — revisit after telemetry.
const MAX_ROUNDS = 3;

export const continueInputSchema = z.object({
  conversation_id: z.string().min(1),
  response: z
    .object({
      // Caller can pick from the offered options (id) OR send free-form
      // text (answer). Tool refuses if both are absent — the response
      // must carry signal.
      selected_option: z.string().optional(),
      answer: z.string().optional(),
    })
    .refine((r) => r.selected_option !== undefined || r.answer !== undefined, {
      message: 'response must include either selected_option or answer',
    }),
  deadline_ms: z.number().int().positive().max(300_000).default(30_000),
});

export type ContinueInput = z.infer<typeof continueInputSchema>;

async function handler(rawInput: ContinueInput): Promise<FinnyEnvelope> {
  const input = continueInputSchema.parse(rawInput);

  const conv = getConversation(input.conversation_id);
  if (!conv) {
    // Finny's session has likely also expired or the conversation was never
    // registered. Cowork should restart from a fresh finny_query call.
    return errorEnvelope({
      code: 'gateway_rejected',
      message:
        `Unknown or expired conversation_id: ${input.conversation_id}. ` +
        `Restart from finny_query (the bridge keeps conversations in memory only; ` +
        `30-min idle eviction or bridge restart drops in-flight conversations).`,
      retryable: false,
      elapsedMs: 0,
      envUsed: 'production',
      sessionId: '—',
      intentRestated: 'finny_continue',
    });
  }

  // Round cap. The conv.round counter starts at 1 when the original
  // needs_input was registered. Increment happens AFTER the cap check
  // so we use `>=` against the cap. After the 3rd continue call the
  // counter would advance to 4 — refuse and force-partial instead.
  if (conv.round >= MAX_ROUNDS) {
    deleteConversation(input.conversation_id);
    return {
      status: 'partial',
      intent_restated: conv.intent_string ?? conv.user_question.slice(0, 200),
      assumptions: [],
      unanswered: [
        `Finny asked for clarification ${MAX_ROUNDS} times without resolving the request — capped to prevent infinite loops. ` +
          `Caller should rephrase the question or break it into smaller pieces.`,
      ],
      data: {
        shape: 'narrative',
        narrative:
          `Conversation ${input.conversation_id} hit the ${MAX_ROUNDS}-round needs_input cap. ` +
          `The original question was: ${conv.user_question}`,
      },
      sources: [],
      confidence: 'low',
      confidence_reason: `Hit ${MAX_ROUNDS}-round needs_input cap`,
      elapsed_ms: 0,
      env_used: 'production',
      bridge_version: '0.0.1',
      finny_session_id: '—',
    };
  }

  // Append the user's clarification to the conversation's audit trail and
  // bump the round counter.
  const newClarification = input.response.selected_option
    ? `Round ${conv.round + 1}: user selected option "${input.response.selected_option}"`
    : `Round ${conv.round + 1}: user answered "${input.response.answer}"`;

  const updated = advanceConversation(input.conversation_id, (e) => {
    e.clarifications_resolved = [...e.clarifications_resolved, newClarification];
  });
  if (!updated) {
    return errorEnvelope({
      code: 'internal',
      message: `conversation ${input.conversation_id} disappeared mid-advance`,
      retryable: false,
      elapsedMs: 0,
      envUsed: 'production',
      sessionId: '—',
    });
  }

  // Replay execute phase with augmented clarifications.
  ensureTaskWorker();

  const params: RunQueryParams = {
    question: updated.user_question,
    expected_shape: updated.expected_shape,
    sessionPrincipal: updated.sessionPrincipal,
    deadlineMs: 300_000,
    intent_string: updated.intent_string,
    blessed: updated.blessed,
    phase: 'execute',
    scope: updated.scope,
    clarifications_resolved: updated.clarifications_resolved,
  };

  const task = taskManager.create({
    type: 'chat',
    input: params,
    sessionId: updated.sessionPrincipal,
  });

  return awaitTaskOrEscalate(
    task.id,
    input.deadline_ms,
    'production',
    updated.sessionPrincipal,
    (updated.intent_string ?? updated.user_question).slice(0, 200)
  );
}

export const continueTool = {
  name: 'finny_continue' as const,
  description:
    "Resume a Finny conversation that returned status: needs_input. Provide the conversation_id from the needs_input envelope and the user's response (either selected_option from the offered options OR a free-form answer). The bridge re-injects the original intent + scope + new clarification and resumes execution. Capped at 3 needs_input rounds — after that the bridge returns status: partial with unanswered[] populated. Async by default: if work exceeds deadline_ms, returns status: running with task_id — poll via finny_task_status.",
  inputSchema: continueInputSchema,
  handler,
};
