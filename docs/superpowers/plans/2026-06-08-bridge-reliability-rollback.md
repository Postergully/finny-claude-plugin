# Bridge Reliability Pass — Deploy + Rollback Plan

**Companion to:** `2026-06-08-bridge-reliability.md` (implementation plan), `2026-06-08-bridge-reliability-design.md` (spec)
**PR:** [#5](https://github.com/Postergully/finny-claude-plugin/pull/5)
**Merge target:** `main`

## Pre-merge state (capture before squash)

- **Branch:** `feat/bridge-reliability`
- **22 commits** from `6a4bcfc` (first feat) to `7774151` (smoke tests)
- **Last good `main` SHA before merge:** capture this as `MAIN_PRE_MERGE_SHA` at merge time.
- **Deploy artifact:** `bridge/dist/index.js` from the merged `main` commit.

## Deploy

1. Merge PR #5 to `main` (squash merge — keeps `main` linear; one revert target).
2. CI runs `pnpm -r check:all` on `main`. If green, proceed.
3. Capture the squash commit SHA as `MERGE_SHA` and the prior `main` SHA as `MAIN_PRE_MERGE_SHA`.
4. Build deploy artifact:
   ```bash
   cd bridge && npm run build
   ```
5. Push to prod EC2 (`i-0ef58962b09d490ee`):
   ```bash
   # via SSM, per docs/handoff conventions
   aws ssm start-session --target i-0ef58962b09d490ee
   sudo systemctl stop finny-mcp
   # rsync dist/ to /var/lib/finny/finny-mcp/
   sudo systemctl start finny-mcp
   sudo systemctl status finny-mcp
   ```
6. Smoke-verify the live server:
   ```bash
   journalctl -u finny-mcp -o cat -f | node bridge/scripts/bridge-watch.mjs
   ```
7. Issue 3 production queries from cowork (one fast, one GL, one bulk-rows). Confirm:
   - First query: returns inline if ≤30s, else `running` then drains by poll 3.
   - GL query: completes within `300_000ms` task wall-clock, no spurious retries.
   - Bulk-rows query: cursor escape fires; `finny_continue({cursor})` drains.

## Observability — what to watch

Run nightly for the first week:
```bash
journalctl -u finny-mcp -o cat --since "24 hours ago" \
  | node bridge/scripts/analyze-gateway-log.mjs
```

### Health thresholds

| Metric | Healthy | Yellow | Red (consider rollback) |
|---|---|---|---|
| `Avg calls/query` | 1–2 | 2–3 | >3 sustained |
| `Session-creation rate (% of queries)` | <2% | 2–10% | >10% |
| `Correction-retry rate (% of calls)` | <5% | 5–15% | >15% |
| `p95 initial-phase latency` | <120 s | 120–180 s | >180 s |
| `p95 calls/query` | ≤2 | 3 | ≥4 |
| Cursor expiry errors | rare (occasional user idle) | spiking | sustained spikes |

If any metric stays in **Red** for >24h, trigger rollback.

## Rollback paths (in order of preference)

### Path 1 — Targeted revert (preferred)

If exactly one workstream is the culprit, revert just that workstream's commits. The 22 commits are grouped:

| Workstream | Commits | Behavior reverting buys |
|---|---|---|
| **A — schema/timeouts** | `6a4bcfc 9870dd2 9936d13 c504c4d 7348b74` | Restore strict envelope schema, 120s HTTP timeout, 10s deadline_ms, 15-poll backoff |
| **B — payload + cursor** | `236067d 104b67f bbf7b3f 7a4036a bd27f0d 222fd17 3baac07 ababf64` | Restore 500-row default, 10MB body cap, no cursor pagination |
| **C — instrumentation** | `ca11801 9fd291e ff9b9d7 f0ce0e7 8dfe6ae` | Drop diagnostics + aggregate logs (low risk; pure observability) |
| **Cleanup** | `b9a2dbb fc082b1` | Restores the old unused `@ts-expect-error` (cosmetic) |
| **Smoke + docs** | `12ccaba 7774151` | Drops smoke tests + status doc updates |

Targeted revert command:
```bash
git checkout main
git pull
# Example: revert Workstream B only
git revert --no-edit 236067d 104b67f bbf7b3f 7a4036a bd27f0d 222fd17 3baac07 ababf64
git push
# Then redeploy bridge
```

### Path 2 — Full revert of the merge

If multiple workstreams are misbehaving or root cause is unclear:

```bash
git checkout main
git pull
git revert -m 1 <MERGE_SHA>      # -m 1 = revert the merge, keep first parent (main)
git push
# Redeploy bridge
```

This produces one clean revert commit; safe to re-merge later after fixes.

### Path 3 — Hard reset (only if Paths 1–2 fail)

Only if `git revert` introduces conflicts that can't be resolved cleanly:
```bash
# Coordinate with anyone else on main first.
git checkout main
git reset --hard <MAIN_PRE_MERGE_SHA>
git push --force-with-lease
```
**Risk:** anyone who pulled `main` between merge and reset has a divergent history. Only use if Path 2 is blocked. Force-pushes to `main` should be approved by you explicitly — not done autonomously.

## Rollback decision tree

```
Production unhealthy?
├─ Single metric in Red, isolatable to one workstream?
│  └─ Path 1 (targeted revert)
├─ Multiple workstreams red OR root cause unclear?
│  └─ Path 2 (full merge revert)
└─ Path 1/2 conflict or blocked?
   └─ Path 3 (hard reset, coordinate first)
```

## Post-rollback

1. Confirm metrics return to baseline within 15 minutes of redeploy.
2. File a follow-up issue: `[bridge-reliability] rollback <date>: <root cause>`.
3. Update `docs/superpowers/specs/2026-06-08-bridge-reliability-design.md` with a "Rolled back" status note + reason.
4. If rolling back Workstream B (cursor pagination), warn cowork users via skill update — `judging-output` mentions cursor; cowork will re-attempt and gracefully fall back to single-envelope on a non-cursor envelope, so no skill change needed for B rollback. Workstream A timeout reverts are invisible to cowork.

## What's pre-shipped vs ship-then-watch

**Pre-shipped (already validated):**
- 462 unit tests + 4 in-process smokes pass.
- `npm run check:all` clean.
- Cursor security (P1) tested and verified.
- Stringification perf (P3) drops ~14 stringifies to 1 on hot path.

**Ship-then-watch (cannot be validated without prod traffic):**
- Real Hermes session reuse behavior (the original "spawning new session per rejection" claim).
- Real-world correction-retry rate.
- Cursor mechanism under real cowork polling cadence.
- Whether 30s default `deadline_ms` actually reduces escalations vs 10s.

These need 24–48h of prod traffic to evaluate against the health thresholds above.
