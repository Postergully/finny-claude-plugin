# finny_progress Tool Dispatcher — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `finny_progress` as a real, dispatched tool so Finny's stage strings ("querying NetSuite VendBill", "applying sign conventions") flow into the task record and surface on cowork's `running` envelope, replacing the current generic "Still running — polling" UX.

**Architecture:** Use OpenAI-compatible tool-use over the existing `/v1/chat/completions` upstream. The bridge sends a `tools: [finny_progress]` definition with each chat call, runs a multi-turn tool-dispatcher loop that intercepts `finny_progress` tool_calls and routes them to `taskManager.updateProgress(taskId, text)`, then continues until the assistant returns a final envelope. Existing `progress.ts` handler, `taskManager.updateProgress`, and `runningEnvelope.progress` plumbing are already in place — this plan adds the missing dispatcher and prompt instruction.

**Tech Stack:** TypeScript, Node ≥20, ESM, Vitest. OpenAI-compatible chat completions (Hermes gateway). Zod for schema validation. Existing `tsup` build.

---

## File Structure

**Create:**
- `bridge/src/mcp/tools/_shared/toolDispatcher.ts` — multi-turn tool-call loop that wraps `HermesClient.chat()`, owns the `finny_progress` dispatch, and returns the final assistant content.
- `bridge/src/__tests__/mcp/tools/toolDispatcher.test.ts` — unit tests for the dispatcher with a mocked `HermesClient`.
- `bridge/src/__tests__/mcp/tools/progressE2E.test.ts` — end-to-end test: runQuery with a mocked upstream that emits a tool_call, then an envelope; assert task record has the progress string and the running envelope surfaces it.

**Modify:**
- `bridge/src/hermes/client.ts` — extend `chat()` to accept optional `tools` and return `tool_calls`. Support multi-turn `messages[]` input.
- `bridge/src/mcp/tools/_shared/chatPipeline.ts` — replace single `chat()` calls with `runChatWithTools()` from the dispatcher. Plumb `taskId` through `RunQueryParams`.
- `bridge/src/mcp/tools/_shared/taskWorker.ts` — pass `taskId` into `runQuery` params when draining a queued task.
- `bridge/src/mcp/tools/_shared/systemPrompt.ts` — add the `finny_progress` emit instruction (replace the deferred-feature comment).
- `bridge/src/mcp/tools/progress.ts` — export the OpenAI tool-spec form of `finny_progress` for the dispatcher.

**Untouched (already correct):**
- `bridge/src/mcp/tools/taskStatus.ts` — already surfaces `progress` on the running envelope.
- `bridge/src/mcp/tasks/manager.ts` — already has `updateProgress`.
- `bridge/src/mcp/tools/_shared/envelopeBuilders.ts` — `runningEnvelope` already accepts `progress`.
- `plugin/skills/judging-output/SKILL.md` — already documents how to render `progress` from polls.

---

## Task 1: Plumb `taskId` through `RunQueryParams`

**Why:** The dispatcher needs to know which task record to write progress to. `runQuery` is called from two places: synchronously by `finny_query`/`finny_report` handlers (no taskId — short queries that return before escalation) and from the background worker (taskId known). When taskId is absent, progress dispatch is a no-op.

**Files:**
- Modify: `bridge/src/mcp/tools/_shared/chatPipeline.ts:26-46` (RunQueryParams)
- Modify: `bridge/src/mcp/tools/_shared/taskWorker.ts:35-45` (worker passes taskId)

- [ ] **Step 1: Add `taskId` to `RunQueryParams` interface**

In `bridge/src/mcp/tools/_shared/chatPipeline.ts`, add the field to the existing interface:

```typescript
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
  sessionPrincipal: string;
  deadlineMs: number;
  intent_string?: string;
  blessed?: BlessListEntry;
  phase?: 'discover' | 'execute' | 'free_form';
  scope?: Record<string, unknown>;
  clarifications_resolved?: string[];
  /**
   * Track S: when set, finny_progress tool_calls during this run are
   * dispatched to taskManager.updateProgress(taskId, text). When undefined
   * (synchronous fast-path queries), progress dispatch is a no-op.
   */
  taskId?: string;
}
```

- [ ] **Step 2: Worker passes taskId when calling runQuery**

