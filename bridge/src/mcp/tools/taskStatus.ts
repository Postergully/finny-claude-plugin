import { z } from 'zod';
import { taskManager } from '../tasks/manager.js';
import { errorEnvelope, runningEnvelope, refusedEnvelope } from './_shared/envelopeBuilders.js';
import type { FinnyEnvelope } from '../../types/envelope.js';
import {
  derivePrincipal,
  PrincipalError,
  unauthorizedEnvelope,
  type Session,
} from './_shared/principal.js';

export const taskStatusInputSchema = z.object({
  task_id: z.string().min(1),
});

export type TaskStatusInput = z.infer<typeof taskStatusInputSchema>;

export const taskStatusTool = {
  name: 'finny_task_status' as const,
  description:
    'Poll a running Finny task (returned by finny_query or finny_report when deadline_ms was exceeded). Returns the envelope when done, or running status with elapsed_ms.',
  inputSchema: taskStatusInputSchema,
  handler: async (rawInput: TaskStatusInput, session?: Session): Promise<FinnyEnvelope> => {
    const input = taskStatusInputSchema.parse(rawInput);

    // Task 4.3 — identity gate at boundary. No bank check here: this
    // tool only polls task state; it does not fan out to any bank.
    try {
      await derivePrincipal(session);
    } catch (e) {
      if (e instanceof PrincipalError) return unauthorizedEnvelope('finny_task_status');
      throw e;
    }

    const task = taskManager.get(input.task_id);

    if (!task) {
      return errorEnvelope({
        code: 'internal',
        message: `Task not found: ${input.task_id}. Task may have been cleaned up (1h TTL) or never existed.`,
        retryable: false,
        intentRestated: 'Poll task status',
        elapsedMs: 0,
        envUsed: 'production',
        sessionId: 'unknown',
      });
    }

    // Completed → stored envelope is the source of truth. Passthrough verbatim;
    // the worker already stamped elapsed_ms/env_used/etc. when it wrote the
    // result. Re-stamping here would corrupt timings.
    if (task.status === 'completed' && task.result) {
      return JSON.parse(task.result) as FinnyEnvelope;
    }

    const createdMs = task.createdAt.getTime();
    const startedMs = task.startedAt?.getTime();
    const completedMs = task.completedAt?.getTime();

    if (task.status === 'failed') {
      return errorEnvelope({
        code: 'internal',
        message: task.error ?? 'Task failed with no error message',
        retryable: true,
        intentRestated: 'Poll task status',
        elapsedMs: completedMs ? completedMs - createdMs : 0,
        envUsed: 'production',
        sessionId: task.sessionId ?? 'unknown',
      });
    }

    if (task.status === 'cancelled') {
      return refusedEnvelope({
        intentRestated: 'Poll task status',
        reason: 'Task was cancelled',
        elapsedMs: completedMs ? completedMs - createdMs : 0,
        envUsed: 'production',
        sessionId: task.sessionId ?? 'unknown',
      });
    }

    // pending or running
    const elapsedMs = startedMs ? Date.now() - startedMs : Date.now() - createdMs;
    return runningEnvelope({
      intentRestated: 'Poll task status',
      taskId: task.id,
      elapsedMs,
      envUsed: 'production',
      sessionId: task.sessionId ?? 'unknown',
      // Track S: surface latest progress string (set by finny_progress
      // via the bridge dispatcher) so cowork's judging-output skill can
      // render "Finny is: <progress>" while we wait.
      progress: task.progress,
    });
  },
};
