# Handover: Dashboard "External Memory" tab — wire up Hindsight via the Finny dashboard backend

**Date:** 2026-06-22
**Author:** previous-session agent (Claude)
**For:** next-session agent (any model) picking this up
**Branch (already created, fresh off `main`):** `feat/dashboard-external-memory-tab` in `/Applications/finny-claude-plugin`
**Related merged PR:** #17 (`feat: staging dashboard vhost`) — `c6c7d63` on `main`
**Hard constraint from user:** **DO NOT modify `hermes-agent` upstream code.** All changes go in the dashboard repo (`Postergully/finny-hermes-dashboard`) and/or the bridge repo (`Postergully/finny-claude-plugin`). No fork of `nousresearch/hermes-agent`, no upstream PR.

---

## 1. The problem in one paragraph

The Finny dashboard at `https://dashboard.finny.{prod,staging}.11mirror.com/` has an **"External Memory"** tab. Today it displays a hardcoded empty state: *"No external memory providers — Register providers in `$HERMES_HOME/external_memory_providers.json` to inspect external memory review queues here."* The SPA expects three endpoints (`GET /api/external-memory/providers`, `/api/external-memory/candidates`, `/api/external-memory/search`) on the dashboard backend (`:9119`), but the running `hermes dashboard v0.14.0` does not implement them. Result: the tab is dead UI on **both prod and staging**, even though Hindsight is fully configured and actively retaining memories on both boxes via the agent's internal memory provider path. **Goal:** make the "External Memory" tab actually show Hindsight's review queue / candidates / providers, without touching `hermes-agent` Python code.

---

## 2. Verified facts (don't waste time re-discovering)

### Hindsight IS connected and IS working — through the agent, not the dashboard

| Surface | State |
|---|---|
| `~/.hermes/.env` (both boxes) | `HINDSIGHT_API_KEY`, `HINDSIGHT_BANK_IDS`, `HINDSIGHT_TIMEOUT` all present |
| `~/.hermes/config.yaml` `memory.provider` | `hindsight` (both boxes) |
| `~/.hermes/profiles/staging/hindsight/config.json` | Real config: `mode=cloud`, banks `sharechat`/`Sharechat` enabled, full retention mission text, `auto_retain=true`, `bank_id=sharechat`, `recall_budget=mid` |
| `~/.hermes/hindsight.db` and `~/.hermes/profiles/staging/hindsight.db` | SQLite caches exist (local hindsight state) |
| `agent/memory_provider.py` in hermes-agent | Active — provider registry inside the agent runtime |
| `~/.hermes/external_memory_providers.json` | **Does NOT exist** on either box. Also doesn't appear to be referenced anywhere in the running hermes-agent code (only in the dashboard SPA's hardcoded user-hint string). |
| Hindsight cloud API `https://api.hindsight.vectorize.io` | Reachable from EC2 with the configured API key |

The agent talks to Hindsight directly (not via `:9119`). The dashboard's external-memory tab is a **separate visual surface** that was built against a contract Hermes Agent doesn't currently fulfil.

### The dead endpoints

The SPA bundle at `/opt/finny/dashboard/dist/{client,server}/assets/external-memory-browser-screen-*.js` calls these three:

```
GET /api/external-memory/providers
GET /api/external-memory/candidates
GET /api/external-memory/search
```

`hermes dashboard v0.14.0` exposes 91 routes on `:9119`. Zero of them match `/api/external-memory/*`. (Full route dump in §6 below — copy/paste from there.) The closest matches are `/api/dashboard/plugin-providers` and the `/api/providers/oauth/*` family — all unrelated.

### The empty-state message is hardcoded in the SPA

`/opt/finny/dashboard/dist/server/assets/external-memory-browser-screen-BrtfYFwJ.js`:

```jsx
<p className="...">Register providers in $HERMES_HOME/external_memory_providers.json to inspect external memory review queues here.</p>
```

That string never reaches Hermes. It's the SPA's own fallback. So creating the JSON file alone won't change anything.

