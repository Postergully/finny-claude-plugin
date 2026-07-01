# Task 4.3 — Bridge principal + bank authz — staging manifest

**Branch:** `feature/task-4.3-bridge-principal`
**Spec:** `finny-core/docs/plan/implementation.md` Task 4.3 (post-2026-07-01
amendment: bank-authz only, no tool-role map).

## Non-git changes required on prod / staging

**This PR is mocked-only in tests. No smoke on staging required for merge.**
Verification code path is fully covered by unit tests using an in-memory
JWKS override (`bridge/src/auth/jwt-claims.test.ts`). No live Zitadel
call is made during test.

However, the shipped code becomes load-bearing at runtime once the
following env vars are present on the bridge's systemd unit
(`/etc/systemd/system/finny-mcp.service` `EnvironmentFile=`). Until they
are, `derivePrincipal` returns `null` (transitional path) and per-bank
checks no-op — matches current bridge behaviour, no regression.

### Env vars the operator MUST set before this becomes enforcing

Add to the bridge unit's `EnvironmentFile`:

- `ZITADEL_ISSUER` — the on-prem Zitadel issuer URL
  (e.g. `https://zitadel.staging.finny.local`).
- `ZITADEL_AUDIENCE` — the OAuth resource identifier the bridge accepts
  (e.g. `finny-bridge`).
- `ZITADEL_JWKS_URL` — the JWKS endpoint the bridge should fetch
  (e.g. `https://zitadel.staging.finny.local/oauth/v2/keys`).
- Optional: `ZITADEL_ROLES_CLAIM` — override for the roles claim key
  (defaults to `urn:zitadel:iam:org:project:roles`, the Zitadel legacy
  generic key; operators SHOULD pin the project-scoped key
  `urn:zitadel:iam:org:project:{projectId}:roles` once the project id is
  known).
- Optional: `ZITADEL_TENANT_CLAIM` — override for the tenant claim key
  (defaults to top-level `tenant_id`, matching
  `finny-core/CLAUDE.md` §Authz substrate step 4).

Once all three required vars are set + the bridge is restarted, principal
verification becomes strict fail-closed:

- Missing bearer token → `unauthorized` envelope.
- Invalid / expired / wrong-audience JWT → `unauthorized` envelope.
- Missing required claim (`sub`, `tenant_id`, role) → `unauthorized`
  envelope.
- Valid JWT → principal derived; subsequent bank checks (when hoisted
  into the bridge dispatcher in a follow-on task) run against
  `bank_acl.read` / `bank_acl.write` with the sealed-tenant prefix guard.

### Dependency on Task 3.2.5 Action

The bridge's `bank_acl` claim reader expects the `bank_acl` claim shape
`{ read: string[], write: string[] }` projected by the Zitadel Action
authored in Task 3.2.5 (staging Action id `379837029803884547`). If the
Action is not installed on the target Zitadel instance, `bank_acl` is
absent from the JWT and the bridge reads it as `{ read: [], write: [] }`
— all bank checks deny. Operator must confirm the Action is installed
before enabling Zitadel enforcement on the bridge.

### Package changes

- `bridge/package.json` — no changes; `jose@^6.2.3` was already a
  dependency of the bridge before this task.
- `pnpm-lock.yaml` — unchanged.

### git-only steps

Standard for this PR: `git fetch && git checkout main && pnpm install &&
pnpm -C bridge build && sudo systemctl restart finny-mcp`. No systemd
unit changes, no Caddy changes, no OAuth changes shipped in this PR
itself.

## What this PR ships (code diff summary)

- `bridge/src/auth/jwt-claims.ts` (new) — Zitadel JWKS verify + claim
  extraction (`sub`, `tenant_id`, `role`, `bank_acl`). Mirrors
  `finny-hermes-dashboard/src/server/jwt-verify.ts` shape.
- `bridge/src/auth/checks.ts` (new) — synchronous `canViewBank` +
  `canWriteBank` wrappers with sealed-tenant prefix guard.
- `bridge/src/mcp/tools/_shared/principal.ts` (new) — `derivePrincipal`
  reads only from `session.authInfo.token`; throws `PrincipalError` on
  failure when Zitadel is configured; returns `null` when not
  configured (transitional).
- `bridge/src/mcp/tools/{query,report,taskStatus,continue,remember}.ts` —
  each calls `derivePrincipal(session)` at handler entry; returns
  `unauthorized` envelope on `PrincipalError`.
- `bridge/src/server/tools-registration.ts` — threads MCP
  `RequestHandlerExtra.authInfo` into each tool as `session`.
- Colocated tests: `jwt-claims.test.ts`, `checks.test.ts`,
  `_shared/principal.test.ts` — mocked-only, no network.

## Not in this PR

- No `canCallTool` gate, no `TOOL_ROLE_MAP`. Tool-level enforcement is
  the downstream per-UID profile layer's job per Phase 4 preamble
  "Tool-assignment cascade".
- No bank-ID synthesis in bridge tool handlers. Per-bank enforcement
  fires at the point of bank access — the exports `canViewBank` /
  `canWriteBank` are the API surface for that follow-on wiring; today
  the point of bank access is downstream, not in the bridge.
- No prod Zitadel deploy. Staging Action id
  `379837029803884547` is the staging-scope runtime; prod Action
  ceremony is pending.

## Verification

- `pnpm -C bridge check:all` green.
- 531 tests passing, 12 skipped, 0 failing (baseline: 504 passing).
- Grep-negative gates all zero (`openfga-sdk`, `fga.{write,check,...}`,
  `getFgaClient`, `TOOL_ROLE_MAP`, `canCallTool`, `await canViewBank`,
  `await canWriteBank`).
- Brand-leak scan on `+` lines: zero
  (Hindsight / Hermes-profile / OpenFGA / FGA / hermes-workspace /
  hermes-gateway all absent).
- No `user_id` / `tenant_id` / `bank_id` fields added to any tool input
  schema.
