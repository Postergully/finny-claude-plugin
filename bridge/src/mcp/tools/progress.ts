/**
 * lolly_progress: internal tool Lolly calls during long execute phases
 * to emit a stage string. The bridge intercepts these calls server-side
 * and writes the string to the current in-flight task record. Cowork
 * does NOT see this tool — it's not registered in tools-registration.ts
 * ALL_TOOLS array. Routed only via the gateway's tool-call dispatch.
 *
 * Track S of post-smoke fixes (spec
 * docs/superpowers/specs/2026-05-15-post-smoke-fixes.md).
 */

import { z } from 'zod';
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
    log(`[lolly_progress] dropped: task=${ctx.taskId} reason=task_missing_or_terminal`);
    return { ok: false, reason: 'task_missing_or_terminal' };
  }
  log(`[lolly_progress] task=${ctx.taskId} text="${parsed.text.slice(0, 80)}"`);
  return { ok: true };
}

export const progressTool = {
  name: 'lolly_progress' as const,
  description:
    'Internal-only. Lolly calls this during long execute phases (>10s expected) to emit a short stage string (≤500 chars) like "querying NetSuite", "applying sign conventions". Cowork does NOT see this tool; the bridge intercepts and writes to the task record.',
  inputSchema: progressInputSchema,
  handler: async (_input: ProgressInput) => {
    log('[lolly_progress] direct handler hit (unexpected — should be routed)');
    return { ok: false, reason: 'direct_invocation_unsupported' };
  },
};
