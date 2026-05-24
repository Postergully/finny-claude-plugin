# Finny Claude Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fork `lolly-claude-plugin` → `finny-claude-plugin`, repoint at the Hermes Bedrock agent on existing EC2, and expose it at `https://finny.11mirror.com/mcp` for Claude.ai / Claude Desktop / Claude Code.

**Architecture:** Three systemd services on `i-0ef58962b09d490ee`: Hermes API (loopback `:8642`) ← finny-mcp bridge (loopback `:3000`, OAuth 2.1, SSE) ← Caddy (`:443`, Let's Encrypt). Pure rename of an already-working bridge — no logic changes, identical 5-tool surface, identical input schemas, identical skills.

**Tech Stack:** TypeScript + pnpm monorepo + tsup + vitest (existing), Node.js 22, Caddy, systemd, AWS Bedrock, Route 53, Let's Encrypt.

**Spec:** `docs/superpowers/specs/2026-05-24-finny-claude-plugin-design.md`

**Workspace:** `/Applications/finny-claude-plugin/` (already cloned from lolly, no git history retained from upstream, initial commit pushed to `Postergully/finny-claude-plugin`).

---

## File Structure (rename map)

The fork is mechanical. The source-of-truth substitutions, applied across all text files except `pnpm-lock.yaml`, `node_modules/`, `__tests__/judge-loop-results-*.json`, and `dist/`:

| Find | Replace |
|---|---|
| `lolly` | `finny` |
| `Lolly` | `Finny` |
| `LOLLY` | `FINNY` |
| `openclaw` | `hermes` |
| `OpenClaw` | `Hermes` |
| `OPENCLAW` | `FINNY_UPSTREAM` *(env vars become `FINNY_UPSTREAM_URL`, `FINNY_UPSTREAM_TOKEN`, `FINNY_MODEL`)* |
| `http://127.0.0.1:18789` | `http://127.0.0.1:8642` |
| `"openclaw"` (model literal) | `"hermes-agent"` |
| `@postergully/lolly-mcp` | `@postergully/finny-mcp` |
| `@postergully/lolly-plugin` | `@postergully/finny-plugin` |
| `lolly-mcp` (binary name) | `finny-mcp` |
| `io.github.freema/openclaw-mcp` (mcpName) | `io.github.postergully/finny-mcp` |

**KEEP UNCHANGED** (per user direction: "all other things remains same finance skill netsuite etc"):
- All NetSuite/finance domain language inside skill envelopes
- Input schema fields like `vendor_name` in `query.ts`
- Judging logic, intent decomposition, ask-back semantics
- `__tests__/fixtures/*.json` and `__tests__/judge-loop-scenarios/` content
- Skill folder names: `cowork-init/`, `day_dream/`, `finance/`, `intent-decomposer/`, `judging-output/`
- File `bin/day-dream-poll.sh`

**Files to rename (path-level):**
- `plugin/skills/lolly-usage/` → `plugin/skills/finny-usage/`
- `bridge/src/openclaw/` → `bridge/src/hermes/` (directory)
- `bridge/plugins/claude/openclaw/` → `bridge/plugins/claude/hermes/`
- `bridge/plugins/claude/hermes/skills/openclaw-management/` → `bridge/plugins/claude/hermes/skills/hermes-management/`

**Files to add:**
- `deploy/systemd/hermes-api.service`
- `deploy/systemd/finny-mcp.service`
- `deploy/caddy/Caddyfile`
- `deploy/iam/finny-additions.json`
- `deploy/README.md`

---

# Phase 1 — Rename pass on the Mac

### Task 1.1: Spot-check the existing tree

**Files:**
- Read: `/Applications/finny-claude-plugin/package.json`
- Read: `/Applications/finny-claude-plugin/pnpm-workspace.yaml`
- Read: `/Applications/finny-claude-plugin/bridge/package.json`
- Read: `/Applications/finny-claude-plugin/plugin/package.json`

- [ ] **Step 1: List files containing rename targets**

Run:
```bash
cd /Applications/finny-claude-plugin
grep -rl --include="*.ts" --include="*.json" --include="*.md" --include="*.sh" --include="*.yaml" --include="*.mjs" -i "lolly\|openclaw" . \
  | grep -v node_modules | grep -v pnpm-lock | grep -v "judge-loop-results-" | grep -v "/dist/" \
  | sort > /tmp/finny-rename-targets.txt
wc -l /tmp/finny-rename-targets.txt
head -30 /tmp/finny-rename-targets.txt
```

Expected: A list of ~120 files. No surprises (no `node_modules` entries, no compiled `dist/` entries).

- [ ] **Step 2: Create rename helper script**

Create `/tmp/finny-rename.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
TARGETS_FILE="/tmp/finny-rename-targets.txt"
while IFS= read -r f; do
  [ -f "$f" ] || continue
  # Order matters: do longest/most-specific first
  sed -i.bak \
    -e 's|@postergully/lolly-mcp|@postergully/finny-mcp|g' \
    -e 's|@postergully/lolly-plugin|@postergully/finny-plugin|g' \
    -e 's|io.github.freema/openclaw-mcp|io.github.postergully/finny-mcp|g' \
    -e 's|http://127.0.0.1:18789|http://127.0.0.1:8642|g' \
    -e 's|"openclaw"|"hermes-agent"|g' \
    -e 's|OPENCLAW_URL|FINNY_UPSTREAM_URL|g' \
    -e 's|OPENCLAW_GATEWAY_TOKEN|FINNY_UPSTREAM_TOKEN|g' \
    -e 's|OPENCLAW_MODEL|FINNY_MODEL|g' \
    -e 's|OPENCLAW_TIMEOUT_MS|FINNY_TIMEOUT_MS|g' \
    -e 's|OPENCLAW_INSTANCES|FINNY_INSTANCES|g' \
    -e 's|LOLLY_GATEWAY_TOKEN|FINNY_GATEWAY_TOKEN|g' \
    -e 's|LOLLY_LIVE_JUDGE_LOOP|FINNY_LIVE_JUDGE_LOOP|g' \
    -e 's|OpenClaw|Hermes|g' \
    -e 's|openclaw|hermes|g' \
    -e 's|OPENCLAW|HERMES|g' \
    -e 's|Lolly|Finny|g' \
    -e 's|lolly|finny|g' \
    -e 's|LOLLY|FINNY|g' \
    "$f"
  rm -f "${f}.bak"
done < "$TARGETS_FILE"
echo "Rewrote $(wc -l < "$TARGETS_FILE") files"
```

`chmod +x /tmp/finny-rename.sh`.

Note: the longer/qualified strings come first so they're caught before generic `lolly`/`openclaw` substitutions consume their components.

- [ ] **Step 3: Dry-run review**

Run on a single file first:
```bash
cp /Applications/finny-claude-plugin/bridge/package.json /tmp/before.json
echo "/Applications/finny-claude-plugin/bridge/package.json" > /tmp/single.txt
TARGETS_FILE=/tmp/single.txt /tmp/finny-rename.sh
diff /tmp/before.json /Applications/finny-claude-plugin/bridge/package.json
```

Expected diff: name `lolly-mcp` → `finny-mcp`, mcpName changed, description with `Lolly` → `Finny`, etc. **If anything looks wrong, restore from before.json and adjust the script before applying broadly.**

- [ ] **Step 4: Commit the unmodified state for safety**

```bash
cd /Applications/finny-claude-plugin
git status
git add -A
git diff --cached --stat
# If only bridge/package.json shows changes from step 3, revert it:
git checkout -- bridge/package.json
git status   # should show clean
```

Expected: clean tree (initial commit already includes all files).

### Task 1.2: Apply rename across all targets

**Files:**
- Modify: ~120 files listed in `/tmp/finny-rename-targets.txt`

- [ ] **Step 1: Apply the rename script**

```bash
/tmp/finny-rename.sh
```

Expected output: `Rewrote 120+ files`.

- [ ] **Step 2: Sanity-check the diff size**

```bash
cd /Applications/finny-claude-plugin
git diff --stat | tail -5
```

Expected: ~120 files changed, hundreds-to-low-thousands of insertions/deletions, similar count of deletions (since these are mostly substitutions, not additions).

- [ ] **Step 3: Verify no `lolly`/`openclaw`/`Lolly`/`OpenClaw` strings remain in source**

```bash
cd /Applications/finny-claude-plugin
grep -r --include="*.ts" --include="*.json" --include="*.md" --include="*.sh" --include="*.yaml" --include="*.mjs" \
  -l 'lolly\|openclaw\|Lolly\|OpenClaw\|LOLLY\|OPENCLAW' . \
  | grep -v node_modules | grep -v pnpm-lock | grep -v "judge-loop-results-" | grep -v "/dist/" \
  || echo "CLEAN"
```

Expected: `CLEAN` (or only paths under `__tests__/judge-loop-results-*.json` which we skipped — those are timestamped output artifacts and should be ignored).

If anything else shows up, **inspect each match**, fix manually with `sed -i`, repeat the grep until clean.

- [ ] **Step 4: Commit**

```bash
cd /Applications/finny-claude-plugin
git add -A
git commit -m "rename: lolly → finny, openclaw → hermes (string substitutions)"
```

### Task 1.3: Rename directory paths

**Files:**
- Move: `plugin/skills/lolly-usage/` → `plugin/skills/finny-usage/`
- Move: `bridge/src/openclaw/` → `bridge/src/hermes/`
- Move: `bridge/plugins/claude/openclaw/` → `bridge/plugins/claude/hermes/`
- Move: `bridge/plugins/claude/hermes/skills/openclaw-management/` → `bridge/plugins/claude/hermes/skills/hermes-management/`

- [ ] **Step 1: Discover dirs to rename**

```bash
cd /Applications/finny-claude-plugin
find . -type d \( -iname "*lolly*" -o -iname "*openclaw*" \) | grep -v node_modules
```

Expected: the 4 directories listed above (paths may differ slightly — adjust steps 2-3 to match).

- [ ] **Step 2: Rename via `git mv`**

```bash
cd /Applications/finny-claude-plugin
git mv plugin/skills/lolly-usage plugin/skills/finny-usage
git mv bridge/src/openclaw bridge/src/hermes
git mv bridge/plugins/claude/openclaw/skills/openclaw-management bridge/plugins/claude/openclaw/skills/hermes-management
git mv bridge/plugins/claude/openclaw bridge/plugins/claude/hermes
```

Note the order: rename the *child* `openclaw-management` skill before its parent `openclaw` plugin dir, otherwise the path will already have moved.

- [ ] **Step 3: Update import statements that reference moved files**

```bash
cd /Applications/finny-claude-plugin
grep -rn "from .*['\"].*openclaw" bridge/src --include="*.ts" | head -20
grep -rn "from .*['\"].*lolly" bridge/src --include="*.ts" | head -20
```

Expected: zero matches (Step 2 only moved dirs; the in-file `openclaw` → `hermes` substitution from Task 1.2 already updated import paths).

If any matches appear, fix manually — every `from './openclaw/...'` import needs to read `from './hermes/...'`.

- [ ] **Step 4: Verify no stray dir names remain**

```bash
cd /Applications/finny-claude-plugin
find . -type d \( -iname "*lolly*" -o -iname "*openclaw*" \) | grep -v node_modules || echo "CLEAN"
```

Expected: `CLEAN`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "rename: directory paths (lolly-usage → finny-usage, openclaw → hermes)"
```

### Task 1.4: Repoint plugin/.mcp.json to remote HTTP transport

**Files:**
- Modify: `plugin/.mcp.json`

- [ ] **Step 1: Inspect current state**

```bash
cd /Applications/finny-claude-plugin
cat plugin/.mcp.json
```

Expected: still has the local-stdio shape (after Task 1.2 it now points at `dist/index.js` of the renamed bridge with `FINNY_UPSTREAM_URL=http://127.0.0.1:8642`).

- [ ] **Step 2: Replace with remote-only HTTP transport**

Overwrite `plugin/.mcp.json`:
```json
{
  "mcpServers": {
    "finny": {
      "type": "http",
      "url": "https://finny.11mirror.com/mcp"
    }
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add plugin/.mcp.json
git commit -m "plugin: switch .mcp.json to remote http transport (finny.11mirror.com)"
```

### Task 1.5: Verify build, typecheck, and tests

**Files:** none (validation only)

- [ ] **Step 1: Install dependencies**

```bash
cd /Applications/finny-claude-plugin
pnpm install
```

Expected: clean install, no peer warnings beyond what existed pre-rename, no errors.

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck
```

Expected: 0 errors. **If a TypeScript error appears, it's almost certainly a missed import path that survived the rename — fix and re-run before continuing.**

- [ ] **Step 3: Build**

```bash
pnpm build
```

Expected: success in both `bridge/` and `plugin/` workspaces. `bridge/dist/index.js` exists.

- [ ] **Step 4: Run unit tests**

```bash
pnpm test --run 2>&1 | tail -20
```

Expected: all tests pass (the suite that ran for Lolly should still pass — we didn't change behavior).

If a test fails because the assertion contains the old name, update the expected string in the test, then re-run.

- [ ] **Step 5: Commit any test-string fixes (only if Step 4 required them)**

```bash
git diff --stat
git add -A
git commit -m "test: update assertions to renamed identifiers"
```

### Task 1.6: Add deploy artifacts

**Files:**
- Create: `deploy/README.md`
- Create: `deploy/systemd/hermes-api.service`
- Create: `deploy/systemd/finny-mcp.service`
- Create: `deploy/caddy/Caddyfile`
- Create: `deploy/iam/finny-additions.json`

- [ ] **Step 1: Create directory structure**

```bash
cd /Applications/finny-claude-plugin
mkdir -p deploy/systemd deploy/caddy deploy/iam
```

- [ ] **Step 2: Write `deploy/systemd/hermes-api.service`**

```ini
[Unit]
Description=Hermes Agent API Server (OpenAI-compatible) for Finny
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/home/ubuntu
EnvironmentFile=/home/ubuntu/.hermes/.env
ExecStart=/home/ubuntu/hermes-venv/bin/hermes gateway
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: Write `deploy/systemd/finny-mcp.service`**

```ini
[Unit]
Description=Finny MCP Bridge (OAuth 2.1 + SSE on 127.0.0.1:3000)
After=network-online.target hermes-api.service
Wants=network-online.target
Requires=hermes-api.service

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/opt/finny/bridge
EnvironmentFile=/opt/finny/bridge/.env
ExecStart=/usr/bin/node /opt/finny/bridge/dist/index.js --transport sse --port 3000 --host 127.0.0.1
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Note: confirm at deploy time whether the bridge CLI accepts `--transport sse --port 3000 --host 127.0.0.1` flags or expects them via env. If env-only, replace the ExecStart line with `ExecStart=/usr/bin/node /opt/finny/bridge/dist/index.js` and add `MCP_TRANSPORT=sse`, `MCP_PORT=3000`, `MCP_HOST=127.0.0.1` to `.env`.

- [ ] **Step 4: Write `deploy/caddy/Caddyfile`**

```
finny.11mirror.com {
    encode gzip
    reverse_proxy 127.0.0.1:3000 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto https
    }
    log {
        output file /var/log/caddy/finny.access.log
        format json
    }
}
```

- [ ] **Step 5: Write `deploy/iam/finny-additions.json`**

These statements get appended to the existing `HermesDeploy` policy. The Route 53 hosted zone ARN will be filled in at deploy time (Phase 3 Task 3.1).

```json
{
  "Sid": "ElasticIPManagement",
  "Effect": "Allow",
  "Action": [
    "ec2:AllocateAddress",
    "ec2:AssociateAddress",
    "ec2:DisassociateAddress",
    "ec2:DescribeAddresses",
    "ec2:ReleaseAddress"
  ],
  "Resource": "*",
  "Condition": {
    "StringEquals": {
      "aws:RequestedRegion": "us-east-1"
    }
  }
}
```

```json
{
  "Sid": "Route53List",
  "Effect": "Allow",
  "Action": [
    "route53:ListHostedZones",
    "route53:ListResourceRecordSets",
    "route53:GetHostedZone",
    "route53:GetChange"
  ],
  "Resource": "*"
}
```

```json
{
  "Sid": "Route53WriteFor11mirror",
  "Effect": "Allow",
  "Action": [
    "route53:ChangeResourceRecordSets"
  ],
  "Resource": "arn:aws:route53:::hostedzone/REPLACE_WITH_11MIRROR_HOSTED_ZONE_ID"
}
```

Save these as a single JSON file containing all three statements wrapped in `{ "Version": "2012-10-17", "Statement": [...] }`.

- [ ] **Step 6: Write `deploy/README.md`** (skeleton; full deploy steps are tracked in this plan, README links back)

```markdown
# Finny — EC2 Deploy

