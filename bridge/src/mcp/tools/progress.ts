/**
 * finny_progress: internal tool Finny calls during long execute phases
 * to emit a stage string. The bridge intercepts these calls server-side
 * and writes the string to the current in-flight task record. Cowork
 * does NOT see this tool — it's not registered in tools-registration.ts
 * ALL_TOOLS array. Routed only via the gateway's tool-call dispatch.
 *
 * Track S of post-smoke fixes (spec
 * docs/superpowers/specs/2026-05-15-post-smoke-fixes.md).
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { taskManager } from '../tasks/manager.js';
import { log } from '../../utils/logger.js';

export const progressInputSchema = z.object({
  text: z.string().min(1).max(500),
});

export type ProgressInput = z.infer<typeof progressInputSchema>;

export interface ProgressContext {
  taskId: string;
}

export function applyProgress(
  input: ProgressInput,
  ctx: ProgressContext
): { ok: boolean; reason?: string } {
  const parsed = progressInputSchema.parse(input);
  const ok = taskManager.updateProgress(ctx.taskId, parsed.text);
  if (!ok) {
    log(`[finny_progress] dropped: task=${ctx.taskId} reason=task_missing_or_terminal`);
    return { ok: false, reason: 'task_missing_or_terminal' };
  }
  log(`[finny_progress] task=${ctx.taskId} text="${parsed.text.slice(0, 80)}"`);
  return { ok: true };
}

export const progressTool = {
  name: 'finny_progress' as const,
  description:
    'Internal-only. Finny calls this during long execute phases (>10s expected) to emit a short stage string (≤500 chars) like "querying NetSuite", "applying sign conventions". Cowork does NOT see this tool; the bridge intercepts and writes to the task record.',
  inputSchema: progressInputSchema,
  handler: async (_input: ProgressInput) => {
    log('[finny_progress] direct handler hit (unexpected — should be routed)');
    return { ok: false, reason: 'direct_invocation_unsupported' };
  },
};

/**
 * OpenAI function-calling shape of finny_progress, suitable for the
 * `tools` array in /v1/chat/completions. Used by the bridge's tool-call
 * dispatcher (see toolDispatcher.ts). NOT exposed on the cowork-facing
 * MCP surface. The `parameters` schema is derived from progressInputSchema
 * so it stays in sync with the runtime validator.
 */
export const progressOpenAIToolSpec = {
  type: 'function' as const,
  function: {
    name: 'finny_progress',
    description:
      'Emit a short stage string (≤500 chars) describing what you are currently doing. ' +
      'Call this at phase boundaries during long execute phases (e.g. "resolving entity", ' +
      '"querying NetSuite", "applying sign conventions"). The bridge writes the string to ' +
      'the in-flight task record so the client cowork agent can render live progress to the user.',
    parameters: zodToJsonSchema(progressInputSchema, {
      target: 'jsonSchema7',
      $refStrategy: 'none',
    }),
  },
};
