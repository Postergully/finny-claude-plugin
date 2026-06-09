---
name: tracking-bridge-perf
description: Pulls Finny bridge gateway logs from prod EC2, runs analyze-gateway-log.mjs, and produces a health report covering bridge-side metrics (sessions, correction retries, call counts), Finny-side metrics (inference latency, response shape), and envelope-related signals (parse failures, schema rejections, drift). Use when the user asks to check bridge speed, audit a session, inspect gateway calls, run a perf checkpoint, or asks "is finny slow", "is the bridge healthy", "session churn check", "post-deploy verify".
---

# Tracking Bridge Performance

A repeatable performance + stability checkpoint for the Finny MCP bridge. Pulls gateway logs over SSM, attributes latency to the right layer (bridge / Finny / envelope), and compares against the rollback thresholds in `docs/superpowers/plans/2026-06-08-bridge-reliability-rollback.md`.

## When to use

Trigger this skill when the user says any of:
- "check bridge speed", "is the bridge slow", "is finny slow"
- "run a perf check", "checkpoint", "audit the session"
- "post-deploy verify", "any regressions", "are the new changes healthy"
- "session churn", "session reuse", "are we still creating fresh sessions"
- "bridge stability", "envelope rejections", "correction retries spiking"

## Quick Start

Three commands, in order. Run them sequentially via SSM `send-command` (not interactive `start-session`):

```bash
# 1. Pull a window of gateway logs and run the analyzer.
aws ssm send-command --instance-ids i-0ef58962b09d490ee --region us-east-1 \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["sudo journalctl -u finny-mcp --since \"60 min ago\" -o cat 2>&1 | node /opt/finny/bridge/scripts/analyze-gateway-log.mjs"]' \
  --query "Command.CommandId" --output text
# Then poll with `aws ssm get-command-invocation --command-id <CID> ...`
```