Deploy artifacts for hosting the Finny MCP bridge on the existing
Hermes EC2 instance (`i-0ef58962b09d490ee`, us-east-1).

## What's here

- `systemd/hermes-api.service` — runs `hermes gateway` (Hermes API server, loopback :8642)
- `systemd/finny-mcp.service` — runs the bridge (loopback :3000, OAuth 2.1)
- `caddy/Caddyfile` — public TLS endpoint at `finny.11mirror.com`
- `iam/finny-additions.json` — extra statements added to the `HermesDeploy` IAM policy

## Deploy procedure

See `docs/superpowers/plans/2026-05-24-finny-claude-plugin.md` Phases 3–7
for the step-by-step deploy. Don't run any of these on a different EC2
without re-checking the security group, IAM, and Route 53 zone IDs.
```

- [ ] **Step 7: Commit deploy artifacts**

```bash
cd /Applications/finny-claude-plugin
git add deploy/
git commit -m "deploy: add systemd units, Caddyfile, and IAM additions"
```

### Task 1.7: Push to GitHub

**Files:** none (push only)

- [ ] **Step 1: Push all commits**

```bash
cd /Applications/finny-claude-plugin
git log --oneline | head -10
git push origin main
```

Expected: 4-5 new commits pushed on top of the initial fork commit.

- [ ] **Step 2: Verify on GitHub**

```bash
gh repo view Postergully/finny-claude-plugin --web 2>&1 | head -2
gh api repos/Postergully/finny-claude-plugin/commits --jq '.[0:5] | .[] | "\(.sha[0:7]) \(.commit.message | split("\n")[0])"'
```

Expected: see all rename commits.

---

# Phase 2 — Pre-deploy verification on Mac

### Task 2.1: Smoke-test the renamed bridge against a stub upstream

**Files:** none (validation only — no code change)

- [ ] **Step 1: Locate or create a smoke harness**

```bash
cd /Applications/finny-claude-plugin
ls bridge/__tests__/ | head -20
grep -rn "describe\|it\(" bridge/__tests__/judgeLoop.test.ts 2>&1 | head
```

Expected: existing test infrastructure that mocks the upstream agent. Use it as-is.

- [ ] **Step 2: Run the live judge loop with a stubbed upstream**

```bash
cd /Applications/finny-claude-plugin
FINNY_LIVE_JUDGE_LOOP= pnpm --filter @postergully/finny-mcp test:run 2>&1 | tail -30
```

Expected: the same suite that worked for Lolly works here. **If a fixture file has hardcoded `lolly` strings inside JSON values that the rename script transformed but the test asserts on**, expect mismatch. Fix the assertion (not the fixture) — fixtures simulate upstream and are outside our rename scope.

- [ ] **Step 3: Skip if no breakage** (no commit needed)

If something broke, fix and commit:
```bash
git add -A
git commit -m "test: post-rename smoke fixes"
git push
```

---

# Phase 3 — AWS infra additions

### Task 3.1: Discover the 11mirror.com hosted zone ID

**Files:** none

- [ ] **Step 1: List hosted zones in your account**

Run on Mac:
```bash
aws route53 list-hosted-zones --query 'HostedZones[?Name==`11mirror.com.`].[Id,Name]' --output text
```

Expected: a single line like `/hostedzone/Z0123456ABCDEFGHIJK	11mirror.com.`.

If `AccessDenied` — your `HermesDeploy` policy doesn't yet have `route53:ListHostedZones`. That's the chicken-and-egg below: skip ahead to Task 3.2 first, then come back.

If empty result — `11mirror.com` is *not* in Route 53 in this AWS account. Stop and reconcile with the user before continuing.

- [ ] **Step 2: Capture the zone ID for later steps**

Save the zone ID (the part after `/hostedzone/`) somewhere you can copy from. From here on, this plan refers to it as `<11MIRROR_ZONE_ID>`.

### Task 3.2: Update HermesDeploy IAM policy

**Files:** working from `~/hermes-deploy/hermes-deploy-policy.json` (Mac) or fresh download.

- [ ] **Step 1: Pull current policy version**

```bash
ACCT=$(aws sts get-caller-identity --query 'Account' --output text)
POLICY_ARN="arn:aws:iam::${ACCT}:policy/HermesDeploy"
aws iam get-policy --policy-arn "$POLICY_ARN" --query 'Policy.DefaultVersionId' --output text
```

Capture the version ID (e.g. `v1`).

```bash
aws iam get-policy-version --policy-arn "$POLICY_ARN" --version-id <VERSION_ID> \
  --query 'PolicyVersion.Document' > /tmp/HermesDeploy.current.json
