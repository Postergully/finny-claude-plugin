// Background task worker + await-helper shared by lolly_query and
// (future Task 4) lolly_report. Singleton, lazy-started on first call.
//
// Design notes:
// - 50ms idle poll is pragmatic — chat tasks are seconds to minutes,
//   50ms of idle noise is irrelevant. No heavier queue abstraction (YAGNI).
// - Worker process-lifetime bound; no graceful shutdown needed for M3.
// - `awaitTaskOrEscalate` is the extracted wait-loop both lolly_query and
//   lolly_report (Task 4) will call with different deadline policies.

import { taskManager } from '../../tasks/manager.js';
import { runQuery, type RunQueryParams } from './chatPipeline.js';
import { runningEnvelope, errorEnvelope } from './envelopeBuilders.js';
import type { LollyEnvelope } from '../../../types/envelope.js';
import { log } from '../../../utils/logger.js';

let workerRunning = false;

/**
 * Start the background drain loop exactly once per process. Safe to call
 * repeatedly — subsequent calls are no-ops.
 */
export function ensureTaskWorker(): void {
  if (workerRunning) return;
  workerRunning = true;
  void drain();
}

async function drain(): Promise<void> {
  for (;;) {
    const task = taskManager.getNextPending();
    if (!task) {
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    taskManager.updateStatus(task.id, 'running');
    try {
      const result = await runQuery(task.input as RunQueryParams);
      taskManager.updateStatus(task.id, 'completed', JSON.stringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Task ${task.id} failed: ${message}`);
      taskManager.updateStatus(task.id, 'failed', undefined, message);
    }
  }
}

/**
 * Poll a task up to `deadlineMs`. If it completes within the window, return
 * the stored envelope (or a mapped error envelope for failed tasks). If the
 * deadline elapses with the task still pending/running, return a
 * `status: 'running'` envelope carrying `data.value.task_id` so cowork can
 * resume via `lolly_task_status`.
 */
export async function awaitTaskOrEscalate(
  taskId: string,
  deadlineMs: number,
  envUsed: 'sandbox' | 'production',
  sessionId: string,
  intentRestated: string
): Promise<LollyEnvelope> {
  const startWait = Date.now();
  while (Date.now() - startWait < deadlineMs) {
    const t = taskManager.get(taskId);
    if (!t) {
      return errorEnvelope({
        code: 'internal',
        message: `Task ${taskId} vanished before completion`,
        retryable: false,
        elapsedMs: Date.now() - startWait,
        envUsed,
        sessionId,
        intentRestated,
      });
    }
    if (t.status === 'completed' && t.result) {
      try {
        return JSON.parse(t.result) as LollyEnvelope;
      } catch (err) {
        return errorEnvelope({
          code: 'internal',
          message: `Failed to parse stored task envelope: ${err instanceof Error ? err.message : String(err)}`,
          retryable: false,
          elapsedMs: Date.now() - startWait,
          envUsed,
          sessionId,
          intentRestated,
        });
      }
    }
    if (t.status === 'failed') {
      return errorEnvelope({
        code: 'internal',
        message: t.error ?? 'Task failed with no error message',
        retryable: true,
        elapsedMs: Date.now() - startWait,
        envUsed,
        sessionId,
        intentRestated,
      });
    }
    if (t.status === 'cancelled') {
      return errorEnvelope({
        code: 'refused',
        message: 'Task was cancelled',
        retryable: false,
        elapsedMs: Date.now() - startWait,
        envUsed,
        sessionId,
        intentRestated,
      });
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  // Deadline elapsed — escalate to running envelope.
  return runningEnvelope({
    intentRestated,
    taskId,
    elapsedMs: Date.now() - startWait,
    envUsed,
    sessionId,
    deadlineExceededMs: deadlineMs,
  });
}