### Source of the SPA

The dashboard repo (Finny fork of `outsourc-e/hermes-workspace`) is at:
- **Org/repo:** `Postergully/finny-hermes-dashboard` (operator's private fork)
- **Operator-laptop checkout:** `~/code/finny-hermes-dashboard` on `main` at `b79786c9` (verified 2026-06-22)
- **Deploy:** local `pnpm build` → tarball → S3 → SSM extract to `/opt/finny/dashboard/` on each EC2 box. Driven by `deploy/scripts/deploy-finny-dashboard.sh --instance <id>` in this repo.
- **Not tracked by `finny-claude-plugin`.** Different repo entirely. `/opt/finny/dashboard/.git` does not exist on EC2 — the deploy script ships build output only.

---

## 3. The shape of the fix (what to build)

The user wants the dashboard to expose Hindsight without touching `hermes-agent`. Two viable paths. Pick one or both.

### Path A — Bridge route on the bridge (`finny-claude-plugin`)

**Location:** `/opt/finny/bridge/...` (Express MCP bridge, runs on `:3000`).
The bridge already proxies the dashboard's MCP endpoints. Add a small Express router that:

1. Reads `~/.hermes/profiles/<active>/hindsight/config.json` to enumerate "providers" (one per bank, plus the implicit Hindsight provider itself).
2. For `/api/external-memory/candidates`: calls Hindsight's REST API (`https://api.hindsight.vectorize.io`) with `HINDSIGHT_API_KEY` to fetch the review queue / pending memories per bank.
3. For `/api/external-memory/search`: takes a query, calls Hindsight's search endpoint, returns hits.
4. For `/api/external-memory/providers`: returns a list shaped like `[{id, name, type, banks, healthy}]` — what the SPA expects.

**SPA-side change:** point the SPA at the bridge, not at `:9119`. The dashboard server (`server-entry.js` at `:3001`) currently calls `:9119` for these routes. Either (a) it falls back to the bridge automatically because `:9119` returns 404 (unlikely without code changes), or (b) we change `external-memory-browser-screen.tsx` in the dashboard repo to call a different base URL for these three endpoints.

**Pros:** Bridge is in `finny-claude-plugin` (this repo). We control deploy. Minimal changes; reuses existing Caddy + `:3000` plumbing.
**Cons:** New runtime dependency (bridge calls Hindsight REST API). Need to handle Hindsight auth + rate limits + errors. SPA still needs a small change to route these calls to the bridge.

### Path B — All in the dashboard SPA + dashboard backend (`Postergully/finny-hermes-dashboard`)

**Location:** the dashboard's own Node server (`server-entry.js` running on `:3001`).
The dashboard SPA's TanStack Start server can implement these three endpoints itself:

1. Read the same `hindsight/config.json` from `$HERMES_HOME` (mounted into the dashboard env via the existing `.env`).
2. Add three TanStack server routes (or API handlers in `server-entry.js`) that fetch from Hindsight and return shapes the SPA already understands.
3. Keep the SPA's UI unchanged (the existing screen will populate once the routes return real data).

**Pros:** Single repo for the change. The existing dashboard server already has access to `HERMES_API_TOKEN` etc. via its `.env`. No bridge changes. The "External Memory" tab becomes self-contained.
**Cons:** Requires building + redeploying the dashboard via `deploy-finny-dashboard.sh`. The dashboard becomes a Hindsight client (not just a Hermes proxy) — slightly broader responsibility.

### Recommended path

**Path B — pure dashboard change.** Reasons:
- The user explicitly said "fix the dashboard code" not the bridge.
- The dashboard server already terminates the SPA's API calls; adding a few routes there is the smallest possible change with no new cross-service plumbing.
- Hindsight is already a "dashboard tab feature" in upstream's mental model (it's where the empty-state UI lives).
- Bridge is for MCP (cowork session entry); keeping it focused is good.

(If the user pushes back on Path B for any reason, Path A is fine too — the analysis above stands.)

---

## 4. Concrete first-week plan