In `bridge/src/mcp/tools/_shared/taskWorker.ts`, modify the drain loop. Find the `runQuery(task.input as RunQueryParams)` call and replace with:

```typescript
async function drain(): Promise<void> {
  for (;;) {
    const task = taskManager.getNextPending();
    if (!task) {
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    taskManager.updateStatus(task.id, 'running');
    try {
      const params: RunQueryParams = {
        ...(task.input as RunQueryParams),
        taskId: task.id,
      };
      const result = await runQuery(params);
      taskManager.updateStatus(task.id, 'completed', JSON.stringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Task ${task.id} failed: ${message}`);
      taskManager.updateStatus(task.id, 'failed', undefined, message);
    }
  }
}
```

- [ ] **Step 3: Run typecheck**

Run: `cd bridge && npm run typecheck`
Expected: PASS — no consumers of `RunQueryParams` are broken (the new field is optional).

- [ ] **Step 4: Commit**

```bash
git add bridge/src/mcp/tools/_shared/chatPipeline.ts bridge/src/mcp/tools/_shared/taskWorker.ts
git commit -m "feat(bridge): plumb taskId through RunQueryParams for progress dispatch"
```

---

## Task 2: Export OpenAI tool-spec for `finny_progress`

**Why:** The dispatcher needs a JSON-schema tool definition to send to Hermes in the `tools` array. The Zod schema in `progress.ts` already exists — convert it to the OpenAI function-calling shape.

**Files:**
- Modify: `bridge/src/mcp/tools/progress.ts` (add export)
- Test: `bridge/src/__tests__/mcp/tools/progress.test.ts` (extend if exists, or new)

- [ ] **Step 1: Write a failing test for the tool-spec export**

Create or extend `bridge/src/__tests__/mcp/tools/progress.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { progressOpenAIToolSpec } from '../../../mcp/tools/progress.js';

