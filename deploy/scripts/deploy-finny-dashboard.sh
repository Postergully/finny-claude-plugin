#!/usr/bin/env bash
# Deploy script for finny-dashboard v1 (first-time install).
#
# What it does:
#   1. Builds the dashboard locally (~/code/finny-hermes-dashboard, expects pre-cloned).
#   2. Tarballs dist/ + server-entry.js + node_modules + package.json + public/ + .vinxi/.
#   3. Uploads to s3://11mirror-staging-transfer/finny-dashboard/<sha>.tar.gz.
#   4. Drives prod EC2 via SSM to: download, extract to /opt/finny/dashboard, write
#      .env (using API_SERVER_KEY pulled from ~/.hermes/.env on the box, never
#      printed), install systemd unit, enable and start, reload Caddy, smoke-test.
#
# Idempotent: re-running upgrades in place. A previous /opt/finny/dashboard is
# moved to /opt/finny/dashboard.bak.<timestamp> for one-step rollback.
#
# Pre-reqs on the running machine (your laptop):
#   - awscli logged in (aws sts get-caller-identity returns user neuu_prod_iam_kali)
#   - dashboard repo at ~/code/finny-hermes-dashboard, on branch main, clean
#   - finny-claude-plugin repo current branch is feat/finny-dashboard
#
# Pre-reqs on prod EC2 (already verified by Task #6):
#   - i-0ef58962b09d490ee, port 3001 free, Node 22 + pnpm 9 installed
#   - ~/.hermes/.env has API_SERVER_ENABLED=true and API_SERVER_KEY=...
#   - Caddy active, Caddyfile at /etc/caddy/Caddyfile (or symlinked to /opt/finny/deploy/caddy/Caddyfile)

set -euo pipefail

# ------- config -------
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
BUCKET="11mirror-staging-transfer"
S3_PREFIX="finny-dashboard"
DASHBOARD_REPO="${HOME}/code/finny-hermes-dashboard"
PLUGIN_REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SYSTEMD_UNIT_SRC="${PLUGIN_REPO}/deploy/systemd/finny-dashboard.service"
TARGET_DIR="/opt/finny/dashboard"
BAK_DIR="/opt/finny/dashboard.bak.$(date +%Y%m%d-%H%M%S)"

log() { printf "\033[1;36m[deploy]\033[0m %s\n" "$*"; }
err() { printf "\033[1;31m[deploy:err]\033[0m %s\n" "$*" >&2; }

# ------- 0. sanity -------
log "verifying local repos…"
[ -d "${DASHBOARD_REPO}/.git" ] || { err "dashboard repo not at ${DASHBOARD_REPO}"; exit 1; }
[ -f "${SYSTEMD_UNIT_SRC}" ]    || { err "systemd unit not at ${SYSTEMD_UNIT_SRC}"; exit 1; }

DASHBOARD_BRANCH=$(git -C "${DASHBOARD_REPO}" rev-parse --abbrev-ref HEAD)
DASHBOARD_SHA=$(git -C "${DASHBOARD_REPO}" rev-parse --short HEAD)
DASHBOARD_DIRTY=$(git -C "${DASHBOARD_REPO}" status --porcelain | wc -l | tr -d ' ')

if [ "${DASHBOARD_BRANCH}" != "main" ]; then
  err "dashboard repo is on '${DASHBOARD_BRANCH}', expected 'main'"
  exit 1
fi
if [ "${DASHBOARD_DIRTY}" != "0" ]; then
  err "dashboard repo is dirty (uncommitted changes). commit or stash first."
  exit 1
fi

log "dashboard: ${DASHBOARD_BRANCH} @ ${DASHBOARD_SHA} (clean)"

# ------- 1. local build -------
log "building dashboard locally (this is the staging-equivalent gate)…"
cd "${DASHBOARD_REPO}"
pnpm install --ignore-workspace --frozen-lockfile=false >/dev/null
pnpm --ignore-workspace build

# Sanity check the build output.
[ -f "${DASHBOARD_REPO}/server-entry.js" ] || { err "server-entry.js missing after build"; exit 1; }
[ -d "${DASHBOARD_REPO}/dist" ]            || { err "dist/ missing after build"; exit 1; }

# ------- 2. tarball -------
TARBALL="/tmp/finny-dashboard-${DASHBOARD_SHA}.tar.gz"
log "creating tarball ${TARBALL}…"
cd "${DASHBOARD_REPO}"
# Ship: dist/, server-entry.js, package.json, pnpm-lock.yaml, public/, node_modules/.
# node_modules is ~600MB — gzipped ~200MB. Acceptable for one-shot deploy.
tar --exclude='./.git' --exclude='./.cache' --exclude='./.tmp' \
    -czf "${TARBALL}" \
    dist server-entry.js package.json pnpm-lock.yaml \
    public node_modules pnpm-workspace.yaml 2>/dev/null

