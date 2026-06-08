// Chat + parse + correction-retry pipeline, extracted from M2's sync
// finny_query handler. Consumed by:
//   - `finny_query` (post-M3 async wrapper)
//   - The background task worker (drains taskManager pending chat tasks)
//   - `finny_report` (M3 Task 4, delegates preamble→runQuery)
//
// Keep `chat()` module-local; only `runQuery` is exported.

import { HermesClient } from '../../../hermes/client.js';
import { FinnyEnvelopeSchema, type FinnyEnvelope } from '../../../types/envelope.js';
import { DEFAULT_FINNY_UPSTREAM_URL, DEFAULT_MODEL } from '../../../config/constants.js';
import type { BlessListEntry } from '../../../intents/types.js';
import { buildQuerySystemPrompt } from './systemPrompt.js';
import { extractEnvelopeJSON, buildCorrectionPrompt } from './parseEnvelope.js';
import {
  logGatewayCall,
  logGatewayQueryAggregate,
  type GatewayDiagnostics,
  type GatewayQueryAggregate,
} from './gatewayLog.js';
import { getOrCreateSession, getSessionCreationCount } from './sessionStore.js';
import { errorEnvelope } from './envelopeBuilders.js';
import { classifyError } from './classifyError.js';
import { createConversation } from './conversationStore.js';
import { log } from '../../../utils/logger.js';
import { runChatWithTools } from './toolDispatcher.js';

const BRIDGE_VERSION = '0.0.1';

export interface RunQueryParams {
  question: string;
  expected_shape?: 'scalar' | 'rows' | 'narrative';
  entity_hints?: {
    vendor_id?: string;
    vendor_name?: string;
    period?: { from?: string; to?: string };
    env?: 'sandbox' | 'production';
    gstin?: string;
  };
  sessionPrincipal: string; // e.g. 'm2-default:production'
  deadlineMs: number;
  // Two-phase intent fields. Absence of `intent_string` (and `phase`) means
  // the legacy free-form path. `blessed` is populated when intent_string
  // matches a bless-list entry (or alias).
  intent_string?: string;
  blessed?: BlessListEntry;
  phase?: 'discover' | 'execute' | 'free_form';
  scope?: Record<string, unknown>;
  clarifications_resolved?: string[];
  /**
   * Track S: identifies the in-flight task record so the tool-call
   * dispatcher (see toolDispatcher.ts) can route finny_progress tool_calls
   * to taskManager.updateProgress(taskId, text). Set by the background
   * worker when draining a queued task; undefined on the synchronous
   * fast-path where progress dispatch is a no-op.
   */
  taskId?: string;
}

function getGatewayUrl(): string {
  return process.env.FINNY_UPSTREAM_URL || DEFAULT_FINNY_UPSTREAM_URL;
}

function getGatewayToken(): string | undefined {
  return process.env.FINNY_GATEWAY_TOKEN || process.env.FINNY_UPSTREAM_TOKEN;
}

function getModel(): string {
  return process.env.FINNY_MODEL || DEFAULT_MODEL;
}