cat /tmp/HermesDeploy.current.json | python3 -m json.tool | head -20
```

- [ ] **Step 2: Compose the new policy document**

Combine the current policy's Statements with the three new statements from `deploy/iam/finny-additions.json`. Substitute the real zone ID into the Route53Write statement.

```bash
ZONE_ID=<11MIRROR_ZONE_ID>   # without /hostedzone/ prefix
python3 <<EOF > /tmp/HermesDeploy.new.json
import json
cur = json.load(open('/tmp/HermesDeploy.current.json'))
add = json.load(open('/Applications/finny-claude-plugin/deploy/iam/finny-additions.json'))
for s in add['Statement']:
    if 'REPLACE_WITH_11MIRROR_HOSTED_ZONE_ID' in str(s.get('Resource','')):
        s['Resource'] = s['Resource'].replace('REPLACE_WITH_11MIRROR_HOSTED_ZONE_ID', '$ZONE_ID')
cur['Statement'].extend(add['Statement'])
json.dump(cur, open('/tmp/HermesDeploy.new.json','w'), indent=2)
EOF
python3 -m json.tool /tmp/HermesDeploy.new.json > /dev/null && echo "JSON valid"
```

- [ ] **Step 3: Push the new policy version and set as default**

```bash
aws iam create-policy-version --policy-arn "$POLICY_ARN" \
  --policy-document file:///tmp/HermesDeploy.new.json --set-as-default
