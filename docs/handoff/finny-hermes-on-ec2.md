# Finny / Hermes Agent on prod EC2 — handoff

**Audience:** another agent (or human) who needs to talk to the Hermes agent that powers Finny on prod, without breaking it.
**Last verified:** 2026-06-22 (staging fields verified via SSM; gotchas 11–12 added)
**Source of truth:** the prod box itself. Re-verify with the SSM commands at the bottom before trusting any specific path/port — drift is real.

┌──────────────────┬────────────────────────────┬─────────────────────────────────────────────────────────┐
  │                  │            Prod            │                          Staging                        │
  ├──────────────────┼────────────────────────────┼─────────────────────────────────────────────────────────┤
  │ Instance         │ i-0ef58962b09d490ee        │ i-0c2c974ff571162eb (Name=finny-staging)                │
  ├──────────────────┼────────────────────────────┼─────────────────────────────────────────────────────────┤
  │ Public IP        │ Elastic IP 34.200.24.169   │ 34.232.186.238 (PUBLIC — verified 2026-06-22 via SSM)   │
  │                  │                            │ Tailnet 100.112.31.24 also reachable                    │
  ├──────────────────┼────────────────────────────┼─────────────────────────────────────────────────────────┤
  │ Gateway :8642    │ 127.0.0.1:8642 on prod box │ 127.0.0.1:8642 (running NOT via the system unit         │
  │                  │                            │ — see §6 gotcha 11)                                     │
  ├──────────────────┼────────────────────────────┼─────────────────────────────────────────────────────────┤
  │ :9119 dashboard  │ 127.0.0.1:9119 (loopback)  │ bound to 100.112.31.24:9119 (Tailscale interface) —     │
  │ API              │ — fixed by PR #16          │ MUST rebind to 127.0.0.1 (see §6 gotcha 12)             │
  ├──────────────────┼────────────────────────────┼─────────────────────────────────────────────────────────┤
  │ /opt/finny SHA   │ faf4215 (deployed)         │ a40d868 (deployed) — 2 commits behind: PR #13 + #16     │
  ├──────────────────┼────────────────────────────┼─────────────────────────────────────────────────────────┤
  │ Snapshot lineage │ source of truth            │ derived from prod (stagesnap-20260617-182341)           │
  ├──────────────────┼────────────────────────────┼─────────────────────────────────────────────────────────┤
  │ Secrets          │ own API_SERVER_KEY         │ own (different) API_SERVER_KEY after refresh            │


---

## 1. The shape of the system

```
   Internet (TLS via Caddy)
        │
   ┌────┴─────────────────────────────────────────────────┐
   │                                                      │
finny.prod.11mirror.com                dashboard.finny.prod.11mirror.com
   │                                                      │
443 → 127.0.0.1:3000                    443 → 127.0.0.1:3001
   │                                                      │
finny-mcp.service                       finny-dashboard.service
(system, /opt/finny/bridge)             (system, /opt/finny/dashboard)
OAuth 2.1 protected                     NO AUTH (v1, will tighten)
   │                                                      │
   └──────── both call → 127.0.0.1:8642 ──────────────────┘
                                  │
                       hermes-gateway.service
                       (USER-mode systemd, ubuntu)
                       /home/ubuntu/.hermes/hermes-agent/
                          venv/bin/python
                          -m hermes_cli.main gateway run --replace

                       Reads: /home/ubuntu/.hermes/.env
                              /home/ubuntu/.hermes/AGENTS.md
                              /home/ubuntu/.hermes/SOUL.md
                              /home/ubuntu/.hermes/config.yaml
```

EC2 instance: `i-0ef58962b09d490ee` (Elastic IP `34.200.24.169`).
Caddy is a system unit. The two `finny-*` Node services are system units. The Hermes gateway is a **user-mode** systemd unit owned by `ubuntu` — that's why `systemctl status hermes-gateway` from root shows nothing; you have to use `sudo -iu ubuntu systemctl --user status hermes-gateway`.

## 2. Hermes Agent specifics on this box