TARBALL_SIZE=$(du -h "${TARBALL}" | awk '{print $1}')
log "tarball size: ${TARBALL_SIZE}"

# ------- 3. upload to S3 -------
S3_KEY="${S3_PREFIX}/${DASHBOARD_SHA}.tar.gz"
S3_URL="s3://${BUCKET}/${S3_KEY}"
log "uploading to ${S3_URL}…"
aws s3 cp "${TARBALL}" "${S3_URL}" --no-progress
log "uploaded."

# Generate a presigned URL the EC2 box can use without needing s3:GetObject
# in its instance profile. Valid 30 min (build + transfer fits comfortably).
log "generating presigned download URL (30 min validity)…"
PRESIGNED_URL=$(aws s3 presign "${S3_URL}" --expires-in 1800)

# ------- 4. read systemd unit content (we'll inline it via SSM) -------
SYSTEMD_UNIT_B64=$(base64 < "${SYSTEMD_UNIT_SRC}" | tr -d '\n')

# ------- 5. drive EC2 via SSM -------
# The SSM script is composed in Python (single-quoted, AWS-CLI-friendly JSON).
# It does:
#   a. mkdir target if first deploy, else move existing aside as backup
#   b. download tarball from S3
#   c. extract
#   d. write .env using API_SERVER_KEY pulled from ~/.hermes/.env (presence-checked
#      already; we read the value here on the box, never on laptop, never in logs)
#   e. install systemd unit (decoded from base64)
#   f. daemon-reload + enable + restart
#   g. wait + smoke localhost:3001
#   h. reload Caddy (Caddyfile change must be applied separately if Caddyfile
#      hasn't been pulled to the box yet — see remote-side note below)
#   i. smoke public URL

log "dispatching deploy to ${INSTANCE_ID}…"

REMOTE_SCRIPT=$(cat <<REMOTE_EOF
set -e
set -o pipefail

PRESIGNED_URL='${PRESIGNED_URL}'
TARGET='${TARGET_DIR}'
BAK='${BAK_DIR}'
UNIT_PATH='/etc/systemd/system/finny-dashboard.service'
UNIT_B64='${SYSTEMD_UNIT_B64}'

echo "=== 1. download tarball (presigned URL, no IAM dep) ==="
sudo -u ubuntu curl -fsSL -o /tmp/finny-dashboard.tgz "\${PRESIGNED_URL}"
ls -lh /tmp/finny-dashboard.tgz

echo
echo "=== 2. backup existing /opt/finny/dashboard if any ==="
if [ -d "\${TARGET}" ]; then
  echo "found existing target — moving to \${BAK}"
  sudo mv "\${TARGET}" "\${BAK}"
else
  echo "no existing target — first deploy"
fi

echo
echo "=== 3. extract ==="
sudo -u ubuntu mkdir -p "\${TARGET}"
sudo -u ubuntu tar -xzf /tmp/finny-dashboard.tgz -C "\${TARGET}"
sudo chown -R ubuntu:ubuntu "\${TARGET}"

echo
echo "=== 4. write .env ==="
# Read keys from ~/.hermes/.env once, write them directly into dashboard .env.
# Values never printed. API_SERVER_KEY is required (existed since v1).
# HINDSIGHT_API_KEY is required for the External Memory tab routes
# (/api/external-memory/*); missing key → 503 from those endpoints.
API_KEY=\$(sudo -u ubuntu bash -c "grep '^API_SERVER_KEY=' /home/ubuntu/.hermes/.env | head -1 | cut -d= -f2-")
if [ -z "\${API_KEY}" ]; then
  echo "ERROR: API_SERVER_KEY missing from ~/.hermes/.env" >&2
  exit 1
fi
HINDSIGHT_KEY=\$(sudo -u ubuntu bash -c "grep '^HINDSIGHT_API_KEY=' /home/ubuntu/.hermes/.env | head -1 | cut -d= -f2-")
if [ -z "\${HINDSIGHT_KEY}" ]; then
  echo "ERROR: HINDSIGHT_API_KEY missing from ~/.hermes/.env (required for External Memory tab)" >&2
  exit 1
fi
sudo -u ubuntu bash -c "cat > '\${TARGET}/.env' <<ENV_EOF
HERMES_API_URL=http://127.0.0.1:8642
HERMES_API_TOKEN=\${API_KEY}
HINDSIGHT_API_KEY=\${HINDSIGHT_KEY}
HOST=127.0.0.1
PORT=3001
ENV_EOF"
sudo chmod 600 "\${TARGET}/.env"
echo ".env written (mode 600)"

echo
echo "=== 5. install systemd unit ==="
echo "\${UNIT_B64}" | base64 -d | sudo tee "\${UNIT_PATH}" > /dev/null
sudo systemctl daemon-reload

echo
echo "=== 6. enable + (re)start finny-dashboard ==="
sudo systemctl enable finny-dashboard
sudo systemctl restart finny-dashboard

echo "waiting 5s for service to come up…"
sleep 5

echo
echo "=== 7. service status ==="
sudo systemctl is-active finny-dashboard || { sudo journalctl -u finny-dashboard -n 50 --no-pager; exit 1; }

echo
echo "=== 8. smoke local 127.0.0.1:3001 ==="
curl -fsS -o /dev/null -w "HTTP %{http_code} (loopback)\n" http://127.0.0.1:3001/ || { echo "loopback smoke failed"; exit 1; }

echo
echo "=== 9. ensure Caddyfile has the dashboard vhost ==="
# Caddyfile on prod is at /etc/caddy/Caddyfile (system) — usually a symlink to
# the repo's deploy/caddy/Caddyfile in /opt/finny. We pulled this branch's
# changes ONLY if /opt/finny is on a branch that includes them. For the
# deployed-branch model, the operator will FF /opt/finny's deployed branch
# AFTER this script verifies the dashboard works. So check if the vhost is
# already in the live Caddyfile, and only reload if it's missing.
if sudo grep -q 'dashboard.finny.prod.11mirror.com' /etc/caddy/Caddyfile; then
  echo "dashboard vhost already present in /etc/caddy/Caddyfile — reloading Caddy"
  sudo systemctl reload caddy
else
  echo "WARNING: dashboard vhost NOT in /etc/caddy/Caddyfile yet."
  echo "After this script finishes, FF /opt/finny's deployed branch to pick up"
  echo "the new Caddyfile, then run: sudo systemctl reload caddy"
  echo "(public URL https://dashboard.finny.prod.11mirror.com will not work until then)"
fi

echo
echo "=== DEPLOY DONE ==="
echo "loopback: OK"
echo "next: FF /opt/finny deployed branch + reload caddy → public URL works"
REMOTE_EOF
)

