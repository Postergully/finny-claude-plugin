# Staging changes: `feat/dashboard-external-memory-tab`

**Date tested:** `2026-06-22` → `2026-06-22`
**Tested by:** `Postergully (orchestrator-driven, verifier-gated)`
**Staging snapshot baseline:** prod AMI (current staging EC2 `i-0c2c974ff571162eb`, snapshot per `2026-06-22 ~06:20 UTC` deploy-log entry)
**PR:** [11mirror/finny-hermes-dashboard#1](https://github.com/11mirror/finny-hermes-dashboard/pull/1) (this branch in `finny-claude-plugin`); paired dashboard PR opened against `Postergully/finny-hermes-dashboard@feat/external-memory-via-hindsight`.

## Git changes (replay via merge)

- `finny-claude-plugin@feat/dashboard-external-memory-tab`: `5600902`, `c6d9aa1`, `5dc7910`, `20df573` (Hindsight contract spec, SPA spec append, naming-note, `deploy-finny-dashboard.sh --branch` flag).
- `finny-hermes-dashboard@feat/external-memory-via-hindsight`: `d2e037ca`, `570d1bd9`, `15a3c00d`, `99a04599` — `HindsightClient` + `/api/external-memory/{providers,candidates,search}` routes. PR: [11mirror/finny-hermes-dashboard#1](https://github.com/11mirror/finny-hermes-dashboard/pull/1).
- `finny-hermes@<no branch>`: no changes (Path B locked — no Hermes Python edits).
- `finny-hermes-config@<no branch>`: no changes.
- `netsuite-kb@<no branch>`: no changes.

## Deploy decision

- [ ] **Deploy immediately after merge** — PR is independent, ship it as soon as merged
- [x] **Hold for batch** — safe to merge but wait for the next batched deploy window
- [ ] **Hotfix** — deploy ASAP, do not batch with anything else
- [ ] **Reconciliation deploy** — special case (e.g., byte-equality reconciliation); see deploy-runbook.md byte-equality flow

Rationale: feature is non-urgent and dashboard-only. Safe to ride the next batched deploy.

## Non-git changes (replay manually on prod, in order)

> These run during step 9b (deploy), NOT at merge time.

1. `/opt/finny/dashboard/.env` on prod EC2 (`i-0ef58962b09d490ee`): append `HINDSIGHT_API_KEY` line, sourced from `~/.hermes/.env` (key already present there per staging precedent).
   - **Command run:**
     ```
     KEY=$(sudo grep '^HINDSIGHT_API_KEY=' /home/ubuntu/.hermes/.env | cut -d= -f2-) \
       && echo "HINDSIGHT_API_KEY=$KEY" | sudo tee -a /opt/finny/dashboard/.env > /dev/null
     ```
     (Value sourced from `~/.hermes/.env` at runtime; never printed into the transcript. Manifest contains keys only — no secret values.)
   - **Why:** the deploy script writes a narrow `/opt/finny/dashboard/.env` (`HERMES_API_URL`, `HERMES_API_TOKEN`, `HOST`, `PORT` only) and does NOT propagate `HINDSIGHT_API_KEY`. The dashboard's new `/api/external-memory/*` routes call `createHindsightClientFromEnv()` which reads `process.env.HINDSIGHT_API_KEY` and 503s if absent. Confirmed on staging: first smoke after deploy returned `503 — HINDSIGHT_API_KEY is not set in process.env`; after appending the key + restart, smoke went green.
2. `sudo systemctl daemon-reload && sudo systemctl restart finny-dashboard`
3. Smoke: `curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/api/external-memory/providers` → expect `200`.

## What was tested on staging

- [ ] 5-tool smoke (`finny_query`, `finny_report`, `finny_task_status`, `finny_continue`, `finny_remember`) via browser Claude cowork at `https://finny.staging.11mirror.com/mcp` — **N/A** (MCP/bridge surfaces unchanged by this PR; only dashboard tab + new dashboard routes were touched).
- [ ] Desktop dashboard chat works against tailnet IP — **N/A** (chat path unchanged; only new External Memory tab + REST routes added).
- [ ] No-Slack-bleed sanity check — **N/A** (no agent loop or profile changes; staging activity stayed on the dashboard HTTP surface only).
- [x] `GET /api/external-memory/providers` → `200`, payload non-empty (providers=2).
- [x] `GET /api/external-memory/candidates` → `200`, payload non-empty (candidates total=5984).
- [x] `GET /api/external-memory/search?q=netsuite` → `200`, payload non-empty (count=98).
- [x] Browser smoke via gstack headless Chromium (`/browse`): External providers tab renders; sharechat provider selectable; candidate cards populate with UUIDs, body text, timestamps. Screenshots at `finny-loops` repo: `domains/dashboard-external-memory/evidence/task-8-external-memory-tab-populated.png` and `domains/dashboard-external-memory/evidence/task-8-external-memory-search-netsuite.png`.
- [x] Deploy ran via the new `--branch feat/external-memory-via-hindsight` flag (Task 7), proving the flag works end-to-end on staging.

## Skipped on prod (staging-only changes)

> Things done on staging for testing/debug that should NOT carry to prod.

None.

## Rollback

1. `git revert <merge-sha>` on `finny-hermes-dashboard` (the route + client changes). `finny-claude-plugin` revert is optional — the `--branch` flag and the spec docs are non-runtime and harmless to leave in place.
2. Re-deploy main to revert `/opt/finny/dashboard`. The deploy script already moves the prior install to `/opt/finny/dashboard.bak.<timestamp>` for one-step rollback; restore from that backup if redeploy is impractical.
3. (Optional) Remove the appended `HINDSIGHT_API_KEY` line from `/opt/finny/dashboard/.env`. Leaving it is harmless once the routes are gone.
4. `sudo systemctl daemon-reload && sudo systemctl restart finny-dashboard`.
5. Verify rollback: `curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/api/external-memory/providers` → expect `404` (route gone).

## Notes / surprises

The `HINDSIGHT_API_KEY` propagation gap is a genuine bug in `deploy/scripts/deploy-finny-dashboard.sh`: the script enumerates a fixed set of env keys to write into `/opt/finny/dashboard/.env` and silently drops anything else the dashboard process needs. The proper long-term fix is to make the deploy script either enumerate Hindsight-related keys it should propagate, or `.env`-tee on the box from `~/.hermes/.env` at install time. Out of scope for this PR; tracked as a follow-up.