| Property | Value |
|---|---|
| Version | `Hermes Agent v0.14.0 (2026.5.16)` |
| Install path | `/home/ubuntu/.hermes/hermes-agent/` |
| Python venv | `/home/ubuntu/.hermes/hermes-agent/venv/` |
| `HERMES_HOME` | `/home/ubuntu/.hermes` |
| `TERMINAL_CWD` | **NOT set** (intentional — see §6 gotcha 1) |
| Working directory of process | `/home/ubuntu/.hermes/hermes-agent` (from systemd unit) |
| User-mode unit file | `/home/ubuntu/.config/systemd/user/hermes-gateway.service` |
| Active git branch | `deployed` on `~/.hermes`, `~/.hermes/hermes-agent`, and each profile checkout |
| Active model | `us.anthropic.claude-sonnet-4-6` via Bedrock (`bedrock-runtime.us-east-1.amazonaws.com`) |
| Max turns per session | 90 |
| Models exposed | One ID `"hermes-agent"` (gateway abstracts the actual model behind it) |

The gateway speaks an OpenAI-compatible HTTP API. The dashboard talks to it. The MCP bridge talks to it. From the agent's perspective, `model="hermes-agent"` is a meta-model — the gateway picks the underlying provider/model from `~/.hermes/config.yaml`.

## 3. Profiles — what's there, what's "active"

```
/home/ubuntu/.hermes/                       ← THE ACTIVE CONFIG ("default")
├── .env                                    ← active secrets
├── AGENTS.md                                ← active agent instructions
├── SOUL.md                                  ← active persona
├── config.yaml                              ← model + provider config
├── hermes-agent/                            ← agent code (git: deployed branch)
└── profiles/
    ├── finny/                               ← alternate workspace, NOT active
    └── stagesnap-20260617-182341/           ← snapshot from staging refresh
```

**There is no `profiles/default/` directory.** The "default profile" IS the contents of `~/.hermes` itself at the root (`AGENTS.md`, `SOUL.md`, `.env`, `config.yaml`). That's a Hermes convention many people miss: profiles override the root, the root IS the active baseline.

| Profile | Purpose | When used |
|---|---|---|
| `~/.hermes/` (root) | **Prod default** — what the running gateway uses today | Always, on this box |
| `~/.hermes/profiles/finny/` | Staging-flavored workspace (separate `deployed`-branch checkout — same SHA as `~/.hermes` per memory `staging-runtime-checkout`) | Only if a gateway is started with `TERMINAL_CWD=/home/ubuntu/.hermes/profiles/finny` |
| `~/.hermes/profiles/stagesnap-20260617-182341/` | Frozen snapshot from a past staging refresh | Reference only; not running |

**Prod and staging diverge here:** prod runs against the *root* `~/.hermes` with no `TERMINAL_CWD`. Staging (a different EC2 box, `finny-staging`, tailnet `100.112.31.24`) runs the gateway with `TERMINAL_CWD` pointed at its own profile checkout. Crossing those wires breaks the active profile silently — see gotcha 1.

## 4. How to talk to the gateway

The gateway listens on **`127.0.0.1:8642`** loopback only. Never internet-reachable. Two ways in:

### Option A — through the MCP bridge (browser Claude cowork)

URL: `https://finny.prod.11mirror.com/mcp`
Auth: OAuth 2.1 (discovery at `/.well-known/oauth-authorization-server`).
Use this when you want Finny to be one of your tools in a chat host that supports MCP.
Do NOT call the gateway directly from outside — there is no public route.

### Option B — through the dashboard UI (humans)

URL: `https://dashboard.finny.prod.11mirror.com/`
Auth: **None in v1.** Anyone with the URL gets full UI including Terminal, Files, Memory, MCP, Skills tabs. Tab gating + auth deferred to v2.
Both Caddy vhosts terminate TLS and reverse-proxy to loopback.

### Option C — direct (only via SSH/SSM into the box)

```bash
# inside EC2:
TOKEN=$(grep ^API_SERVER_KEY= /home/ubuntu/.hermes/.env | cut -d= -f2-)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8642/v1/models
curl -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"model":"hermes-agent","messages":[{"role":"user","content":"hi"}]}' \
     http://127.0.0.1:8642/v1/chat/completions
```

