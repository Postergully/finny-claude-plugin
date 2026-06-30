# Staging changes: `fix/eval-transport-mcp-jsonrpc`

**Date tested:** 2026-06-30 → 2026-06-30
**Tested by:** Postergully + Claude
**Staging snapshot baseline:** prod AMI (refreshed 2026-06-29)
**PR:** #37

## Git changes (replay via merge)

- `finny-claude-plugin@fix/eval-transport-mcp-jsonrpc`: see PR #37 (commits `7ec6916..2adbb4e`)
- `finny-hermes@*`: no changes
- `finny-hermes-config@*`: no changes
- `netsuite-kb@*`: no changes

## Deploy decision

- [x] **Hold for batch** — eval-only changes; the only operator-facing surface is the new optional `EVAL_BYPASS_ENABLED` env. Safe to merge but not urgent. Do NOT enable the bypass env in prod under any circumstance.

## Non-git changes (replay manually on prod, in order)

> **PROD MUST NOT enable the eval bypass.** The lines below describe what was
> done on staging for eval baseline capture only. They are listed for record-
> keeping; prod replay should explicitly skip them.

1. **`/opt/finny/bridge/.env` — staging-only:** added `EVAL_BYPASS_ENABLED=true`.
   - **Command run:** `echo 'EVAL_BYPASS_ENABLED=true' >> /opt/finny/bridge/.env`
   - **Why:** Lets `eval/capture-oracle.ts` reach `/mcp` from localhost without
     OAuth, for Phase 1 Task 1.3 oracle capture.
   - **PROD ACTION:** DO NOT set this. The bypass is dead code when the env
     var is unset. Prod's `EVAL_BYPASS_ENABLED` should remain unset/false.
2. **`/opt/finny/bridge/.env` — staging-only:** added `127.0.0.1` and
   `127.0.0.1:3000` to `MCP_ALLOWED_HOSTS`.
   - **Command run:** `sed -i 's|^MCP_ALLOWED_HOSTS=.*|MCP_ALLOWED_HOSTS=finny.staging.11mirror.com,127.0.0.1,127.0.0.1:3000|' /opt/finny/bridge/.env`
   - **Why:** capture-oracle hits the bridge over localhost; DNS-rebinding
     allowlist must include 127.0.0.1 to accept those requests.
   - **PROD ACTION:** prod's `MCP_ALLOWED_HOSTS` must remain
     `finny.11mirror.com` (or whatever the prod hostname is) only.
3. **`~/.hermes/profiles/finny/.env`:** synced `API_SERVER_KEY` to match
   `/opt/finny/bridge/.env::FINNY_UPSTREAM_TOKEN`.
   - **Command run:** see `bridge-token-sync.sh`-equivalent
   - **Why:** fixes issue #38 — gateway was rejecting bridge calls because
     the active profile's `.env` held a stale key that overrode the systemd
     EnvironmentFile.
   - **PROD ACTION:** **REQUIRED on prod too.** If prod's gateway logs show
     `API server rejected invalid API key`, the same sync is needed there.
     Compare `~/.hermes/profiles/<active>/.env::API_SERVER_KEY` with
     `/opt/finny/bridge/.env::FINNY_UPSTREAM_TOKEN`; if they differ, sync.
4. `sudo systemctl restart finny-mcp` (after the env edits above)
5. `sudo -iu ubuntu systemctl --user restart hermes-gateway` (for the
   API_SERVER_KEY change in step 3)

## What was tested on staging

- [x] Direct gateway curl against `http://127.0.0.1:8642/v1/chat/completions`
      with bridge token → HTTP 200 with completion payload
- [x] Bridge `/mcp` reachable via eval-bypass over localhost → MCP
      `initialize` returns 200 with server capabilities
- [x] `eval/capture-oracle.ts` against staging captures 20/20 envelopes
      (no transport_errors, no 401s)
- [x] PII redaction grep returns zero hits on `eval/oracle/*.json`
- [x] `eval/cli.ts` baseline run on staging: 19/20 pass, 1 drift (q01).
      See `eval/runs/2026-06-30-staging-baseline.json` and
      `eval/oracle/REDACTION-MAP.md` "Known flaky queries" section.
- [ ] 5-tool smoke via browser Claude cowork: NOT re-run after the
      `MCP_ALLOWED_HOSTS` widen. Pre-existing OAuth flow still works
      because `finny.staging.11mirror.com` remains in the allowlist.

## Skipped on prod (staging-only changes)

- `EVAL_BYPASS_ENABLED=true` in `/opt/finny/bridge/.env` — eval-only,
  STRICTLY do not enable in prod.
- `127.0.0.1` and `127.0.0.1:3000` additions to `MCP_ALLOWED_HOSTS` —
  staging-only, eliminates a defence-in-depth layer that prod needs.

## Rollback

- `git revert <merge-sha>` on `finny-claude-plugin`.
- On staging only:
  1. Remove `EVAL_BYPASS_ENABLED` line from `/opt/finny/bridge/.env`.
  2. Reset `MCP_ALLOWED_HOSTS` to `finny.staging.11mirror.com` only.
  3. `sudo systemctl restart finny-mcp`.
- The bridge-side bypass code is dead code when `EVAL_BYPASS_ENABLED` is
  unset, so leaving it in the prod binary is harmless. But for cleanliness,
  the revert above removes the code path entirely.

## Notes / surprises

- Burned ~90 min on a curl-shell-escaping false-401: the gateway 401
  appeared to indicate auth drift, but the actual cause was a mangled JSON
  request body. Documented in user-level memory
  (`curl-401-vs-mangled-body.md`).
- The `hmac.compare_digest` in the gateway worked correctly all along; the
  fix was `~/.hermes/profiles/finny/.env::API_SERVER_KEY` sync. Hermes'
  profile-aware `.env` loader overrides the systemd `EnvironmentFile`.
- Eval baseline cannot reach 20/20 pass while q01 hits Finny's LLM live
  for `phase: 'discover'`. The proper fix is a deterministic
  discover short-circuit in `bridge/src/mcp/tools/query.ts`; deferred to a
  follow-up PR. q01 documented as known-flaky in `REDACTION-MAP.md`.