```

Expected: returns the new version (e.g. `v2`).

- [ ] **Step 4: Verify the user can now perform the new actions**

```bash
aws ec2 describe-addresses --region us-east-1 --query 'Addresses[*].[PublicIp,InstanceId]' --output table
aws route53 list-hosted-zones --query 'HostedZones[?Name==`11mirror.com.`].[Id,Name]' --output text
```

Expected: both succeed. The first will show `None` if no Elastic IPs are allocated yet — that's fine.

- [ ] **Step 5: (Optional) Delete oldest policy versions if the 5-version limit looms**

```bash
aws iam list-policy-versions --policy-arn "$POLICY_ARN" \
  --query 'Versions[?IsDefaultVersion==`false`].VersionId' --output text
# If 4+ non-default versions exist:
# aws iam delete-policy-version --policy-arn "$POLICY_ARN" --version-id <oldest>
```

### Task 3.3: Allocate Elastic IP and associate with EC2

**Files:** none

- [ ] **Step 1: Allocate the EIP**

```bash
aws ec2 allocate-address --domain vpc --region us-east-1 \
  --tag-specifications 'ResourceType=elastic-ip,Tags=[{Key=Name,Value=finny-mcp},{Key=Project,Value=finny}]' \
  --query '[AllocationId,PublicIp]' --output text
