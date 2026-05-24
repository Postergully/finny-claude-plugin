# Finny envelope fixtures

Snapshots of Finny envelope shapes used by the M3 judge-loop harness (Task 9) and unit tests.

## M2 fixtures (historical)

- `M2-happy-scalar.json` — **live.** Clean scalar answer (`status: "ok"`, `data.shape: "scalar"`, `confidence: "high"`) captured from an arithmetic question during M2 verification. The original spec question ("How many vendor records exist in total?") tripped Finny's 180s embedded-agent timeout on the M2 sync path; arithmetic was the fallback to get a signed happy-path envelope.
- `M2-drift-vendor.json` — **live.** Ambiguous "Reliance" vendor lookup. Outcome is `status: "error"` with `error.code: "envelope_parse_failed"` because Finny returned `error.code: "approval_required"` — a value M2's closed enum rejected. This is the historical record of the bug that motivated Task 1's `'other'` escape valve; keep it for context.

## M3 fixtures

- `M3-query-async-running.json` — **synthesized.** The `status: "running"` envelope `finny_query` returns when its `deadline_ms` (5000 ms here) elapses before the background task completes. `task_id` is present both top-level (schema plumbing) and in `data.value` (contract-authoritative slot per design §2.4). `data.rendered_markdown` carries the auxiliary `{task_id, deadline_exceeded_ms}` JSON so downstream judges see both.
- `M3-query-async-done.json` — **synthesized.** The completed envelope stored by the background task worker and returned by `finny_task_status({task_id})` after polling. `task_id` matches `M3-query-async-running.json` so the Task 9 harness can assert the running→done transition on the same task.
- `M3-other-escape.json` — **synthesized.** Proves Task 1's `'other'` escape valve works end-to-end: Finny's semantic `approval_required` code rides through as `error.code: "other"` + `error.message: "approval_required"` instead of being masked as `envelope_parse_failed`. Triggered by the canonical ambiguous-vendor case (same entity class as the historical `M2-drift-vendor.json`).

### Why synthesized, not live?

Task 8 attempted live capture first; sandbox gateway was down at run-time (`curl http://127.0.0.1:8642/health` failed) so per-plan instructions we fell back to synthesis immediately rather than thrash on infra. The envelope *shape* is the assertion target for Task 9's harness, and the shape is deterministic: defined by `FinnyEnvelopeSchema` + the shared `envelopeBuilders` (`runningEnvelope`, `errorEnvelope`, and the live `chatPipeline` happy-path composition). Fixtures are marked `"_synthesized": true` at the root so future readers know the provenance; each validates against `FinnyEnvelopeSchema` with `_synthesized` stripped.

When the sandbox is back up, regenerate per the recipe below — shape should be stable; values (elapsed_ms, rows_scanned, assumptions wording) will vary.

## Regeneration (against live sandbox)

Preflight:

```bash
security find-generic-password -a "$USER" -s "finny-gateway-token" -w >/dev/null && echo token present
curl -sf http://127.0.0.1:8642/health   # expect {"ok":true,"status":"live"}
```

If both pass:

```bash
export FINNY_GATEWAY_TOKEN=$(security find-generic-password -a "$USER" -s "finny-gateway-token" -w)
pnpm -F @postergully/finny-mcp build
cd bridge

# Running envelope (short deadline against a known-slow query):
node __tests__/fixtures/capture.mjs M3-query-async-running \
  '{"tool":"finny_query","input":{"question":"how many vendor records exist in production?","deadline_ms":5000,"entity_hints":{"env":"production"}}}'

# Done envelope (poll the task_id from above until completed):
CAPTURE_TASK_MAX_MS=300000 node __tests__/fixtures/capture-task.mjs M3-query-async-done <task_id>

# Other-escape envelope (ambiguous name → Finny's approval_required flows through):
node __tests__/fixtures/capture.mjs M3-other-escape \
  '{"tool":"finny_query","input":{"question":"What is the open balance for vendor Reliance?","entity_hints":{"env":"production"}}}'
```

Sanitize before committing: `bridge_version` → `"redacted"`, `finny_session_id` → `"redacted"`. **Keep `task_id`** — Task 9's harness asserts the running→done transition uses the same id. Never commit a raw `FINNY_GATEWAY_TOKEN` value.
