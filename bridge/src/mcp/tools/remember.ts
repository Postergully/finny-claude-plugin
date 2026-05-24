// Track L: finny_remember — persists a synthesis or note into Finny's
// workspace memory by forwarding to her agent layer with a "remember"
// system prompt. The bridge validates and forwards; Finny's existing
// memory writer + 11mirror writeback handles the actual persistence.
//
// Read-only contract preserved for the other 4 public tools — this is
// the only write-style tool the bridge exposes, and the write path is
// inside Finny (workspace memory), not against NetSuite.

import { z } from 'zod';

import type { FinnyEnvelope } from '../../types/envelope.js';
import { HermesClient } from '../../hermes/client.js';
import { DEFAULT_FINNY_UPSTREAM_URL, DEFAULT_MODEL } from '../../config/constants.js';
import { buildRememberSystemPrompt } from './_shared/systemPrompt.js';
import { errorEnvelope } from './_shared/envelopeBuilders.js';
import { getOrCreateSession } from './_shared/sessionStore.js';
import { classifyError } from './_shared/classifyError.js';
import { logGatewayCall } from './_shared/gatewayLog.js';

const BRIDGE_VERSION = '0.0.1';

// ~2000 token approximation: ~4 chars/token → ~8000 chars.
const MAX_CONTENT_CHARS = 8000;

export const rememberInputSchema = z.object({
  content: z.string().min(1).max(MAX_CONTENT_CHARS),
  tags: z.array(z.string()).default([]),
  source: z.enum(['cowork', 'manual']),
});

export type RememberInput = z.infer<typeof rememberInputSchema>;

function getGatewayUrl(): string {
  return process.env.FINNY_UPSTREAM_URL || DEFAULT_FINNY_UPSTREAM_URL;
}

function getGatewayToken(): string | undefined {
  return process.env.FINNY_GATEWAY_TOKEN || process.env.FINNY_UPSTREAM_TOKEN;
}

function getModel(): string {
  return process.env.FINNY_MODEL || DEFAULT_MODEL;
}

async function handler(rawInput: RememberInput): Promise<FinnyEnvelope> {
  const input = rememberInputSchema.parse(rawInput);

  const sessionPrincipal = `remember-${input.source}:production`;
  const sessionId = getOrCreateSession(sessionPrincipal);
  const started = Date.now();

  const systemPrompt = buildRememberSystemPrompt({
    content: input.content,
    tags: input.tags,
    source: input.source,
  });

  const url = getGatewayUrl();
  const token = getGatewayToken();
  const model = getModel();
  const deadlineMs = 60_000;
  const client = new HermesClient(url, token, deadlineMs, model);

  const combined = `${systemPrompt}\n\n---\n\n${input.content}`;
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

  try {
    const result = await client.chat(combined, sessionId);
    const latencyMs = Date.now() - started;
    logGatewayCall(reqShape, {
      status: 200,
      latency_ms: latencyMs,
      response_chars: result.response.length,
    });

    // The bridge owns the success envelope shape for remember — we don't
    // need to parse Finny's response or trust her envelope. Finny's job
    // is to persist; the bridge synthesizes the ok confirmation. This
    // mirrors the spec §5.4 contract: data.shape: 'scalar', value: 'ok'.
    return {
      status: 'ok',
      intent_restated: `Persist note (source: ${input.source}, tags: ${input.tags.join(',') || '(none)'})`,
      assumptions: [],
      unanswered: [],
      data: { shape: 'scalar', value: 'ok' },
      sources: [],
      confidence: 'high',
      confidence_reason:
        'Forwarded to Finny with remember system prompt; persistence handled by her memory writer.',
      elapsed_ms: latencyMs,
      env_used: 'production',
      bridge_version: BRIDGE_VERSION,
      finny_session_id: sessionId,
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    const maybeStatus = (err as { status?: number } | undefined)?.status ?? 0;
    logGatewayCall(reqShape, {
      status: maybeStatus,
      latency_ms: latencyMs,
      error: message.slice(0, 512),
    });
    const { retryable } = classifyError(err);
    return errorEnvelope({
      code: 'internal',
      message,
      retryable,
      elapsedMs: latencyMs,
      envUsed: 'production',
      sessionId,
      intentRestated: 'finny_remember',
    });
  }
}

export const rememberTool = {
  name: 'finny_remember' as const,
  description:
    "Persist a synthesis or note into Finny's memory. Bridge forwards to Finny's agent layer with a remember system prompt; Finny's existing memory writer handles workspace memory + 11mirror writeback. Use for daily day_dream digests or operator-driven notes. Input: { content (≤2000 token approx, ~8000 chars), tags (recommended: ['day_dream', 'YYYY-MM-DD']), source ('cowork' | 'manual') }.",
  inputSchema: rememberInputSchema,
  handler,
};
