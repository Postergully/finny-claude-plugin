# Handoff — `finny_progress` tool dispatcher (mid-flight)

**Date:** 2026-06-04
**Branch:** `feat/finny-progress-tool-dispatcher` (off `main`, **not pushed**)
**Plan:** [`docs/superpowers/plans/2026-06-03-finny-progress-tool-dispatcher.md`](../superpowers/plans/2026-06-03-finny-progress-tool-dispatcher.md)
**Status:** Tasks 1–5 of 8 committed. Tasks 6–8 remain.

## Why this work exists

User screenshots showed cowork stuck in a "Loaded tools, used finny integration → Still running — waiting 5s and polling again" loop while Finny worked. Investigation found:

- The `finny_progress` tool handler exists (`bridge/src/mcp/tools/progress.ts`).
- `taskManager.updateProgress()` exists.
- `runningEnvelope.progress` field exists and is surfaced by `taskStatus.ts`.
- `judging-output` SKILL teaches cowork to render `progress` from polls.
- **But** the bridge had no tool-use dispatcher — Hermes returns OpenAI-style `tool_calls[]`, the bridge only read `choices[0].message.content`, so any `finny_progress` emit would vanish silently. `systemPrompt.ts` lines 169–172 explicitly deferred instructing Finny to emit until the dispatcher landed.

This plan wires it end-to-end.

## Architecture (the call path once complete)

```
runQuery(params) [chatPipeline.ts]
    └── chat({systemPrompt, userMessage, sessionId, deadlineMs, taskId})
          └── runChatWithTools(...) [toolDispatcher.ts]
                ├── messages = [system, user]
                └── loop (cap 10):
                      result = client.chat({messages, tools:[progressOpenAIToolSpec], sessionId})
                      if no tool_calls → return result.content
                      else:
                        push assistant turn
                        for each tool_call:
                          dispatchToolCall(call, taskId)
                            └── if name=finny_progress + taskId set:
                                  applyProgress({text}, {taskId})
                                    └── taskManager.updateProgress(taskId, text)
                          push tool result turn
```

`taskStatus` (already done before this plan) reads `task.progress` and surfaces it on the running envelope. `judging-output` (already done) renders it.

## What's done — committed in order

| # | Commit | Subject | Reviewed |
|---|---|---|---|
| 1 | `4d39e5a` | feat(bridge): plumb taskId through RunQueryParams for progress dispatch | ✅ spec ✅ quality |
|   | `4edc270` | docs(bridge): clarify RunQueryParams.taskId docstring | (quality-fix) |
| 2 | `d3a511f` | feat(bridge): export progressOpenAIToolSpec for tool-call dispatcher | ✅ spec ❌ quality |
|   | `c30d695` | refactor(bridge): derive progressOpenAIToolSpec parameters from Zod | (quality-fix) |
| 3 | `f9119c9` | feat(bridge): HermesClient.chat supports OpenAI tools + tool_calls | ✅ spec ✅ quality |
| 4 | `767a464` | feat(bridge): tool-call dispatcher routing finny_progress to taskManager | ✅ spec ✅ quality |
|   | `8c271ba` | docs(bridge): annotate toolDispatcher loop cap and sequential dispatch | (quality-fix) |
| 5 | `e442450` | feat(bridge): runQuery uses toolDispatcher to route finny_progress | ⚠️ **not reviewed** |

Plus the plan commit at the base: `e67f0d1`.

### Detail per task

**Task 1.** `RunQueryParams.taskId?: string` in `bridge/src/mcp/tools/_shared/chatPipeline.ts`. Worker `drain()` in `bridge/src/mcp/tools/_shared/taskWorker.ts` spreads task input + `taskId: task.id`.

**Task 2.** `progressOpenAIToolSpec` exported from `bridge/src/mcp/tools/progress.ts`. `parameters` derived via `zodToJsonSchema(progressInputSchema, {target: 'jsonSchema7', $refStrategy: 'none'})` to mirror the pattern in `tools-registration.ts:71-82`. Test in `bridge/src/__tests__/mcp/tools/progress.test.ts`.

