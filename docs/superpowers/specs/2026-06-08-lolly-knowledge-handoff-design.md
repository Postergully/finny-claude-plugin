# Lolly → Hermes/Finny Knowledge Handoff (Pointer-Only)

**Date:** 2026-06-08
**Status:** Design — pending review
**Owner:** Postergully / Finny ops

## Context

Lolly (a sibling OpenClaw agent) was retired. Its accumulated knowledge — `MEMORY.md`,
`USER.md`, `AGENTS.md`, daily notes, three workspace skills, and 332 JSONL sessions
of NetSuite/finance interactions — was exported to a tarball:

- `lolly-export-handoff.tar.gz` (64 MB compressed, 129 MB extracted)
- SHA256 `47895bc1a7cd3d8bf618cfc1559d720bbdfd70fb3a36d69c24a296b89cb9134d`
- Inside: `for-hermes-migrate/` (knowledge + skills), `archive/sessions/` (raw JSONL),
  `archive/persona/` (Lolly's identity files), `audit/`, `MANIFEST.md`.

The MANIFEST recipe assumes a fresh Hermes box and runs `hermes claw migrate` to merge
into `~/.hermes/`. **We are not doing that.** Production Finny on
EC2 `i-0ef58962b09d490ee` is a live ERP agent with its own persona, MEMORY, and config.
A merge-style migration is too risky.

## Goal

Make Lolly's NetSuite/finance knowledge available to Finny's Hermes **as an external
read-only reference**, without modifying any of Hermes's own state. Hermes consults the
archive on demand, guided by a single pointer block appended to its `AGENTS.md`.

## Non-goals

- No `hermes claw migrate`, no `hermes claw cleanup`, no writes to `~/.hermes/`.
- No copies into `~/.agents/skills/` or any Hermes-auto-loaded location.
- No ingestion of raw session JSONL on EC2.
- No transfer of `archive/persona/` (Hermes has its own persona).
- No transfer of `11mirror`, `fbrain-tooling`, or `github` skills.
- No automated re-sync — this is a one-shot snapshot.

## Architecture

```
LOCAL (operator machine)                       PRODUCTION EC2 i-0ef58962b09d490ee
/tmp/lolly-export/                             ~/.hermes/                  ← UNTOUCHED
├── for-hermes-migrate/workspace-main/         ~/.agents/skills/           ← UNTOUCHED
│   ├── MEMORY.md  USER.md  AGENTS.md          ~/lolly-archive/            ← NEW (read-only)
│   ├── memory/                                └── workspace-main/
│   └── skills/{netsuite,                          ├── MEMORY.md
│              daily-synthesis,                    ├── USER.md
│              data-presentation}                  ├── AGENTS.md  (de-openclaw'd)
│                                                  ├── memory/
└── archive/sessions/                              ├── skills/{netsuite,
       │                                           │           daily-synthesis,
       ▼ synthesize locally (332 JSONL → 1 md)     │           data-presentation}
       lolly-learning-sessions.md ──ship──────────►└── lolly-learning-sessions.md
                                                    (raw JSONL stays local)

Hermes's existing AGENTS.md gains ONE fenced pointer block (additive, removable).
```

## What gets to EC2 (three buckets, all pointers)

| Bucket | Contents | Lands at | Referenced by |
|---|---|---|---|
| 1. Knowledge files | `MEMORY.md`, `USER.md`, `AGENTS.md` (scrubbed), `memory/` daily notes | `~/lolly-archive/workspace-main/` | Pointer block |
| 2. Skills (read-only) | `netsuite/`, `daily-synthesis/`, `data-presentation/` | `~/lolly-archive/workspace-main/skills/` | Pointer block |
| 3. Session synthesis | `lolly-learning-sessions.md` (one file, distilled from 332 JSONL) | `~/lolly-archive/lolly-learning-sessions.md` | Pointer block |

Skipped: `11mirror/`, `fbrain-tooling/`, `github/`, `archive/persona/`,
`archive/operational/`, `openclaw.json`, raw `archive/sessions/*.jsonl`.

## Phases

### Phase 1 — Local prep

Extract tarball, verify SHA256, build a pruned `lolly-archive-staging/` tree:

```
lolly-archive-staging/
└── workspace-main/
    ├── MEMORY.md
    ├── USER.md
    ├── AGENTS.md            ← scrubbed copy
    ├── memory/              ← copied as-is
    └── skills/
        ├── netsuite/
        ├── daily-synthesis/
        └── data-presentation/
```

**AGENTS.md scrub checklist** (manual review before staging):

- Remove openclaw-specific cron syntax references.
- Remove MCP bridge config notes specific to OpenClaw.
- Remove `openclaw.json` references.
- Remove sandbox-name references (`sandbox: lolly`, `~/.openclaw/`, etc.).
- Keep all NetSuite rules, vendor sign conventions, GL mappings, query patterns.

### Phase 2 — Session synthesis (local, parallel)

Inputs: 332 primary `*.jsonl` files in `archive/sessions/` (~74 MB).
Output: one `lolly-learning-sessions.md` of durable patterns.

Pipeline:

1. Sort sessions by mtime; split into ~10 date-bucketed shards (~33 files each).
2. Dispatch one subagent per shard in parallel. Each subagent extracts:
   - NetSuite query gotchas and SuiteQL idioms
   - Vendor sign conventions and GL mapping patterns
   - Recurring user asks and the answers that worked
   - Dead ends and approaches that failed
   - Tool-call patterns that were efficient
3. **Subagent rules (hard):** no raw user quotes, no customer names or financial
   figures, no PII, no NetSuite IDs, no API keys. Output is patterns and lessons,
   not transcripts.
4. Merge pass (single subagent or final synthesis) collapses 10 shard digests into
   one `lolly-learning-sessions.md`, deduplicating and grouping by theme.

Raw JSONL never leaves the local machine. Local copy retained as fallback for
one-off grep if a future question requires source detail.

### Phase 3 — Transfer

1. Tar the staging tree: `tar czf lolly-archive-staging.tar.gz lolly-archive-staging/`.
2. Compute SHA256, share via:
   - SCP through SSM session (preferred — no public ingress), or
   - S3 presigned URL with SSE-S3, single-use, ≤ 1 hour expiry, or
   - Encrypted channel (Signal file transfer, password-protected zip).
3. Operator verifies SHA256 on EC2 before unpacking.

### Phase 4 — Install on EC2

```bash
# On EC2 via SSM session, as the hermes/finny user
mkdir -p ~/lolly-archive
tar xzf /tmp/lolly-archive-staging.tar.gz -C ~/lolly-archive/ --strip-components=1
chmod -R a-w ~/lolly-archive/                      # enforce read-only
find ~/lolly-archive/ -type d -exec chmod u+rx {} \;  # restore dir traversal
ls -la ~/lolly-archive/workspace-main/
```

No service restart. No `hermes` command run.

### Phase 5 — Pointer block

Append a fenced, bracketed block to Hermes's live `AGENTS.md` (path discovered in
Phase 6 pre-flight — likely `~/.hermes/AGENTS.md` or a workspace AGENTS.md).