```

Expected: prints `eipalloc-xxx` and the public IP. Record both.

- [ ] **Step 2: Associate with the Hermes instance**

```bash
ALLOC_ID=<eipalloc-xxx>
aws ec2 associate-address --allocation-id "$ALLOC_ID" \
  --instance-id i-0ef58962b09d490ee --region us-east-1
```

Expected: returns `AssociationId`.

- [ ] **Step 3: Verify the instance now has the new public IP**

```bash
aws ec2 describe-instances --instance-ids i-0ef58962b09d490ee --region us-east-1 \
  --query 'Reservations[0].Instances[0].[PublicIpAddress,PublicDnsName]' --output text
```

Expected: the IP matches the EIP from Step 1.

### Task 3.4: Open security group ingress on :80 and :443

**Files:** none

- [ ] **Step 1: Find the instance's security group**

```bash
SG_ID=$(aws ec2 describe-instances --instance-ids i-0ef58962b09d490ee --region us-east-1 \
  --query 'Reservations[0].Instances[0].SecurityGroups[0].GroupId' --output text)
echo "Security group: $SG_ID"
```

- [ ] **Step 2: Add HTTP and HTTPS ingress**

```bash
aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --region us-east-1 \
  --ip-permissions '[
    {"IpProtocol":"tcp","FromPort":80,"ToPort":80,"IpRanges":[{"CidrIp":"0.0.0.0/0","Description":"HTTP for Caddy ACME"}]},
    {"IpProtocol":"tcp","FromPort":443,"ToPort":443,"IpRanges":[{"CidrIp":"0.0.0.0/0","Description":"HTTPS for finny.11mirror.com"}]}
  ]'
```

Expected: success. If `InvalidPermission.Duplicate`, the rule already exists — fine.

- [ ] **Step 3: Verify**

```bash
aws ec2 describe-security-groups --group-ids "$SG_ID" --region us-east-1 \
  --query 'SecurityGroups[0].IpPermissions[?ToPort==`80`||ToPort==`443`]' --output table
```

### Task 3.5: Create Route 53 A record for finny.11mirror.com

**Files:** `/tmp/finny-route53-change.json`

- [ ] **Step 1: Compose the change batch**

```bash
ZONE_ID=<11MIRROR_ZONE_ID>      # no /hostedzone/ prefix
EIP=<the public IP from 3.3>
cat > /tmp/finny-route53-change.json <<EOF
{
  "Comment": "finny MCP endpoint",
  "Changes": [{
    "Action": "UPSERT",
    "ResourceRecordSet": {
      "Name": "finny.11mirror.com.",
      "Type": "A",
      "TTL": 300,
      "ResourceRecords": [{"Value": "$EIP"}]
    }
  }]
}
EOF
cat /tmp/finny-route53-change.json
```

- [ ] **Step 2: Submit the change**

```bash
aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" \
  --change-batch file:///tmp/finny-route53-change.json \
  --query '[ChangeInfo.Id,ChangeInfo.Status]' --output text
