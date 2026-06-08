# Lolly → Hermes/Finny Knowledge Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stage Lolly's NetSuite/finance knowledge at `~/lolly-archive/` on the production Finny EC2 as a read-only pointer reference, with a single removable pointer block appended to Hermes's live `AGENTS.md`. Hermes's own state stays byte-untouched.

**Architecture:** Three buckets (knowledge files, three selected skills, one synthesized lessons file) staged read-only at `~/lolly-archive/` on EC2 `i-0ef58962b09d490ee`. Raw session JSONL stays local; a parallel subagent synthesis collapses 332 JSONL files into one `lolly-learning-sessions.md`. Pointer block in fenced markers makes the change trivially reversible.

**Tech Stack:** bash, tar, shasum, sed, AWS SSM Session Manager, Anthropic subagents (for session synthesis), `finny_query` MCP tool (for smoke test).

**Spec:** `docs/superpowers/specs/2026-06-08-lolly-knowledge-handoff-design.md`

**Hard rules (re-read before each task):**
- No `hermes claw migrate`, no `hermes claw cleanup`.
- No writes inside `~/.hermes/` except the one fenced pointer block in `AGENTS.md`.
- No copies into `~/.agents/skills/`.
- Raw `archive/sessions/*.jsonl` never touches EC2.
- Skipped: `11mirror`, `fbrain-tooling`, `github` skills; `archive/persona/`; `archive/operational/`; `openclaw.json`.

---

## Task 1: Verify source tarball and extract to a clean working dir

**Files:**
- Source: `/tmp/lolly-export-handoff.tar.gz`
- Create: `/tmp/lolly-work/lolly-export/` (full extraction)

- [ ] **Step 1: Verify SHA256**

Run:
```bash
shasum -a 256 /tmp/lolly-export-handoff.tar.gz
```

Expected: `47895bc1a7cd3d8bf618cfc1559d720bbdfd70fb3a36d69c24a296b89cb9134d  /tmp/lolly-export-handoff.tar.gz`

If the hash differs, STOP. Do not proceed.

- [ ] **Step 2: Extract to a clean working dir**

Run:
```bash
rm -rf /tmp/lolly-work
mkdir -p /tmp/lolly-work
tar xzf /tmp/lolly-export-handoff.tar.gz -C /tmp/lolly-work/
ls /tmp/lolly-work/lolly-export/
```

Expected output includes: `MANIFEST.md`, `archive/`, `audit/`, `for-hermes-migrate/`.

- [ ] **Step 3: Confirm the inputs we'll use exist**

Run:
```bash
test -f /tmp/lolly-work/lolly-export/for-hermes-migrate/workspace-main/MEMORY.md && echo OK
test -f /tmp/lolly-work/lolly-export/for-hermes-migrate/workspace-main/USER.md && echo OK
test -f /tmp/lolly-work/lolly-export/for-hermes-migrate/workspace-main/AGENTS.md && echo OK
test -d /tmp/lolly-work/lolly-export/for-hermes-migrate/workspace-main/memory && echo OK
test -d /tmp/lolly-work/lolly-export/for-hermes-migrate/workspace-main/skills/netsuite && echo OK
test -d /tmp/lolly-work/lolly-export/for-hermes-migrate/workspace-main/skills/daily-synthesis && echo OK
test -d /tmp/lolly-work/lolly-export/for-hermes-migrate/workspace-main/skills/data-presentation && echo OK
ls /tmp/lolly-work/lolly-export/archive/sessions/*.jsonl 2>/dev/null | wc -l
```

Expected: seven `OK` lines and a session count (≥ 332).

---

## Task 2: Build pruned staging tree (knowledge + 3 skills, no extras)

**Files:**
- Create: `/tmp/lolly-archive-staging/workspace-main/`

- [ ] **Step 1: Scaffold the staging tree**

Run:
```bash
rm -rf /tmp/lolly-archive-staging
mkdir -p /tmp/lolly-archive-staging/workspace-main/skills
```

- [ ] **Step 2: Copy the three knowledge files and the daily-notes dir**

Run:
```bash
SRC=/tmp/lolly-work/lolly-export/for-hermes-migrate/workspace-main
DST=/tmp/lolly-archive-staging/workspace-main
cp "$SRC/MEMORY.md" "$DST/MEMORY.md"
cp "$SRC/USER.md"   "$DST/USER.md"
cp "$SRC/AGENTS.md" "$DST/AGENTS.md"   # gets scrubbed in Task 3
cp -R "$SRC/memory" "$DST/memory"
ls "$DST"
```

