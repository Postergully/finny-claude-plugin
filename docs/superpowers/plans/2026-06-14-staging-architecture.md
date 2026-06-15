# Staging Architecture for Finny Bridge + Hermes — Implementation Plan

**Date:** 2026-06-14 (plan), 2026-06-15 (revised after eng-review + brainstorming)
**Status:** Plan (approved, ready to execute)
**Spec:** `docs/superpowers/specs/2026-06-15-staging-architecture-design.md`
**First test target:** `docs/superpowers/plans/2026-06-11-atomic-fetch-search-as-code.md`

> The design rationale, decisions (D1–D12), failure modes, and architecture diagram live in the spec.
> This plan is the executable checklist: what to do, where, in what order, with verification at each gate.

## Approach summary

Build staging by taking an OS snapshot of prod EC2 and editing a small set of identity/listener fields post-boot. Two listeners on staging: public MCP at `https://staging.finny.11mirror.com/mcp` (browser Claude cowork) and tailnet-only dashboard at `http://<tailscale-ip>:9119` (Hermes desktop app). Branch → PR → push to staging → smoke → commit per-branch change manifest → merge → prod deploy by walking the manifest. Snapshot refreshed ≤14 days.

## Goals (from spec)

- Catch infra-shaped bugs (systemd, Caddy, OAuth, IAM, venv layout) before prod.
- Gate the **merge**, not the deploy. Manifest is the contract.
- Zero contamination of prod: own disk, own OAuth, no Slack on staging profile.
- "No surprises" prod deploy via mandatory per-branch change manifest.

## Non-goals (NOT in scope)

- NetSuite sandbox (deliberate parity gap, deferred).
- Automated CI deploy to staging.
- Replacing mocked / sibling-clone loops.
- Multi-developer concurrent staging (2 users, serialized).
- Public-internet dashboard.

## What already exists (reused, not rebuilt)

- `deploy/hermes-bootstrap.sh` — kept for cold-rebuild fallback; primary build path is AMI snapshot.
- `bridge/` MCP server (OAuth 2.1, `MCP_ALLOWED_HOSTS`, transports).
- Prod Caddy + systemd units + IAM role (cloned via AMI).
- Tailscale tailnet (already in use; staging joins as a new node).
- Hermes desktop app on user's Mac (per-profile remote backend).
- Mocked bridge test loop.

## Phase 1 — Snapshot + boot staging EC2 (~2 hr)

1. **Take AMI snapshot of prod.** `aws ec2 create-image --instance-id i-0ef58962b09d490ee --name "finny-prod-snapshot-$(date +%Y%m%d-%H%M)" --no-reboot`. Record AMI id.
2. **Launch staging EC2** from that AMI. t3.small, same VPC/subnet as prod. Tag `env=staging`.
3. **Allocate Elastic IP** and associate with staging instance.
4. **DNS A-record** `staging.finny.11mirror.com` → staging Elastic IP.
5. **Install + enroll Tailscale** on staging EC2: `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`. Record tailnet IP from `tailscale ip -4`.
6. **Create staging IAM role** (mirror of prod permissions, tagged `env=staging`); attach to instance.
7. **Security-group ingress:** 443 public (Caddy), no public 22 (SSM only).

**Gate:** SSM into staging EC2 successfully; `tailscale status` shows it on the tailnet.

## Phase 2 — Post-snapshot edits (~1 hr, all on staging EC2 via SSM)

> Capture every edit in this phase as `docs/staging/snapshot-refresh-checklist.md` so the next refresh is a replay, not a memory exercise.

8. **Generate staging MCP OAuth secrets:**
   - `MCP_CLIENT_ID=$(openssl rand -hex 32)`
   - `MCP_CLIENT_SECRET=$(openssl rand -hex 32)`
   - Store both in AWS Secrets Manager under `finny/staging/oauth/*`.
   - Write to `/opt/finny/bridge/.env`.

9. **Generate dashboard basic-auth credentials:**
   - Pick a username for `HERMES_DASHBOARD_BASIC_AUTH_USERNAME`.
   - Generate scrypt password hash for `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH` (per Nous docs — use the hash variant, never plaintext).
   - `HERMES_DASHBOARD_BASIC_AUTH_SECRET=$(openssl rand -hex 32)` (so sessions survive dashboard restarts).
   - Write all three to `~/.hermes/.env` (mode 0600).

10. **Set dashboard host:** `HERMES_DASHBOARD_HOST=<tailnet-ip>` in `~/.hermes/.env`.

11. **Set MCP allowed hosts:** `MCP_ALLOWED_HOSTS=staging.finny.11mirror.com` in `/opt/finny/bridge/.env`.