```

Expected: returns the change ID and `PENDING`.

- [ ] **Step 3: Wait for propagation**

```bash
CHANGE_ID=<from-step-2>
aws route53 wait resource-record-sets-changed --id "$CHANGE_ID"
echo "DNS change INSYNC"
```

- [ ] **Step 4: Resolve from public DNS**

```bash
dig +short finny.11mirror.com @1.1.1.1
```

Expected: the EIP. **If different IP or empty for >5 minutes, stop and investigate** before continuing — Caddy's ACME challenge will fail otherwise.

---

# Phase 4 — EC2 install: Node, Caddy, repo, build

All steps run inside an SSM session as `ubuntu`. Open one with:
```bash
aws ssm start-session --target i-0ef58962b09d490ee --region us-east-1
sudo -iu ubuntu
```

### Task 4.1: Install Node.js 22 and pnpm

**Files:** system

- [ ] **Step 1: Install Node 22 via NodeSource**

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
npm -v
```

Expected: `v22.x.x`.

- [ ] **Step 2: Install pnpm globally**

```bash
sudo npm install -g pnpm@9
pnpm -v
```

Expected: `9.x`.

### Task 4.2: Install Caddy from upstream apt repo

**Files:** system

- [ ] **Step 1: Add Caddy's apt repo and install**

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy
caddy version
```

Expected: 2.x version printed.

- [ ] **Step 2: Verify Caddy started by default**

```bash
sudo systemctl status caddy --no-pager | head -10
```

Expected: `active (running)`. Caddy comes pre-enabled on apt install.

### Task 4.3: Clone finny-claude-plugin into /opt/finny

**Files:** `/opt/finny/`

- [ ] **Step 1: Create directory and set ownership**

```bash
sudo mkdir -p /opt/finny
sudo chown -R ubuntu:ubuntu /opt/finny
```

- [ ] **Step 2: Clone the repo**

The repo is private — auth via a deploy key or a GitHub Personal Access Token. For the deploy walkthrough we'll use HTTPS + PAT just for the clone:

```bash
read -s -p "GitHub PAT (with repo:read on Postergully/finny-claude-plugin): " PAT
git clone https://${PAT}@github.com/Postergully/finny-claude-plugin.git /opt/finny
unset PAT
cd /opt/finny
git log --oneline -5
```

For long-term: replace HTTPS remote with SSH + a deploy key on the instance, or use AWS CodeCommit mirror. **Do not** leave the PAT in the remote URL — replace it after cloning:

```bash
cd /opt/finny
git remote set-url origin git@github.com:Postergully/finny-claude-plugin.git   # only if SSH key set up
# Or simpler: since deploy is one-time pull, keep HTTPS but strip the token:
git remote set-url origin https://github.com/Postergully/finny-claude-plugin.git
git remote -v
```

- [ ] **Step 3: Install deps and build**

```bash
cd /opt/finny
pnpm install --frozen-lockfile
pnpm build
ls -la bridge/dist/index.js
```

Expected: `bridge/dist/index.js` exists.

---

# Phase 5 — Configure secrets and env files

### Task 5.1: Generate shared secret for Hermes ↔ bridge

**Files:** ephemeral

- [ ] **Step 1: Generate secret**

In the SSM session as `ubuntu`:
```bash
SHARED=$(openssl rand -hex 32)
echo "$SHARED"
```

Save this somewhere outside the EC2 (e.g., your password manager). It will be written into both `~/.hermes/.env` (as `API_SERVER_KEY`) and `/opt/finny/bridge/.env` (as `FINNY_UPSTREAM_TOKEN`).

- [ ] **Step 2: Generate OAuth client secret**

```bash
OAUTH=$(openssl rand -hex 32)
echo "$OAUTH"
```

Save this too. Goes into `MCP_CLIENT_SECRET`.

### Task 5.2: Append to ~/.hermes/.env

**Files:** `/home/ubuntu/.hermes/.env`

- [ ] **Step 1: Inspect current contents**

```bash
cat /home/ubuntu/.hermes/.env
```

Expected: empty file (created by `hermes doctor --fix` earlier) or whatever you've added since.

- [ ] **Step 2: Append API server config**

```bash
cat >> /home/ubuntu/.hermes/.env <<EOF
API_SERVER_ENABLED=true
API_SERVER_KEY=$SHARED
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=8642
EOF
chmod 600 /home/ubuntu/.hermes/.env
```

- [ ] **Step 3: Verify**

```bash
grep -E "API_SERVER_" /home/ubuntu/.hermes/.env
```

Expected: 4 lines with the values from above.

### Task 5.3: Write /opt/finny/bridge/.env

**Files:** `/opt/finny/bridge/.env`

- [ ] **Step 1: Write the file**

```bash
cat > /opt/finny/bridge/.env <<EOF
AUTH_ENABLED=true
MCP_CLIENT_ID=finny
MCP_CLIENT_SECRET=$OAUTH
MCP_ISSUER_URL=https://finny.11mirror.com
TRUST_PROXY=1
CORS_ORIGINS=https://claude.ai
FINNY_UPSTREAM_URL=http://127.0.0.1:8642
FINNY_UPSTREAM_TOKEN=$SHARED
FINNY_MODEL=hermes-agent
FINNY_TIMEOUT_MS=300000
EOF
chmod 600 /opt/finny/bridge/.env
```

- [ ] **Step 2: Verify ownership and permissions**

```bash
ls -la /opt/finny/bridge/.env
```

Expected: `-rw------- 1 ubuntu ubuntu`.

---

# Phase 6 — systemd services and Caddy

### Task 6.1: Install hermes-api.service

**Files:** `/etc/systemd/system/hermes-api.service`

- [ ] **Step 1: Copy the unit file from the repo**

```bash
sudo cp /opt/finny/deploy/systemd/hermes-api.service /etc/systemd/system/
sudo systemctl daemon-reload
```

- [ ] **Step 2: Enable and start**

```bash
sudo systemctl enable hermes-api
sudo systemctl start hermes-api
sleep 3
sudo systemctl status hermes-api --no-pager | head -15
```

Expected: `active (running)`. Logs visible via `journalctl -u hermes-api -n 50`.

- [ ] **Step 3: Smoke-test the API server**

```bash
curl -sS http://127.0.0.1:8642/v1/health
echo
curl -sS -H "Authorization: Bearer $SHARED" http://127.0.0.1:8642/v1/models | python3 -m json.tool
```

Expected: health returns `{"status":"ok"}`. `/v1/models` returns a JSON object listing `hermes-agent`.

### Task 6.2: Install finny-mcp.service

**Files:** `/etc/systemd/system/finny-mcp.service`

- [ ] **Step 1: Confirm bridge CLI flags**

```bash
node /opt/finny/bridge/dist/index.js --help 2>&1 | head -30
```

Expected: see flags like `--transport`, `--port`, `--host`. **If the bridge expects env vars instead**, edit `/etc/systemd/system/finny-mcp.service` to drop the flags and add env entries (see Task 1.6 Step 3 note).

- [ ] **Step 2: Copy the unit file**

```bash
sudo cp /opt/finny/deploy/systemd/finny-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload
```

- [ ] **Step 3: Enable and start**

```bash
sudo systemctl enable finny-mcp
sudo systemctl start finny-mcp
sleep 3
sudo systemctl status finny-mcp --no-pager | head -15
```

Expected: `active (running)`.

If it fails: `journalctl -u finny-mcp -n 100 --no-pager`. Most common failure is missing `dist/index.js` (Phase 4 Task 4.3 Step 3 didn't complete) or env file syntax error.

- [ ] **Step 4: Smoke-test the bridge locally**

```bash
curl -sS http://127.0.0.1:3000/health || echo "no /health route"
curl -sS http://127.0.0.1:3000/.well-known/oauth-authorization-server | python3 -m json.tool | head -20
```

Expected: the OAuth metadata document returns with `issuer: https://finny.11mirror.com`. **If issuer says `localhost` or `127.0.0.1`, `MCP_ISSUER_URL` isn't being read** — fix the env file or the systemd unit.

