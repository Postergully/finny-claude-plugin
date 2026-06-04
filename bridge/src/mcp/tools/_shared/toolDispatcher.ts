/**
 * Multi-turn OpenAI tool-use dispatcher. Wraps HermesClient.chat() and
 * routes finny_progress tool_calls to taskManager.updateProgress(). Loops
 * until the assistant returns content with no tool_calls, or a hard cap
 * of 10 iterations is reached (defensive — Finny shouldn't loop forever).
 *
 * All other tool names result in a `unknown_tool` error in the tool
 * result; the assistant can decide what to do. This keeps the bridge
 * minimal — finny_progress is the only tool we register today.
 */

import type { HermesClient, OpenAIMessage } from '../../../hermes/client.js';
import type { OpenAIToolCall } from '../../../hermes/types.js';
import {
  progressOpenAIToolSpec,
  applyProgress,
  progressInputSchema,
  type ProgressInput,
} from '../progress.js';
import { log } from '../../../utils/logger.js';

// Defensive cap. Finny emits ≤6 progress strings per query in practice;
// 10 leaves headroom without letting a runaway loop burn upstream budget.
const MAX_LOOPS = 10;

export interface RunChatWithToolsParams {
  client: HermesClient;
  systemPrompt: string;
  userMessage: string;
  sessionId: string;
  taskId: string | undefined;
}

export interface RunChatWithToolsResult {
  content: string;
  iterations: number;
}

export async function runChatWithTools(
  params: RunChatWithToolsParams
): Promise<RunChatWithToolsResult> {
  const messages: OpenAIMessage[] = [
    { role: 'system', content: params.systemPrompt },
    { role: 'user', content: params.userMessage },
  ];

  for (let i = 0; i < MAX_LOOPS; i++) {
    const result = await params.client.chat({
      messages,
      tools: [progressOpenAIToolSpec],
      sessionId: params.sessionId,
    });

    if (!result.tool_calls || result.tool_calls.length === 0) {
      return { content: result.response, iterations: i + 1 };
    }

    // Append the assistant's tool_call message to history.
    messages.push({
      role: 'assistant',
      content: result.response || null,
      tool_calls: result.tool_calls,
    });

    // Execute each tool_call sequentially. finny_progress is idempotent
    // (last-write-wins on the task record), so order within a single
    // assistant turn doesn't matter. If a future tool has side effects
    // that require parallel or ordered semantics, revisit this.
    for (const call of result.tool_calls) {
      const toolResult = await dispatchToolCall(call, params.taskId);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(toolResult),
      });
    }
  }

  // Loop cap hit — return whatever the last assistant content was (likely empty).
  log(`[toolDispatcher] loop cap hit (${MAX_LOOPS}) for task=${params.taskId ?? '<none>'}`);
  return { content: '', iterations: MAX_LOOPS };
}

async function dispatchToolCall(
  call: OpenAIToolCall,
  taskId: string | undefined
): Promise<{ ok: boolean; reason?: string }> {
  if (call.function.name !== 'finny_progress') {
    return { ok: false, reason: 'unknown_tool' };
  }

  if (!taskId) {
    // No task context (synchronous fast-path query). Acknowledge so Finny
    // doesn't retry, but don't write anywhere.
    return { ok: false, reason: 'no_task_context' };
  }

  let parsed: ProgressInput;
  try {
    const raw = JSON.parse(call.function.arguments) as unknown;
    parsed = progressInputSchema.parse(raw);
  } catch (err) {
    log(
      `[toolDispatcher] finny_progress arg parse failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return { ok: false, reason: 'invalid_arguments' };
  }

  return applyProgress(parsed, { taskId });
}