**Task 3.** `HermesClient.chat()` overloaded:
- Legacy: `chat(message: string, sessionId?: string)` — preserved.
- New: `chat(params: ChatWithToolsParams)` where `ChatWithToolsParams = {messages: OpenAIMessage[]; tools?: OpenAIToolDef[]; sessionId?: string}`.

Exports added: `OpenAIToolCall`, `OpenAIMessage`, `OpenAIToolDef`, `ChatWithToolsParams`. `HermesChatResponse.tool_calls?` optional, only present when assistant emits them. `OpenAIChatCompletionResponse.message.tool_calls?` extended. Test in `bridge/src/__tests__/hermes/clientTools.test.ts`.

**Task 4.** `bridge/src/mcp/tools/_shared/toolDispatcher.ts` exports `runChatWithTools(params): Promise<{content, iterations}>`. Hard cap 10 iterations (commented: ≤6 emits per query observed). Sequential per-turn dispatch (commented: idempotent for finny_progress; revisit if side-effecting tools added). `dispatchToolCall` returns `{ok, reason?}`. Reasons: `unknown_tool` (tool name ≠ finny_progress), `no_task_context` (taskId undefined — sync fast-path), `invalid_arguments` (JSON.parse or Zod failed). Tests cover all four branches. Tool result is `JSON.stringify`d into the `tool` message content.

**Task 5.** `chatPipeline.ts`:
- Added `import { runChatWithTools } from './toolDispatcher.js'`.
- Local `chat()` helper now requires `taskId: string | undefined` and delegates to `runChatWithTools`.
- All three `await chat({...})` callsites in `runQuery` (initial + 2 correction retries) pass `taskId: params.taskId`.
- The legacy combined-string shape (`${systemPrompt}\n\n---\n\n${userMessage}`) is dropped — dispatcher feeds them as separate `system` and `user` messages each turn (standard OpenAI tool-use shape).
- `chatPipeline.test.ts` updated: mock now handles both legacy string and new `{messages, tools, sessionId}` overload; helper extracts prompts for assertions.
- 428 bridge tests passed at last run before commit.

## What's NOT done

### Task 5 review (skipped due to interruption)