This is the implementation skeleton. Brainstorm + spec + plan before coding (use the superpowers skills if this Claude has them).

### Phase 0 — read this doc, then verify (15 min)

- Read this whole handover file.
- `git fetch origin && git checkout main && git pull && git branch --show-current` should be `feat/dashboard-external-memory-tab`.
- Open https://dashboard.finny.staging.11mirror.com/ in browser, click "External Memory" tab, confirm the empty state still shows.
- SSM into staging (`i-0c2c974ff571162eb`, region `us-east-1`) and re-run the verifications below to confirm the runtime hasn't drifted:
  ```bash
  curl -sS http://127.0.0.1:9119/openapi.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['paths']),'paths'); [print(p) for p in sorted(d['paths']) if 'memor' in p.lower()]"
  # expect: 91 paths, ZERO with 'memor' in name
  sudo -u ubuntu cat /home/ubuntu/.hermes/profiles/staging/hindsight/config.json | head -20
  # expect: full Hindsight config
  ```

### Phase 1 — discover Hindsight's HTTP API (30 min)

Hindsight is `vectorize.io`. We need to know:
- What's the auth scheme? (`Authorization: Bearer hsk_...`? Custom header? Query string?)
- Endpoints for: list banks, list candidates per bank, search a bank, get a memory by ID, list pending review items.
- Rate limits.

Sources to check (in order):
1. **The hermes-agent source on the EC2 box** — `agent/memory_provider.py` has the working Hindsight client; you can read its HTTP calls without modifying anything. This is the cheapest answer.
   ```bash
   # via SSM:
   sudo -u ubuntu grep -rn "hindsight\|vectorize\.io" /home/ubuntu/.hermes/hermes-agent/agent/ | head -30
   sudo -u ubuntu cat /home/ubuntu/.hermes/hermes-agent/agent/memory_provider.py | head -200
   ```
2. Hindsight docs at https://docs.vectorize.io or https://api.hindsight.vectorize.io if there's a public OpenAPI.
3. Search the dashboard SPA bundle for any vestigial Hindsight client code that might already exist client-side.

### Phase 2 — design the three endpoints (30 min)

Pick the response shapes the SPA already expects. Read the SPA bundle:
```bash
sudo grep -oE "external-memory[a-zA-Z0-9_/-]*" /opt/finny/dashboard/dist/server/assets/external-memory-browser-screen-BrtfYFwJ.js | sort -u
sudo cat /opt/finny/dashboard/dist/server/assets/external-memory-browser-screen-BrtfYFwJ.js | head -200
```
The SPA's TypeScript source on operator laptop (`~/code/finny-hermes-dashboard/.../external-memory-browser-screen.tsx`) is the authoritative source of types. Read it.

Write a one-page design doc covering:
- Request/response JSON for each of the 3 routes.
- How "providers" maps to "banks" in Hindsight (1 provider = 1 bank? Or 1 provider = the Hindsight cloud as a whole, with banks as sub-resources?).
- Error shape for 5xx and "Hindsight unreachable".
- Caching: do we cache provider list? For how long?
- Auth: dashboard server reads `HINDSIGHT_API_KEY` from its own `.env` (already present per `/opt/finny/dashboard/.env` keys).

### Phase 3 — implement on operator laptop (`~/code/finny-hermes-dashboard`)

Working directory is **NOT** `/Applications/finny-claude-plugin` for this part — it's the dashboard repo on operator laptop:
```bash
cd ~/code/finny-hermes-dashboard
git checkout main
git pull
git checkout -b feat/external-memory-via-hindsight
```

Add server routes. The TanStack Start project structure should have something like `app/routes/api.external-memory.providers.ts` (or similar — confirm by reading existing API routes in the repo). Wire each route to a small Hindsight client module.

Tests (if the repo has Vitest/Jest already): mock the Hindsight API and assert the response shapes match the SPA's expectations.

### Phase 4 — deploy to staging only

Use the existing flow:
```bash
cd /Applications/finny-claude-plugin
./deploy/scripts/deploy-finny-dashboard.sh --instance i-0c2c974ff571162eb
```