Expected: `AGENTS.md  MEMORY.md  USER.md  memory  skills`.

- [ ] **Step 3: Copy ONLY the three approved skills**

Run:
```bash
SRC=/tmp/lolly-work/lolly-export/for-hermes-migrate/workspace-main/skills
DST=/tmp/lolly-archive-staging/workspace-main/skills
for s in netsuite daily-synthesis data-presentation; do
  cp -R "$SRC/$s" "$DST/$s"
done
ls "$DST"
```

Expected: `daily-synthesis  data-presentation  netsuite` (exactly three entries, in any order).

- [ ] **Step 4: Drop `.bak` files inside copied skills (kept tidy)**

Run:
```bash
find /tmp/lolly-archive-staging -name '*.bak-*' -print -delete | head
find /tmp/lolly-archive-staging -name '*.bak-*' | wc -l
```

Expected: final count `0`.

- [ ] **Step 5: Confirm forbidden content absent**

Run:
```bash
test ! -d /tmp/lolly-archive-staging/workspace-main/skills/11mirror && echo "no 11mirror OK"
test ! -d /tmp/lolly-archive-staging/workspace-main/skills/fbrain-tooling && echo "no fbrain-tooling OK"
test ! -d /tmp/lolly-archive-staging/workspace-main/skills/github && echo "no github OK"
find /tmp/lolly-archive-staging -name openclaw.json | wc -l
```

Expected: three `OK` lines and a final count of `0`.

- [ ] **Step 6: Commit a snapshot of the staging tree's file list (audit trail)**

Run:
```bash
( cd /tmp/lolly-archive-staging && find . -type f | sort > /tmp/lolly-archive-staging.filelist.txt )
wc -l /tmp/lolly-archive-staging.filelist.txt
```

Expected: a non-zero line count printed. Keep this file — it's the inventory the operator will diff against the EC2 install.

---

## Task 3: Scrub AGENTS.md of openclaw-isms

**Files:**
- Modify: `/tmp/lolly-archive-staging/workspace-main/AGENTS.md`

- [ ] **Step 1: Find candidate openclaw references**

Run:
```bash
grep -nEi 'openclaw|~/\.openclaw|sandbox: lolly|sandbox=lolly|claw migrate|claw cleanup|MCP bridge|cron syntax|openclaw\.json' \
  /tmp/lolly-archive-staging/workspace-main/AGENTS.md || echo "no matches"
```

Expected: a list of line numbers + matches (or `no matches`).

- [ ] **Step 2: Edit each match by hand**

For every match from Step 1, open the file and remove or rewrite the line so it reads as a generic note (or delete it entirely) per this checklist from the spec:

- Remove openclaw-specific cron syntax references.
- Remove MCP bridge config notes specific to OpenClaw.
- Remove `openclaw.json` references.
- Remove sandbox-name references (`sandbox: lolly`, `~/.openclaw/`).
- Keep all NetSuite rules, vendor sign conventions, GL mappings, query patterns.

Use a text editor (do not script the rewrite — judgment required per line).

- [ ] **Step 3: Re-grep to confirm nothing forbidden remains**

Run:
```bash
grep -nEi 'openclaw|~/\.openclaw|sandbox: lolly|sandbox=lolly|claw migrate|claw cleanup|openclaw\.json' \
  /tmp/lolly-archive-staging/workspace-main/AGENTS.md && echo "STILL HAS MATCHES" || echo "clean OK"
```

Expected: `clean OK`.

- [ ] **Step 4: Diff for human review**

Run:
```bash
diff /tmp/lolly-work/lolly-export/for-hermes-migrate/workspace-main/AGENTS.md \
     /tmp/lolly-archive-staging/workspace-main/AGENTS.md | head -80
```

Eyeball the diff. NetSuite/finance content should be untouched; only operational/openclaw lines removed.

---

## Task 4: Shard session JSONL files for parallel synthesis

**Files:**
- Create: `/tmp/lolly-work/shards/shard-{01..10}.list` (each a list of JSONL paths)

- [ ] **Step 1: Build sorted list of primary session JSONLs (skip .bak / .reset)**

