# Staging changes: `fix/kanban-silent-death-telemetry`

**Date tested:** `2026-06-30`
**Tested by:** Kali + Claude (cowork)
**Staging EC2:** `i-0c2c974ff571162eb` (finny-staging, 34.232.186.238)
**PR:** `#<pr-number>` (draft)
**Status:** 🔍 §0 + §1 complete — layer identified, §2–§4 still TODO before implementation
**Channel:** Hermes dashboard kanban (`https://dashboard.finny.staging.11mirror.com/tasks`)
**Dashboard repo:** [`11mirror/finny-hermes-dashboard`](https://github.com/11mirror/finny-hermes-dashboard) — NOT `Postergully/finny-hermes`. Local clone: `~/code/finny-hermes-dashboard`. Deploy: `pnpm build` → tarball → S3 → SSM extract to `/opt/finny/dashboard/` (NOT a `git pull` on EC2).

## Why this is a discovery brief, not an implementation plan

We observed on staging today (2026-06-30) that the dashboard kanban at `https://dashboard.finny.staging.11mirror.com/tasks` already ships with five columns: `Triage`, `Ready`, `Running`, `Review`, `Blocked`. Header text confirms it's an active board: *"Workspace Tasks is a lightweight task board. Drag cards to change status."*

This changes the "silent death" framing. There are at least four ways the failure mode can manifest:

- **(a)** Task completes, dashboard never re-renders → bug in the dashboard subscription layer.
- **(b)** Agent worker exits without emitting a final state → bug in the agent loop.
- **(c)** Bridge drops the terminal envelope → bug in `bridge/src/mcp/tools/_shared/taskWorker.ts` or wrapper.
- **(d)** Final state IS emitted, lands in (e.g.) `Blocked` correctly, but artifacts are stripped/lost → bug in the artifact persistence layer.

Telemetry that's useful for (b) is useless for (a). **Find the layer first, instrument second.** Otherwise we add log lines in the wrong place and ship a manifest for nothing.

## Scope (after discovery)

§0 + §1 are complete; the failing layer is now identified as **(e) result-not-surfaced + (f) artifacts-not-on-disk**. The next investigator should:

1. Do §3 probe: launch a fresh kanban task on staging, watch the worker's actual filesystem writes (`strace`/`inotifywatch` on `~/.hermes/kanban/workspaces/`), and pin down whether the worker writes to a non-existent path, a tmpdir that's cleaned up, or never writes at all.
2. Confirm whether `tasks.result` is supposed to be populated by the completion handler (read `~/.hermes/hermes-agent/hermes_cli/kanban*.py`). If yes → the populate call is missing/broken. If no → the dashboard's task read query needs to JOIN `task_runs` for the summary.
3. Then ship telemetry: structured WARN log at the moment the worker emits `completed` with a workspace_path that doesn't exist on disk; and another at the moment the dashboard renders a `done` task with NULL `result`.

Explicit non-goals: stuck-task user-prompt protocol (that's `spec/stuck-task-user-prompt`, sibling branch — it's the *consumer* of this telemetry, not part of this branch). Plan UI rendering (blocked on finny-loops phase ~5). Retry logic. State machine redesign. **Also out of scope: fixing the artifact-write bug itself** — telemetry first, fix in a follow-up PR so reverts stay surgical.

## Investigation brief (do this BEFORE writing any code)

Fill in findings inline under each section. The PR description summarises which layer is broken and what the telemetry will catch.

### 0. Confirm which repo owns the failing UI (do this FIRST)

The screenshot strings ("Workspace Tasks", "lightweight task board", "Drag cards to change status") and the `/tasks` route are **not** in `/Applications/finny-hermes`. Per `memory/dashboard-repo-location.md`:

- Dashboard repo is `11mirror/finny-hermes-dashboard` (private fork of `outsourc-e/hermes-workspace`).
- Local clone expected at `~/code/finny-hermes-dashboard`.
- Deploy on EC2 lives at `/opt/finny/dashboard/`, served on port `:3001` (TanStack Start).
- **Don't confuse with `finny-hermes/plugins/kanban/`** — that's the upstream Hermes kanban plugin at route `/kanban`, a different surface.

Before §1, confirm:

- [ ] `~/code/finny-hermes-dashboard` exists locally (clone if not).
- [ ] Grep for screenshot literals there: `grep -rn "Workspace Tasks\|lightweight task board\|Drag cards" ~/code/finny-hermes-dashboard/src`.
- [ ] On EC2 (`i-0ef58962b09d490ee`), find the deployed bundle's commit SHA: `cat /opt/finny/dashboard/VERSION` or `ls -la /opt/finny/dashboard/` and check for a SHA marker. Compare against `~/code/finny-hermes-dashboard` `git log`.
- [ ] If local and deployed diverge, work from whichever matches what staging is serving (rebase or check out the deployed SHA locally).

> **Findings (2026-06-30):**
> Local clone path: `~/code/finny-hermes-dashboard` (exists, on `main` @ `26c1a23c`)
> Screenshot string match: `src/screens/tasks/tasks-screen.tsx:34` (and test at `tasks-ux.test.ts:9`). Confirms dashboard repo owns the UI; **NOT** `finny-hermes/plugins/kanban/`.
> EC2 deployed SHA marker: no `VERSION` file at `/opt/finny/dashboard/`. Deployed `package.json` version `2.3.0` == local `package.json` version `2.3.0`. Bundle string match found in `/opt/finny/dashboard/dist/{client,server}/assets/tasks-*.js`. Treating local `main@26c1a23c` as deployed-equivalent for this investigation.
> Local SHA matched/needs-rebase: **matched** (no rebase needed).
> Caddy vhost confirmed: `dashboard.finny.staging.11mirror.com → 127.0.0.1:3001` (TanStack Start server).

### 1. Reproduce the silent death on staging

- Trigger a task that historically silently dies (find one from chat history or run a known long-running query).
- Watch the kanban board in real time. Which column does the card end up in? Does it disappear? Does it freeze in `Running`?
- Open browser devtools → Network. What does the task-status payload look like at the moment of "death"? Capture the last 2–3 responses.
- Open `journalctl --user -u hermes-gateway -f` on the EC2 box during the repro. What's the last log line emitted for that task id?

> **Findings (2026-06-30):**
>
> Reproduced via Kali creating "prepare a DSO report" (`t_008d0a75`) on staging during the investigation, and via tracing the prior "preapre tax report" (`t_434379ad`) from earlier the same day.
>
> **The kanban itself works end-to-end.** Both tasks have a full healthy lifecycle in `/home/ubuntu/.hermes/kanban.db`:
> - `tasks` row: `status='done'`, `started_at` set, `completed_at` set, `workspace_path` set
> - `task_events` rows: `created → assigned → claimed → spawned → heartbeat(*) → completed`
> - `task_runs` row: `outcome='completed'`, `summary='…'`, `metadata={…}`
> - The `completed` event payload carries a rich `summary` AND an `artifacts: [...]` array listing the files the worker says it wrote
>
> **But two things are missing for the user:**
> 1. **`tasks.result` column is NULL** — the rich summary lives on the run/event records, not on the task row. The task list query (and the dashboard UI) reads from `tasks` and so renders an empty card.
> 2. **The workspace dir on disk does not exist.** `ls /home/ubuntu/.hermes/kanban/workspaces/t_434379ad/` → `No such file or directory`. Same for `t_008d0a75`. The whole `~/.hermes/kanban/workspaces/` parent dir is empty. The artifact paths the worker reported (`TDS_Report_May2026_MTPL.csv`, `dso_report_jun2026.txt`, etc.) are not anywhere on the box.
>
> **Storage path correction for future investigators:** This investigation initially looked in the wrong places. The kanban does **not** use the flat-file paths the original brief assumed:
> - ❌ `/home/ubuntu/.hermes/tasks.json` — used by `swarm2-kanban` flow, not this kanban
> - ❌ `/home/ubuntu/.hermes/profiles/staging/tasks.json` — same, stale
> - ❌ `/home/ubuntu/.hermes/swarm2-kanban.json` — does not exist on staging
> - ✅ **`/home/ubuntu/.hermes/kanban.db`** (SQLite) — actual store, tables: `tasks`, `task_events`, `task_runs`, `task_links`, `task_comments`, `kanban_notify_subs`
> - ⚠️ `/home/ubuntu/.hermes/profiles/staging/kanban.db` exists but is **stale (last write 2026-06-17)** — the running gateway writes to `~/.hermes/kanban.db`, not the staging-profile one. This contradicts `memory/staging-runtime-checkout.md`'s "profile-only" assumption for kanban data; needs follow-up.
>
> Backend resolution: dashboard chose `hermes-proxy` backend (i.e. `getCapabilities().kanban === true`), so all writes are forwarded to Hermes' kanban API and land in the SQLite DB above. Direct POST probe from EC2 (`curl http://127.0.0.1:3001/api/claude-tasks`) returned `201` with a real `t_*` id and the row appeared in `kanban.db` immediately.

### 2. Identify the failing layer

Based on §1 evidence, narrow to one of (a)/(b)/(c)/(d) above. Cite the specific file/line that's the suspected source.

- (a) Dashboard: where is the kanban subscribed to task updates? In `~/code/finny-hermes-dashboard/src/` — websocket / SSE / TanStack-Start route loader / polling hook. (NOT in `finny-hermes`.)
- (b) Agent worker: where is the task loop's terminal-state emission? In `/Applications/finny-hermes/` — grep for `state.*done`, `emit.*complete`.
- (c) Bridge: `bridge/src/mcp/tools/_shared/taskWorker.ts` terminal envelope path; `bridge/src/types/envelope.ts` for the shape.
- (d) Artifact persistence: where does the dashboard read artifacts? Same place that writes them?

> **Suspected layer + cite (updated 2026-06-30 after §1):**
>
> The original (a)/(b)/(c)/(d) framing was wrong — this is NOT a silent death in the agent loop, the bridge, or the dashboard subscription. Both completed tasks have rich `completed` events with summaries and artifact lists in the DB.
>
> The user-perceived silent death is actually **two co-located bugs**:
>
> **(e) Result-not-surfaced** — `tasks.result` column is NULL even though `task_events.completed` and `task_runs.summary` carry the data. The dashboard renders from `tasks`, so the card shows up empty.
> - Cite: `tasks` table schema in `~/.hermes/kanban.db` has `result` column that is never populated on completion. The data exists in `task_events` (payload JSON) and `task_runs.summary`/`metadata`.
> - Likely fix surface: Hermes worker's task-completion path that updates `tasks` after writing `task_events.completed`. Investigate in `~/.hermes/hermes-agent/hermes_cli/kanban*.py` and `tools/kanban_tools.py`.
>
> **(f) Artifacts-not-on-disk** — The worker emits `artifacts: ["/home/ubuntu/.hermes/kanban/workspaces/t_XXX/..."]` but `~/.hermes/kanban/workspaces/` doesn't exist on the box. Either the worker writes to a different path then mis-reports, or it never actually writes the files and the artifact list is fabricated from intent. This is the more dangerous bug — claims of work done without artefacts to back them.
> - Cite: needs §3 probe to confirm WHERE the worker actually writes (tmpdir? in-memory? a different profile?) vs. WHERE it claims to write.
>
> Sibling spec `spec/stuck-task-user-prompt` was framing for "task stuck/dies before completion" — these tasks are the opposite: they complete cleanly but with no artefacts and no user-visible summary, which looks identical from the dashboard.

### 3. Confirm with a minimal probe

Add one throwaway log line at the suspected layer. Re-run the repro. Did the log fire?

- If yes → telemetry plan is "make that log line permanent + structured + WARN level".
- If no → the bug is upstream of the suspected layer. Move up one layer and repeat.

> **Probe result:**
> `<fill in>`

### 4. Cross-check with sibling branch (`spec/stuck-task-user-prompt`)

The stuck-task spec is investigating the same surface. If both investigations converge on the same layer (likely), the telemetry here directly informs that spec's Path A/B/C/D decision. Coordinate findings — append a short note to both docs once §1–§3 done.

> **Convergence note:**
> `<fill in>`

## Hard rules for whoever picks this up

1. **No code commit until §1–§3 are filled in.** Edit this manifest first.
2. **No retry logic.** This branch is telemetry only. If the investigation reveals the bug is fixable in 5 lines, propose it in the PR description but ship telemetry in a separate commit so reverts are surgical.
3. **No new dependencies.** Use existing logger, existing envelope shape (`bridge/src/types/envelope.ts`).
4. **Get reviewer approval on the chosen layer** before opening the implementation commit. PR description must answer: "Which layer? What evidence? What signal will the telemetry produce?"
5. **Stay on staging.** All edits per `memory/staging-runtime-checkout.md` — `~/.hermes/profiles/staging/` git checkout on EC2, not local.

## Git changes (replay via merge)

- `finny-claude-plugin@fix/kanban-silent-death-telemetry`: `<this manifest + investigation findings only>`
- `finny-hermes-dashboard@fix/kanban-silent-death-telemetry`: `<shas — likely the main source change if layer is (a) or (d)>`
- `finny-hermes@fix/kanban-silent-death-telemetry`: `<shas, or "no changes" — only if layer is (b)>`
- `finny-claude-plugin/bridge@fix/kanban-silent-death-telemetry`: `<shas, or "no changes" — only if layer is (c)>`
- `finny-hermes-config@<branch>`: `<shas, or "no changes">`
- `netsuite-kb@<branch>`: `no changes`

> Note: dashboard deploy is **not** `git pull` on EC2 — it's `pnpm build` locally → S3 tarball → SSM extract to `/opt/finny/dashboard/`. The non-git section below MUST capture this if the dashboard repo is involved.

## Deploy decision

- [ ] **Deploy immediately after merge** — telemetry-only, low risk, useful on prod day one
- [ ] **Hold for batch**
- [ ] **Hotfix** — only if investigation reveals the silent-death is causing visible data loss in prod today
- [ ] **Reconciliation deploy**

## Non-git changes (replay manually on prod, in order)

> If the dashboard repo is involved: deploy is **not** a `git pull` on EC2. Capture the build+upload steps here.
> If only bridge or agent code changed: `git pull` on `deployed` + standard restart is sufficient.

1. **Dashboard build + deploy** (only if `finny-hermes-dashboard` changed):
   - `cd ~/code/finny-hermes-dashboard && pnpm install && pnpm build`
   - `tar -czf dashboard-<sha>.tgz dist/` (or whatever the build output dir is — verify)
   - Upload to S3 bucket per existing deploy script (find in `finny-hermes-dashboard` repo or operator's deploy notes)
   - On EC2 via SSM: extract to `/opt/finny/dashboard/`
   - Restart dashboard service (find unit name on EC2 — likely `finny-dashboard` or similar on port `:3001`)
   - **Why:** dashboard is not pulled by git on EC2; staged via S3.
2. `<other file or surface>`: `<change>`
   - **Command run:** `<exact command, redact secrets>`
   - **Why:** `<one line>`

## What was tested on staging

- [ ] Investigation §1 repro completed (silent-death reproduced and column behaviour observed)
- [ ] Investigation §2 layer identified with cite
- [ ] Investigation §3 probe fired (or upstream layer identified)
- [ ] Implementation: WARN log fires on a repeat of the §1 repro
- [ ] Implementation: failure envelope shape matches `bridge/src/types/envelope.ts` conventions
- [ ] Implementation: dashboard task at `https://dashboard.finny.staging.11mirror.com/tasks` shows the failure (badge/banner) — only if scope §1 included it
- [ ] 5-tool smoke (`finny_query`, `finny_report`, `finny_task_status`, `finny_continue`, `finny_remember`) via browser cowork at `https://finny.staging.11mirror.com/mcp` — no regressions
- [ ] Desktop dashboard chat works against tailnet IP `100.112.31.24`
- [ ] No-Slack-bleed sanity check

## Skipped on prod (staging-only changes)

> Likely items: extra debug logs added during §3 probe that didn't graduate to the permanent WARN. Remove or downgrade before merge.
> If empty: **"None."**

## Rollback

- `git revert <merge-sha>` on `finny-hermes` (and `finny-claude-plugin` if non-trivial manifest edits).
- No non-git changes to reverse (expected).
- Restart: `sudo -iu ubuntu systemctl --user restart hermes-gateway`

## Notes / surprises

- **Profile-isolation assumption broken for kanban.** `memory/staging-runtime-checkout.md` says the gateway reads from `~/.hermes/profiles/staging/`, but the kanban store the running gateway actually writes to is `~/.hermes/kanban.db` (root), not `~/.hermes/profiles/staging/kanban.db`. The staging-profile kanban.db's last write is 2026-06-17. Either the kanban subsystem doesn't honour `HERMES_HOME`/profile separation, or there's a separate `KANBAN_DB` env var we missed. Worth a separate ticket — it means kanban data on staging is shared with whatever else writes to `~/.hermes/`.
- **The 5 columns in the UI ≠ the 6 enum values in the schema.** `TaskColumn` is `backlog | todo | in_progress | review | blocked | done` (six). UI shows `Triage | Ready | Running | Review | Blocked` (five visible, plus Done off-screen). Triage→backlog, Ready→todo, Running→in_progress mapping in `tasks-screen.tsx` is fine, but the user-side write of "Running" is silently rewritten to "Ready" by `mapLaneToDashboardStatus` (`kanban-backend.ts:80-89`) because "Hermes rejects direct writes of running." This explains why the DSO task immediately appeared in Running even though Triage was selected at creation — the dispatcher claimed it in the seconds between Save and screenshot.
- **`/api/tasks` returns SPA HTML, not 404.** TanStack Start's catch-all swallows unknown API paths. There's already a defensive guard in `src/lib/tasks-api.ts:34` for this. Worth a config-level fix (proper 404 on unknown `/api/*`) so future debugging doesn't get bait-and-switched. Out of scope here.

## Cross-references

- Sibling: `spec/stuck-task-user-prompt` — design-only branch investigating the same dashboard surface; its Path A/B/C/D decision depends on this branch's investigation findings.
- Live surface: `https://dashboard.finny.staging.11mirror.com/tasks`
- Plan review that produced both branches: 2026-06-30 (DHH + Kieran + simplicity reviewers; consensus = ship dashboard fixes independently of finny-loops phases 4–9, after evidence-based investigation, not by guessing).
- Runtime layout: `memory/staging-runtime-checkout.md`, `memory/hermes-context-cwd.md`.