The bearer token is the value of `API_SERVER_KEY` in `~/.hermes/.env`. Without it, the gateway returns `401`. **Never echo the value into transcripts** (memory: `never-expose-secrets`); use length-and-hash-prefix comparisons if you need to verify a match.

## 5. What the dashboard UI calls

Browser-side, the dashboard SPA is a TanStack Start app that hits its own server (`server-entry.js` at port 3001). The server then calls the Hermes gateway. Two layers, two URLs.

What the **dashboard server** calls upstream:

| Endpoint | Purpose | Required for |
|---|---|---|
| `GET http://127.0.0.1:8642/health` | gateway alive? | startup banner |
| `GET http://127.0.0.1:8642/v1/models` | model list (currently returns just `"hermes-agent"`) | model selector |
| `POST http://127.0.0.1:8642/v1/chat/completions` | actual chat (streaming SSE) | the chat tab |
| `GET http://127.0.0.1:9119/...` | Sessions, Skills, Config, Jobs APIs | Sessions/Skills/Config tabs |

That last row is the **`hermes dashboard`** service — a SEPARATE process you start with `hermes dashboard`. **As of 2026-06-20 this IS running on prod** (PR #16 enabled it; verified `curl http://127.0.0.1:9119/` → 200 on 2026-06-22). The text below describes the FAILURE MODE before the fix, kept for diagnostic value. Symptom you'll still see in prod journald is a softer one — `mode=zero-fork` instead of `mode=portable` — meaning the SPA hasn't claimed a fork even though `:9119` is up.

```
mode=portable
core=[health, chatCompletions, models, streaming]
enhanced=[memory, jobs]
missing=[sessions, skills, config]
```

`mode=portable` means: chat works, but the Sessions/Skills/Config tabs in the UI are degraded. The chat tab can still send messages — but the model selector falls back to gateway capabilities, and if the user hasn't explicitly picked a model, the composer rejects sends with a "Retry" prompt and never hits the wire.

**Symptoms when this trips you up:**
- You type a message, hit Enter, it shows "Retry" in red, and the gateway log shows ZERO `POST /v1/chat/completions` for that timestamp. The dashboard frontend gave up before sending.
- Dashboard journald spams `[model-info] falling back to gateway capabilities (source=gateway-capabilities mode=portable)`.

**Fix:** either start `hermes dashboard` on `:9119` as a second user-mode systemd unit (proper), OR pick a provider+model explicitly in Settings → Provider in the UI and the composer will start sending (workaround).

## 6. Gotchas

### 1. `TERMINAL_CWD` direction depends on prod vs staging

Hermes loads `AGENTS.md`/`SOUL.md`/`CLAUDE.md` from `$TERMINAL_CWD` (or `os.getcwd()` if unset), **not** from `$HERMES_HOME`. See `~/.claude/projects/-Applications-finny-claude-plugin/memory/hermes-context-cwd.md`.

- **Prod:** `TERMINAL_CWD` must NOT be set. The systemd unit's `WorkingDirectory=/home/ubuntu/.hermes/hermes-agent` and the gateway falls back through to `os.getcwd()` and ends up loading `~/.hermes/AGENTS.md` correctly.
- **Staging:** `TERMINAL_CWD` MUST be set to the staging profile path (e.g. `/home/ubuntu/.hermes/profiles/staging`). Without it, staging silently runs against prod-equivalent config.

If `agent.prompt_builder` shows `Context file blocked: prompt_injection` or `CONTEXT (0 chars)` in the assembled system prompt, you've miswired this.

### 2. Two Hermes venvs on the box

Per memory `hermes-venv-mismatch`: there are TWO Python venvs:
- `~/hermes-venv/` — older, what the (non-existent) `hermes-api.service` system unit *would* point at.
- `~/.hermes/hermes-agent/venv/` — the one the running user-mode unit actually uses.

Don't restart the gateway by editing `hermes-api.service` — that unit doesn't exist on this box. Use `sudo -iu ubuntu systemctl --user restart hermes-gateway`.

### 3. Editing `.env` doesn't reach a running gateway

Per memory `slack-token-rotation`: changing `~/.hermes/.env` does NOT live-reload into the gateway process. You must restart it: `sudo -iu ubuntu systemctl --user restart hermes-gateway`.

### 4. SOUL.md keeps getting blocked as prompt-injection

In journald you'll see repeated `WARNING agent.prompt_builder: Context file SOUL.md blocked: prompt_injection`. The Hermes prompt-builder has a guardrail that's flagging the existing `~/.hermes/SOUL.md`. Pre-existing issue; means SOUL.md isn't loading into agent context — Finny's persona behavior is degraded. NOT caused by anything in this dashboard work.

### 5. No `hermes-api.service` — there's `hermes-gateway` instead

If you write a new systemd unit and add `Requires=hermes-api.service` or `After=hermes-api.service`, systemd will refuse to start your unit because `hermes-api` is not a known unit on this box. Use `Wants=network-online.target` and trust the user-mode `hermes-gateway` to come up independently.

### 6. The dashboard repo and the bridge repo are SEPARATE

| Repo | Purpose | Path on prod |
|---|---|---|
| `Postergully/finny-claude-plugin` | Bridge code + dashboard SPA + all infra (systemd, Caddy, manifests) | `/opt/finny/` (dashboard at `/opt/finny/dashboard/` is a SUBDIRECTORY of this repo, NOT a separate checkout — verified 2026-06-22) |
| `hermes-agent` (NousResearch upstream) | The agent runtime itself | `/home/ubuntu/.hermes/hermes-agent/` |

Each follows the **deployed-branch model**: `git log deployed..main` per repo answers "what's pending deploy?". Don't FF `deployed` to `main` blindly — other folks' PRs may have merged into `main` without staging manifests, and you'd silently deploy them. Use cherry-pick when you want to scope a deploy to one PR.

### 7. `/etc/caddy/Caddyfile` is NOT symlinked to the repo

The live `/etc/caddy/Caddyfile` on prod is a regular file, hand-managed. Edits to `/opt/finny/deploy/caddy/Caddyfile` in the repo don't reach Caddy until someone explicitly copies them. The two have drifted (the live file has an `/auth-test` handler that's not in the repo). When you reload Caddy, you're reloading whatever's at `/etc/caddy/Caddyfile`, not the repo file.