```markdown
<!-- BEGIN: lolly-archive-pointer (added 2026-06-08, removable) -->
## Lolly archive (read-only reference)

For NetSuite, vendor, GL, and SuiteQL questions, consult
`~/lolly-archive/workspace-main/`. This is read-only reference material from a
retired sibling agent. Do not modify.

- Knowledge: `MEMORY.md`, `USER.md`, `AGENTS.md`, `memory/` (daily notes)
- Skills: `skills/netsuite/`, `skills/daily-synthesis/`, `skills/data-presentation/`
- Lessons learned: `~/lolly-archive/lolly-learning-sessions.md`
  (distilled patterns from prior NetSuite sessions)

If a NetSuite query, vendor sign convention, or GL mapping question is unclear,
read the relevant file under `~/lolly-archive/` before answering.
<!-- END: lolly-archive-pointer -->
```

The fenced markers make rollback a single `sed -i '/BEGIN: lolly-archive-pointer/,/END: lolly-archive-pointer/d'`.

### Phase 6 — Pre-flight + verify

**Pre-flight (before phase 4):**

- SSM into EC2, locate the live `AGENTS.md` Hermes actually reads. Capture path.
- Snapshot `~/.hermes/` size + `find ~/.hermes -type f | wc -l` for before/after diff.
- Confirm no existing `~/lolly-archive/` directory.
- Confirm none of `netsuite`, `daily-synthesis`, `data-presentation` already exist
  as Hermes skill names (collision check).

**Verify (after phase 5):**

- `hermes status` exits clean.
- `~/.hermes/` file count + size unchanged vs. pre-flight snapshot.
- `ls ~/lolly-archive/workspace-main/` shows expected shape.
- Smoke test through the Finny bridge: invoke `finny_query` with a NetSuite question
  whose answer is in `lolly-learning-sessions.md`. Confirm Hermes either references
  the archive or produces the right answer.
- One follow-up question explicitly mentioning "consult lolly-archive" — confirm the
  path is reachable.

### Phase 7 — Rollback (one command)

```bash
sed -i.bak '/<!-- BEGIN: lolly-archive-pointer/,/<!-- END: lolly-archive-pointer/d' <AGENTS-PATH>
rm -rf ~/lolly-archive/
```

Hermes is byte-identical to pre-change (modulo the `.bak` of AGENTS.md).

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Hermes ignores the pointer block and doesn't consult the archive | Smoke test in Phase 6 confirms reachability; pointer block is explicit ("read the relevant file before answering") |
| AGENTS.md still contains openclaw-isms after scrub | Manual checklist in Phase 1; spot-check after staging |
| Synthesis loses signal vs. raw JSONL | Raw JSONL retained locally indefinitely; if a question's answer isn't in the digest, do a one-off local grep and ship findings as a follow-up |
| Permissions drift over time (a-w lost) | Document expected mode in `~/lolly-archive/README.md` placed at install time; no enforcement automation |
| Sensitive content in `lolly-learning-sessions.md` slips through synthesis | Hard subagent rules (no quotes, no PII, no figures); manual diff/review of the merged file before transfer |
| Pointer-block path drift if Hermes upgrades restructure config | Phase 6 pre-flight finds the live path; if Hermes upgrades later move it, add a re-discovery note to ops runbook |

## Open questions

None at design time. Pre-flight resolves AGENTS.md location.

## Acceptance

- `~/.hermes/` byte-untouched after install (file count + size match pre-flight).
- Pointer block present in live AGENTS.md, bracketed by removable markers.
- Smoke test passes: a NetSuite question produces an answer informed by archive content.
- Rollback procedure tested in a dry-run on a non-prod box (or documented risk-accept if not).
- Raw `archive/sessions/*.jsonl` confirmed absent from EC2.