Implementer self-reviewed and committed `e442450` before spec/quality reviewers could run. **Recommended action for next agent:** dispatch the spec + quality reviewers retroactively against `e442450` before moving on. Look specifically at:
- The `chatPipeline.test.ts` update — does the new mock actually exercise both call shapes, or does it just permit them?
- Are all three callsites threading `taskId`? (System reminder during the session showed lines 145 and 180; the third is at line ~225 in the post-edit file — verify.)
- Does dropping the `${systemPrompt}\n\n---\n\n${userMessage}` concat change Hermes behavior in any test? (The dispatcher's system+user split is more correct, but if any existing test asserts on the combined shape, it would have been updated.)

### Task 6 — `systemPrompt.ts` instruction (NEXT TASK)

**File:** `bridge/src/mcp/tools/_shared/systemPrompt.ts`. Around lines 155–180 there's a deferred-feature comment block (`// Track S follow-up: finny_progress prompt instruction will land when the chatPipeline tool-use dispatcher exists. Until then, instructing Finny to call finny_progress would route nowhere…`). Replace it with a `progressInstructions` block that tells Finny to call `finny_progress` at 3–6 stage boundaries. Gate by `phase === 'execute'` so discover stays clean.

Plan §Task 6 has the full code. Add a snapshot test in `bridge/src/__tests__/mcp/tools/systemPrompt.test.ts` covering execute (contains `finny_progress`) and discover (does NOT contain it).

### Task 7 — E2E test

**Create:** `bridge/src/__tests__/mcp/tools/progressE2E.test.ts`. Mock `HermesClient.prototype.chat` to return: turn 1 = tool_call `finny_progress({text:"querying NetSuite VendBill"})`, turn 2 = valid envelope JSON. Drive `runQuery` with a `taskId` from `taskManager.create()`. Assert: returned envelope is `ok`, `taskManager.get(id).progress === 'querying NetSuite VendBill'`, then `taskStatusTool.handler({task_id})` on a still-running task surfaces the progress string in the running envelope.

Plan §Task 7 has the full test code. Then run `npm run check:all` from `bridge/` and confirm green.

### Task 8 — Manual smoke

Operational verification against real Hermes upstream. Issue a slow query (`vendor_summary` is a known 60–180s candidate). Confirm `[finny_progress] task=… text="…"` log lines appear, `finny_task_status` returns running envelope with `progress` set, cowork renders "Finny is: <stage>" instead of "Still running — polling now". Iterate `systemPrompt.ts` if Finny ignores the tool. Document outcome in this folder.

## Working tree state at handoff

Pre-existing dirty files unrelated to this plan (left alone):

```
 M bridge/.env.example          (pre-existing local config)
 M bridge/src/cli.ts            (whitespace-only error message reflow; not from this plan)
 M deploy/README.md             (pre-existing)
?? CLAUDE.md                    (pre-existing project notes file)
?? deploy/hermes-bootstrap.sh   (pre-existing)
?? docs/hermes-reference/       (pre-existing)
?? slack-manifest.json          (pre-existing)
```

Do NOT include these in the next commit on this branch unless intentional.

## Quick verification commands

```bash
cd /Applications/finny-claude-plugin
git log --oneline e67f0d1..HEAD  # 9 commits expected (plan + 8 implementation/fix commits)
cd bridge
npm run check:all                # lint + typecheck + test:run + build, all green
```

## Resuming the workflow

The plan's execution mode is `superpowers:subagent-driven-development`. When you pick this up:

1. Re-read the plan: `docs/superpowers/plans/2026-06-03-finny-progress-tool-dispatcher.md`.
2. Run the bridge `npm run check:all` to confirm the branch still builds.
3. (Optional but recommended) Dispatch retroactive spec + quality review of `e442450` for Task 5.
4. Dispatch Task 6 implementer per the plan.
5. After Task 6, dispatch Task 7. Task 8 is manual.
6. After Task 7 passes, dispatch a final whole-implementation reviewer.
7. Use `superpowers:finishing-a-development-branch` to land — likely PR off `main`.

## Risks / open questions

- **Hermes upstream behavior unverified.** Tasks 1–7 are mock-driven. Task 8 is the first time Finny is actually given `tools: [finny_progress]` in a real chat completion. If Hermes' chat API ignores the `tools` field, or if Finny's underlying model doesn't honor function-calling, the whole chain still won't show progress to users. Mitigation: vendored Hermes docs (`docs/hermes-reference/llms-full.txt`) say the `/v1/chat/completions` endpoint is OpenAI-compatible and supports tools, but verify on real traffic.
- **Cowork-side rendering.** This plan does NOT touch the cowork plugin. The `judging-output` SKILL already documents how to render `progress` from poll responses (lines 434–451). If progress strings hit the running envelope but the user still sees generic polling messages, the gap is in the cowork client's adherence to that SKILL — not the bridge.
- **Long-running tasks vs. tool budget.** Each `finny_progress` emit is one round-trip on the upstream chat API. 6 emits = 6 extra LLM turns. Watch upstream cost/latency in smoke testing.

## Related plans / artifacts

- Hermes-side handoff skill (separate workstream): `hermes-handoff/cowork-mcp-client/v1.0.0/SKILL.md` on branch `feat/hermes-handoff-cowork-mcp-client-v1` (already pushed). That skill instructs Finny to emit `finny_progress` at stage boundaries — once Task 6 lands here, both halves of the contract are wired and Finny can be told to install v1.0.0 of the skill.
