// Shared envelope builders for error / running / refused shapes.
//
// Extracted ahead of schedule (M3 Self-Review) so Task 2's async
// rewrite can emit `runningEnvelope` without duplicating shape logic.
// Tasks 3 (taskStatus), 4 (report), 5 (executeSuiteQL) also consume.

import type { LollyEnvelope } from '../../../types/envelope.js';

const BRIDGE_VERSION = '0.0.1';

export type InfraErrorCode =
  | 'envelope_parse_failed'
  | 'gateway_rejected'
  | 'gateway_unreachable'
  | 'timeout'
  | 'unauthorized'
  | 'refused'
  | 'internal'
  | 'wrong_tool'
  | 'other';

export interface ErrorEnvelopeParams {
  code: InfraErrorCode;
  message: string;
  retryable: boolean;
  elapsedMs: number;
  envUsed: 'sandbox' | 'production';
  sessionId: string;
  intentRestated?: string;
}

export function errorEnvelope(params: ErrorEnvelopeParams): LollyEnvelope {
  return {
    status: 'error',
    intent_restated: params.intentRestated ?? 'unable to process query',
    assumptions: [],
    unanswered: [],
    data: null,
    sources: [],
    confidence: 'low',
    confidence_reason: params.message.slice(0, 200),
    error: {
      code: params.code,
      message: params.message,
      retryable: params.retryable,
    },
    elapsed_ms: params.elapsedMs,
    env_used: params.envUsed,
    bridge_version: BRIDGE_VERSION,
    lolly_session_id: params.sessionId,
  };
}

export interface RunningEnvelopeParams {
  intentRestated: string;
  taskId: string;
  elapsedMs: number;
  envUsed: 'sandbox' | 'production';
  sessionId: string;
  deadlineExceededMs?: number;
  // Track S: latest progress string from the in-flight task (if any).
  // Surfaced on the running envelope so cowork can render
  // "Lolly is: <progress>" between polls. Optional; when absent the
  // judging-output skill leaves the user-visible status unchanged.
  progress?: string;
}

/**
 * Emit an envelope with `status: 'running'`. The canonical `task_id` lives
 * in `data.value.task_id` (per §2.4 design — `lolly_task_status` reads it
 * from there). We also populate the pre-existing top-level `task_id` field
 * because `LollyEnvelopeSchema.superRefine` requires it when
 * `status === 'running'`. Both point at the same value; `data.value` is
 * the contract-authoritative location, top-level is validation plumbing.
 */
export function runningEnvelope(params: RunningEnvelopeParams): LollyEnvelope {
  return {
    status: 'running',
    intent_restated: params.intentRestated,
    assumptions: [],
    unanswered: [],
    // `data.value` carries the task_id as a plain string — this is the
    // contract-authoritative slot (§2.4). `rendered_markdown` carries the
    // auxiliary `deadline_exceeded_ms` as JSON so downstream judges get
    // both without breaking DataScalar's `string | number` schema.
    data: {
      shape: 'scalar',
      value: params.taskId,
      rendered_markdown: JSON.stringify({
        task_id: params.taskId,
        deadline_exceeded_ms: params.deadlineExceededMs ?? params.elapsedMs,
      }),
    },
    sources: [],
    confidence: 'low',
    confidence_reason: 'Task still running — poll with lolly_task_status using data.value.task_id',
    task_id: params.taskId,
    ...(params.progress ? { progress: params.progress } : {}),
    elapsed_ms: params.elapsedMs,
    env_used: params.envUsed,
    bridge_version: BRIDGE_VERSION,
    lolly_session_id: params.sessionId,
  };
}

export interface RefusedEnvelopeParams {
  intentRestated: string;
  reason: string;
  elapsedMs: number;
  envUsed: 'sandbox' | 'production';
  sessionId: string;
  /**
   * Optional confidence override. Default `'low'` fits refusals that may be
   * probabilistic (Lolly herself refusing). Bridge-side deterministic guards
   * (SuiteQL write-verb, destructive-intent) should pass `'high'` — the
   * decision is made by a regex on the caller's input, not by any
   * probabilistic layer, so the judge should trust it absolutely and not
   * retry.
   */
  confidence?: 'low' | 'medium' | 'high';
}

export function refusedEnvelope(params: RefusedEnvelopeParams): LollyEnvelope {
  return {
    status: 'refused',
    intent_restated: params.intentRestated,
    assumptions: [],
    unanswered: [],
    data: null,
    sources: [],
    confidence: params.confidence ?? 'low',
    confidence_reason: params.reason.slice(0, 200),
    elapsed_ms: params.elapsedMs,
    env_used: params.envUsed,
    bridge_version: BRIDGE_VERSION,
    lolly_session_id: params.sessionId,
  };
}