# Submit via SSM. We pipe the script through stdin to a remote bash to avoid
# JSON-quoting hell.
REMOTE_B64=$(printf '%s' "${REMOTE_SCRIPT}" | base64 | tr -d '\n')

CMD_ID=$(aws ssm send-command \
  --instance-ids "${INSTANCE_ID}" \
  --document-name "AWS-RunShellScript" \
  --comment "finny-dashboard deploy ${DASHBOARD_SHA}" \
  --parameters "{\"commands\":[\"echo '${REMOTE_B64}' | base64 -d | bash\"]}" \
  --query "Command.CommandId" --output text)

log "SSM command ${CMD_ID} dispatched. polling…"

# Poll for completion.
for i in $(seq 1 60); do
  sleep 5
  STATUS=$(aws ssm get-command-invocation \
    --command-id "${CMD_ID}" \
    --instance-id "${INSTANCE_ID}" \
    --query "Status" --output text 2>/dev/null || echo "Pending")
  if [ "${STATUS}" = "Success" ] || [ "${STATUS}" = "Failed" ] || [ "${STATUS}" = "TimedOut" ] || [ "${STATUS}" = "Cancelled" ]; then
    break
  fi
  printf "  [%02d] status=%s\n" "$i" "${STATUS}"
done

OUTPUT=$(aws ssm get-command-invocation \
  --command-id "${CMD_ID}" \
  --instance-id "${INSTANCE_ID}" \
  --query "StandardOutputContent" --output text)
ERR=$(aws ssm get-command-invocation \
  --command-id "${CMD_ID}" \
  --instance-id "${INSTANCE_ID}" \
  --query "StandardErrorContent" --output text)

echo
echo "================ REMOTE STDOUT ================"
echo "${OUTPUT}"
echo "================ REMOTE STDERR ================"
echo "${ERR}"
echo "==============================================="
echo
log "final SSM status: ${STATUS}"

if [ "${STATUS}" != "Success" ]; then
  err "deploy failed. inspect remote stderr above."
  err "rollback hint: sudo systemctl stop finny-dashboard && sudo rm -rf ${TARGET_DIR} && sudo mv ${BAK_DIR} ${TARGET_DIR}"
  exit 1
fi

# ------- 6. cleanup local tarball -------
rm -f "${TARBALL}"

# ------- 7. summary -------
echo
log "DONE."
log "deployed sha: ${DASHBOARD_SHA}"
log "loopback: http://127.0.0.1:3001/ (verified on EC2)"
log "next steps:"
log "  1. on prod EC2: FF /opt/finny's deployed branch to include this PR's Caddyfile change"
log "  2. on prod EC2: sudo systemctl reload caddy"
log "  3. smoke test: curl -I https://dashboard.finny.prod.11mirror.com/"
log "  4. delete s3://${BUCKET}/${S3_KEY} once you've verified prod (artifact cleanup)"