12. **Edit Caddyfile** (`/etc/caddy/Caddyfile`):
    - Replace `finny.prod.11mirror.com { ... }` block with `staging.finny.11mirror.com { ... }` block.
    - Same proxy target (`reverse_proxy /mcp 127.0.0.1:3000`), same journald logging.
    - `caddy validate /etc/caddy/Caddyfile`
    - `sudo systemctl reload caddy`
    - Caddy auto-issues TLS cert via Let's Encrypt on first request.

13. **Create staging Hermes profile:**
    - `~/.hermes/profiles/staging.yaml` = copy of `default.yaml` with messaging integrations (Slack, etc.) removed.
    - Switch active profile via `hermes gateway` CLI (`sudo -iu ubuntu hermes gateway list` shows profile names; switch to `staging`).

14. **Add `hermes-dashboard.service`** at `~/.config/systemd/user/hermes-dashboard.service`:
    ```ini
    [Unit]
    Description=Hermes desktop-app backend (dashboard)
    After=network-online.target hermes-gateway.service
    Wants=network-online.target

    [Service]
    Type=simple
    EnvironmentFile=%h/.hermes/.env
    ExecStart=/home/ubuntu/.hermes/hermes-agent/.venv/bin/hermes dashboard --no-open --host ${HERMES_DASHBOARD_HOST} --port 9119
    Restart=on-failure

    [Install]
    WantedBy=default.target
    ```
    `systemctl --user daemon-reload && systemctl --user enable --now hermes-dashboard`.
    Note: ExecStart points at the **editable-install venv** (`.hermes/hermes-agent/.venv`), not the orphan `hermes-venv` from `[[hermes-venv-mismatch]]`. Done right from day one on staging.

15. **Restart units** to pick up new env / config:
    - `sudo systemctl restart finny-mcp` (system)
    - `sudo -iu ubuntu systemctl --user restart hermes-gateway hermes-dashboard`
    - `sudo systemctl reload caddy`

16. **Capture Phase 2 as a checklist** at `docs/staging/snapshot-refresh-checklist.md` in the bridge repo (committed in Phase 4).

**Gate:** All four units (`finny-mcp`, `hermes-gateway`, `hermes-dashboard`, `caddy`) report `active (running)`.

## Phase 3 — Verify end-to-end (~1 hr)

17. **Tailnet reachability:** `tailscale status` confirms staging EC2; user's Mac can `ping <staging-tailnet-ip>`.

18. **Dashboard auth gate:**
    ```
    curl -s http://<tailnet-ip>:9119/api/status | jq '.auth_required, .auth_providers'
    ```
    expect `true` and `["basic"]`.

19. **Desktop app, both users:** Settings → Gateway → Remote gateway → add `staging` profile pointing at `http://<tailnet-ip>:9119` → sign in with basic auth → confirm dashboard chat works.

20. **Public OAuth metadata:**
    ```
    curl -sS https://staging.finny.11mirror.com/.well-known/oauth-protected-resource
    ```
    expect TLS green, returns metadata pointing at staging's `client_id` (different from prod's).

21. **Browser Claude cowork:** register Custom Connector at `https://staging.finny.11mirror.com/mcp`, complete OAuth, confirm all 5 MCP tools work end-to-end:
    - `finny_query` (read-only NetSuite query)
    - `finny_report` (read-only report)
    - `finny_task_status`
    - `finny_continue`
    - `finny_remember`

