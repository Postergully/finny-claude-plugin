import { OpenClawConnectionError, OpenClawApiError } from '../utils/errors.js';
import { logDebug, isDebugEnabled } from '../utils/logger.js';
import type {
  OpenClawHealthResponse,
  OpenClawChatResponse,
  OpenAIChatCompletionResponse,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_DEBUG_BODY_LENGTH = 4096;

/**
 * Pluggable token source. Default reads process.env.OPENCLAW_GATEWAY_TOKEN.
 * Production deployments can wire this to read from a mounted secret file
 * (e.g. /var/lib/lolly/secrets/gateway-token) without changing the client.
 */
export type TokenProvider = () => string | undefined;

const defaultTokenProvider: TokenProvider = () => process.env.OPENCLAW_GATEWAY_TOKEN;

export class OpenClawClient {
  private baseUrl: string;
  private gatewayToken: string | undefined;
  private timeoutMs: number;
  private model: string;
  private tokenProvider: TokenProvider;

  constructor(
    baseUrl: string,
    gatewayToken?: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    model: string = 'openclaw',
    tokenProvider?: TokenProvider
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.gatewayToken = gatewayToken;
    this.timeoutMs = timeoutMs;
    this.model = model;
    this.tokenProvider = tokenProvider ?? defaultTokenProvider;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.gatewayToken) {
      headers['Authorization'] = `Bearer ${this.gatewayToken}`;
    }
    return headers;
  }

  private truncateForLog(value: string): string {
    if (value.length <= MAX_DEBUG_BODY_LENGTH) return value;
    return value.slice(0, MAX_DEBUG_BODY_LENGTH) + `... (truncated, ${value.length} chars total)`;
  }

  /**
   * Issue a fetch with bearer auth and retry-once-on-401/403 semantics.
   *
   * Retry rationale (idempotency-safe even for POST):
   * A 401/403 from the gateway means the request was REJECTED at the auth
   * boundary before any side effect on the agent. Re-sending the same body
   * with a refreshed token is therefore safe even for non-idempotent methods.
   * We retry exactly once — no exponential storms (see findings doc F16).
   *
   * Token refresh: invokes the configured tokenProvider (default: re-read
   * process.env.OPENCLAW_GATEWAY_TOKEN). Production wires this to a file-
   * backed provider so rotated gateway tokens are picked up without restart.
   *
   * Known limits (deliberately deferred — track as P1 follow-ups):
   *  - Concurrent-401 race: N in-flight requests during rotation each refresh
   *    independently and write the same value to gatewayToken. Idempotent and
   *    bounded; fix is single-flight Promise-coalescing if production logs show
   *    refresh-storms under burst load.
   *  - Shared timeout budget: caller's AbortController spans both attempts. A
   *    401 near the deadline leaves little budget for the retry. Theoretical
   *    (401s return fast); fix is per-attempt timers if "retry timed out"
   *    appears in production.
   */
  private async fetchWithAuthRetry(url: string, init: RequestInit): Promise<Response> {
    const buildInit = (): RequestInit => ({
      ...init,
      headers: {
        ...this.buildHeaders(),
        ...((init.headers as Record<string, string>) || {}),
      },
    });

    const response = await fetch(url, buildInit());

    if (response.status !== 401 && response.status !== 403) {
      return response;
    }

    // Try to refresh the token from the configured provider.
    const refreshed = this.tokenProvider();
    if (!refreshed) {
      logDebug(
        () => `Auth ${response.status} from ${url}; tokenProvider returned no token, not retrying`
      );
      return response;
    }

    // If the refreshed token is identical to the current one, retry would be
    // pointless — surface the original error.
    if (refreshed === this.gatewayToken) {
      logDebug(
        () => `Auth ${response.status} from ${url}; refreshed token unchanged, not retrying`
      );
      return response;
    }

    logDebug(
      () =>
        `Auth ${response.status} from ${url}; refreshing gateway token and retrying once (token-rotation event)`
    );
    this.gatewayToken = refreshed;

    return fetch(url, buildInit());
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    logDebug(() => `Request: ${options.method ?? 'GET'} ${url}`);
    if (options.body) {
      logDebug(() => `Request body: ${this.truncateForLog(options.body as string)}`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchWithAuthRetry(url, {
        ...options,
        signal: controller.signal,
      });

      if (!response.ok) {
        if (isDebugEnabled()) {
          const contentLength = response.headers.get('content-length');
          if (!contentLength || parseInt(contentLength, 10) <= MAX_RESPONSE_SIZE_BYTES) {
            const errorBody = await response.text();
            if (errorBody.length <= MAX_RESPONSE_SIZE_BYTES) {
              logDebug(
                () => `Response error (${response.status}): ${this.truncateForLog(errorBody)}`
              );
            }
          }
        }
        throw new OpenClawApiError(
          `API request failed: ${response.status} ${response.statusText}`,
          response.status
        );
      }

      logDebug(() => `Response: ${response.status} ${response.statusText}`);

      // Validate response size before consuming the body
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE_BYTES) {
        throw new OpenClawApiError('Response exceeds maximum allowed size (10MB)', 413);
      }

      const text = await response.text();
      if (text.length > MAX_RESPONSE_SIZE_BYTES) {
        throw new OpenClawApiError('Response exceeds maximum allowed size (10MB)', 413);
      }

      return JSON.parse(text) as T;
    } catch (error) {
      if (error instanceof OpenClawApiError) {
        throw error;
      }
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new OpenClawConnectionError(
          `Request to OpenClaw timed out after ${this.timeoutMs}ms`
        );
      }
      throw new OpenClawConnectionError(
        `Failed to connect to OpenClaw at ${this.baseUrl}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Single-shot readiness probe used by the bridge's GET /ready endpoint.
   *
   * Hits HEAD /v1/models with a 1-second timeout. /v1/models exists only
   * when gateway.http.endpoints.chatCompletions.enabled is true, so a
   * 200 or 401 from this path proves both layers we tripped on in D4/D11:
   * (a) tunnel delivers bytes; (b) gateway's chat endpoint is configured.
   *
   * Returns ok=true on 2xx OR 401 (401 = listener exists, just rejecting
   * our auth — readiness for routing purposes is satisfied).
   */
  async probeReady(timeoutMs = 1000): Promise<{
    ok: boolean;
    latencyMs: number;
    upstreamStatus?: number;
    error?: 'timeout' | 'connection_refused' | 'fetch_error' | 'upstream_error';
  }> {
    const start = Date.now();
    const headers: Record<string, string> = {};
    if (this.gatewayToken) {
      headers['Authorization'] = `Bearer ${this.gatewayToken}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        method: 'HEAD',
        headers,
        signal: controller.signal,
      });
      const latencyMs = Date.now() - start;
      if (res.ok || res.status === 401) {
        return { ok: true, latencyMs, upstreamStatus: res.status };
      }
      return { ok: false, latencyMs, upstreamStatus: res.status, error: 'upstream_error' };
    } catch (e) {
      const latencyMs = Date.now() - start;
      if (e instanceof DOMException && e.name === 'AbortError') {
        return { ok: false, latencyMs, error: 'timeout' };
      }
      const err = e as { cause?: { code?: string } };
      const error: 'connection_refused' | 'fetch_error' =
        err?.cause?.code === 'ECONNREFUSED' ? 'connection_refused' : 'fetch_error';
      return { ok: false, latencyMs, error };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Check gateway health by sending a minimal chat completion request.
   * A 400 Bad Request means the gateway is alive (it parsed JSON, rejected input).
   * A successful response also means healthy.
   * Connection errors mean the gateway is down.
   */
  async health(): Promise<OpenClawHealthResponse> {
    const url = `${this.baseUrl}/v1/chat/completions`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchWithAuthRetry(url, {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          model: 'health-check',
          messages: [],
          max_tokens: 1,
        }),
      });

      // Both 200 and 400 mean the gateway is alive and processing requests
      if (response.status >= 200 && response.status < 500) {
        return { status: 'ok', message: `Gateway responding (HTTP ${response.status})` };
      }

      return { status: 'error', message: `Gateway error (HTTP ${response.status})` };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new OpenClawConnectionError(
          `Request to OpenClaw timed out after ${this.timeoutMs}ms`
        );
      }
      throw new OpenClawConnectionError(
        `Failed to connect to OpenClaw at ${this.baseUrl}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Send a chat message via the OpenAI-compatible /v1/chat/completions endpoint.
   */
  async chat(message: string, sessionId?: string): Promise<OpenClawChatResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [{ role: 'user', content: message }],
      max_tokens: 4096,
    };

    if (sessionId) {
      body.session_id = sessionId;
    }

    const headers: Record<string, string> = {};
    if (sessionId) {
      headers['x-openclaw-session-key'] = sessionId;
    }

    const completion = await this.request<OpenAIChatCompletionResponse>('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify(body),
      headers,
    });

    const content = completion.choices?.[0]?.message?.content ?? '';

    return {
      response: content,
      model: completion.model,
      usage: completion.usage,
    };
  }
}