async function chat(params: {
  systemPrompt: string;
  userMessage: string;
  sessionId: string;
  deadlineMs: number;
  taskId: string | undefined;
  diagnostics: GatewayDiagnostics;
}): Promise<{ content: string; latencyMs: number }> {
  const url = getGatewayUrl();
  const token = getGatewayToken();
  const model = getModel();
  const client = new HermesClient(url, token, params.deadlineMs, model);

  const started = Date.now();
  const reqShape = {
    method: 'POST',
    url: `${url}/v1/chat/completions`,
    body_shape: {
      model,
      messages_count: 2, // system + user (tool turns expand from there)
      max_tokens: 4096,
      has_session: true,
      tools: ['finny_progress'],
    },
  };

  try {
    const result = await runChatWithTools({
      client,
      systemPrompt: params.systemPrompt,
      userMessage: params.userMessage,
      sessionId: params.sessionId,
      taskId: params.taskId,
    });
    const latencyMs = Date.now() - started;
    // NOTE: when taskId triggers finny_progress round-trips, latency_ms and response_chars aggregate across all dispatcher iterations (≤MAX_LOOPS); messages_count:2 reflects the initial request only.
    logGatewayCall(
      reqShape,
      {
        status: 200,
        latency_ms: latencyMs,
        response_chars: result.content.length,
      },
      params.diagnostics
    );
    return { content: result.content, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    const maybeStatus = (err as { status?: number } | undefined)?.status ?? 0;
    logGatewayCall(
      reqShape,
      {
        status: maybeStatus,
        latency_ms: latencyMs,
        error: message.slice(0, 512),
      },
      params.diagnostics
    );
    throw err;
  }
}

export async function runQuery(params: RunQueryParams): Promise<FinnyEnvelope> {
  const envUsed: 'sandbox' | 'production' = params.entity_hints?.env ?? 'production';
  const started = Date.now();
  const beforeSessionCount = getSessionCreationCount();
  const sessionId = getOrCreateSession(params.sessionPrincipal);
  const sessionWasJustCreated = getSessionCreationCount() > beforeSessionCount;

  const phases: GatewayQueryAggregate['phases'] = {
    initial: { calls: 0, latency_ms: 0 },
    correction: { calls: 0, latency_ms: 0 },
    progress_loop: { calls: 0, latency_ms: 0 },
  };

  const callChat = async (
    phase: 'initial' | 'correction',
    args: { systemPrompt: string; userMessage: string }
  ) => {
    const isCorrection = phase === 'correction';
    const started = Date.now();
    phases[phase].calls += 1;
    try {
      const result = await chat({
        systemPrompt: args.systemPrompt,
        userMessage: args.userMessage,
        sessionId,
        deadlineMs: params.deadlineMs,
        taskId: params.taskId,
        diagnostics: {
          session_id: sessionId,
          session_created: phase === 'initial' ? sessionWasJustCreated : false,
          correction_retry: isCorrection,
          tool_loop_iter: 0,
        },
      });
      phases[phase].latency_ms += result.latencyMs;
      return result;
    } catch (err) {
      phases[phase].latency_ms += Date.now() - started;
      throw err;
    }
  };

  try {
    const phase: 'discover' | 'execute' | 'free_form' =
      params.phase ?? (params.intent_string ? 'execute' : 'free_form');

    const systemPrompt = buildQuerySystemPrompt({
      expected_shape: params.expected_shape ?? 'narrative',
      phase,
      intent_string: params.intent_string,
      blessed: params.blessed,
      scope: params.scope,
      clarifications_resolved: params.clarifications_resolved,
      user_question: params.question,
    });

    let rawFirst: string;
    try {
      const first = await callChat('initial', {
        systemPrompt,
        userMessage: params.question,
      });
      rawFirst = first.content;
    } catch (err) {
      const { code, retryable } = classifyError(err);
      return errorEnvelope({
        code,
        message: err instanceof Error ? err.message : String(err),
        retryable,
        elapsedMs: Date.now() - started,
        envUsed,
        sessionId,
      });
    }

    // First-pass parse
    const parsedFirst = extractEnvelopeJSON(rawFirst);
    if (parsedFirst !== null) {
      const validation = FinnyEnvelopeSchema.safeParse({
        ...(parsedFirst as object),
        elapsed_ms: Date.now() - started,
        env_used: envUsed,
        bridge_version: BRIDGE_VERSION,
        finny_session_id: sessionId,
      });
      if (validation.success) {
        return finalizeEnvelope(validation.data, params);
      }
      // Fall through to correction retry
      try {
        const correction = await callChat('correction', {
          systemPrompt,
          userMessage: buildCorrectionPrompt(rawFirst, validation.error.issues),
        });
        const parsedSecond = extractEnvelopeJSON(correction.content);
        if (parsedSecond !== null) {
          const validation2 = FinnyEnvelopeSchema.safeParse({
            ...(parsedSecond as object),
            elapsed_ms: Date.now() - started,
            env_used: envUsed,
            bridge_version: BRIDGE_VERSION,
            finny_session_id: sessionId,
          });
          if (validation2.success) return finalizeEnvelope(validation2.data, params);
          return errorEnvelope({
            code: 'envelope_parse_failed',
            message: `Correction retry still invalid: ${validation2.error.issues[0]?.message ?? 'unknown'}`,
            retryable: false,
            elapsedMs: Date.now() - started,
            envUsed,
            sessionId,
          });
        }
      } catch (err) {
        const { code, retryable } = classifyError(err);
        return errorEnvelope({
          code,
          message: err instanceof Error ? err.message : String(err),
          retryable,
          elapsedMs: Date.now() - started,
          envUsed,
          sessionId,
        });
      }
      return errorEnvelope({
        code: 'envelope_parse_failed',
        message: 'Correction retry did not contain extractable JSON',
        retryable: false,
        elapsedMs: Date.now() - started,
        envUsed,
        sessionId,
      });
    }

    // First pass failed to extract JSON at all — try correction once.
    try {
      const correction = await callChat('correction', {
        systemPrompt,
        userMessage: buildCorrectionPrompt(
          rawFirst,
          'Response did not contain a valid JSON envelope.'
        ),
      });
      const parsedSecond = extractEnvelopeJSON(correction.content);
      if (parsedSecond !== null) {
        const validation = FinnyEnvelopeSchema.safeParse({
          ...(parsedSecond as object),
          elapsed_ms: Date.now() - started,
          env_used: envUsed,
          bridge_version: BRIDGE_VERSION,
          finny_session_id: sessionId,
        });
        if (validation.success) return finalizeEnvelope(validation.data, params);
        return errorEnvelope({
          code: 'envelope_parse_failed',
          message: `Correction retry still invalid: ${validation.error.issues[0]?.message ?? 'unknown'}`,
          retryable: false,
          elapsedMs: Date.now() - started,
          envUsed,
          sessionId,
        });
      }
    } catch (err) {
      const { code, retryable } = classifyError(err);
      return errorEnvelope({
        code,
        message: err instanceof Error ? err.message : String(err),
        retryable,
        elapsedMs: Date.now() - started,
        envUsed,
        sessionId,
      });
    }

    return errorEnvelope({
      code: 'envelope_parse_failed',
      message: 'Neither initial response nor correction retry produced a valid envelope',
      retryable: false,
      elapsedMs: Date.now() - started,
      envUsed,
      sessionId,
    });
  } finally {
    logGatewayQueryAggregate({
      session_id: sessionId,
      total_calls:
        phases.initial.calls + phases.correction.calls + phases.progress_loop.calls,
      total_latency_ms:
        phases.initial.latency_ms +
        phases.correction.latency_ms +
        phases.progress_loop.latency_ms,
      phases,
    });
  }
}

// When Finny returns status: 'needs_input', the bridge owns the
// conversation lifecycle. Finny may emit needs_input.question (and
// optionally options) but doesn't know the conversation_id or round —
// those are the bridge's bookkeeping. This helper allocates a
// conversation_id, stores the original RunQuery context, and patches
// the envelope so cowork can immediately call finny_continue.
//
// The bridge ALSO accepts envelopes where Finny already filled in a
// conversation_id (defensive — older Finny prompts may include it). In
// that case we still re-key with our own id to keep the store
// authoritative; Finny's id is discarded.
function maybeRegisterNeedsInput(env: FinnyEnvelope, params: RunQueryParams): FinnyEnvelope {
  if (env.status !== 'needs_input' || !env.needs_input) return env;

  const conversationId = createConversation({
    intent_string: params.intent_string,
    blessed: params.blessed,
    user_question: params.question,
    expected_shape: params.expected_shape ?? 'narrative',
    scope: params.scope,
    clarifications_resolved: params.clarifications_resolved ?? [],
    sessionPrincipal: params.sessionPrincipal,
  });

  return {
    ...env,
    needs_input: {
      ...env.needs_input,
      conversation_id: conversationId,
      round: 1,
    },
  };
}

// Track G: Discover phase violation detection.
//
// When Finny probes NetSuite during phase: 'discover' (despite the prompt
// telling her not to), the symptom is sources[] entries with kind 'suiteql'
// or 'rest'. Brain reads have kind 'memory' or 'skill', so non-brain
// sources during discover = a real violation. We log to the bridge log and
// annotate confidence_reason — we do NOT strip the sources or reject the
// envelope, because (a) doing so could hide useful data Finny already
// produced and (b) the warning lets us measure violation rate via
// access-log analysis and tighten further if needed. See spec §3.3.
function detectDiscoverViolation(env: FinnyEnvelope, params: RunQueryParams): boolean {
  if (params.phase !== 'discover') return false;
  if (!env.sources || env.sources.length === 0) return false;
  return env.sources.some((s) => s.kind === 'suiteql' || s.kind === 'rest');
}

// Single chokepoint for envelope post-processing: discover-violation
// surfacing first, then needs_input registration. Runs at every successful
// validation point in runQuery (initial parse, post-correction parse,
// post-correction-with-no-JSON parse).
function finalizeEnvelope(env: FinnyEnvelope, params: RunQueryParams): FinnyEnvelope {
  if (detectDiscoverViolation(env, params)) {
    const offendingKinds = env.sources
      .filter((s) => s.kind === 'suiteql' || s.kind === 'rest')
      .map((s) => s.kind)
      .join(',');
    log(
      `[discover_violation] intent="${params.intent_string ?? '<none>'}" sources=${offendingKinds} — discover phase ran live NetSuite probes (UX latency penalty)`
    );
    const annotated: FinnyEnvelope = {
      ...env,
      confidence_reason: `${env.confidence_reason} [bridge: discover phase ran live NetSuite queries — see bridge log for discover_violation]`,
    };
    return maybeRegisterNeedsInput(annotated, params);
  }
  return maybeRegisterNeedsInput(env, params);
}

export { maybeRegisterNeedsInput, finalizeEnvelope };