Run:
```bash
mkdir -p /tmp/lolly-work/shards
find /tmp/lolly-work/lolly-export/archive/sessions -maxdepth 1 -type f -name '*.jsonl' \
  ! -name '*.bak*' ! -name '*.reset*' \
  -printf '%T@ %p\n' \
  | sort -n \
  | awk '{print $2}' > /tmp/lolly-work/shards/all-sessions.list
wc -l /tmp/lolly-work/shards/all-sessions.list
```

Expected: a count ≥ 332.

- [ ] **Step 2: Split into 10 roughly-equal date-ordered shards**

Run:
```bash
cd /tmp/lolly-work/shards
TOTAL=$(wc -l < all-sessions.list)
PER=$(( (TOTAL + 9) / 10 ))
split -l "$PER" -d -a 2 all-sessions.list shard-
ls shard-*
wc -l shard-*
```

Expected: 10 shard files (`shard-00` through `shard-09`), each ~33 entries.

- [ ] **Step 3: Sanity-check the first and last shard**

Run:
```bash
head -2 /tmp/lolly-work/shards/shard-00
tail -2 /tmp/lolly-work/shards/shard-09
```

Expected: shard-00 holds oldest sessions; shard-09 holds newest. (Confirms time-ordering.)

---

## Task 5: Synthesize each shard via parallel subagents

**Files:**
- Create: `/tmp/lolly-work/shards/shard-{00..09}.digest.md`

- [ ] **Step 1: Define the per-shard subagent prompt template**

The subagent prompt for shard N is exactly:

> You are reading raw OpenClaw session JSONL files for a retired agent named Lolly. The files contain conversation history with a NetSuite ERP user. Your job is to extract **durable patterns and lessons**, not transcripts.
>
> **Hard rules (any violation = failed output):**
> - No raw user quotes longer than 5 words.
> - No customer names, vendor names, person names, or NetSuite internal IDs.
> - No specific dollar amounts, invoice numbers, account numbers, or PII.
> - No API keys, tokens, URLs with credentials.
> - Output is patterns and lessons, not transcripts.
>
> **What to extract:**
> - NetSuite SuiteQL idioms that worked / didn't work.
> - Vendor sign conventions, GL mapping patterns (described abstractly).
> - Recurring user-question shapes and what answer pattern resolved them.
> - Dead ends — approaches that looked right but failed, with the failure mode.
> - Tool-call sequences that were efficient.
>
> **Format:** Markdown with these sections (omit empty ones): `## SuiteQL idioms`, `## Vendor / GL conventions`, `## Recurring question patterns`, `## Dead ends`, `## Efficient tool sequences`. Bullet lists, ≤ 80 chars per line.
>
> **Inputs:** the JSONL files at the paths in `/tmp/lolly-work/shards/shard-NN.list`.
> **Output:** write to `/tmp/lolly-work/shards/shard-NN.digest.md` and report a one-line summary.

- [ ] **Step 2: Dispatch 10 subagents in parallel (one Agent call per shard, all in one message)**

For each `NN` from `00` to `09`, fill the template above (substituting the shard number) and dispatch via the Agent tool with `subagent_type: general-purpose`. **All 10 calls must go in a single assistant message** so they run concurrently.

Expected: 10 subagent results, each reporting "wrote `/tmp/lolly-work/shards/shard-NN.digest.md`".

- [ ] **Step 3: Verify all 10 digests landed**

Run:
```bash
ls /tmp/lolly-work/shards/shard-*.digest.md | wc -l
wc -l /tmp/lolly-work/shards/shard-*.digest.md
```

Expected: count is `10`; each file non-empty.

- [ ] **Step 4: Spot-check rules compliance**

Run:
```bash
grep -nE '\$[0-9]+|invoice #|customer:|vendor:' /tmp/lolly-work/shards/shard-*.digest.md || echo "clean OK"
```

Expected: `clean OK`. If any matches, re-dispatch the offending shard's subagent with stricter wording.

---

## Task 6: Merge shard digests into `lolly-learning-sessions.md`

**Files:**
- Create: `/tmp/lolly-archive-staging/lolly-learning-sessions.md`

- [ ] **Step 1: Concatenate shards into a working merge buffer**

Run:
```bash
cat /tmp/lolly-work/shards/shard-*.digest.md > /tmp/lolly-work/merged.raw.md
wc -l /tmp/lolly-work/merged.raw.md
```