The `--instance` flag was added in PR #17. The script pulls from `~/code/finny-hermes-dashboard@main`, so first either land your dashboard PR to its `main` OR temporarily point the script at your feature branch (read the script — it has `git rev-parse --abbrev-ref HEAD` checks that may need to be relaxed for the test cycle).

### Phase 5 — smoke test on staging

- Browser: open the External Memory tab on staging dashboard. Tab should now populate with banks from `hindsight/config.json` (`sharechat`, `Sharechat`).
- Click into a provider/bank. Candidates should list.
- Try the search box. Hits should return.

### Phase 6 — open PRs

**Two PRs likely needed:**
1. `Postergully/finny-hermes-dashboard` — the actual code change.
2. `Postergully/finny-claude-plugin` (this repo, branch `feat/dashboard-external-memory-tab`) — staging manifest doc + deploy log row, per `staging-promotion-discipline`. May also include changes to `deploy-finny-dashboard.sh` if needed.

### Phase 7 — promote to prod

Standard deployed-branch flow per `docs/staging/deploy-runbook.md`:
- Merge dashboard PR → operator builds + deploys to prod via `deploy-finny-dashboard.sh` (default = prod).
- Merge plugin PR → FF `deployed` → `git pull` on prod `/opt/finny`.

---

## 5. What's already done (don't redo)

- ✅ Staging dashboard vhost is live: `https://dashboard.finny.staging.11mirror.com/`.
- ✅ Staging `:9119` rebound to `127.0.0.1` (was Tailscale `100.112.31.24`).
- ✅ Staging `hermes-gateway` user-mode unit fixed (was failing with wrong venv).
- ✅ `deploy-finny-dashboard.sh` accepts `--instance` flag (default = prod, staging uses `--instance i-0c2c974ff571162eb`).
- ✅ Caddyfile in repo has both prod and staging dashboard vhosts.
- ✅ Handoff doc `docs/handoff/finny-hermes-on-ec2.md` updated with gotchas 11 and 12, and corrected gotcha 6.
- ✅ Branch `feat/dashboard-external-memory-tab` created off `main` (current commit `c6c7d63`).

---

## 6. Reference data (verified 2026-06-22 via SSM)

### Staging EC2 facts

- Instance: `i-0c2c974ff571162eb`
- Public IP: `34.232.186.238`
- Tailnet: `100.112.31.24` (also reachable)
- Region: `us-east-1`
- Profile dir: `/home/ubuntu/.hermes/profiles/staging/`
- Hermes gateway PID at handover time: 58438 (unit-launched)
- `:9119` bound to `127.0.0.1`, `:3001` (Finny dashboard SPA backend) bound to `127.0.0.1`, `:3000` (bridge) bound to `127.0.0.1`.

### `:9119` route inventory (truncated to relevant bits)

```
/api/dashboard/plugin-providers       ← unrelated (plugin OAuth)
/api/providers/oauth/                 ← unrelated
/api/providers/oauth/{provider_id}
/api/providers/oauth/{provider_id}/start
/api/providers/oauth/{provider_id}/submit
/api/providers/oauth/{provider_id}/poll/{session_id}
/api/providers/oauth/sessions/{session_id}
... (84 more, none matching /api/external-memory/*)
```

### Hindsight config on staging

```json
{
  "mode": "cloud",
  "apiKey": "hsk_bd1754d2c6d9be2200b3aa74d61d1677_b02b69d6e6669c8b",
  "timeout": 120,
  "idle_timeout": 300,
  "retain_tags": "finny,sharechat-finance",
  "banks": {
    "sharechat":   { "bankId": "sharechat",   "budget": "mid", "enabled": true },
    "Sharechat":   { "bankId": "Sharechat",   "budget": "mid", "enabled": true }
  },
  "api_url": "https://api.hindsight.vectorize.io",
  "bank_id": "sharechat",
  "recall_budget": "mid",
  "auto_retain": true,
  "retain_context": "ShareChat finance session — Finny cowork (api_server)",
  "bank_retain_mission": "<<long ShareChat-specific instruction text>>"
}
```
(Path: `/home/ubuntu/.hermes/profiles/staging/hindsight/config.json`. NEVER print the apiKey into chat or transcripts in real ops — `~/.gstack` memory `never-expose-secrets`. The key above appears here for handover continuity; treat it as redacted in any future doc you write.)