describe('progressOpenAIToolSpec', () => {
  it('exposes finny_progress in OpenAI function-calling shape', () => {
    expect(progressOpenAIToolSpec).toMatchObject({
      type: 'function',
      function: {
        name: 'finny_progress',
        description: expect.stringContaining('progress'),
        parameters: {
          type: 'object',
          properties: {
            text: expect.objectContaining({ type: 'string' }),
          },
          required: ['text'],
        },
      },
    });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd bridge && npx vitest run src/__tests__/mcp/tools/progress.test.ts -t "OpenAI"`
Expected: FAIL — `progressOpenAIToolSpec` is not exported.

- [ ] **Step 3: Implement the export**

In `bridge/src/mcp/tools/progress.ts`, add at the bottom of the file (after `progressTool`):

```typescript
/**
 * OpenAI function-calling shape of finny_progress, suitable for the
 * `tools` array in /v1/chat/completions. Used by the bridge's tool-call
 * dispatcher (see toolDispatcher.ts). NOT exposed on the cowork-facing
 * MCP surface.
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
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          minLength: 1,
          maxLength: 500,
          description: 'Stage string, ≤80 chars recommended, present tense, lowercase.',
        },
      },
      required: ['text'],
    },
  },
};
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd bridge && npx vitest run src/__tests__/mcp/tools/progress.test.ts -t "OpenAI"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/mcp/tools/progress.ts bridge/src/__tests__/mcp/tools/progress.test.ts
git commit -m "feat(bridge): export progressOpenAIToolSpec for tool-call dispatcher"
```

---

## Task 3: Extend `HermesClient.chat()` to support tools + tool_calls

**Why:** The current `chat()` returns only `content: string`. To run the tool-dispatcher loop, the bridge needs to send a `tools` array and a multi-turn `messages[]`, and read back `tool_calls` from the assistant message.

**Files:**
- Modify: `bridge/src/hermes/client.ts:285-310`
- Test: `bridge/src/__tests__/hermes/client.test.ts` (or new file if absent)

- [ ] **Step 1: Write failing test for the extended `chat()` signature**

Create `bridge/src/__tests__/hermes/clientTools.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { HermesClient } from '../../hermes/client.js';

describe('HermesClient.chat with tools', () => {
  it('sends messages[] + tools[] and returns tool_calls when present', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'finny_progress', arguments: '{"text":"querying"}' },
                },
              ],
            },
          },
        ],
        model: 'finny',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = new HermesClient('http://test', 'tok', 5000, 'finny');
    const result = await client.chat({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'finny_progress', parameters: {} } }],
      sessionId: 'sess1',
    });

    expect(result.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'finny_progress', arguments: '{"text":"querying"}' },
      },
    ]);
    expect(result.response).toBe('');

    const requestBody = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(requestBody.tools).toBeDefined();
    expect(requestBody.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('preserves single-string compat call shape', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        model: 'finny',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = new HermesClient('http://test', undefined, 5000, 'finny');
    const result = await client.chat('hello', 'sess1');
    expect(result.response).toBe('ok');
    expect(result.tool_calls).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd bridge && npx vitest run src/__tests__/hermes/clientTools.test.ts`
Expected: FAIL — current `chat()` doesn't accept the object-form params or return `tool_calls`.

- [ ] **Step 3: Implement the overload**

In `bridge/src/hermes/client.ts`, replace the existing `chat` method with two overloads. Keep the legacy single-string form working for callers that haven't migrated.

First, add types near the top of the file (after existing exports/imports, before the class):

```typescript
export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIToolDef {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatWithToolsParams {
  messages: OpenAIMessage[];
  tools?: OpenAIToolDef[];
  sessionId?: string;
}

export interface HermesChatResponse {
  response: string;
  model: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  tool_calls?: OpenAIToolCall[];
}
```

Then replace the `chat` method body:

```typescript
async chat(message: string, sessionId?: string): Promise<HermesChatResponse>;
async chat(params: ChatWithToolsParams): Promise<HermesChatResponse>;
async chat(
  messageOrParams: string | ChatWithToolsParams,
  sessionId?: string
): Promise<HermesChatResponse> {
  let messages: OpenAIMessage[];
  let tools: OpenAIToolDef[] | undefined;
  let effectiveSessionId: string | undefined;

  if (typeof messageOrParams === 'string') {
    messages = [{ role: 'user', content: messageOrParams }];
    effectiveSessionId = sessionId;
  } else {
    messages = messageOrParams.messages;
    tools = messageOrParams.tools;
    effectiveSessionId = messageOrParams.sessionId;
  }

  const body: Record<string, unknown> = {
    model: this.model,
    messages,
    max_tokens: 4096,
  };
  if (tools && tools.length > 0) body.tools = tools;
  if (effectiveSessionId) body.session_id = effectiveSessionId;

  const headers: Record<string, string> = {};
  if (effectiveSessionId) headers['x-hermes-session-key'] = effectiveSessionId;

  const completion = await this.request<OpenAIChatCompletionResponse>('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify(body),
    headers,
  });

  const choice = completion.choices?.[0];
  const content = choice?.message?.content ?? '';
  const tool_calls = choice?.message?.tool_calls;

  return {
    response: content ?? '',
    model: completion.model,
    usage: completion.usage,
    ...(tool_calls && tool_calls.length > 0 ? { tool_calls } : {}),
  };
}
```

Also update the `OpenAIChatCompletionResponse` interface (search for it in the same file) to allow optional `tool_calls` on `message`:

```typescript
interface OpenAIChatCompletionResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
  }>;
  model: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd bridge && npx vitest run src/__tests__/hermes/clientTools.test.ts`
Expected: PASS — both tests pass.

- [ ] **Step 5: Run the full bridge test suite to confirm no regressions**

Run: `cd bridge && npm run test:run`
Expected: PASS — all existing tests still green.

- [ ] **Step 6: Commit**

```bash
git add bridge/src/hermes/client.ts bridge/src/__tests__/hermes/clientTools.test.ts
git commit -m "feat(bridge): HermesClient.chat supports OpenAI tools + tool_calls"
```

---

## Task 4: Build the tool-call dispatcher

**Why:** This is the core of the feature. A single `chat()` call may return either a final assistant message (envelope JSON) or `tool_calls`. If tool_calls, the dispatcher must execute each one, append a tool-result message, and call `chat()` again. Loop until the assistant returns content with no tool_calls or a hard cap (10 iterations) is hit.

**Files:**
- Create: `bridge/src/mcp/tools/_shared/toolDispatcher.ts`
- Test: `bridge/src/__tests__/mcp/tools/toolDispatcher.test.ts`

- [ ] **Step 1: Write the failing test for `runChatWithTools` happy path**

Create `bridge/src/__tests__/mcp/tools/toolDispatcher.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runChatWithTools } from '../../../mcp/tools/_shared/toolDispatcher.js';
import { taskManager } from '../../../mcp/tasks/manager.js';

describe('runChatWithTools', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns content directly when no tool_calls are emitted', async () => {
    const fakeClient = {
      chat: vi.fn().mockResolvedValue({ response: '{"status":"ok"}', model: 'finny' }),
    };
    const out = await runChatWithTools({
      client: fakeClient as never,
      systemPrompt: 'sys',
      userMessage: 'q',
      sessionId: 'sess',
      taskId: undefined,
    });
    expect(out.content).toBe('{"status":"ok"}');
    expect(fakeClient.chat).toHaveBeenCalledTimes(1);
  });

  it('dispatches finny_progress tool_calls to taskManager.updateProgress', async () => {
    const id = taskManager.create({ question: 'q' } as never, 'm2-default:production');
    taskManager.updateStatus(id, 'running');

    const fakeClient = {
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          response: '',
          model: 'finny',
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'finny_progress', arguments: '{"text":"querying NetSuite"}' },
            },
          ],
        })
        .mockResolvedValueOnce({ response: '{"status":"ok"}', model: 'finny' }),
    };

    const out = await runChatWithTools({
      client: fakeClient as never,
      systemPrompt: 'sys',
      userMessage: 'q',
      sessionId: 'sess',
      taskId: id,
    });

    expect(out.content).toBe('{"status":"ok"}');
    expect(fakeClient.chat).toHaveBeenCalledTimes(2);
    const t = taskManager.get(id);
    expect(t?.progress).toBe('querying NetSuite');

    // Second call must include the tool result
    const secondCallParams = fakeClient.chat.mock.calls[1]![0];
    const toolMsg = secondCallParams.messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMsg).toMatchObject({
      role: 'tool',
      tool_call_id: 'c1',
      content: expect.stringContaining('"ok":true'),
    });
  });

  it('caps loop at 10 iterations and returns last content', async () => {
    const fakeClient = {
      chat: vi.fn().mockResolvedValue({
        response: '',
        model: 'finny',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'finny_progress', arguments: '{"text":"loop"}' },
          },
        ],
      }),
    };
    const out = await runChatWithTools({
      client: fakeClient as never,
      systemPrompt: 'sys',
      userMessage: 'q',
      sessionId: 'sess',
      taskId: undefined,
    });
    expect(fakeClient.chat).toHaveBeenCalledTimes(10);
    expect(out.content).toBe(''); // last response had no content, just tool_calls
  });

  it('no-ops finny_progress dispatch when taskId is undefined', async () => {
    const fakeClient = {
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          response: '',
          model: 'finny',
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'finny_progress', arguments: '{"text":"x"}' },
            },
          ],
        })
        .mockResolvedValueOnce({ response: '{"status":"ok"}', model: 'finny' }),
    };
    const out = await runChatWithTools({
      client: fakeClient as never,
      systemPrompt: 'sys',
      userMessage: 'q',
      sessionId: 'sess',
      taskId: undefined,
    });
    expect(out.content).toBe('{"status":"ok"}');
    // Tool result should still be returned (with reason: 'no_task_context')
    const secondCallParams = fakeClient.chat.mock.calls[1]![0];
    const toolMsg = secondCallParams.messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMsg.content).toContain('no_task_context');
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd bridge && npx vitest run src/__tests__/mcp/tools/toolDispatcher.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the dispatcher**

Create `bridge/src/mcp/tools/_shared/toolDispatcher.ts`:

```typescript
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

import type { HermesClient, OpenAIMessage, OpenAIToolCall } from '../../../hermes/client.js';
import { progressOpenAIToolSpec } from '../progress.js';
import { applyProgress } from '../progress.js';
import { progressInputSchema } from '../progress.js';
import { log } from '../../../utils/logger.js';

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

    // Execute each tool_call; append a tool result for each.
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

  let parsed: { text: string };
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
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd bridge && npx vitest run src/__tests__/mcp/tools/toolDispatcher.test.ts`
Expected: PASS — all four cases green.

- [ ] **Step 5: Run lint + typecheck**

Run: `cd bridge && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bridge/src/mcp/tools/_shared/toolDispatcher.ts bridge/src/__tests__/mcp/tools/toolDispatcher.test.ts
git commit -m "feat(bridge): tool-call dispatcher routing finny_progress to taskManager"
```

---

## Task 5: Wire the dispatcher into `runQuery`

**Why:** Replace the existing single-shot `chat()` calls in `chatPipeline.ts` with `runChatWithTools()`, passing the `taskId` from `RunQueryParams`. This is the integration point that makes Finny's progress tool calls actually flow through the dispatcher.

**Files:**
- Modify: `bridge/src/mcp/tools/_shared/chatPipeline.ts:60-100` (`chat()` helper) and the two callsites of `chat()` inside `runQuery`.

- [ ] **Step 1: Replace the local `chat()` helper with a thin wrapper**

In `bridge/src/mcp/tools/_shared/chatPipeline.ts`, find the local `async function chat(params: ...)` definition (around line 60). Replace it with:

```typescript
import { runChatWithTools } from './toolDispatcher.js';

// ... existing imports stay ...

async function chat(params: {
  systemPrompt: string;
  userMessage: string;
  sessionId: string;
  deadlineMs: number;
  taskId: string | undefined;
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
    logGatewayCall(reqShape, {
      status: 200,
      latency_ms: latencyMs,
      response_chars: result.content.length,
    });
    return { content: result.content, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    const maybeStatus = (err as { status?: number } | undefined)?.status ?? 0;
    logGatewayCall(reqShape, {
      status: maybeStatus,
      latency_ms: latencyMs,
      error: message.slice(0, 512),
    });
    throw err;
  }
}
```

- [ ] **Step 2: Update the three `chat()` callsites in `runQuery` to pass `taskId`**

In the same file, find each `await chat({ ... })` invocation inside `runQuery` (there are three: initial, correction-after-validation-error, correction-after-no-JSON). Add `taskId: params.taskId` to each call's args object. Example:

```typescript
const first = await chat({
  systemPrompt,
  userMessage: params.question,
  sessionId,
  deadlineMs: params.deadlineMs,
  taskId: params.taskId,
});
```

Apply identically to the two correction-retry calls.

- [ ] **Step 3: Run typecheck and full test suite**

Run: `cd bridge && npm run typecheck && npm run test:run`
Expected: PASS — no existing tests should break (taskId is optional and threads through).

- [ ] **Step 4: Commit**

```bash
git add bridge/src/mcp/tools/_shared/chatPipeline.ts
git commit -m "feat(bridge): runQuery uses toolDispatcher to route finny_progress"
```

---

## Task 6: Update systemPrompt to instruct Finny to emit progress

**Why:** The OpenAI tools-API definition tells Finny the tool exists; the system prompt tells her *when to use it*. Without this instruction, Finny may know the tool but never call it.

**Files:**
- Modify: `bridge/src/mcp/tools/_shared/systemPrompt.ts:155-180`

- [ ] **Step 1: Replace the deferred-feature comment with the actual instruction**

In `bridge/src/mcp/tools/_shared/systemPrompt.ts`, find the `// Track S follow-up: finny_progress prompt instruction will land when the` comment block (around line 169) and replace it with the instruction. The execute-phase prompt builder should emit a `progressInstructions` block:

```typescript
const progressInstructions = [
  'Progress emission (mandatory for long executes):',
  'Call the finny_progress tool at phase boundaries during this run, with a',
  'short stage string (≤80 chars, present tense, lowercase). Examples:',
  '  finny_progress({text: "resolving entity and period"})',
  '  finny_progress({text: "querying NetSuite VendBill"})',
  '  finny_progress({text: "applying sign conventions"})',
  '  finny_progress({text: "composing answer"})',
  'Aim for 3-6 emits per query. Do not emit during discover phase. Do not',
  'emit generic strings like "thinking" or "still working". The bridge',
  'writes these to the in-flight task record so the client agent can show',
  'live progress to the user.',
  '',
].join('\n');

return [
  'You are Finny, a ShareChat NetSuite ERP agent. The caller wants you to RUN this intent.',
  '',
  ctx.intent_string ? `Intent: "${ctx.intent_string}"` : '',
  ctx.user_question ? `User's verbatim question: "${ctx.user_question}"` : '',
  '',
  blessLineExec,
  '',
  scopeBlock,
  clarificationsBlock,
  '',
  `Expected output shape: ${ctx.expected_shape}.`,
  '',
  progressInstructions,
  ...envelopeContract(ctx.expected_shape),
]
  .filter(Boolean)
  .join('\n');
```

- [ ] **Step 2: Add a snapshot test for the prompt**

If a test file for `systemPrompt.ts` does not exist, create `bridge/src/__tests__/mcp/tools/systemPrompt.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildQuerySystemPrompt } from '../../../mcp/tools/_shared/systemPrompt.js';

describe('buildQuerySystemPrompt', () => {
  it('includes finny_progress instruction during execute phase', () => {
    const prompt = buildQuerySystemPrompt({
      expected_shape: 'rows',
      phase: 'execute',
      intent_string: 'vendor_balance',
      user_question: 'open balance for MTPL',
    });
    expect(prompt).toContain('finny_progress');
    expect(prompt).toContain('phase boundaries');
  });

  it('does NOT include finny_progress instruction during discover phase', () => {
    const prompt = buildQuerySystemPrompt({
      expected_shape: 'rows',
      phase: 'discover',
      intent_string: 'vendor_balance',
      user_question: 'open balance',
    });
    expect(prompt).not.toContain('finny_progress');
  });
});
```

If the discover branch of `buildQuerySystemPrompt` is a separate function in the same file, the second test exercises that path. If both phases share a single builder, gate the `progressInstructions` insertion with `if (phase === 'execute')` so the discover branch stays clean.

- [ ] **Step 3: Run the test, verify it passes**

Run: `cd bridge && npx vitest run src/__tests__/mcp/tools/systemPrompt.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add bridge/src/mcp/tools/_shared/systemPrompt.ts bridge/src/__tests__/mcp/tools/systemPrompt.test.ts
git commit -m "feat(bridge): instruct Finny to call finny_progress at stage boundaries"
```

---

## Task 7: End-to-end test through `runQuery` + `taskWorker`

**Why:** Each piece is unit-tested. This task asserts the whole chain: `runQuery` (with `taskId`) → dispatcher → `applyProgress` → `taskManager.get(taskId).progress` → `taskStatus` returns a `running` envelope with `progress` set.

**Files:**
- Create: `bridge/src/__tests__/mcp/tools/progressE2E.test.ts`

- [ ] **Step 1: Write the E2E test**

Create `bridge/src/__tests__/mcp/tools/progressE2E.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { taskManager } from '../../../mcp/tasks/manager.js';
import { runQuery } from '../../../mcp/tools/_shared/chatPipeline.js';
import { taskStatusTool } from '../../../mcp/tools/taskStatus.js';
import { HermesClient } from '../../../hermes/client.js';

describe('finny_progress end-to-end', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('progress strings flow from tool_call to running envelope', async () => {
    // Mock HermesClient.chat: turn 1 returns a finny_progress tool_call,
    // turn 2 returns a valid envelope.
    const chatSpy = vi
      .spyOn(HermesClient.prototype, 'chat')
      .mockResolvedValueOnce({
        response: '',
        model: 'finny',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: {
              name: 'finny_progress',
              arguments: '{"text":"querying NetSuite VendBill"}',
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        response: JSON.stringify({
          status: 'ok',
          intent_restated: 'vendor balance for MTPL',
          confidence: 0.9,
          confidence_reason: 'direct lookup',
          data: { kind: 'rendered', rendered_markdown: '₹1,234' },
          sources: [{ kind: 'memory', ref: 'gl_map' }],
          unanswered: [],
          env_used: 'production',
        }),
        model: 'finny',
      });

    const id = taskManager.create(
      {
        question: 'open balance MTPL',
        expected_shape: 'scalar',
        sessionPrincipal: 'm2-default:production',
        deadlineMs: 30_000,
      } as never,
      'm2-default:production'
    );
    taskManager.updateStatus(id, 'running');

    const env = await runQuery({
      question: 'open balance MTPL',
      expected_shape: 'scalar',
      sessionPrincipal: 'm2-default:production',
      deadlineMs: 30_000,
      taskId: id,
    });

    expect(env.status).toBe('ok');
    expect(chatSpy).toHaveBeenCalledTimes(2);

    // Progress should now be on the task record.
    const stored = taskManager.get(id);
    expect(stored?.progress).toBe('querying NetSuite VendBill');

    // taskStatus on a still-running task surfaces progress.
    taskManager.updateStatus(id, 'running'); // simulate still in-flight
    const statusEnv = await taskStatusTool.handler({ task_id: id });
    expect(statusEnv.status).toBe('running');
    // The runningEnvelope spreads `progress` into the data field.
    expect(JSON.stringify(statusEnv)).toContain('querying NetSuite VendBill');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd bridge && npx vitest run src/__tests__/mcp/tools/progressE2E.test.ts`
Expected: PASS.

- [ ] **Step 3: Run the full bridge check**

Run: `cd bridge && npm run check:all`
Expected: PASS — lint, typecheck, all tests, build all green.

- [ ] **Step 4: Commit**

```bash
git add bridge/src/__tests__/mcp/tools/progressE2E.test.ts
git commit -m "test(bridge): e2e test — finny_progress tool_call flows to running envelope"
```

---

## Task 8: Manual smoke test against a real upstream

**Why:** Mocks prove the wiring; only a real Hermes call confirms Finny actually emits `finny_progress` when given the tool. If she doesn't, the systemPrompt needs more nudging.

**Files:** None. Operational verification only.

- [ ] **Step 1: Start the bridge in dev mode**

In one terminal:
```bash
cd bridge
cp .env.example .env  # if not already done
# Edit .env: set FINNY_UPSTREAM_URL and FINNY_UPSTREAM_TOKEN to real values
npm run dev
```

- [ ] **Step 2: Issue a long-running query via MCP Inspector or the deployed cowork plugin**

Use the same `vendor_summary` query the user ran when capturing the screenshots in this issue (a query known to take 60–180s).

- [ ] **Step 3: Tail bridge logs and confirm progress emits**

In another terminal:
```bash
cd bridge && tail -f /tmp/finny-bridge.log 2>/dev/null || true
# Or wherever the bridge writes logs in dev mode (stdout if no file).
```

Look for `[finny_progress] task=<id> text="..."` lines. Expected: 3–6 such lines per long query.

- [ ] **Step 4: Confirm the running envelope carries `progress`**

While the query is mid-flight, call `finny_task_status` with the `task_id` from the initial `running` envelope. The response should include a `progress` field with the latest stage string.

- [ ] **Step 5: Confirm cowork renders it**

In the cowork client, the polling messages should now read e.g. "Finny is: querying NetSuite VendBill" instead of "Still running — polling now". This is rendered by the `judging-output` skill (already implemented).

- [ ] **Step 6: If Finny doesn't emit, iterate the systemPrompt**

If no `[finny_progress]` log lines appear after a 60s query, Finny is ignoring the tool. Tighten the systemPrompt (Task 6) — e.g., add "You MUST call finny_progress at least 3 times during this query." and re-run. Commit any prompt revisions as a follow-up.

- [ ] **Step 7: Document the smoke result**

Update `docs/handoff/` with a note (or extend the latest handoff HTML) recording the smoke-test outcome: how many emits per query, any prompt iterations that were needed.

---

## Self-review

**Spec coverage:** The user's directive — "register finny_progress as a real MCP tool that writes to the task record" — is covered by Tasks 2 (tool spec export), 3 (HermesClient.chat extended), 4 (dispatcher), 5 (wiring into runQuery), 6 (systemPrompt instruction). Task 7 proves end-to-end via test; Task 8 proves it in production.

**Placeholder scan:** No "TBD"/"TODO"/"implement later". All code blocks are complete and runnable. The one place the plan defers is Task 8 Step 6 (prompt iteration) which is genuinely contingent on observed behavior — that's appropriate.

**Type consistency:** `RunQueryParams.taskId` is added in Task 1 and consumed in Tasks 5 and 7. `OpenAIMessage`, `OpenAIToolCall`, `OpenAIToolDef` are defined in Task 3 and consumed in Tasks 4, 7. `progressOpenAIToolSpec` is defined in Task 2 and consumed in Task 4. `runChatWithTools` is defined in Task 4 and consumed in Task 5.

**Architecture note carried across tasks:** `finny_progress` is intentionally NOT added to `ALL_TOOLS` in `tools-registration.ts`. Cowork must not see it. It travels only in the `tools` array of the upstream chat-completions request, and only the bridge dispatcher executes it.