Expected: a non-zero line count.

- [ ] **Step 2: Dispatch a single merge subagent**

Dispatch one subagent (Agent tool, `subagent_type: general-purpose`) with this prompt:

> Read `/tmp/lolly-work/merged.raw.md`. It contains 10 digests of patterns/lessons from a retired NetSuite agent named Lolly. Produce ONE consolidated markdown file that:
>
> - De-duplicates overlapping patterns across shards.
> - Groups by section (`## SuiteQL idioms`, `## Vendor / GL conventions`, `## Recurring question patterns`, `## Dead ends`, `## Efficient tool sequences`).
> - Preserves the same hard rules as the per-shard pass: no quotes > 5 words, no PII, no figures, no IDs.
> - Adds a top-level header: `# Lolly's Learning — Session Synthesis (2026-06-08)` and a 3-line preface explaining what this file is and that it's distilled from 332 sessions.
>
> Write the result to `/tmp/lolly-archive-staging/lolly-learning-sessions.md`. Report the final line count.

Expected: subagent reports a line count and the file exists.

- [ ] **Step 3: Manual diff/review pass (you, the operator)**

Run:
```bash
wc -l /tmp/lolly-archive-staging/lolly-learning-sessions.md
head -40 /tmp/lolly-archive-staging/lolly-learning-sessions.md
grep -nE '\$[0-9]+|invoice #|customer:|vendor:' /tmp/lolly-archive-staging/lolly-learning-sessions.md || echo "clean OK"
```

Read the file end-to-end. If anything looks like a transcript, a real name, or a real number, edit it out by hand before continuing.

---

## Task 7: Package staging tree for transfer + compute SHA256

**Files:**
- Create: `/tmp/lolly-archive-staging.tar.gz`
- Create: `/tmp/lolly-archive-staging.sha256`

- [ ] **Step 1: Tar the staging tree**

Run:
```bash
( cd /tmp && tar czf lolly-archive-staging.tar.gz lolly-archive-staging )
ls -lh /tmp/lolly-archive-staging.tar.gz
```

Expected: a tarball, size in MB (≪ 64 MB original — only knowledge + 3 skills + 1 md).

- [ ] **Step 2: Compute and store SHA256**

Run:
```bash
shasum -a 256 /tmp/lolly-archive-staging.tar.gz | tee /tmp/lolly-archive-staging.sha256
```

Expected: hex hash + filename printed and saved.

---

## Task 8: Pre-flight on EC2 (find live AGENTS.md, snapshot Hermes state, collision check)

