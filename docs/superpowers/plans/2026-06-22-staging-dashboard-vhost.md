# Staging Dashboard vhost — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `https://dashboard.finny.staging.11mirror.com/` reach the Hermes gateway on the staging EC2 box, mirroring prod's dashboard URL. Two parallel browser URLs, isolated per environment.

**Architecture:** Repeat the prod dashboard install on the staging EC2 box. Reuse the existing `deploy/scripts/deploy-finny-dashboard.sh` (parametrized per task) and the two prod manifests (PR #13, PR #16). New work on the repo side: a Caddyfile entry, a deploy-script tweak, a manifest doc, the canonical `hermes-gateway.service` unit (to replace the broken on-disk one), a deploy-log row. No code changes to dashboard or bridge. Pre-flight: fix the broken `hermes-gateway` user-mode unit on staging.

**Tech Stack:** AWS SSM (us-east-1), Route53, Caddy v2, systemd (system + user-mode), Node 22, pnpm 9, Vite/TanStack Start, Hermes Agent v0.14.0.

## Global Constraints

- **Source of truth for spec:** `docs/superpowers/specs/2026-06-22-staging-dashboard-vhost-design.md`
- **Source of truth for handoff:** `docs/handoff/finny-hermes-on-ec2.md`
- **Working branch (in `finny-claude-plugin`):** `feat/staging-dashboard-vhost` off current `main` tip.
- **Repos NOT touched at the source level:** `finny-hermes`, `finny-hermes-config` (`~/.hermes` is the per-box config repo and only its working tree is read on staging).
- **No prod changes during execution.** Only at the very end, the merged PR's docs ride to prod via the standard deployed-branch promotion (no runtime steps on prod).
- **No code in the dashboard repo (`Postergully/finny-hermes-dashboard`).** We deploy the existing `main` build to staging unchanged.
- **No auth on the staging dashboard.** v1 posture, matches prod (handoff §gotcha 8).
- **No Bedrock router work in this PR.** Deferred per user direction.
- **Never echo secrets** (`API_SERVER_KEY`, AWS keys) into transcripts. SSM logs command bodies — secrets must be read on-box (`grep ^KEY= ~/.hermes/.env`) and never passed as command arguments.
- **No heredocs inside `aws ssm send-command --parameters 'commands=[...]'`.** Multi-line file content goes through `deploy/systemd/*.service` (already in repo) or a tarball staged via S3. Plan-eng-review D1: stage in repo + S3.
- **Snapshot-restore must use the exact path printed in the snapshot step**, not a glob (`/tmp/foo.snapshot-*`). Globs may match multiple files on re-run and fail unpredictably.
- **Staging EC2:** instance `i-0c2c974ff571162eb`, public IP `34.232.186.238`, hostname `ip-10-0-1-86`.
- **Prod EC2 (read-only here):** instance `i-0ef58962b09d490ee`, IP `34.200.24.169`.
- **Route53 zone for staging:** ID `Z01920243UX91ZKYKCMPA`, name `staging.11mirror.com.`
- **Dashboard repo (separate from `finny-claude-plugin`):** `Postergully/finny-hermes-dashboard` at operator laptop `~/code/finny-hermes-dashboard`. The dashboard ships at `/opt/finny/dashboard/` on each EC2 box but is **not tracked** by `finny-claude-plugin` git (deploy script tars + ships build output).
- **S3 bucket for SSM transfers:** `11mirror-staging-transfer` (already used by `deploy-finny-dashboard.sh`). Reused for unit-file transfer.

---

## File Structure

Files created or modified in this plan, all inside `Postergully/finny-claude-plugin`:

| Path | Action | Owner |
|---|---|---|
| `deploy/systemd/hermes-gateway.service` | **Create (already done in review prep)** — canonical user-mode unit referenced by Task 3 | Pre-staged |
| `deploy/caddy/Caddyfile` | Modify (append staging vhost block) | Phase E (Task 8) |
| `deploy/scripts/deploy-finny-dashboard.sh` | Modify (accept `--instance` flag; default = prod) | Phase B (Task 4) |
| `docs/staging/feat-staging-dashboard-vhost-changes.md` | Create (manifest per `staging-promotion-discipline`) | Phase G (Task 11) |
| `docs/staging/deploy-log.md` | Modify (append row) | Phase G (Task 11) |
| `docs/handoff/finny-hermes-on-ec2.md` | Already updated this session — no further changes |

Files modified directly on the staging EC2 box (NOT in the repo):

| Path | Action | Owner |
|---|---|---|
| `/etc/caddy/Caddyfile` (staging box) | Append vhost block (file copied from S3) | Phase E (Task 9) |
| `/home/ubuntu/.config/systemd/user/hermes-gateway.service` | Replace from S3 (canonical) | Phase A (Task 3) |
| `/home/ubuntu/.config/systemd/user/hermes-gateway.service.d/staging.conf` | Create (drop-in for `TERMINAL_CWD`) | Phase A (Task 3) |
| `/etc/systemd/system/finny-dashboard.service` | Create from repo unit (deploy script does this) | Phase B (Task 5) |
| `/home/ubuntu/.config/systemd/user/hermes-dashboard.service` | Replace from S3 (loopback-bound) | Phase B (Task 6) |
| `/opt/finny/dashboard/` | Populate (built tarball via deploy script) | Phase B (Task 5) |

AWS resources created:

| Resource | Owner |
|---|---|
| Route53 A record `dashboard.finny.staging.11mirror.com → 34.232.186.238` (TTL 300) | Phase D (Task 7) |
| S3 objects under `s3://11mirror-staging-transfer/finny-staging-vhost/` (transient) | Tasks 3, 6, 9 |

---

## Task 1: Branch + commit spec & plan

**Files:**
- Create branch: `feat/staging-dashboard-vhost`
- Commit: `docs/superpowers/specs/2026-06-22-staging-dashboard-vhost-design.md`, `docs/superpowers/plans/2026-06-22-staging-dashboard-vhost.md`, `docs/handoff/finny-hermes-on-ec2.md`, `deploy/systemd/hermes-gateway.service`
- Test: `git status` clean; branch is the new feature branch.

**Interfaces:**
- Consumes: untracked spec + plan files + handoff edits already in working tree.
- Produces: clean feature branch with one initial commit containing the docs + canonical gateway unit.

- [ ] **Step 1: Pull latest main**

```bash
cd /Applications/finny-claude-plugin
git fetch origin
git checkout main
git pull --ff-only origin main
```

Expected: `Already up to date.` or fast-forward; no merge conflicts.

- [ ] **Step 2: Create the feature branch**

```bash
git checkout -b feat/staging-dashboard-vhost
git rev-parse --abbrev-ref HEAD
```

Expected: prints `feat/staging-dashboard-vhost`.

- [ ] **Step 3: Verify the docs and unit file are in working tree**

```bash
ls docs/superpowers/specs/2026-06-22-staging-dashboard-vhost-design.md \
   docs/superpowers/plans/2026-06-22-staging-dashboard-vhost.md \
   deploy/systemd/hermes-gateway.service
git status --short docs/handoff/finny-hermes-on-ec2.md
```

Expected: all four paths exist; the handoff file shows as modified (`M`).

- [ ] **Step 4: Commit them**

```bash
git add docs/superpowers/specs/2026-06-22-staging-dashboard-vhost-design.md \
        docs/superpowers/plans/2026-06-22-staging-dashboard-vhost.md \
        docs/handoff/finny-hermes-on-ec2.md \
        deploy/systemd/hermes-gateway.service
git commit -m "docs(staging): spec, plan, handoff updates for staging dashboard vhost

Adds:
- Spec for the staging dashboard vhost work (separate-vhost path)
- Implementation plan (8 phases, 12 tasks)
- Canonical hermes-gateway.service user-mode unit (referenced by Task 3
  to replace the broken on-disk unit on staging)
- Handoff doc updates: gotchas 11 + 12 (staging gateway orphan + 9119
  Tailscale binding); comparison table corrected with verified staging
  instance/IP; gotcha 6 corrected (dashboard repo is not a separate
  11mirror checkout)
"
git status
```

Expected: clean working tree; one new commit.

---

## Task 2: Pre-flight verification on staging (read-only)

**Files:**
- Test (no file changes): SSM read-only commands.

**Interfaces:**
- Consumes: instance `i-0c2c974ff571162eb`, AWS CLI logged in.
- Produces: confirmed current state matches the spec; if drift, ABORT and re-spec.

- [ ] **Step 1: Re-confirm staging baseline matches the spec**

Run from your laptop:

```bash
CMD_ID=$(aws ssm send-command --region us-east-1 \
  --instance-ids i-0c2c974ff571162eb \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=[
    "echo === GATEWAY-PID ===",
    "ps -ef | grep hermes_cli.main | grep -v grep",
    "echo === GATEWAY-UNIT-STATUS ===",
    "sudo -iu ubuntu systemctl --user is-active hermes-gateway",
    "sudo -iu ubuntu systemctl --user is-failed hermes-gateway",
    "echo === HERMES-DASHBOARD-BIND ===",
    "sudo ss -tlnp | grep 9119",
    "echo === DASHBOARD-3001 ===",
    "sudo ss -tlnp | grep 3001 || echo no-3001",
    "echo === OPT-FINNY-SHA ===",
    "sudo -u ubuntu git -C /opt/finny rev-parse HEAD",
    "echo === DASHBOARD-DIR-EXISTS ===",
    "ls /opt/finny/dashboard 2>&1 | head -3 || echo no-dashboard",
    "echo === STAGING-PROFILE-DIR ===",
    "sudo -u ubuntu ls /home/ubuntu/.hermes/profiles/staging/ 2>&1 | head -10 || echo no-staging-profile",
    "sudo -u ubuntu test -f /home/ubuntu/.hermes/profiles/staging/AGENTS.md && echo AGENTS.md=present || echo AGENTS.md=MISSING"
  ]' \
  --query "Command.CommandId" --output text)
sleep 6
aws ssm get-command-invocation --region us-east-1 \
  --command-id "$CMD_ID" --instance-id i-0c2c974ff571162eb \
  --query StandardOutputContent --output text
```

Expected output (today's reality):
- `=== GATEWAY-PID ===` shows ONE python process with `/home/ubuntu/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main gateway run --replace`.
- `=== GATEWAY-UNIT-STATUS ===` shows `inactive` and `failed`.
- `=== HERMES-DASHBOARD-BIND ===` shows `100.112.31.24:9119`.
- `=== DASHBOARD-3001 ===` shows `no-3001`.
- `=== OPT-FINNY-SHA ===` shows `a40d868891c9497582fbf79acff780f3b9cc8582`.
- `=== DASHBOARD-DIR-EXISTS ===` shows `no-dashboard`.
- `=== STAGING-PROFILE-DIR ===` shows files including `AGENTS.md` (or, if missing, the `AGENTS.md=MISSING` line).
- `AGENTS.md=present` — **REQUIRED**. If `MISSING`, ABORT this plan: the staging gateway will start with empty CONTEXT and Finny will go silent. Recovering the staging profile is out of scope here; bring it back first.

If any of the runtime checks don't match, ABORT and re-verify the spec.

- [ ] **Step 2: Confirm DNS does NOT yet resolve `dashboard.finny.staging.11mirror.com`**

```bash
dig +short dashboard.finny.staging.11mirror.com
```

Expected: empty (no A record yet).

If it returns a value, someone already added the record — investigate before continuing.

- [ ] **Step 3: Verify operator-laptop dashboard repo is on `main` and clean**

```bash
test -d ~/code/finny-hermes-dashboard/.git && echo "OK"
git -C ~/code/finny-hermes-dashboard fetch origin
git -C ~/code/finny-hermes-dashboard rev-parse --abbrev-ref HEAD
git -C ~/code/finny-hermes-dashboard status --porcelain | wc -l
git -C ~/code/finny-hermes-dashboard rev-parse --short HEAD
git -C ~/code/finny-hermes-dashboard rev-parse --short origin/main
```

Expected: branch `main`, dirty count `0`, local HEAD == `origin/main`. If repo is missing, clone it from the URL the operator already uses for prod deploys (likely `Postergully/finny-hermes-dashboard`). If dirty or behind, fix that before Task 5.

---

## Task 3: Phase A — Fix the broken `hermes-gateway` user-mode unit on staging

**Files:**
- Use (already in repo): `deploy/systemd/hermes-gateway.service`
- S3 stage: `s3://11mirror-staging-transfer/finny-staging-vhost/<sha>/hermes-gateway.service`, `s3://.../staging.conf`
- Modify (on staging only): `/home/ubuntu/.config/systemd/user/hermes-gateway.service`, `/home/ubuntu/.config/systemd/user/hermes-gateway.service.d/staging.conf`
- Test: `systemctl --user status hermes-gateway`, `curl http://127.0.0.1:8642/health`, `pgrep -fc hermes_cli.main`

**Interfaces:**
- Consumes: pre-flight findings from Task 2; canonical unit `deploy/systemd/hermes-gateway.service`.
- Produces: staging gateway is supervised by a healthy user-mode unit pointing at the correct venv with `TERMINAL_CWD` drop-in for staging. Working `:8642` is preserved across the swap via `gateway run --replace`.

- [ ] **Step 1: Snapshot current unit + working sibling for diff/rollback**

```bash
CMD_ID=$(aws ssm send-command --region us-east-1 \
  --instance-ids i-0c2c974ff571162eb \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=[
    "TS=$(date +%Y%m%d-%H%M%S)",
    "SNAP=/tmp/hermes-gateway.service.snapshot-$TS",
    "sudo -u ubuntu cp /home/ubuntu/.config/systemd/user/hermes-gateway.service $SNAP",
    "echo SNAPSHOT_PATH=$SNAP",
    "echo === CURRENT-UNIT ===",
    "sudo -u ubuntu cat /home/ubuntu/.config/systemd/user/hermes-gateway.service",
    "echo === SIBLING-DASHBOARD-UNIT ===",
    "sudo -u ubuntu cat /home/ubuntu/.config/systemd/user/hermes-dashboard.service"
  ]' \
  --query "Command.CommandId" --output text)
sleep 4
aws ssm get-command-invocation --region us-east-1 \
  --command-id "$CMD_ID" --instance-id i-0c2c974ff571162eb \
  --query StandardOutputContent --output text
```

**Capture the exact `SNAPSHOT_PATH=...` value into your scratchpad.** Rollback in Step 5 references this exact path (no glob).

- [ ] **Step 2: Stage canonical unit + staging drop-in to S3**

Create the staging-specific drop-in locally:

```bash
mkdir -p /tmp/finny-staging-vhost
cat > /tmp/finny-staging-vhost/staging.conf <<'CONF'
[Service]
Environment="TERMINAL_CWD=/home/ubuntu/.hermes/profiles/staging"
CONF
SHA=$(git -C /Applications/finny-claude-plugin rev-parse --short HEAD)
S3_PREFIX="s3://11mirror-staging-transfer/finny-staging-vhost/${SHA}"
aws s3 cp /Applications/finny-claude-plugin/deploy/systemd/hermes-gateway.service "${S3_PREFIX}/hermes-gateway.service"
aws s3 cp /tmp/finny-staging-vhost/staging.conf "${S3_PREFIX}/staging.conf"
echo "S3_PREFIX=${S3_PREFIX}"
```

Capture `S3_PREFIX` for Step 3. (Each task that uses S3 stages with a fresh git SHA so re-runs don't collide.)

- [ ] **Step 3: Pull files onto staging and start the new unit**

Per plan-eng-review D2: do NOT pre-kill the orphan. Use `gateway run --replace` to take over `:8642` atomically. If the unit fails to start, the orphan stays alive and `:8642` stays up.

Substitute `<S3_PREFIX>` with the value from Step 2:

```bash
CMD_ID=$(aws ssm send-command --region us-east-1 \
  --instance-ids i-0c2c974ff571162eb \
  --document-name "AWS-RunShellScript" \
  --parameters "commands=[
    \"set -e\",
    \"sudo -u ubuntu mkdir -p /home/ubuntu/.config/systemd/user/hermes-gateway.service.d\",
    \"sudo -u ubuntu aws s3 cp <S3_PREFIX>/hermes-gateway.service /home/ubuntu/.config/systemd/user/hermes-gateway.service\",
    \"sudo -u ubuntu aws s3 cp <S3_PREFIX>/staging.conf /home/ubuntu/.config/systemd/user/hermes-gateway.service.d/staging.conf\",
    \"echo === NEW-UNIT ===\",
    \"sudo -u ubuntu cat /home/ubuntu/.config/systemd/user/hermes-gateway.service\",
    \"echo === DROPIN ===\",
    \"sudo -u ubuntu cat /home/ubuntu/.config/systemd/user/hermes-gateway.service.d/staging.conf\",
    \"sudo -iu ubuntu systemctl --user daemon-reload\",
    \"echo === START-UNIT ===\",
    \"sudo -iu ubuntu systemctl --user start hermes-gateway\",
    \"sleep 5\",
    \"echo === STATUS ===\",
    \"sudo -iu ubuntu systemctl --user status hermes-gateway --no-pager | head -15\",
    \"echo === HEALTH ===\",
    \"curl -sS -o /dev/null -w 'health: %{http_code}\\n' http://127.0.0.1:8642/health\",
    \"echo === PROCESS-COUNT ===\",
    \"pgrep -fc 'hermes_cli.main gateway run' || echo 0\"
  ]" \
  --query "Command.CommandId" --output text)
sleep 14
aws ssm get-command-invocation --region us-east-1 \
  --command-id "$CMD_ID" --instance-id i-0c2c974ff571162eb \
  --query StandardOutputContent --output text
```

Expected:
- `=== STATUS ===` shows `Active: active (running)`.
- `=== HEALTH ===` shows `health: 200`.
- `=== PROCESS-COUNT ===` prints `1` (orphan got SIGTERM'd by `--replace`; only the unit-launched gateway remains).

If `=== HEALTH ===` is non-200 OR the unit is not active OR process count is 0, GO TO STEP 5 (rollback).

- [ ] **Step 4: Enable the unit for next reboot + verify CONTEXT loads**

```bash
CMD_ID=$(aws ssm send-command --region us-east-1 \
  --instance-ids i-0c2c974ff571162eb \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=[
    "sudo -iu ubuntu systemctl --user enable hermes-gateway",
    "sudo -iu ubuntu systemctl --user is-enabled hermes-gateway",
    "echo === CONTEXT-PROBE ===",
    "sudo -iu ubuntu journalctl --user -u hermes-gateway --no-pager --since \"1 minute ago\" | grep -E \"CONTEXT|prompt_builder|AGENTS\" | head -10",
    "echo === REMOVE-PRE-STAGING-BAK ===",
    "sudo -u ubuntu rm -f /home/ubuntu/.config/systemd/user/hermes-gateway.service.pre-staging.bak",
    "ls /home/ubuntu/.config/systemd/user/ | grep -i gateway"
  ]' \
  --query "Command.CommandId" --output text)
sleep 5
aws ssm get-command-invocation --region us-east-1 \
  --command-id "$CMD_ID" --instance-id i-0c2c974ff571162eb \
  --query StandardOutputContent --output text
```

Expected:
- `is-enabled` returns `enabled`.
- `=== CONTEXT-PROBE ===` shows AGENTS-related log lines (NOT `CONTEXT (0 chars)` or `prompt_injection blocked`).
- Only `hermes-gateway.service` (and the `.d/` directory) listed — no `.pre-staging.bak`.

If the CONTEXT probe shows `0 chars` or `prompt_injection blocked`, the staging profile is mis-wired. STOP and investigate before continuing — the dashboard will reach a silent gateway.

- [ ] **Step 5: (Conditional) Rollback if Step 3 or 4 failed**

Substitute `<SNAPSHOT_PATH>` with the exact path from Step 1's output (NOT a glob):

```bash
aws ssm send-command --region us-east-1 --instance-ids i-0c2c974ff571162eb \
  --document-name "AWS-RunShellScript" \
  --parameters "commands=[
    \"sudo -u ubuntu cp <SNAPSHOT_PATH> /home/ubuntu/.config/systemd/user/hermes-gateway.service\",
    \"sudo -u ubuntu rm -rf /home/ubuntu/.config/systemd/user/hermes-gateway.service.d\",
    \"sudo -iu ubuntu systemctl --user daemon-reload\",
    \"sudo -iu ubuntu systemctl --user stop hermes-gateway 2>&1 || true\",
    \"echo orphan should still be running because we never killed it\",
    \"pgrep -fa hermes_cli.main\"
  ]"
```

Then investigate before re-attempting. The orphan was not killed (per D2), so `:8642` should still be up.

- [ ] **Step 6: No commit; staging-runtime only**

---

## Task 4: Phase B (part 1) — Parametrize the deploy script with `--instance`

**Files:**
- Modify: `deploy/scripts/deploy-finny-dashboard.sh`
- Test: `bash -n`, `--help` smoke

**Interfaces:**
- Consumes: existing prod-hardcoded script.
- Produces: script accepts `--instance <id>` (default `i-0ef58962b09d490ee`). Backward compatible — running with no flag still deploys to prod.

- [ ] **Step 1: Read the current script header (lines 1-40)**

```bash
sed -n '1,40p' /Applications/finny-claude-plugin/deploy/scripts/deploy-finny-dashboard.sh
```

Confirm line 28 is `INSTANCE_ID="i-0ef58962b09d490ee"`.

- [ ] **Step 2: Replace the bare `INSTANCE_ID=...` line with arg-parsing**

Find the line `INSTANCE_ID="i-0ef58962b09d490ee"` and replace it with:

```bash
INSTANCE_ID="i-0ef58962b09d490ee"  # default = prod

while [ $# -gt 0 ]; do
  case "$1" in
    --instance) INSTANCE_ID="$2"; shift 2 ;;
    -h|--help)
      echo "usage: $0 [--instance <ec2-instance-id>]"
      echo "  default instance = i-0ef58962b09d490ee (prod)"
      echo "  for staging use:   --instance i-0c2c974ff571162eb"
      exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done
```

- [ ] **Step 3: Syntax check**

```bash
bash -n /Applications/finny-claude-plugin/deploy/scripts/deploy-finny-dashboard.sh && echo OK
```

Expected: `OK`.

- [ ] **Step 4: --help smoke**

```bash
/Applications/finny-claude-plugin/deploy/scripts/deploy-finny-dashboard.sh --help
echo "exit: $?"
```

Expected: usage printed, exit 0.

- [ ] **Step 5: Reject smoke for unknown flag**

```bash
/Applications/finny-claude-plugin/deploy/scripts/deploy-finny-dashboard.sh --bogus 2>&1 | head -1
echo "exit: $?"
```

Expected: `unknown flag: --bogus`, exit 2.

- [ ] **Step 6: Commit**

```bash
cd /Applications/finny-claude-plugin
git add deploy/scripts/deploy-finny-dashboard.sh
git commit -m "feat(deploy): accept --instance flag for staging deploys

Default stays prod (i-0ef58962b09d490ee). Pass --instance i-0c2c974ff571162eb
for staging. Enables reusing one script for both environments.
"
```

---

## Task 5: Phase B (part 2) — Run the deploy script against staging

**Files:**
- Modify (on staging only): `/opt/finny/dashboard/`, `/etc/systemd/system/finny-dashboard.service`, `/opt/finny/dashboard/.env`
- Test: `curl http://127.0.0.1:3001/`, `systemctl status finny-dashboard`

**Interfaces:**
- Consumes: parametrized deploy script from Task 4; pre-built dashboard at `~/code/finny-hermes-dashboard@origin/main` on operator laptop (verified clean in Task 2 Step 3).
- Produces: `:3001` listening on staging loopback; `finny-dashboard.service` active.

- [ ] **Step 1: Pre-flight Node/pnpm + API_SERVER_ENABLED on staging**

```bash
CMD_ID=$(aws ssm send-command --region us-east-1 --instance-ids i-0c2c974ff571162eb \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=[
    "node --version",
    "pnpm --version 2>/dev/null || echo NO_PNPM",
    "sudo -u ubuntu grep -E \"^API_SERVER_(KEY|ENABLED)=\" /home/ubuntu/.hermes/.env | sed \"s/=.*/=<redacted>/\""
  ]' \
  --query "Command.CommandId" --output text)
sleep 4
aws ssm get-command-invocation --region us-east-1 --command-id "$CMD_ID" --instance-id i-0c2c974ff571162eb --query StandardOutputContent --output text
```

Expected:
- `node`: `v22.x` or higher.
- `pnpm`: `9.x` or higher (NOT `NO_PNPM`).
- env: BOTH `API_SERVER_KEY=<redacted>` and `API_SERVER_ENABLED=<redacted>` present.

If Node/pnpm missing:
```bash
aws ssm send-command --region us-east-1 --instance-ids i-0c2c974ff571162eb \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["sudo apt-get update","sudo apt-get install -y nodejs npm","sudo npm i -g pnpm@9"]'
```

If `API_SERVER_ENABLED=true` is missing, append it and restart the gateway (the gateway you just fixed in Task 3):
```bash
aws ssm send-command --region us-east-1 --instance-ids i-0c2c974ff571162eb \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["sudo -u ubuntu grep -q ^API_SERVER_ENABLED=true /home/ubuntu/.hermes/.env || (echo API_SERVER_ENABLED=true | sudo -u ubuntu tee -a /home/ubuntu/.hermes/.env)","sudo -iu ubuntu systemctl --user restart hermes-gateway","sleep 4","curl -sS -o /dev/null -w \"health: %{http_code}\\n\" http://127.0.0.1:8642/health"]'
```

- [ ] **Step 2: Run the deploy script against staging**

```bash
cd /Applications/finny-claude-plugin
./deploy/scripts/deploy-finny-dashboard.sh --instance i-0c2c974ff571162eb 2>&1 | tee /tmp/staging-dashboard-deploy.log
```

Watch for:
- Local build success (Vite/TanStack Start).
- Tarball uploaded to S3.
- SSM commands on staging succeed (extract, write `.env`, install systemd unit, enable, start).
- Final loopback smoke `curl http://127.0.0.1:3001/` returns 200.

If a step fails mid-way: this is a first install (no `dashboard.bak.*` to roll back to). On failure: delete `/opt/finny/dashboard/` on staging, fix the issue, re-run.

- [ ] **Step 3: Independent verification**

```bash
CMD_ID=$(aws ssm send-command --region us-east-1 --instance-ids i-0c2c974ff571162eb \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=[
    "echo === LISTENERS ===",
    "sudo ss -tlnp | grep -E \"3001|8642\"",
    "echo === SERVICE-STATUS ===",
    "sudo systemctl status finny-dashboard --no-pager | head -10",
    "echo === LOOPBACK-PROBE ===",
    "curl -sS -o /dev/null -w \"3001: %{http_code}\\n\" http://127.0.0.1:3001/",
    "curl -sS -o /dev/null -w \"8642: %{http_code}\\n\" http://127.0.0.1:8642/health",
    "echo === ENV-FILE-KEYS ===",
    "sudo grep -oE \"^[A-Z_]+=\" /opt/finny/dashboard/.env | sort -u"
  ]' \
  --query "Command.CommandId" --output text)
sleep 5
aws ssm get-command-invocation --region us-east-1 --command-id "$CMD_ID" --instance-id i-0c2c974ff571162eb --query StandardOutputContent --output text
```

Expected:
- `3001:` returns `200`.
- `8642:` returns `200`.
- service is `active (running)`.
- env-file keys: `HERMES_API_URL=`, `HERMES_API_TOKEN=`, `HOST=`, `PORT=` (values redacted).

- [ ] **Step 4: No commit; staging-runtime only**

---

## Task 6: Phase B (part 3) + Phase C — Install + correctly bind `hermes-dashboard` (`:9119`) on staging

**Files:**
- Use (already in repo): `deploy/systemd/hermes-dashboard.service`
- S3 stage: `s3://11mirror-staging-transfer/finny-staging-vhost/<sha>/hermes-dashboard.service`
- Modify (on staging only): `/home/ubuntu/.config/systemd/user/hermes-dashboard.service`
- Test: `curl http://127.0.0.1:9119/health`, `ss -tlnp | grep 9119`

**Interfaces:**
- Consumes: hermes-agent venv at `/home/ubuntu/.hermes/hermes-agent/venv` (verified Task 3); `hermes` CLI present in that venv.
- Produces: user-mode unit `hermes-dashboard.service` listening on `127.0.0.1:9119` (replacing the current `100.112.31.24:9119` binding).

- [ ] **Step 1: One-time pre-build of the upstream UI on staging**

```bash
CMD_ID=$(aws ssm send-command --region us-east-1 --instance-ids i-0c2c974ff571162eb \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["sudo -u ubuntu bash -lc \"cd /home/ubuntu/.hermes/hermes-agent/web && npm ci && npm run build\" 2>&1 | tail -20","ls /home/ubuntu/.hermes/hermes-agent/hermes_cli/web_dist/ | head -5"]' \
  --query "Command.CommandId" --output text)
sleep 90
aws ssm get-command-invocation --region us-east-1 --command-id "$CMD_ID" --instance-id i-0c2c974ff571162eb --query StandardOutputContent --output text
```

Expected: build finishes; `web_dist/` lists `index.html` + assets.

- [ ] **Step 2: Snapshot the staging `:9119` unit**

```bash
CMD_ID=$(aws ssm send-command --region us-east-1 --instance-ids i-0c2c974ff571162eb \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=[
    "TS=$(date +%Y%m%d-%H%M%S)",
    "SNAP=/tmp/hermes-dashboard.service.snapshot-$TS",
    "sudo -u ubuntu cp /home/ubuntu/.config/systemd/user/hermes-dashboard.service $SNAP",
    "echo SNAPSHOT_PATH=$SNAP",
    "echo === CURRENT-UNIT ===",
    "sudo -u ubuntu cat /home/ubuntu/.config/systemd/user/hermes-dashboard.service"
  ]' \
  --query "Command.CommandId" --output text)
sleep 4
aws ssm get-command-invocation --region us-east-1 --command-id "$CMD_ID" --instance-id i-0c2c974ff571162eb --query StandardOutputContent --output text
```

**Capture `SNAPSHOT_PATH=...`** for rollback. Note the current `--host` argument — should be `100.112.31.24`; we replace with `127.0.0.1`.

- [ ] **Step 3: Stage canonical unit to S3**

```bash
SHA=$(git -C /Applications/finny-claude-plugin rev-parse --short HEAD)
S3_PREFIX="s3://11mirror-staging-transfer/finny-staging-vhost/${SHA}"
aws s3 cp /Applications/finny-claude-plugin/deploy/systemd/hermes-dashboard.service "${S3_PREFIX}/hermes-dashboard.service"
echo "S3_PREFIX=${S3_PREFIX}"
```

The repo unit already binds `--host 127.0.0.1` and `--port 9119`.

- [ ] **Step 4: Pull onto staging and restart**

Substitute `<S3_PREFIX>`:

```bash
CMD_ID=$(aws ssm send-command --region us-east-1 --instance-ids i-0c2c974ff571162eb \
  --document-name "AWS-RunShellScript" \
  --parameters "commands=[
    \"sudo -u ubuntu aws s3 cp <S3_PREFIX>/hermes-dashboard.service /home/ubuntu/.config/systemd/user/hermes-dashboard.service\",
    \"echo === NEW-UNIT ===\",
    \"sudo -u ubuntu cat /home/ubuntu/.config/systemd/user/hermes-dashboard.service\",
    \"sudo -iu ubuntu systemctl --user daemon-reload\",
    \"sudo -iu ubuntu systemctl --user restart hermes-dashboard\",
    \"sleep 5\",
    \"echo === STATUS ===\",
    \"sudo -iu ubuntu systemctl --user status hermes-dashboard --no-pager | head -10\",
    \"echo === BIND ===\",
    \"sudo ss -tlnp | grep 9119\",
    \"echo === HEALTH ===\",
    \"curl -sS -o /dev/null -w '9119: %{http_code}\\n' http://127.0.0.1:9119/health\"
  ]" \
  --query "Command.CommandId" --output text)
sleep 14
aws ssm get-command-invocation --region us-east-1 --command-id "$CMD_ID" --instance-id i-0c2c974ff571162eb --query StandardOutputContent --output text
```

Expected:
- `=== STATUS ===` shows `Active: active (running)`.
- `=== BIND ===` shows `127.0.0.1:9119` (NOT `100.112.31.24:9119`).
- `=== HEALTH ===` returns `9119: 200`.

If any check fails, restore from snapshot — substitute `<SNAPSHOT_PATH>` with the exact value captured in Step 2:

```bash
aws ssm send-command --region us-east-1 --instance-ids i-0c2c974ff571162eb \
  --document-name "AWS-RunShellScript" \
  --parameters "commands=[
    \"sudo -u ubuntu cp <SNAPSHOT_PATH> /home/ubuntu/.config/systemd/user/hermes-dashboard.service\",
    \"sudo -iu ubuntu systemctl --user daemon-reload\",
    \"sudo -iu ubuntu systemctl --user restart hermes-dashboard\"
  ]"
```

- [ ] **Step 5: Force the Finny SPA to re-detect capabilities**

```bash
aws ssm send-command --region us-east-1 --instance-ids i-0c2c974ff571162eb \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["sudo systemctl restart finny-dashboard","sleep 4","sudo journalctl -u finny-dashboard --no-pager --since \"1 minute ago\" | grep -E \"mode=|gateway\" | head -5"]' \
  --query "Command.CommandId" --output text
```

Expected: at least one log line with `mode=zero-fork` (NOT `mode=portable`).

- [ ] **Step 6: No commit; staging-runtime only**

---

## Task 7: Phase D — Add Route53 A record

**Files:**
- Test: `dig +short dashboard.finny.staging.11mirror.com`

**Interfaces:**
- Consumes: hosted zone `Z01920243UX91ZKYKCMPA`, IP `34.232.186.238`.
- Produces: A record resolving to staging EC2 public IP.

- [ ] **Step 1: Create the change-batch JSON**

```bash
cat > /tmp/route53-staging-dashboard.json <<'JSON'
{
  "Comment": "Add dashboard.finny.staging.11mirror.com for staging dashboard vhost",
  "Changes": [
    {
      "Action": "CREATE",
      "ResourceRecordSet": {
        "Name": "dashboard.finny.staging.11mirror.com.",
        "Type": "A",
        "TTL": 300,
        "ResourceRecords": [{"Value": "34.232.186.238"}]
      }
    }
  ]
}
JSON
cat /tmp/route53-staging-dashboard.json
```

- [ ] **Step 2: Submit and capture ChangeId**

```bash
CHANGE_ID=$(aws route53 change-resource-record-sets \
  --hosted-zone-id Z01920243UX91ZKYKCMPA \
  --change-batch file:///tmp/route53-staging-dashboard.json \
  --query "ChangeInfo.Id" --output text)
echo "CHANGE_ID=${CHANGE_ID}"
```

Expected: returns `/change/C...`. If error `InvalidChangeBatch: ... already exists`, the record is already present — go to Step 4 to confirm DNS.

- [ ] **Step 3: Wait for INSYNC**

```bash
aws route53 wait resource-record-sets-changed --id "${CHANGE_ID}"
echo "in sync"
```

Expected: returns silently after Route53 propagates (usually <60s).

- [ ] **Step 4: Confirm DNS resolves**

```bash
dig +short dashboard.finny.staging.11mirror.com
```

Expected: `34.232.186.238`. If empty after 60s, retry; do not proceed to Phase E until this resolves.

- [ ] **Step 5: No commit; AWS-side only**

---

## Task 8: Phase E (part 1) — Mirror the Caddyfile change in the repo

**Files:**
- Modify: `deploy/caddy/Caddyfile`

**Interfaces:**
- Consumes: nothing (parallel-safe with Task 7).
- Produces: repo's `Caddyfile` has both prod and staging dashboard vhosts.

- [ ] **Step 1: Read current Caddyfile**

```bash
cat /Applications/finny-claude-plugin/deploy/caddy/Caddyfile
```

Confirm it has `finny.prod.11mirror.com` + `dashboard.finny.prod.11mirror.com` blocks.

- [ ] **Step 2: Append the staging dashboard block**

Use Edit. Append after the `dashboard.finny.prod.11mirror.com { ... }` closing brace:

```

dashboard.finny.staging.11mirror.com {
	encode gzip
	reverse_proxy 127.0.0.1:3001 {
		header_up Host {host}
		header_up X-Real-IP {remote_host}
		header_up X-Forwarded-Proto https
	}
}
```

- [ ] **Step 3: Validate the Caddyfile syntax locally if Caddy is on PATH**

```bash
which caddy && caddy validate --config /Applications/finny-claude-plugin/deploy/caddy/Caddyfile --adapter caddyfile
```

If `caddy` is not installed locally, skip — staging's reload in Task 9 will validate.

- [ ] **Step 4: Commit**

```bash
cd /Applications/finny-claude-plugin
git add deploy/caddy/Caddyfile
git commit -m "feat(caddy): add staging dashboard vhost

Mirrors the prod dashboard block to dashboard.finny.staging.11mirror.com
on the staging EC2 box (i-0c2c974ff571162eb / 34.232.186.238).
"
```

---

## Task 9: Phase E (part 2) — Apply Caddyfile change live on staging

**Files:**
- Modify (on staging only): `/etc/caddy/Caddyfile`
- S3 stage: `s3://11mirror-staging-transfer/finny-staging-vhost/<sha>/Caddyfile`
- Test: `curl https://dashboard.finny.staging.11mirror.com/`, `curl https://finny.staging.11mirror.com/` (regression)

**Interfaces:**
- Consumes: Route53 record from Task 7 (DNS must resolve before reload); committed `deploy/caddy/Caddyfile` from Task 8.
- Produces: HTTPS endpoint live with valid Let's Encrypt cert; existing `finny.staging.11mirror.com` unaffected.

- [ ] **Step 1: Snapshot live Caddyfile**

```bash
CMD_ID=$(aws ssm send-command --region us-east-1 --instance-ids i-0c2c974ff571162eb \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=[
    "TS=$(date +%Y%m%d-%H%M%S)",
    "SNAP=/etc/caddy/Caddyfile.snapshot-$TS",
    "sudo cp /etc/caddy/Caddyfile $SNAP",
    "echo SNAPSHOT_PATH=$SNAP",
    "echo === LIVE-FILE ===",
    "sudo cat /etc/caddy/Caddyfile"
  ]' \
  --query "Command.CommandId" --output text)
sleep 4
aws ssm get-command-invocation --region us-east-1 --command-id "$CMD_ID" --instance-id i-0c2c974ff571162eb --query StandardOutputContent --output text
```

**Capture `SNAPSHOT_PATH=...`** for rollback.

- [ ] **Step 2: Build the new Caddyfile locally and stage to S3**

```bash
NEW_CADDYFILE=/tmp/staging-Caddyfile-$(date +%s)
# The staging live file currently has only `finny.staging.11mirror.com`. Compose
# the new file from that block + the new staging dashboard block.
cat > "${NEW_CADDYFILE}" <<'CADDY'
finny.staging.11mirror.com {
    encode gzip
    reverse_proxy 127.0.0.1:3000 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-Proto https
    }
}

dashboard.finny.staging.11mirror.com {
    encode gzip
    reverse_proxy 127.0.0.1:3001 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-Proto https
    }
}
CADDY
SHA=$(git -C /Applications/finny-claude-plugin rev-parse --short HEAD)
S3_PREFIX="s3://11mirror-staging-transfer/finny-staging-vhost/${SHA}"
aws s3 cp "${NEW_CADDYFILE}" "${S3_PREFIX}/Caddyfile"
echo "S3_PREFIX=${S3_PREFIX}"
```

If, after Step 1, the live file shows additional vhosts beyond `finny.staging.11mirror.com`, update `${NEW_CADDYFILE}` to include them BEFORE staging to S3.

- [ ] **Step 3: Pull onto staging, validate, reload**

Substitute `<S3_PREFIX>`:

```bash
CMD_ID=$(aws ssm send-command --region us-east-1 --instance-ids i-0c2c974ff571162eb \
  --document-name "AWS-RunShellScript" \
  --parameters "commands=[
    \"sudo aws s3 cp <S3_PREFIX>/Caddyfile /etc/caddy/Caddyfile\",
    \"echo === NEW-FILE ===\",
    \"sudo cat /etc/caddy/Caddyfile\",
    \"echo === VALIDATE ===\",
    \"sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile\",
    \"echo === RELOAD ===\",
    \"sudo systemctl reload caddy\",
    \"sleep 4\",
    \"sudo systemctl status caddy --no-pager | head -8\",
    \"sudo journalctl -u caddy --no-pager --since '1 minute ago' | tail -20\"
  ]" \
  --query "Command.CommandId" --output text)
sleep 10
aws ssm get-command-invocation --region us-east-1 --command-id "$CMD_ID" --instance-id i-0c2c974ff571162eb --query StandardOutputContent --output text
```

Expected:
- `=== VALIDATE ===` prints `Valid configuration`.
- Reload returns 0; journal shows TLS provisioning for the new host (may take 10-30s).

If validate fails, restore from snapshot — substitute `<SNAPSHOT_PATH>` from Step 1:

```bash
aws ssm send-command --region us-east-1 --instance-ids i-0c2c974ff571162eb \
  --document-name "AWS-RunShellScript" \
  --parameters "commands=[\"sudo cp <SNAPSHOT_PATH> /etc/caddy/Caddyfile\",\"sudo systemctl reload caddy\"]"
```

- [ ] **Step 4: Public TLS smoke + regression check on existing vhost**

```bash
echo "=== NEW DASHBOARD URL ==="
curl -sS -I https://dashboard.finny.staging.11mirror.com/ | head -3
echo "=== REGRESSION CHECK: existing staging URL ==="
curl -sS -I https://finny.staging.11mirror.com/ | head -3
```

Expected: both return `HTTP/2 200`. The dashboard URL may need 30s after reload for first cert issuance — retry if `Service Unavailable` on first hit.

If the existing URL regressed, IMMEDIATELY rollback per Step 3's failure path.

---

## Task 10: Phase F — End-to-end smoke test

**Files:**
- Test: browser, curl

**Interfaces:**
- Consumes: live URL from Task 9.
- Produces: confidence the deploy is correct end-to-end.

- [ ] **Step 1: HTTPS HEAD**

```bash
curl -sS -I https://dashboard.finny.staging.11mirror.com/
```

Expected: `HTTP/2 200`, valid TLS, `server: Caddy`.

- [ ] **Step 2: Browser smoke**

Open `https://dashboard.finny.staging.11mirror.com/` in a browser. Verify:
- Brain SVG splash + "Finny" wordmark.
- UI renders without console errors.

- [ ] **Step 3: Pick a model in Settings → Provider**

Per handoff §5 — the SPA's composer needs an explicit model picked. Pick the same model staging's `~/.hermes/config.yaml` declares (Bedrock-backed sonnet-4-6 unless changed).

- [ ] **Step 4: Send a chat message**

Type `hi` → Enter. Expected: streaming response from the Hermes gateway. If you see "Retry" in red and no response, check `journalctl -u finny-dashboard` and `journalctl --user -u hermes-gateway` on staging.

- [ ] **Step 5: Verify Sessions/Skills/Config tabs populate**

Click each tab. Expected: each shows data (skill catalog, recent sessions list, config view). If any shows "not available", `:9119` is mis-wired — re-check Task 6.

- [ ] **Step 6: Confirm prod unaffected**

```bash
curl -sS -I https://dashboard.finny.prod.11mirror.com/ | head -3
curl -sS -I https://finny.prod.11mirror.com/ | head -3
```

Expected: both `HTTP/2 200`.

---

## Task 11: Phase G — Write the staging manifest + deploy log entry

**Files:**
- Create: `docs/staging/feat-staging-dashboard-vhost-changes.md`
- Modify: `docs/staging/deploy-log.md` (append row)

**Interfaces:**
- Consumes: the actual commands run in Tasks 3–10.
- Produces: documentation conformant to `staging-promotion-discipline`.

- [ ] **Step 1: Create the manifest**

Write to `docs/staging/feat-staging-dashboard-vhost-changes.md` (use the exact template below; substitute `<your-handle>`, `<HH:MM>`, and PR number when known):

```markdown
# Staging changes: `feat/staging-dashboard-vhost`

**Date applied:** `2026-06-22`
**Applied by:** `<your-handle>`
**Staging snapshot baseline:** N/A — work was done directly on staging EC2 i-0c2c974ff571162eb
**PR:** `#<TBD>`

## Git changes (replay via merge)

- `finny-claude-plugin@feat/staging-dashboard-vhost`: see PR — adds `deploy/systemd/hermes-gateway.service` (canonical user-mode unit), staging vhost in `deploy/caddy/Caddyfile`, `--instance` flag in `deploy/scripts/deploy-finny-dashboard.sh`, this manifest.
- `finny-hermes@<branch>`: no changes
- `finny-hermes-config@<branch>`: no changes (working tree of `~/.hermes` on staging is on `feat/atomic-fetch-v3` and was not touched)
- **External repo:** `Postergully/finny-hermes-dashboard@main` — built locally on operator laptop, tarball deployed to `/opt/finny/dashboard` on staging via S3 + SSM.

## Deploy decision

- [x] **Already applied to staging only** (2026-06-22 <HH:MM> UTC). No prod runtime impact.

## Non-git changes (replay manually on staging, in order)

> Run as `ubuntu` on staging EC2 `i-0c2c974ff571162eb` via SSM unless otherwise noted. All multi-line file content was staged via S3 (`s3://11mirror-staging-transfer/finny-staging-vhost/<sha>/`), never inline heredoc-in-JSON.

1. **Pre-flight cleanup of `hermes-gateway` user-mode unit (handoff §gotcha 11).**
   - Snapshotted, replaced unit file with `deploy/systemd/hermes-gateway.service` from the repo (via S3), added drop-in at `~/.config/systemd/user/hermes-gateway.service.d/staging.conf` with `TERMINAL_CWD=/home/ubuntu/.hermes/profiles/staging`.
   - Did NOT pre-kill the orphan; relied on `gateway run --replace` to take over `:8642` atomically.
   - Verified: unit active, `:8642/health` 200, exactly one `hermes_cli.main` process, AGENTS context loaded.
   - Removed leftover `hermes-gateway.service.pre-staging.bak`.

2. **DNS A-record:** `dashboard.finny.staging.11mirror.com` → `34.232.186.238` in zone `Z01920243UX91ZKYKCMPA`.
   - `aws route53 change-resource-record-sets --hosted-zone-id Z01920243UX91ZKYKCMPA --change-batch file:///tmp/route53-staging-dashboard.json` (CREATE A, TTL 300).

3. **Pre-build upstream Hermes web UI** (one-time per Hermes version, mirrors PR #16 step 1):
   - `sudo -u ubuntu bash -lc "cd /home/ubuntu/.hermes/hermes-agent/web && npm ci && npm run build"`.
   - Outputs to `/home/ubuntu/.hermes/hermes-agent/hermes_cli/web_dist/`.

4. **Run the parametrized deploy script:**
   - `./deploy/scripts/deploy-finny-dashboard.sh --instance i-0c2c974ff571162eb`.
   - Builds dashboard locally, tarballs, uploads to S3, drives staging EC2 via SSM to: extract to `/opt/finny/dashboard/`, write `.env` (token sourced from `~/.hermes/.env` on-box), install `finny-dashboard.service`, enable + start.

5. **Replace `hermes-dashboard.service` user-mode unit with the loopback-bound canonical** (PR #16 manifest applied to staging):
   - Snapshotted previous unit (was `--host 100.112.31.24`).
   - Pulled `deploy/systemd/hermes-dashboard.service` from the repo via S3 to `~/.config/systemd/user/hermes-dashboard.service`.
   - `daemon-reload`, `restart`. Verified `:9119` listening on `127.0.0.1` (NOT Tailscale).
   - Restarted `finny-dashboard` to flip SPA banner from `mode=portable` to `mode=zero-fork`.

6. **Append staging dashboard vhost to `/etc/caddy/Caddyfile`:**
   - Snapshotted, pulled new file via S3, `caddy validate`, `systemctl reload caddy`.
   - Caddy auto-provisioned Let's Encrypt cert.
   - Regression-checked existing `finny.staging.11mirror.com` still 200.

7. **Smoke test:**
   - `curl -sI https://dashboard.finny.staging.11mirror.com/` → `HTTP/2 200`.
   - Browser: model selected, chat message streamed, Sessions/Skills/Config tabs populated.
   - Confirmed prod URL unaffected.

## What was tested on staging

- [x] **Yes — entire flow ran on staging** (`i-0c2c974ff571162eb`). This PR's runtime steps are by definition staging-only; there is no prod-side runtime work.

## Skipped on prod (staging-only changes)

All non-git steps in this manifest. Prod gets only the doc + `deploy/scripts/deploy-finny-dashboard.sh` + `deploy/caddy/Caddyfile` + `deploy/systemd/hermes-gateway.service` source changes via the standard deployed-branch promotion. No services restart on prod.

## Rollback

1. **DNS:** `aws route53 change-resource-record-sets ... DELETE A record`.
2. **Caddy:** restore `/etc/caddy/Caddyfile.snapshot-<TS>`, `systemctl reload caddy`.
3. **Dashboard service on staging:** `sudo systemctl disable --now finny-dashboard`. Optional: `rm -rf /opt/finny/dashboard/`.
4. **`hermes-dashboard` user-mode unit:** restore from `/tmp/hermes-dashboard.service.snapshot-<TS>`, `daemon-reload`, restart.
5. **`hermes-gateway` user-mode unit:** restore from `/tmp/hermes-gateway.service.snapshot-<TS>`, remove `~/.config/systemd/user/hermes-gateway.service.d/`, `daemon-reload`. The orphan was not killed during the swap, so `:8642` should still be up.
6. **Git:** revert merge SHA on `finny-claude-plugin` `main`.

## Notes / surprises

- The dashboard repo (`Postergully/finny-hermes-dashboard`) is **not** tracked by `finny-claude-plugin`. The deploy script reads from operator laptop `~/code/finny-hermes-dashboard` and tarballs the build output. Documented for future operators; long-term, build/publish should move to CI (TODO).
- Staging's `~/.hermes` working tree is intentionally on `feat/atomic-fetch-v3`. Not reset to `deployed`. Gateway behavior on staging may differ from prod for that reason — flag this if any chat anomalies show up.
- `hermes-gateway` user-mode unit was failing since 2026-06-18 with wrong venv (`/home/ubuntu/hermes-venv/bin/python`); fixed in this deploy to point at `/home/ubuntu/.hermes/hermes-agent/venv/bin/python` via the canonical unit + `TERMINAL_CWD` drop-in. Reboot footgun closed.
- `hermes-dashboard` was previously bound to `100.112.31.24:9119` (Tailscale interface); rebound to `127.0.0.1:9119` to match the dashboard SPA's loopback expectation.
- All multi-line file content was staged via S3 (`s3://11mirror-staging-transfer/finny-staging-vhost/<sha>/`) instead of inline heredocs in `aws ssm send-command --parameters`, eliminating the JSON-escaping failure mode.
- No Bedrock router work — explicitly deferred to next PR per user direction.
```

- [ ] **Step 2: Append a row to `docs/staging/deploy-log.md`**

```bash
tail -20 /Applications/finny-claude-plugin/docs/staging/deploy-log.md 2>/dev/null || cat /Applications/finny-claude-plugin/docs/staging/deploy-log.md
```

If the file doesn't exist, create it with a header. Otherwise mirror the existing row format. A generic table row, if the log is a markdown table:

```markdown
| 2026-06-22 | feat/staging-dashboard-vhost | <PR#> | staging-only (i-0c2c974ff571162eb) | dashboard.finny.staging.11mirror.com live; gateway unit fixed; :9119 rebound to loopback |
```

If the log uses bullet lines, mirror that style instead.

- [ ] **Step 3: Commit**

```bash
cd /Applications/finny-claude-plugin
git add docs/staging/feat-staging-dashboard-vhost-changes.md docs/staging/deploy-log.md
git commit -m "docs(staging): manifest + log for feat/staging-dashboard-vhost

Documents the staging-only deploy of dashboard.finny.staging.11mirror.com,
including the pre-flight fix of the broken hermes-gateway user-mode unit
and the :9119 rebind from Tailscale to loopback.
"
```

---

## Task 12: Phase H — Open PR + promote to deployed

**Files:**
- (none — git/GitHub operations)

**Interfaces:**
- Consumes: clean feature branch with four commits (Tasks 1, 4, 8, 11).
- Produces: PR merged to `main`, `deployed` FF'd to new tip, prod `git pull` on `/opt/finny` (no runtime steps because this PR's runtime work was staging-only).

- [ ] **Step 1: Push the branch**

```bash
cd /Applications/finny-claude-plugin
git push -u origin feat/staging-dashboard-vhost
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --base main --title "feat: staging dashboard vhost (dashboard.finny.staging.11mirror.com)" \
  --body "$(cat <<'EOF'
## Summary

- Adds `dashboard.finny.staging.11mirror.com` vhost to `deploy/caddy/Caddyfile`.
- Parametrizes `deploy/scripts/deploy-finny-dashboard.sh` with `--instance` (default = prod).
- Adds canonical `deploy/systemd/hermes-gateway.service` referenced by Task 3 to fix the broken on-disk unit on staging.
- Documents the staging deploy in `docs/staging/feat-staging-dashboard-vhost-changes.md`.
- Updates `docs/staging/deploy-log.md`.
- Updates `docs/handoff/finny-hermes-on-ec2.md` (gotchas 11–12, comparison table, gotcha 6 correction).

Spec: `docs/superpowers/specs/2026-06-22-staging-dashboard-vhost-design.md`
Plan: `docs/superpowers/plans/2026-06-22-staging-dashboard-vhost.md`

## Test plan

- [x] Staging gateway user-mode unit replaced; `:8642/health` 200 across the swap (no outage)
- [x] Staging `:9119` bound to 127.0.0.1, health 200
- [x] Staging `:3001` (finny-dashboard) listening
- [x] DNS resolves dashboard.finny.staging.11mirror.com → 34.232.186.238
- [x] Public URL HTTP/2 200, valid TLS
- [x] Existing finny.staging.11mirror.com still 200 (regression check)
- [x] Browser: chat message streams, Sessions/Skills/Config tabs populate
- [x] Prod URL unchanged (HTTP/2 200)

## Production runtime impact

**None.** This PR's runtime work is entirely on staging EC2 `i-0c2c974ff571162eb`. The merged code adds:
- A Caddyfile entry that prod's `/etc/caddy/Caddyfile` ignores (prod's live file is hand-managed, see handoff gotcha 7).
- A `--instance` flag with prod as default, so existing prod deploys are unaffected.
- A canonical `hermes-gateway.service` unit. Prod's existing `~/.config/systemd/user/hermes-gateway.service` is NOT replaced by this merge — that's an operator action gated on the next prod-side staging cycle.
- Docs.

Prod promotion: `deployed` FF, `git pull` on `/opt/finny`. No service restarts.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: After review + merge, FF `deployed`**

(Operator action, after PR is approved and merged to `main`.)

```bash
git fetch origin
git checkout deployed
git merge --ff-only origin/main
git push origin deployed
```

- [ ] **Step 4: Pull on prod (no restart needed)**

```bash
aws ssm send-command --region us-east-1 --instance-ids i-0ef58962b09d490ee \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["sudo -u ubuntu git -C /opt/finny fetch origin","sudo -u ubuntu git -C /opt/finny merge --ff-only origin/deployed","sudo -u ubuntu git -C /opt/finny rev-parse --short HEAD"]'
```

Wait, then verify the new SHA on prod.

- [ ] **Step 5: Smoke prod URL**

```bash
curl -sS -I https://dashboard.finny.prod.11mirror.com/ | head -3
```

Expected: `HTTP/2 200`. (No prod runtime changes were made — this is a sanity check only.)

---

## NOT in scope

- **Bedrock router config swap on staging.** Deferred to next PR per user direction.
- **CI build/publish for the dashboard repo.** The dashboard is built on operator laptop and shipped via S3 + SSM. Long-term this should move to GitHub Actions producing artifacts; out of scope here. (TODO candidate.)
- **Auth on the staging dashboard.** Staying with v1 no-auth posture, matching prod (handoff §gotcha 8).
- **Resetting `~/.hermes` on staging from `feat/atomic-fetch-v3` to `deployed`.** Intentional drift for atomic-fetch testing; not this PR's concern.
- **Replacing prod's `~/.config/systemd/user/hermes-gateway.service` with the new canonical unit.** Prod's unit currently works; the canonical is staged in repo for future prod-side cycles, not auto-applied.
- **Prod `:9119` "mode=zero-fork" vs "mode=portable" doc cleanup.** Handoff already updated this session; no further action.
- **Renaming the dashboard fork org (`Postergully` vs `11mirror`).** Documented in this PR; rename is operator decision, separate PR.

## What already exists

- `deploy/scripts/deploy-finny-dashboard.sh` (lines 1-300+) — already idempotent, S3-driven, SSM-based. We add one flag (`--instance`); no other changes.
- `deploy/systemd/finny-dashboard.service` — installed unchanged on staging by Task 5 via the deploy script.
- `deploy/systemd/hermes-dashboard.service` — installed unchanged on staging by Task 6 (via S3 stage).
- `deploy/caddy/Caddyfile` — append a 7-line block; no edits to existing blocks.
- Two prod manifests (`docs/staging/feat-finny-dashboard-changes.md`, `feat-enable-hermes-dashboard-changes.md`) — the staging manifest in Task 11 is a slimmer aggregate of the same operations. We don't re-write the prod manifests.
- Existing Caddy + DNS pattern for `finny.staging.11mirror.com` — we copy that pattern for the dashboard subdomain.

## Failure modes

| Codepath | Realistic failure | Test? | Error handling? | Visible? |
|---|---|---|---|---|
| Task 3: gateway unit swap | Unit fails to start (typo, missing venv) | ✅ Step 3 health check | ✅ Step 5 rollback path; orphan preserved by D2 | YES — non-200 health |
| Task 5: deploy script | Local build fails (pnpm workspace error) | ✅ script exits non-0 | ✅ first-install rollback = `rm -rf /opt/finny/dashboard` | YES — script log |
| Task 6: `:9119` rebind | Wrong `--host` arg in unit | ✅ Step 4 ss + curl | ✅ Step 4 rollback | YES — `ss` shows wrong bind |
| Task 7: Route53 | Record already exists from prior attempt | ✅ Step 2 surfaces InvalidChangeBatch | ✅ Step 4 dig confirms regardless | YES — error msg |
| Task 9: Caddy reload | Cert provisioning rate-limited | ⚠️ Step 4 manual retry | ⚠️ wait + retry; no auto-recovery | YES — TLS error in browser |
| Task 9: Caddy reload | Existing vhost regressed | ✅ Step 4 regression curl | ✅ Step 3 snapshot rollback | YES — regression test fails |
| Task 3: TERMINAL_CWD wrong | Empty CONTEXT in agent | ✅ Step 4 journalctl probe | ✅ STOP-and-investigate gate | PARTIAL — only via journal |

**Critical gaps closed:** TERMINAL_CWD verification (Task 3 Step 4) closes the silent-CONTEXT failure mode; regression curl in Task 9 Step 4 closes the broken-existing-vhost failure mode; D2 sequencing closes the `:8642`-outage-on-unit-failure mode.

## Worktree parallelization strategy

Sequential implementation, no parallelization opportunity. Tasks 3-10 each depend on the previous (gateway → dashboard → :9119 → DNS → Caddy → smoke). Tasks 4 + 8 (repo edits) could be done in parallel with the runtime tasks but the speedup is negligible and the conflict surface (committing + pushing repo while operating staging) outweighs the gain.

---

## Self-Review

- **Spec coverage:**
  - Phase A (broken gateway unit) → Task 3 ✅
  - Phase B (deploy script + dashboard install) → Tasks 4 + 5 ✅
  - Phase B/C (`hermes-dashboard` :9119 install + rebind to loopback) → Task 6 ✅
  - Phase D (Route53) → Task 7 ✅
  - Phase E (Caddyfile in repo + live) → Tasks 8 + 9 ✅
  - Phase F (smoke test) → Task 10 ✅
  - Phase G (manifest + deploy log) → Task 11 ✅
  - Phase H (promotion to prod via deployed branch) → Task 12 ✅
  - Risks (Caddy cert wait, prod-isolation, gateway reboot footgun) — all addressed in respective tasks.

- **Plan-eng-review fixes applied:**
  - D1: heredocs replaced with S3 + SSM for unit/Caddyfile transfer (Tasks 3, 6, 9). ✅
  - D2: Task 3 no longer pre-kills the orphan; relies on `--replace` and verifies process count. ✅
  - Finding 3: Route53 `wait` (Task 7) uses captured ChangeId from a single `change-resource-record-sets` call. ✅
  - Finding 4: Task 2 Step 3 verifies operator dashboard repo clean + on origin/main. ✅
  - Finding 5: distribution-CI gap captured in NOT-in-scope as TODO candidate. ✅
  - Finding 6: snapshot-restore uses captured exact path, not glob. ✅
  - Finding 7: Task 2 Step 1 verifies `staging` profile dir + `AGENTS.md`; Task 3 Step 4 verifies CONTEXT loads. ✅
  - Finding 8: Task 1 Step 4 commits the spec + plan + handoff updates + new unit file. ✅
  - Finding 9: DRY — gateway unit content lives only in `deploy/systemd/hermes-gateway.service`; tasks reference the file, not inline content. ✅
  - Test gaps: regression curl added (Task 9 Step 4), process-count check enforced (Task 3 Step 3), CONTEXT probe added (Task 3 Step 4). ✅

- **Placeholder scan:** None. Every step has exact commands or exact substitution placeholders (`<S3_PREFIX>`, `<SNAPSHOT_PATH>`) with capture instructions.

- **Type consistency:** Unit file names and bind addresses match across tasks; SHA-prefixed S3 paths consistent.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | not run |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 9 issues found, 9 resolved (2 via AskUserQuestion D1+D2, 7 inline); 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (no UI work) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

**UNRESOLVED:** 0
**VERDICT:** ENG CLEARED — ready to implement.
