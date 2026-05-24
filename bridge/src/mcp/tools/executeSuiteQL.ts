import { z } from 'zod';
import { OpenClawClient } from '../../openclaw/client.js';
import { LollyEnvelopeSchema, type LollyEnvelope } from '../../types/envelope.js';
import { DEFAULT_OPENCLAW_URL, DEFAULT_MODEL } from '../../config/constants.js';
import { detectWriteVerb, buildSuiteQLPreamble } from './_shared/suiteqlGuard.js';
import { extractEnvelopeJSON } from './_shared/parseEnvelope.js';
import { getOrCreateSession } from './_shared/sessionStore.js';
import { errorEnvelope, refusedEnvelope } from './_shared/envelopeBuilders.js';
import { classifyError } from './_shared/classifyError.js';
import { logGatewayCall } from './_shared/gatewayLog.js';

const BRIDGE_VERSION = '0.0.1';
const SUITEQL_DEADLINE_MS = 60_000;

export const executeSuiteQLInputSchema = z.object({
  sql: z.string().min(1),
  env: z.enum(['sandbox', 'production']),
  max_rows: z.number().int().positive().max(5000).default(500),
  reason: z.string().min(1),
});

export type ExecuteSuiteQLInput = z.infer<typeof executeSuiteQLInputSchema>;

function getGatewayUrl(): string {
  return process.env.OPENCLAW_URL || DEFAULT_OPENCLAW_URL;
}

function getGatewayToken(): string | undefined {
  return process.env.LOLLY_GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN;
}

function getModel(): string {
  return process.env.OPENCLAW_MODEL || DEFAULT_MODEL;
}

async function handler(rawInput: ExecuteSuiteQLInput): Promise<LollyEnvelope> {
  const input = executeSuiteQLInputSchema.parse(rawInput);
  const envUsed = input.env;
  const intentRestated = `Execute SuiteQL: ${input.reason.slice(0, 160)}`;

  // Gate 1 — write-verb guard runs BEFORE any gateway call. Fail closed.
  const writeVerb = detectWriteVerb(input.sql);
  if (writeVerb) {
    return refusedEnvelope({
      intentRestated,
      reason: `SQL contains write verb '${writeVerb}'. Only read-only SuiteQL is supported in lolly_executeSuiteQL. Write operations require a separate governance review.`,
      envUsed,
      sessionId: '—',
      elapsedMs: 0,
      confidence: 'high',
    });
  }

  const principal = `m2-default:${envUsed}`;
  const sessionId = getOrCreateSession(principal);
  const preamble = buildSuiteQLPreamble({
    sql: input.sql,
    env: input.env,
    max_rows: input.max_rows,
    reason: input.reason,
  });
  const started = Date.now();

  const url = getGatewayUrl();
  const token = getGatewayToken();
  const model = getModel();
  const client = new OpenClawClient(url, token, SUITEQL_DEADLINE_MS, model);

  const combined = `${preamble}\n\n---\n\n${input.sql}`;
  const reqShape = {
    method: 'POST',
    url: `${url}/v1/chat/completions`,
    body_shape: {
      model,
      messages_count: 1,
      max_tokens: 4096,
      has_session: true,
    },
  };

  let rawContent: string;
  try {
    const result = await client.chat(combined, sessionId);
    const latencyMs = Date.now() - started;
    logGatewayCall(reqShape, {
      status: 200,
      latency_ms: latencyMs,
      response_chars: result.response.length,
    });
    rawContent = result.response;
  } catch (err) {
    const latencyMs = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    const maybeStatus = (err as { status?: number } | undefined)?.status ?? 0;
    logGatewayCall(reqShape, {
      status: maybeStatus,
      latency_ms: latencyMs,
      error: message.slice(0, 512),
    });
    const { code, retryable } = classifyError(err);
    return errorEnvelope({
      code,
      message,
      retryable,
      elapsedMs: latencyMs,
      envUsed,
      sessionId,
      intentRestated,
    });
  }

  const parsed = extractEnvelopeJSON(rawContent);
  if (parsed === null) {
    return errorEnvelope({
      code: 'envelope_parse_failed',
      message: 'SuiteQL response did not contain extractable JSON envelope',
      retryable: false,
      elapsedMs: Date.now() - started,
      envUsed,
      sessionId,
      intentRestated,
    });
  }

  const validation = LollyEnvelopeSchema.safeParse({
    ...(parsed as object),
    elapsed_ms: Date.now() - started,
    env_used: envUsed,
    bridge_version: BRIDGE_VERSION,
    lolly_session_id: sessionId,
  });
  if (validation.success) {
    return validation.data;
  }
  return errorEnvelope({
    code: 'envelope_parse_failed',
    message: `SuiteQL envelope validation failed: ${
      validation.error.issues[0]?.message ?? 'unknown'
    }`,
    retryable: false,
    elapsedMs: Date.now() - started,
    envUsed,
    sessionId,
    intentRestated,
  });
}

export const executeSuiteQLTool = {
  name: 'lolly_executeSuiteQL' as const,
  description:
    "Execute a read-only SuiteQL statement against Lolly's configured NetSuite environment. Sync path — direct chat call, not async via taskManager (SuiteQL returns in seconds; for minutes-long natural-language questions, use lolly_query). Write verbs (DROP/DELETE/UPDATE/INSERT/ALTER/TRUNCATE/CREATE/GRANT/REVOKE/MERGE/REPLACE) rejected in-bridge before any gateway call.",
  inputSchema: executeSuiteQLInputSchema,
  handler,
};