### 8. The dashboard spawns real PTYs

`finny-dashboard.service` spawns `python3 dist/server/assets/pty-helper.py /home/ubuntu ...` for the Files/Terminal tabs. These are real `/bin/bash` PTYs running as `ubuntu` on the prod box. Combined with the v1 no-auth posture, this is a real exposure: anyone with the URL gets a shell on prod EC2.

### 9. Bedrock auth is on the EC2 instance role, not in `.env`

The model is Bedrock-backed. The gateway gets AWS credentials from the **EC2 instance role** `hermes-bedrock-HermesInstanceRole-...` — you won't find an `AWS_*` key in `~/.hermes/.env`. If you move this code to a non-EC2 host, you'll need to provide AWS credentials some other way.

### 10. Same `.env` on multiple boxes ≠ same secrets

Staging EC2 (`finny-staging`, tailnet `100.112.31.24`) is a snapshot derived from prod (`stagesnap-20260617-182341` is the marker). After a refresh it will have different `API_SERVER_KEY`, different gateway, different everything. The dashboard's `.env` has a token that came from THIS box's `~/.hermes/.env`. If you redeploy the dashboard to a different box, regenerate it from THAT box's `.env`.

### 11. Staging's `hermes-gateway` user-unit is broken; live gateway is an orphan from a one-shot script

Verified 2026-06-22 on staging (`i-0c2c974ff571162eb`) — full investigation report in spec `docs/superpowers/specs/2026-06-22-staging-dashboard-vhost-design.md` §2.

The "system unit" suspicion was wrong. There is **no system-level** `hermes-gateway.service`. What exists is a **user-mode** unit at `/home/ubuntu/.config/systemd/user/hermes-gateway.service` (owned by `systemd --user` PID 761), with `Linger=yes` for user `ubuntu` so it persists after logout. Status:

- **Failed (exit-code 1) since 2026-06-18 03:25:43.** `ExecStart` points at the wrong venv `/home/ubuntu/hermes-venv/bin/python` (memory `hermes-venv-mismatch`).
- A `hermes-gateway.service.pre-staging.bak` sibling exists from a hand-edit on 2026-06-15.
- The unit IS `enabled` in `default.target.wants` and **will auto-start at boot/linger**.

The actual live gateway on `:8642` is **PID 33143**, an **orphan** from a one-shot script. Provenance:

```
2026-06-18 09:15:53 UTC — root ran:
  sudo -iu ubuntu bash --login -c 'bash -lc bash\ /tmp/start_gateway_proper.sh ...'
The login shell exited at 09:16:04, but /tmp/start_gateway_proper.sh
had already forked the gateway and detached. Linger=yes kept the orphan
alive. PPid=1 (reparented to init).
```

It runs in cgroup `user.slice/user-1000.slice/session-c368.scope` (state `closing`) — **NOT** under any `.service`. Cmdline: `/home/ubuntu/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main gateway run --replace`. Working dir at probe: `/home/ubuntu/.hermes/profiles/staging`.

**Why this is a reboot footgun:** on next reboot, `systemd --user` will try to start the broken `hermes-gateway` unit. Its `gateway run --replace` semantics will SIGTERM whatever's holding `:8642` (the orphan), then itself fail. Result: staging has no gateway after reboot.

**Cleanup recommendation (executed during the staging-dashboard plan, NOT here):**
1. Stop the orphan PID 33143 cleanly.
2. Edit the user-mode unit so `ExecStart`, `WorkingDirectory`, `VIRTUAL_ENV`, and `PATH` reference `/home/ubuntu/.hermes/hermes-agent/venv`.
3. Add `Environment=TERMINAL_CWD=/home/ubuntu/.hermes/profiles/staging` to match the orphan's `cwd`.
4. `systemctl --user daemon-reload && systemctl --user restart hermes-gateway`.
5. Remove `.pre-staging.bak`.

Masking is wrong — the unit is the intended supervisor; it just has stale paths. Reference: cross-check `hermes-dashboard.service` (sibling user unit, currently `active running`) for the right path conventions.

Command IDs for re-verification (us-east-1, `i-0c2c974ff571162eb`): `2f8f2f19`, `a435c6cc`, `1f0fa9a0`, `8e36fc45`.

### 12. Staging `hermes-dashboard.service` (`:9119`) binds to Tailscale, not loopback

Verified 2026-06-22 on staging:

```
LISTEN 0 2048 100.112.31.24:9119 0.0.0.0:* users:(("hermes",pid=2772,fd=14))
```

