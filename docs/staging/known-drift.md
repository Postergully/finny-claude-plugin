# Known drift on prod working trees

This file inventories working-tree drift on prod that PR1 **does not** reconcile. PR1 establishes the deployed-branch model and accepts existing dirt as a baseline. A follow-up PR will reconcile each item below.

The byte-equality safeguard (`git diff HEAD origin/deployed`) protects tracked-file *content* during the PR1 rollout. The items below are either (a) modifications to tracked files where the working-tree version diverges from `HEAD`, or (b) untracked files. Both are orthogonal to the byte-equality check.

---

## Why this exists

The repos under `~/.hermes` were authored directly on the prod EC2 instance. Skills, memories, cron prompts, and gateway configuration evolved in-place, and many edits were never committed/pushed. The atomic-fetch search-as-code work surfaced the same pattern for code (phase-1/phase-2). PR1 closes the door on future drift by introducing the deployed-branch discipline; this file catalogs the open back-door so a follow-up PR can close it.

---

## `~/.hermes` (finny-hermes-config)

Captured during the staging audit. Re-snapshot before reconciliation — this list ages.

### Modified tracked files

| Path | Approx. delta | Notes |
|---|---|---|
| `cron/jobs.json` | edits | Cron schedule edits — verify against the running crontab before reverting |
| `memories/MEMORY.md` | +114 lines | Includes Hindsight DUAL-BANK architecture (2026-06-13), June 2026 revenue projection framework, April 2026 GST ITC revision (bill NW-2026-27/0057). **Not backed up elsewhere — preserve before any reset.** |
| `skills/<various>/SKILL.md` | edits across several skills | Each skill needs case-by-case review |
| `skills/<...>/resolver.md` | +309 lines | Substantial in-place authoring |

### Untracked files (suspected)

- Cron output / log files
- `profiles/staging/` (created by snapshot-refresh)
- `venv/` (Python virtualenv, must stay gitignored)
- `MEMORY.md.bak.*` (timestamped backups created by Hermes)
- `day_dream` synthesis artifacts (per-run; PR1 gitignores these)

Re-run `git status --porcelain` on prod via SSM before the reconciliation PR — the list above is a snapshot, not authoritative.

---

## `/opt/finny` (finny-claude-plugin)

Expected clean (`git status --porcelain` empty at audit time). If the strict invariant fires during PR1 rollout, append findings here before proceeding.

---

## `~/.hermes/hermes-agent` (finny-hermes)

Audit showed `web/package-lock.json` modified (npm install ran on prod at some point). Other paths suspected clean — re-verify at PR1 rollout time.

---

## Reconciliation plan (deferred to follow-up PR)

1. **Snapshot first.** Capture every modified tracked file's working-tree contents into a branch off `deployed`. This is the "as-running" snapshot.
2. **Diff against `HEAD`** per file. Decide per item: commit (it's real work), revert (it's accidental), or gitignore (it's runtime artifact).
3. **Untracked file triage.** For each untracked path: gitignore (runtime), commit (intentional new file), or delete (stale).
4. **PR through the discipline.** Branch → staging dry-run → manifest → merge → deploy via runbook. Same discipline as any other change.
5. **Post-reconciliation invariant tightening.** Once the working tree is clean, `setup-deployed-branch.md`'s baseline-delta exception can be retired and the strict invariant restored everywhere.

---

## What this is NOT

- Not a list of bugs. The drift is operational debt, not malfunction.
- Not an excuse to leave it indefinitely. The follow-up PR closes this loop.
- Not a complete inventory yet — the list above is staging-audit-derived; the reconciliation PR re-snapshots prod first.

---

## Related

- `setup-deployed-branch.md` § "Why baseline-delta is acceptable here" — explains the safety guarantee under the loosened invariant
- `deploy-runbook.md` — uses baseline-delta for `~/.hermes` going forward
- `worktree-staging-architecture-plan-changes.md` — PR1 manifest with "Known deferred work" pointer to this file