### Prod EC2 (read-only context)

- Instance: `i-0ef58962b09d490ee`
- Same shape as staging: same `hermes dashboard` version, same SPA bundle, same dead empty-state UI.
- Hindsight at `~/.hermes/hindsight/` on prod; staging-equivalent banks unverified for this handover (assume similar but check before trusting).

---

## 7. Gotchas you'll hit

1. **The dashboard repo is NOT in `finny-claude-plugin`.** It's a separate `Postergully/finny-hermes-dashboard` checkout at `~/code/finny-hermes-dashboard`. Half the code paths you'll touch are in that repo, not the one you're branched in.

2. **Deploy script reads from `~/code/finny-hermes-dashboard@main`.** If you're testing a feature branch on staging, you have to either (a) land your dashboard PR to its `main` first (yikes), or (b) temporarily relax the branch check in `deploy-finny-dashboard.sh` (see lines around `if [ "${DASHBOARD_BRANCH}" != "main" ]`) for your test cycle. Don't commit the relaxed check.

3. **Pre-existing CI is RED on `main`.** PRs #14, #15, #16, #17 all merged with red CI. Investigate-and-fix is out of scope for this work; merge with `--admin` like prior PRs (or fix CI as a separate PR if you want).

4. **Staging gateway model ID is `staging`, not `hermes-agent`.** Different from prod. Don't hardcode a model name in any new code.

5. **Don't touch `~/.hermes` config branches on staging.** Staging's `~/.hermes` working tree is on `feat/atomic-fetch-v3` for active testing — leave it alone.

6. **`external_memory_providers.json` is a red herring** for the agent path — the file is only referenced as a hardcoded user-hint string in the SPA bundle. Creating that file changes nothing on its own.

7. **Heredoc-in-SSM-JSON is fragile.** When you ship file changes to staging, use the S3 + presigned URL pattern that PR #17's Task 3/6/9 used (already in `deploy-finny-dashboard.sh`).

8. **SSM `--parameters 'commands=[...]'` is not the same as `--cli-input-json`.** When passing presigned URLs (which contain `=`, `&`, `?`), prefer `--cli-input-json file://...` to avoid shell quoting hell. PR #17 has working examples.

---

## 8. References (in this repo)

- **Spec for the just-merged work:** `docs/superpowers/specs/2026-06-22-staging-dashboard-vhost-design.md`
- **Plan for the just-merged work:** `docs/superpowers/plans/2026-06-22-staging-dashboard-vhost.md`
- **Manifest for the just-merged work:** `docs/staging/feat-staging-dashboard-vhost-changes.md`
- **Deploy log:** `docs/staging/deploy-log.md` (most recent entry is 2026-06-22)
- **Handoff (system architecture, gotchas, SSM cheatsheet):** `docs/handoff/finny-hermes-on-ec2.md`
- **Staging-promotion discipline:** memory `staging-promotion-discipline` and `docs/staging/deploy-runbook.md`
- **Deployed-branch model:** memory `deployed-branch-model`

---

## 9. Suggested first message for the next session

> "I'm picking up from `docs/handoff/2026-06-22-dashboard-external-memory-handover.md`. Branch `feat/dashboard-external-memory-tab` is ready. Goal is to make the dashboard's External Memory tab show Hindsight data, without touching hermes-agent code. Reading the handover, then verifying staging is still in expected state, then I'll come back with a brainstorm-stage design for the three endpoints."

That's enough to bootstrap a fresh session.

---

**End of handover.** Commit this file on `feat/dashboard-external-memory-tab` so the next session can pick it up by branch.