### Task 6.3: Configure Caddy

**Files:** `/etc/caddy/Caddyfile`

- [ ] **Step 1: Replace the default Caddyfile**

```bash
sudo cp /opt/finny/deploy/caddy/Caddyfile /etc/caddy/Caddyfile
sudo mkdir -p /var/log/caddy
sudo chown caddy:caddy /var/log/caddy
```

- [ ] **Step 2: Validate syntax and reload**

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager | head -10
```

Expected: validate passes, reload succeeds.

- [ ] **Step 3: Watch ACME flow**

```bash
sudo journalctl -u caddy -n 100 --no-pager | tail -30
```

Expected: messages about obtaining a certificate from Let's Encrypt for `finny.11mirror.com`. **If you see ACME failure**, the most likely cause is DNS hasn't propagated (Phase 3 Task 3.5) or port 80 isn't open (Phase 3 Task 3.4).

### Task 6.4: External smoke test

**Files:** none

- [ ] **Step 1: From your Mac**

```bash
curl -vI https://finny.11mirror.com/.well-known/oauth-authorization-server 2>&1 | head -20
```

Expected: TLS handshake succeeds with a Let's Encrypt cert; HTTP/2 200.

- [ ] **Step 2: Fetch OAuth metadata externally**

```bash
curl -sS https://finny.11mirror.com/.well-known/oauth-authorization-server | python3 -m json.tool
```

Expected: `issuer: "https://finny.11mirror.com"` (not localhost), `authorization_endpoint`, `token_endpoint`, `registration_endpoint` all on the public host.

- [ ] **Step 3: Hit /mcp without auth**

```bash
curl -sS -i -X POST https://finny.11mirror.com/mcp -H "Content-Type: application/json" -d '{}' | head -10
```

Expected: `401 Unauthorized` with a `WWW-Authenticate: Bearer` header. **If 200 OK, OAuth isn't enforcing — `AUTH_ENABLED` is wrong in the bridge env.**

---

# Phase 7 — Reboot resilience and ops verification

### Task 7.1: Reboot test

**Files:** none

- [ ] **Step 1: Reboot the instance**

```bash
sudo reboot
```

The SSM session will drop. Wait ~60s.

- [ ] **Step 2: Reconnect and verify all three services started**

```bash
aws ssm start-session --target i-0ef58962b09d490ee --region us-east-1
sudo -iu ubuntu
sudo systemctl is-active hermes-api finny-mcp caddy
```

Expected: three lines, all `active`.

- [ ] **Step 3: External smoke**

From Mac:
```bash
curl -sS -i https://finny.11mirror.com/.well-known/oauth-authorization-server | head -5
```

Expected: 200 OK.

### Task 7.2: Log retention and basic monitoring

**Files:** none (deferred — flag for a future plan)

- [ ] **Step 1: Note for ops handoff**

Note in `deploy/README.md` (commit & push) that:
- Service logs go to `journalctl -u <service>` (rotated by systemd-journald default)
- Caddy logs go to `/var/log/caddy/finny.access.log` (no logrotate yet — add when needed)
- No alerting/uptime monitoring set up yet

```bash
cd /Applications/finny-claude-plugin
cat >> deploy/README.md <<'EOF'

## Observability (current state)