Prod (PR #16) binds `:9119` to `127.0.0.1`. The dashboard SPA's server-side calls assume loopback. Until staging is rebound to `127.0.0.1:9119`, the staging dashboard's Sessions/Skills/Config/Memory/Jobs tabs will not work — the SPA will fall back to gateway capabilities (the `mode=zero-fork` / `mode=portable` warning in §5).

Fix path: either (a) re-run the PR #16 manifest on staging after FF'ing `/opt/finny` to `faf4215` (it likely sets the bind correctly because prod ended up correct), or (b) edit the staging unit's bind argument explicitly. Verify with `curl http://127.0.0.1:9119/` returning 200 (not connection-refused).

## 7. SSM cheatsheet — re-verify reality before trusting this doc

```bash
# Instance: i-0ef58962b09d490ee, region: us-east-1

# Are the right services up?
aws ssm send-command --instance-ids i-0ef58962b09d490ee \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["systemctl list-units --type=service --state=active | grep -E \"caddy|finny\"","sudo -iu ubuntu systemctl --user list-units | grep hermes"]' \
  --query "Command.CommandId" --output text

# Is the gateway listening + on what port?
... commands=["sudo ss -tlnp | grep -E \"3000|3001|8642|9119\""]

# Are the right env keys present (no values echoed)?
... commands=["sudo -u ubuntu bash -c \"grep -oE ^[A-Z_]+= /home/ubuntu/.hermes/.env | sort -u\""]

# Probe the gateway end-to-end (read TOKEN on the box, never on laptop)
... commands=["TOKEN=$(sudo -u ubuntu bash -c \"grep ^API_SERVER_KEY= /home/ubuntu/.hermes/.env | cut -d= -f2-\")","curl -sS -H \"Authorization: Bearer $TOKEN\" http://127.0.0.1:8642/v1/models | head"]

# What branch is each repo on prod?
... commands=["sudo -u ubuntu git -C /opt/finny rev-parse --abbrev-ref HEAD","sudo -u ubuntu git -C /opt/finny/dashboard rev-parse --abbrev-ref HEAD","sudo -u ubuntu git -C /home/ubuntu/.hermes rev-parse --abbrev-ref HEAD","sudo -u ubuntu git -C /home/ubuntu/.hermes/hermes-agent rev-parse --abbrev-ref HEAD"]

# Read the journal for diagnosis
... commands=["sudo journalctl -u finny-dashboard -n 60 --no-pager","sudo journalctl -u finny-mcp -n 60 --no-pager","sudo -iu ubuntu journalctl --user -u hermes-gateway -n 60 --no-pager"]

# Restart the gateway (after editing .env or upgrading)
... commands=["sudo -iu ubuntu systemctl --user restart hermes-gateway","sleep 3","sudo -iu ubuntu systemctl --user status hermes-gateway --no-pager | head -10"]

# Restart the dashboard
... commands=["sudo systemctl restart finny-dashboard","sleep 3","sudo systemctl status finny-dashboard --no-pager | head -10","curl -sS -o /dev/null -w \"loopback: %{http_code}\\n\" http://127.0.0.1:3001/"]
```

For each command, `aws ssm get-command-invocation --command-id <id> --instance-id i-0ef58962b09d490ee --query StandardOutputContent --output text` reads the output.

## 8. Where to look next

| Want to know | Where |
|---|---|
| What changed in the dashboard fork vs upstream | `11mirror/finny-hermes-dashboard:BRAND.md` |
| How a deploy is supposed to flow | `finny-claude-plugin:docs/staging/README.md` + `deploy-runbook.md` |
| What's deployed vs pending on each repo | `git log deployed..main` per repo |
| Recent agent failures, tool errors | `sudo -iu ubuntu journalctl --user -u hermes-gateway --since "1 hour ago"` |
| Active model + provider | `sudo -u ubuntu /home/ubuntu/.hermes/hermes-agent/venv/bin/hermes config show` |
| Why a context file isn't loading | grep `prompt_builder` in gateway logs (see gotcha 4) |
| Whether the dashboard SPA is the issue or the agent is | the agent reads from `127.0.0.1:8642` — `curl` it directly with the bearer token (option C above) to bypass everything UI |

## 9. Prod ↔ Staging isolation & promotion

This section is the contract for "I want to try X on staging without risk to prod."

### 9.1 Model / config isolation

Staging EC2 (`finny-staging`, tailnet `100.112.31.24`) and prod EC2 (`i-0ef58962b09d490ee`) each have their **own** `~/.hermes/config.yaml`, their **own** `~/.hermes/.env`, and their **own** checkout of the `finny-hermes-config` repo at `~/.hermes` (see `deployed-branch-model` memory). Editing `config.yaml` on staging:

- Does NOT touch prod. Prod's gateway only sees a change after the `deployed` branch on `finny-hermes-config` is fast-forwarded **and** prod runs `git pull` on `~/.hermes` + the gateway is restarted (gotcha 3 — no live reload).
- The model list surfaced in the dashboard model selector comes from `:9119` (`hermes dashboard` API — see §5). That's a per-box service too, so even after a config change, what the dashboard *shows* depends on `:9119` running on that box.

### 9.2 AWS Bedrock router (Application Inference Profile / intelligent prompt routing)

Per gotcha 9, Bedrock credentials come from the EC2 instance role, NOT `.env`. Staging has a different instance role from prod's `hermes-bedrock-HermesInstanceRole-...`.

To swap in an AWS Bedrock router model on staging:
1. Edit `~/.hermes/config.yaml` on the staging box, replacing the model ID with the router ARN / inference profile ID.
2. **Verify staging's instance role has `bedrock:InvokeModel*` on the router AND on every underlying model the router can dispatch to.** Without this, you'll see `AccessDeniedException` from the gateway under specific prompts (whichever route the router picks).
3. Restart `hermes-gateway` on staging.
4. Once validated on staging, promote via §9.3. **Before merging to `main`, confirm prod's instance role has the same Bedrock permissions on the router + underlying models** — otherwise the deploy will land green but the agent will 403 on first prompt.

### 9.3 Staging → prod promotion (deployed-branch model)

Three repos, same flow each. References: `deployed-branch-model` and `staging-promotion-discipline` memories; full runbook lives in `docs/staging/deploy-runbook.md` on `main` of this repo.

```
edit on staging EC2 (~/.hermes  OR  /opt/finny  OR  ~/.hermes/hermes-agent)
   → commit on a feature branch
   → push, open PR against main
   → review + merge to main
   → write docs/staging/<branch>-changes.md  (manifest: files touched, restart steps,
                                               smoke checks, rollback note)
   → operator FF protected `deployed` branch to main's tip
   → on PROD EC2: git pull in the relevant checkout
       /opt/finny                  →  finny-claude-plugin (bridge + infra)
       /opt/finny/dashboard        →  11mirror/finny-hermes-dashboard
       ~/.hermes                   →  finny-hermes-config (config, AGENTS.md, SOUL.md, skills)
       ~/.hermes/hermes-agent      →  finny-hermes (gateway runtime)
   → walk the manifest:
       - copy non-symlinked files (e.g. /etc/caddy/Caddyfile per gotcha 7)
       - run any migrations
       - reload caddy if vhosts changed:  sudo systemctl reload caddy
       - restart gateway:                 sudo -iu ubuntu systemctl --user restart hermes-gateway
       - restart node services:           sudo systemctl restart finny-dashboard finny-mcp
   → smoke-test:
       - curl http://127.0.0.1:8642/v1/models   (with bearer)
       - curl https://dashboard.finny.prod.11mirror.com/  → 200
       - end-to-end chat through the dashboard
   → append a row to docs/staging/deploy-log.md
```

Three flavors of deploy, all in `deploy-runbook.md`:
- **Routine deploy** — new commits land on prod via `git pull`; restart services. Most common.
- **Byte-equality reconciliation** — prod's working tree already matches new `deployed` (e.g. atomic-fetch refactors); gate on `git diff --quiet HEAD origin/deployed`; no build, no restart.
- **Rollback** — operator force-pushes `deployed` back to a known-good SHA; on prod `git reset --hard origin/deployed`; walk manifest in reverse.

**Pitfalls when writing the manifest** (caught in PR #8 review):
- Inline `# comment &&` inside `bash -lc "..."` swallows the chain. Comments on their own line.
- `git diff HEAD origin/deployed` (without `--quiet`) always exits 0 — it's a viewer, not a gate. Use `git diff --quiet`.
- `git status --porcelain` is informational; gate on `[ -z "$(git status --porcelain)" ]`.

## 10. Changes since this was written

This doc is point-in-time. The system mutates. Before trusting it:
1. Run the SSM cheatsheet probes in §7.
2. Diff what you see against the tables in §1, §2, §3.
3. If anything's off, fix this doc first, then proceed with your task.

The boxes I trusted: branches in §3 (`deployed`), version in §2, vhosts in §1, env-key presence in §2, profile dirs in §3.


Issue : 1. :red_circle: Zod 47% retry rate — the case in short

Root cause: NetSuite API returns rows as {objects} but the bridge Zod schema expects [arrays]. Every query where NS returns rows: [{col: val}] instead of rows: [[val]] fails Zod → retry.

This is a bridge-side bug. The fix is in the response normalisation layer (before Finny sees the data, or Zod needs to accept both shapes). Code to check: wherever the NS /query/v1/suiteql response is parsed before being passed to Zod — the rows key needs a shape-check + conversion.