Then run `evaluate.md` (in this skill's references) against the analyzer output to produce the health verdict.

## How latency attribution works

Every layer leaves a different fingerprint in the JSONL records. Use this table to attribute slowness correctly — most "bridge is slow" reports turn out to be Finny-side or envelope-side.

| Symptom | Where it lives | What to look at |
|---|---|---|
| `p95 initial-phase latency` high | **Finny inference** | The model itself is slow; not a bridge bug. Lever: agent-side prompt/skill optimization. |
| `p95 correction-phase latency` high | **Envelope** | Finny's first response failed Zod; correction retry is doing real work. Investigate `envelope_parse_failed` records. |
| `Avg calls/query > 3` | **Envelope OR tool loop** | Either correction retries OR `finny_progress` tool-loop iterations. Check `correction_retry: true` rate. |
| `Session-creation rate > 10%` | **Bridge OR Hermes** | If same principal across many queries → likely Hermes-side fresh `api-xxxxx` (file against hermes-agent). If different principals → expected. |
| `Cursor expiry errors spiking` | **Cowork (skill)** | Cowork isn't draining cursors fast enough OR `judging-output` skill regressed. Bridge-side fix unlikely. |
| HTTP 5xx in `gateway_call.response.status` | **Hermes gateway** | Connectivity or upstream auth. Check gateway service status. |
| `tool_loop_iter > 0` repeatedly | **Tool dispatcher** | Finny is calling `finny_progress` heavily. Currently always 0 (instrumentation deferred); revisit when wired. |

## Health thresholds (Red = consider rollback)

These come from the rollback plan — keep them in sync. Update both places if either changes.

| Metric | 🟢 Healthy | 🟡 Yellow | 🔴 Red |
|---|---|---|---|
| Avg calls/query | 1–2 | 2–3 | >3 sustained 24h |
| Session-creation rate | <2% | 2–10% | >10% sustained 24h |
| Correction-retry rate | <5% | 5–15% | >15% sustained |
| p95 initial-phase latency | <120 s | 120–180 s | >180 s |
| p95 calls/query | ≤2 | 3 | ≥4 |
| Cursor expiry errors | rare | spiking | sustained spikes |

**Sample-size rule:** Don't call any metric Red with `n < 10` queries. With small n, report as 🟡 with "needs more data" and recommend issuing more queries before judging.

## Instructions

Follow these phases in order:

### Phase 1 — Pull the data

Choose the window based on what the user asked:
- "is it healthy right now" → 60 min
- "post-deploy verify" → since deploy time (use `--since "<HH:MM>"` exact time)
- "weekly review" / "have we regressed" → 24 hours
- "investigate this specific incident" → narrow window around the incident

Always use `AWS-RunShellScript` (non-interactive) — `start-session` is interactive and won't work in scripted flows. Capture the `CommandId`, sleep 5–8 s, then `get-command-invocation` to retrieve output. See `references/ssm-commands.md` for ready-to-paste commands.

### Phase 2 — Sanity-check sample size + window

Before trusting any percentile, run:

```bash
# Count gateway_call vs gateway_query_aggregate records in the window.
sudo journalctl -u finny-mcp --since "<window>" -o cat 2>&1 \
  | grep -c '"kind":"gateway_call"'
sudo journalctl -u finny-mcp --since "<window>" -o cat 2>&1 \
  | grep -c '"kind":"gateway_query_aggregate"'
```

If `gateway_call` count is much higher than `aggregate` count, the window probably spans pre-deploy logs (the old code didn't emit aggregates). Tighten the window to post-restart only — find the restart timestamp via:
```bash
sudo journalctl -u finny-mcp -o cat | grep -m1 "Starting hermes-mcp"
```

### Phase 3 — Run the analyzer + read the raw shape

Two commands:
```bash
# Aggregate report
sudo journalctl -u finny-mcp --since "<window>" -o cat 2>&1 \
  | node /opt/finny/bridge/scripts/analyze-gateway-log.mjs

# Sample raw records (last 5)
sudo journalctl -u finny-mcp --since "<window>" -o cat 2>&1 \
  | grep -E '"kind":"gateway_call"|"kind":"gateway_query_aggregate"' \
  | tail -5
```

Reading the raw shape catches issues the analyzer flattens — e.g., one giant slow query that drags p95 vs sustained slowness across many queries.

### Phase 4 — Attribute + judge

For each metric in Red or Yellow:
1. Use the **latency attribution table** above to identify the layer.
2. Note any caveat (sample size, window pollution, single outlier query).
3. Compare against the thresholds table — but only call a Red verdict if `n ≥ 10` AND the signal is sustained.

### Phase 5 — Produce the report

Use the **Report template** below. Always include:
- Window + sample size up front
- One row per metric with observed value vs threshold
- Layer attribution for any non-green metric
- Explicit rollback verdict (HOLD / WATCH / ROLLBACK)
- Concrete next action

## Report template

Copy this exactly and fill in:

```markdown
## Bridge perf checkpoint — <date> — <window>

**Sample:** <N> queries / <M> gateway calls

| Metric | Observed | Threshold | Verdict |
|---|---|---|---|
| Avg calls/query | <x.x> | <3 | 🟢/🟡/🔴 |
| Session-creation rate | <xx%> | <10% | 🟢/🟡/🔴 |
| Correction-retry rate | <xx%> | <15% | 🟢/🟡/🔴 |
| p95 initial-phase latency | <xxx s> | <180 s | 🟢/🟡/🔴 |
| p95 calls/query | <x> | <4 | 🟢/🟡/🔴 |
| Cursor expiry errors | <count> | rare | 🟢/🟡/🔴 |

**Layer attribution** (only for non-green metrics):
- <metric>: <bridge/finny/envelope/hermes/cowork>. <one-line reason>

**Verdict:** HOLD | WATCH | ROLLBACK
- HOLD: all green, or yellows with low sample size — no action.
- WATCH: yellows with adequate sample, or a Red driven by a non-bridge layer — gather more data, don't roll back.
- ROLLBACK: bridge-side Red sustained 24h+ — go to `docs/superpowers/plans/2026-06-08-bridge-reliability-rollback.md` and pick a path.

**Next action:** <one concrete thing>
```

## Bridge / Finny / Envelope cheat sheet

When the user asks "is X the problem?", here's how each layer looks:

### Bridge-side signals
- `session_created: true` rate (sustained spike → bridge or gateway side)
- `correction_retry` rate (envelope contract issue, but the bridge is the layer noticing)
- Cursor store metrics (`cur-...` token issuance, expiry rate)
- HTTP timeout errors → check `DEFAULT_TIMEOUT_MS` in `bridge/src/hermes/client.ts`
- Schema rejections → grep `envelope_parse_failed` in journal

### Finny-side signals
- `latency_ms` on `gateway_call` records with `correction_retry: false` and `tool_loop_iter: 0` is pure Finny inference time.
- Compare against measured baseline: p50 ≈ 149 s, p90 ≈ 183 s (n=4 chains, 2026-05-14/15).
- If p95 is materially above p90 baseline → Finny is slower than usual. Not a bridge issue.
- For the agent-side fix path, see `docs/handoff/` and `bridge/CLAUDE.md` (Hermes gateway runs separately on port 8642).

### Envelope-related signals
- `correction_retry: true` records with high `latency_ms` → Finny took a full pass to fix Zod errors.
- `envelope_parse_failed` error code → bridge tried twice and failed both times. Surface to user via `judging-output`.
- `rows_scanned: null` on a source — should parse cleanly (Workstream A relaxed schema 2026-06-08).
- `error.retryable` absent — should parse cleanly (same fix).
- New `OUT_OF_SCOPE` codes appearing — Finny is non-compliant; canonical is `'refused'`.

## Examples

### Example 1 — User asks "is the bridge healthy"

Phase 1: pull last 60 min via SSM.
Phase 2: `gateway_call=12, aggregate=8` — adequate sample, no window-pollution.
Phase 3: analyzer shows `Avg calls/query 1.5, session-creation 12%, p95 initial 95s`.
Phase 4: session-creation 🟡 (just over 10%), all else 🟢. Sample n=8 queries — borderline; report as 🟡 with "n=8, watch for n=20+".
Phase 5: emit report with verdict WATCH, next action "issue 12 more queries over the next 6h, re-run".

### Example 2 — User asks "is finny slow on revenue reports"

Phase 1: pull window covering recent revenue-report queries.
Phase 2: filter to queries where `intent_restated` contains "revenue".
Phase 3: analyzer + raw record inspection.
Phase 4: if `p95 initial-phase` is 200 s but `correction_retry` rate normal → it's Finny inference, not bridge. Layer = **finny**.
Phase 5: verdict HOLD on bridge, next action "agent-side prompt optimization on the revenue report path; bridge has nothing to fix".

### Example 3 — User asks "are we spawning fresh sessions per rejection"

This is the original session-churn question from the spec.
Phase 1: pull 24h of logs.
Phase 2: filter to records where `correction_retry: true` AND `session_created: true` simultaneously.

```bash
sudo journalctl -u finny-mcp --since "24h ago" -o cat 2>&1 \
  | grep '"kind":"gateway_call"' \
  | grep '"correction_retry":true' \
  | grep '"session_created":true' \
  | wc -l
```

If that count is **0**, the bridge is correctly reusing sessions on correction retries — the original claim doesn't hold for the bridge layer. If non-zero, that's a real bridge bug; investigate `chatPipeline.ts:179` (correction retry path) — but per the 2026-06-08 audit, the bridge passes the same `sessionId` through, so a non-zero count would suggest a regression.

If aggregate `session_created` rate is high BUT this combined count is 0 → the churn is between queries (cross-query session reuse failing), not within a query. That points at sessionStore TTL/eviction or a Hermes-side issue (gateway minting new agent contexts despite stable bridge `session_id`).

## References

- [SSM commands](references/ssm-commands.md) — ready-to-paste `aws ssm` invocations for common windows
- Project rollback plan: `docs/superpowers/plans/2026-06-08-bridge-reliability-rollback.md`
- EC2 ops memory: `~/.claude/projects/-Applications-finny-claude-plugin/memory/ec2-ops.md`
- Bridge perf checkpoint memory: `~/.claude/projects/-Applications-finny-claude-plugin/memory/bridge-reliability-checkpoint.md`

## Guidelines

- **Always pull data first, talk second.** Don't speculate about bridge health without log evidence.
- **Attribute before judging.** A Red metric driven by Finny inference is not a bridge regression.
- **Respect the sample-size rule.** With `n < 10`, report 🟡 not 🔴 — recommend gathering more data instead of rolling back.
- **Use SSM `send-command`, not `start-session`.** The latter is interactive and won't work in scripted flows.
- **Don't run `analyze-gateway-log.mjs` over a window that spans a deploy.** Pre-deploy logs lack aggregates and inflate the per-call:per-query ratio. Tighten to post-restart.
- **Never roll back on the first checkpoint.** Verdict ROLLBACK requires a sustained Red over ≥24 h on a bridge-side metric.
- **The layer attribution table is the source of truth** — keep it consistent with `docs/superpowers/plans/2026-06-08-bridge-reliability-rollback.md`.