- Service logs: `journalctl -u hermes-api -u finny-mcp -u caddy -f`
- Caddy access log: `/var/log/caddy/finny.access.log` (JSON, no rotation configured)
- No alerting / uptime monitoring yet — add CloudWatch or external check before relying in production.
EOF
git add deploy/README.md
git commit -m "deploy: document current observability gaps"
git push
```

---

# Phase 8 — Client wiring and end-to-end test

### Task 8.1: Test from Claude.ai Custom Connectors

**Files:** none (manual UI step)

- [ ] **Step 1: Add the connector**

In `claude.ai`:
- Settings → Connectors → Add custom connector
- URL: `https://finny.11mirror.com/mcp`
- Click through the OAuth consent flow

Expected: connector lists 5 tools (`finny_query`, `finny_report`, `finny_task_status`, `finny_continue`, `finny_remember`).

- [ ] **Step 2: Call `finny_query` from a Claude.ai conversation**

Prompt: "Use finny_query to ask Finny what its current model is."

Expected: tool invocation succeeds, response references Bedrock / Claude Sonnet 4.6.

- [ ] **Step 3: Tail bridge logs during the call**

Back in SSM:
```bash
journalctl -u finny-mcp -f
```

Expected: see request log, OAuth verification, upstream call to `127.0.0.1:8642`, response.

### Task 8.2: Publish plugin via marketplace.json

**Files:** `.claude-plugin/marketplace.json` (already updated by the rename pass)

- [ ] **Step 1: Verify marketplace manifest**

```bash
cat /Applications/finny-claude-plugin/.claude-plugin/marketplace.json
```

Expected:
```json
{
  "name": "postergully-finny-claude-plugin",
  "owner": { "name": "Postergully" },
  "plugins": [
    { "name": "finny", "source": "./plugin", "description": "..." }
  ]
}
```

- [ ] **Step 2: Test marketplace install in Claude Code**

In Claude Code, install the plugin from the GitHub repo (mechanism per the cowork plugin install spec — same flow you used for `lolly-claude-plugin`).

Expected: plugin installs, `.mcp.json` is read, Claude Code shows `finny` MCP server as Connected with the 5 tools.

- [ ] **Step 3: Trigger one tool from Claude Code**

Run a short prompt that invokes `finny_query`.

Expected: same as Task 8.1 Step 2 — works end-to-end.

### Task 8.3: Mark the deploy complete

**Files:** none

- [ ] **Step 1: Tag the release**

```bash
cd /Applications/finny-claude-plugin
git tag -a v0.1.0-deploy -m "First production deploy of Finny MCP at finny.11mirror.com"
git push origin v0.1.0-deploy
```

- [ ] **Step 2: Update README.md** (lightly — not in scope for this plan to rewrite)

```bash
echo "" >> README.md
echo "**Deployed:** \`https://finny.11mirror.com/mcp\` (OAuth 2.1)" >> README.md
git add README.md
git commit -m "docs: note production endpoint"
git push
```

Done.

---

## Self-Review

**1. Spec coverage:**
- Architecture diagram → Phases 4–6 deploy all three layers. ✓
- Tool surface (5 tools) → preserved by rename rules; verified externally in Task 8.1 Step 1. ✓
- Repo layout → established by Phase 1 Tasks 1.2–1.6. ✓
- Key config shapes (`.mcp.json`, `bridge/.env`, `~/.hermes/.env`, `Caddyfile`) → Task 1.4 + Task 5.2 + Task 5.3 + Task 1.6. ✓
- Deploy phases A–E → Phase 1 (A), Phase 1.7 (B partial — push-only), Phase 3 (B infra), Phase 4 (C), Phase 6 (D), Phase 8 (E). ✓
- IAM additions → Task 1.6 Step 5 (file) + Task 3.2 (apply). ✓
- Cost delta — no implementation tasks needed (just documented). ✓
- Risks 1 (`.mcp.json` schema) → Task 8.2 Step 2 will surface it. ✓
- Risks 2 (issuer URL exact match) → Task 6.2 Step 4 + Task 6.4 Step 2 verify this. ✓
- Risks 3 (API server stability) → Task 6.1 Step 3 smoke + Task 7.1 reboot test. ✓
- Risks 4 (rename collisions) → Task 1.2 Step 3 (clean grep). ✓
- Risks 5 (existing .hermes/.env) → Task 5.2 Step 1 (inspect first, append-not-overwrite). ✓
- Success criteria — all 6 covered: HTTPS health (6.4.1), OAuth challenge (6.4.3), Custom Connector flow (8.1), tool call (8.1.2), reboot persistence (7.1), marketplace install (8.2.2). ✓

**2. Placeholder scan:** All `<placeholders>` in the plan are clearly marked stand-ins for runtime values (zone IDs, allocation IDs, secrets) — those *must* be substituted by the engineer at deploy time, not pre-filled. No `TBD` / "implement later" / "handle edge cases" present.

**3. Type/identifier consistency:**
- `FINNY_UPSTREAM_URL`, `FINNY_UPSTREAM_TOKEN`, `FINNY_MODEL` used consistently across rename map, bridge .env, and tests. ✓
- `API_SERVER_KEY` (Hermes side) = `FINNY_UPSTREAM_TOKEN` (bridge side) — explicitly tied via shared `$SHARED` variable in Task 5.1. ✓
- Service names `hermes-api.service`, `finny-mcp.service` consistent across deploy/, Phase 6, and Phase 7. ✓
- Port assignments: 8642 (Hermes), 3000 (bridge), 443 (Caddy) — consistent. ✓

No fixes needed.