**Files:**
- Read on EC2: `~/.hermes/AGENTS.md` (or wherever Hermes's live AGENTS.md is)
- Create on EC2: `~/lolly-handoff/preflight.txt`

- [ ] **Step 1: SSM into the prod EC2**

Run (from local machine):
```bash
aws ssm start-session --target i-0ef58962b09d490ee
```

All subsequent EC2 steps run inside this session. (User: the unit-owning user — likely `ubuntu` or `ec2-user`. If the SSM default user differs from the Hermes service user, `sudo -iu <hermes-user>` first. Confirm via the systemd unit: `systemctl cat finny-mcp.service | grep User=`.)

- [ ] **Step 2: Find the live AGENTS.md Hermes reads**

Run on EC2:
```bash
ls -la ~/.hermes/AGENTS.md 2>/dev/null
ls -la ~/AGENTS.md         2>/dev/null
find ~ -maxdepth 3 -name 'AGENTS.md' -not -path '*/node_modules/*' 2>/dev/null
```

Capture the path Hermes is using. Save it for later steps as `LIVE_AGENTS=<path>`.

If multiple candidates, check which Hermes actually loads:
```bash
hermes status 2>&1 | head -20      # may show config paths
hermes config show 2>&1 | head -40  # if available
```

- [ ] **Step 3: Snapshot `~/.hermes/` state for byte-untouched verification**

Run on EC2:
```bash
mkdir -p ~/lolly-handoff
{
  echo "=== preflight $(date -u +%FT%TZ) ==="
  echo "LIVE_AGENTS=$LIVE_AGENTS"
  echo
  echo "--- ~/.hermes file count ---"
  find ~/.hermes -type f 2>/dev/null | wc -l
  echo "--- ~/.hermes total size (bytes) ---"
  du -sb ~/.hermes 2>/dev/null
  echo "--- ~/.hermes file hashes (sorted) ---"
  find ~/.hermes -type f 2>/dev/null -exec sha256sum {} + | sort -k2
} > ~/lolly-handoff/preflight.txt
wc -l ~/lolly-handoff/preflight.txt
```

Expected: `preflight.txt` is non-empty.

- [ ] **Step 4: Confirm `~/lolly-archive/` does not exist yet**

Run on EC2:
```bash
test ! -e ~/lolly-archive && echo "no prior archive OK" || echo "STOP: ~/lolly-archive already exists"
```

Expected: `no prior archive OK`. If it exists, STOP and reconcile.

- [ ] **Step 5: Skill-name collision check**

Run on EC2:
```bash
for s in netsuite daily-synthesis data-presentation; do
  if [ -d ~/.agents/skills/$s ] || [ -d ~/.hermes/skills/$s ]; then
    echo "COLLISION: $s already exists"
  else
    echo "no collision: $s OK"
  fi
done
```

Expected: three `no collision` lines. (We're staging at `~/lolly-archive/` not `~/.agents/skills/` so collisions are informational, but a collision means Finny may have its own version we need to respect.)

- [ ] **Step 6: Confirm Hermes is healthy before changes**

Run on EC2:
```bash
hermes status
systemctl --user status finny-mcp 2>/dev/null || sudo systemctl status finny-mcp
```

Expected: Hermes status clean; systemd unit active. Capture output into `~/lolly-handoff/preflight.txt`.

---

## Task 9: Transfer staging tarball to EC2 (encrypted channel)

**Files:**
- Source: `/tmp/lolly-archive-staging.tar.gz` (local)
- Destination: `~/lolly-handoff/lolly-archive-staging.tar.gz` (EC2)

- [ ] **Step 1: Transfer via SSM (no public ingress)**

Run from local machine:
```bash
aws ssm start-session \
  --target i-0ef58962b09d490ee \
  --document-name AWS-StartPortForwardingSession \
  --parameters 'portNumber=22,localPortNumber=2222' &
SSM_PID=$!
sleep 3
scp -P 2222 -o StrictHostKeyChecking=no \
  /tmp/lolly-archive-staging.tar.gz \
  /tmp/lolly-archive-staging.sha256 \
  <hermes-user>@127.0.0.1:~/lolly-handoff/
kill $SSM_PID
```

Substitute `<hermes-user>` with the user identified in Task 8 Step 1.

Alternative if SSM port-forward is not configured: upload to a private S3 bucket with SSE-S3, presigned URL ≤ 1 hour, then `aws s3 cp` on EC2.

- [ ] **Step 2: Verify SHA256 on EC2**

Run on EC2:
```bash
cd ~/lolly-handoff
shasum -a 256 -c lolly-archive-staging.sha256
```

Expected: `lolly-archive-staging.tar.gz: OK`. If FAIL, STOP and re-transfer.

---

## Task 10: Install staging tree at `~/lolly-archive/` (read-only)

**Files:**
- Create on EC2: `~/lolly-archive/workspace-main/`
- Create on EC2: `~/lolly-archive/lolly-learning-sessions.md`
- Create on EC2: `~/lolly-archive/README.md`

- [ ] **Step 1: Extract**

Run on EC2:
```bash
mkdir -p ~/lolly-archive
tar xzf ~/lolly-handoff/lolly-archive-staging.tar.gz -C ~/lolly-archive/ --strip-components=1
ls -la ~/lolly-archive/
```

Expected output includes: `workspace-main`, `lolly-learning-sessions.md`.

- [ ] **Step 2: Drop a README.md describing what this is**

Run on EC2:
```bash
cat > ~/lolly-archive/README.md <<'EOF'
# ~/lolly-archive — read-only knowledge reference

Installed: 2026-06-08
Source: Lolly (retired sibling agent, OpenClaw 2026.5.28)
Mode: read-only reference. DO NOT MODIFY.

Contents:
- workspace-main/MEMORY.md, USER.md, AGENTS.md, memory/  — knowledge files
- workspace-main/skills/{netsuite, daily-synthesis, data-presentation}  — read-only skills
- lolly-learning-sessions.md  — distilled patterns from 332 sessions

Hermes references this archive via a fenced pointer block in its live AGENTS.md.
Hermes's own ~/.hermes/ is untouched.

Rollback:
  sed -i.bak '/<!-- BEGIN: lolly-archive-pointer/,/<!-- END: lolly-archive-pointer/d' <LIVE_AGENTS>
  rm -rf ~/lolly-archive/

Expected mode: dirs 0555, files 0444. If perms drift, restore:
  chmod -R a-w ~/lolly-archive/
  find ~/lolly-archive/ -type d -exec chmod a+rx {} \;
EOF
ls ~/lolly-archive/README.md
```

- [ ] **Step 3: Enforce read-only mode**

Run on EC2:
```bash
chmod -R a-w ~/lolly-archive/
find ~/lolly-archive/ -type d -exec chmod a+rx {} \;
ls -la ~/lolly-archive/ | head -5
find ~/lolly-archive/ -maxdepth 2 ! -perm -u+r -print | head
```

Expected: directories show `r-xr-xr-x`, files show `r--r--r--`. The `! -perm -u+r` finder should print nothing.

- [ ] **Step 4: Verify shape matches the local file list**

From local machine, run:
```bash
scp -P 2222 -o StrictHostKeyChecking=no \
  /tmp/lolly-archive-staging.filelist.txt \
  <hermes-user>@127.0.0.1:~/lolly-handoff/
```

Then on EC2:
```bash
( cd ~/lolly-archive && find . -type f | sort ) > ~/lolly-handoff/ec2-filelist.txt
diff ~/lolly-handoff/lolly-archive-staging.filelist.txt ~/lolly-handoff/ec2-filelist.txt && echo "shape OK"
```

Expected: `shape OK` and no diff output. (The local list was rooted at `./workspace-main/...` etc.; if rooting differs, normalize before diffing — `sed -i 's|^\./lolly-archive-staging/|./|' /tmp/lolly-archive-staging.filelist.txt` locally before transfer.)

---

## Task 11: Append the pointer block to Hermes's live AGENTS.md

**Files:**
- Modify on EC2: `$LIVE_AGENTS` (path captured in Task 8)

- [ ] **Step 1: Back up the live AGENTS.md**

Run on EC2:
```bash
cp "$LIVE_AGENTS" "$LIVE_AGENTS.pre-lolly-pointer.bak"
ls -la "$LIVE_AGENTS"*
```

Expected: original + `.pre-lolly-pointer.bak` both present.

- [ ] **Step 2: Confirm no prior pointer block exists (idempotency check)**

Run on EC2:
```bash
grep -c 'BEGIN: lolly-archive-pointer' "$LIVE_AGENTS" || true
```

Expected: `0`. If `1` or higher, STOP — a prior install exists; investigate before continuing.

- [ ] **Step 3: Append the fenced pointer block**

Run on EC2:
```bash
cat >> "$LIVE_AGENTS" <<'EOF'

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
EOF
tail -25 "$LIVE_AGENTS"
```

Expected: tail output shows the inserted block intact.

- [ ] **Step 4: Verify exactly one pointer block present**

Run on EC2:
```bash
grep -c 'BEGIN: lolly-archive-pointer' "$LIVE_AGENTS"
grep -c 'END: lolly-archive-pointer' "$LIVE_AGENTS"
```

Expected: each `1`.

---

## Task 12: Verify Hermes byte-untouched + smoke test

**Files:**
- Read on EC2: `~/lolly-handoff/preflight.txt` (from Task 8)

- [ ] **Step 1: Re-snapshot `~/.hermes/` and diff against pre-flight**

Run on EC2:
```bash
{
  echo "=== postflight $(date -u +%FT%TZ) ==="
  echo
  echo "--- ~/.hermes file count ---"
  find ~/.hermes -type f 2>/dev/null | wc -l
  echo "--- ~/.hermes total size (bytes) ---"
  du -sb ~/.hermes 2>/dev/null
  echo "--- ~/.hermes file hashes (sorted) ---"
  find ~/.hermes -type f 2>/dev/null -exec sha256sum {} + | sort -k2
} > ~/lolly-handoff/postflight.txt

# Diff (the AGENTS.md hash WILL differ if it lives under ~/.hermes; that's expected and is the only allowed change)
diff ~/lolly-handoff/preflight.txt ~/lolly-handoff/postflight.txt | head -40
```

Expected: at most ONE differing line (the hash of `$LIVE_AGENTS` if it's inside `~/.hermes/`; otherwise zero diffs). Any other diff = STOP and investigate.

- [ ] **Step 2: `hermes status` clean**

Run on EC2:
```bash
hermes status
```

Expected: same output shape as Task 8 Step 6. No new errors.

- [ ] **Step 3: Restart `finny-mcp` (only if Hermes loads AGENTS.md at boot, not on every request)**

Check first whether AGENTS.md is read live or cached:
```bash
hermes config show 2>/dev/null | grep -i 'agents.md\|cache' | head
```

If cached, restart the unit:
```bash
sudo systemctl restart finny-mcp
sleep 2
sudo systemctl status finny-mcp | head -15
```

Expected: unit active, no crash logs.

If AGENTS.md is read live per request, skip the restart.

- [ ] **Step 4: Smoke test through the Finny MCP bridge**

From local machine (or wherever the MCP bridge is reachable), invoke `finny_query` with a NetSuite question whose answer should be in `lolly-learning-sessions.md`:

```
finny_query: "What's the vendor sign convention for credit memos in our NetSuite GL?"
```

Expected: the response either (a) cites or paraphrases content from `~/lolly-archive/`, or (b) produces a coherent NetSuite-aware answer. If the response says "I don't know" without consulting the archive, the pointer block is being ignored — fix by making the pointer block more explicit or moving it earlier in `$LIVE_AGENTS`.

- [ ] **Step 5: Explicit-consult test**

Invoke `finny_query` again with an explicit pointer:

```
finny_query: "Read ~/lolly-archive/lolly-learning-sessions.md and tell me the top 3 SuiteQL idioms it documents."
```

Expected: response summarizes content actually present in the file. Confirms the path is reachable to Hermes.

---

## Task 13: Document rollback in the deploy README

**Files:**
- Modify: `/Applications/finny-claude-plugin/deploy/README.md`

- [ ] **Step 1: Append a rollback section**

Edit `deploy/README.md` and append:

```markdown

## Lolly archive (knowledge handoff — 2026-06-08)

Read-only knowledge reference at `~/lolly-archive/` on prod EC2 `i-0ef58962b09d490ee`.
Pointer block lives in Hermes's live `AGENTS.md` between the markers
`<!-- BEGIN: lolly-archive-pointer ... -->` and `<!-- END: lolly-archive-pointer -->`.

### Rollback (one operator action)

```bash
# On EC2:
LIVE_AGENTS=<path-captured-during-install>   # see ~/lolly-handoff/preflight.txt
sed -i.bak '/<!-- BEGIN: lolly-archive-pointer/,/<!-- END: lolly-archive-pointer/d' "$LIVE_AGENTS"
rm -rf ~/lolly-archive/
hermes status   # confirm clean
```

After rollback, `~/.hermes/` is byte-identical to pre-handoff state (modulo
the `.bak` of the live AGENTS.md created by sed).

Source spec: `docs/superpowers/specs/2026-06-08-lolly-knowledge-handoff-design.md`
Plan: `docs/superpowers/plans/2026-06-08-lolly-knowledge-handoff.md`
```

- [ ] **Step 2: Commit**

Run from `/Applications/finny-claude-plugin`:
```bash
git add deploy/README.md
git commit -m "$(cat <<'EOF'
docs: add Lolly archive rollback to deploy README

Quick rollback recipe for the read-only knowledge handoff installed
2026-06-08 at ~/lolly-archive/ on prod Finny EC2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: commit succeeds.

---

## Final acceptance checklist

Before declaring the handoff complete:

- [ ] `~/.hermes/` file hashes match pre-flight (modulo the live AGENTS.md if it sits there).
- [ ] Pointer block present exactly once in `$LIVE_AGENTS`.
- [ ] `~/lolly-archive/` exists, mode 0555/0444, shape matches `lolly-archive-staging.filelist.txt`.
- [ ] No `archive/sessions/*.jsonl` on EC2 (raw chat history stayed local).
- [ ] No `11mirror/`, `fbrain-tooling/`, `github/` skills installed on EC2.
- [ ] No `archive/persona/` on EC2.
- [ ] `hermes status` clean.
- [ ] Smoke test (Task 12 Step 4) returned a NetSuite-informed answer.
- [ ] Explicit-consult test (Task 12 Step 5) returned content present in the archive file.
- [ ] `deploy/README.md` rollback section committed.
- [ ] Local raw `archive/sessions/` retained (fallback for future grep).