22. **No-Slack-bleed sanity check:** during the Phase 3 testing window, search prod Slack channels for any message from the bot. Expect zero new bot messages tied to staging activity. (If staging Hermes responded to a prod Slack message, the profile switch in step 13 didn't take — debug before proceeding.)

**Gate:** All 5 tools green via browser cowork; dashboard chat green via desktop app; no Slack bleed observed.

## Phase 4 — Document the discipline (~2 hr)

23. **`CLAUDE.md` — add "Staging-to-prod promotion" section.** Includes:
    - Branch → PR → staging → manifest → merge → prod-deploy flow.
    - Two-listener model (public MCP + tailnet dashboard) and what each is for.
    - Path to manifest template: `docs/staging/<branch-name>-changes.md`.
    - Mandatory rule: **no prod deploy without a manifest in the merged branch**.
    - Snapshot-refresh rule (≤14 days, or before testing any branch >7 days old).

24. **`docs/staging/README.md` — long-form how-to.** Covers:
    - How to push a branch to staging (SSM commands).
    - Manifest template + filled example.
    - Snapshot-refresh procedure (point to `snapshot-refresh-checklist.md` from Phase 2).
    - Caddy edit checklist (the exact diff applied in step 12).
    - Verification commands (the four `curl`s from Phase 3).
    - Rollback procedure.

25. **Replace the "Staging tunnel" row** in `CLAUDE.md`'s local-dev-loops table with a "Staging EC2" row pointing at this doc. Mark the old SSH-tunnel-to-prod loop as "emergency only — prefer staging EC2."

26. **Memory entry:** create `staging-promotion-discipline.md` so Claude sessions remember the rule across compaction. Type: `feedback` (workflow rule). Include why (drift-trap prevention) and how to apply (manifest mandatory, no exceptions).

27. **Manifest template** at `docs/staging/MANIFEST-TEMPLATE.md`:
    ```markdown
    # Staging changes: <branch-name>
    Date tested: <YYYY-MM-DD> → <YYYY-MM-DD>
    Tested by: <name>
    Staging snapshot baseline: prod AMI <ami-id> (taken <date>)

    ## Git changes (replay via merge)
    - finny-claude-plugin@<branch>: <commits or "see PR #N">
    - finny-hermes@<branch>: <or "no changes">
    - finny-hermes-config@<branch>: <or "no changes">
    - netsuite-kb@<branch>: <or "no changes">

    ## Non-git changes (replay manually on prod, in order)
    1. <env / systemd / apt / Caddy edit>
    ...
    If empty: "No non-git changes — git merge + standard restart is sufficient."

    ## What was tested on staging
    - 5-tool smoke ✓
    - <feature-specific tests> ✓

    ## Skipped on prod (staging-only changes)
    - <or "None.">

    ## Rollback
    - <revert plan>
    ```

**Gate:** All four docs + memory committed to the branch (and PR'd into main when staging itself is verified).

## Phase 5 — First real branch through the loop (~2 hr)

28. **Push `atomic-fetch-search-as-code` branch to staging** (the user's current WIP, plan at `docs/superpowers/plans/2026-06-11-atomic-fetch-search-as-code.md`).
    ```
    sudo -iu ubuntu bash -lc '
      cd /opt/finny &&
      git fetch origin &&
      git checkout atomic-fetch-search-as-code &&
      pnpm install --frozen-lockfile &&
      pnpm -C bridge build
    '
    sudo systemctl restart finny-mcp
    sudo -iu ubuntu systemctl --user restart hermes-gateway
    ```

29. **Walk full PR → staging → manifest → merge cycle** for that branch:
    - Test atomic-fetch behavior via desktop dashboard (chat-driven exercise).
    - Test atomic-fetch behavior via browser cowork → staging MCP (cowork-driven exercise).
    - Capture every non-git change in `docs/staging/atomic-fetch-search-as-code-changes.md`, commit to the branch.
    - Verify manifest is complete (everything done on staging is recorded).
    - Reviewer (teammate) checks PR has code + manifest + smoke evidence; approves.
    - Merge to main.
    - Prod deploy: `git pull` on prod EC2, walk the manifest's non-git steps, restart units.
    - Confirm prod still green (5-tool smoke against `https://finny.prod.11mirror.com/mcp`).

30. **Document rough edges** found during the first real exercise:
    - Update `deploy/hermes-bootstrap.sh` if cold-rebuild parity drifts from snapshot reality.
    - Update `docs/staging/README.md` so the next branch is smoother.
    - Update `docs/staging/snapshot-refresh-checklist.md` if Phase 2 needed extra steps.

**Gate:** atomic-fetch shipped to prod via the new flow; both authors agree the loop felt right; rough edges documented.

## Failure modes (from spec)

See spec § Failure modes. Two consciously accepted gaps:

- **Staging mutates prod NetSuite:** discipline only (read-heavy queries, draft records).
- **Manifest skipped on a branch:** reviewer enforces v1; CI gate captured as TODO.

## Worktree parallelization

Plan steps are sequentially gated. Phase 1 → 2 → 3 → 4 → 5 must run in order; each phase has a verification gate that must pass before the next starts. Sequential implementation, no parallelization opportunity.

## TODOs (deferred — captured in spec)

- Provision NetSuite sandbox.
- CI gate on manifest presence.
- Auto-deploy to staging on PR open.
- Post-deploy canary on staging.
- Fix `[[hermes-venv-mismatch]]` properly (start on staging, promote via the same flow).
- Snapshot-refresh automation (EventBridge schedule).
- Cost / orphan policy (nightly stop or quarterly review).

## Completion summary template

Fill in after Phase 5 closes:
- Phase 1 (snapshot + boot): ___
- Phase 2 (post-snapshot edits): ___
- Phase 3 (verify): ___ (5/5 tools green? dashboard green? no Slack bleed?)
- Phase 4 (docs): ___
- Phase 5 (atomic-fetch through the loop): ___ (manifest produced? prod deploy clean?)
- Rough edges found: ___
- TODOS captured: ___

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | Initial 5 issues raised; all resolved through brainstorming → spec D1–D12 |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**UNRESOLVED:** 0
**VERDICT:** ENG CLEARED — ready to implement.
