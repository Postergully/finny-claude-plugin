# Staging — operator's guide

This directory holds the staging-tier discipline: how to test a branch on staging, how to capture every non-git change, how to refresh the staging snapshot, and how to roll back.

The **design rationale** lives in `docs/superpowers/specs/2026-06-15-staging-architecture-design.md` (D1–D15).
The **executable build steps** live in `snapshot-refresh-checklist.md` (this directory).
This file is the **operator's how-to** — read this first if you're testing a branch.

---

## When to use staging

| Change touches… | Mocked tests OK? | Staging required? |
|---|---|---|
| Bridge logic only (envelopes, Zod schemas, intent dispatch) | Yes | No |
| MCP wiring, OAuth code paths | Yes | **Yes** — OAuth-against-real-Caddy needs the real listener |
| systemd unit files, Caddyfile | No | **Yes** |
| `~/.hermes/.env` or `~/.hermes/profiles/*/.env` | No | **Yes** |
| `/opt/finny/bridge/.env` | No | **Yes** |
| Hermes profile changes (skills, agent-hooks, plans) | No | **Yes** |
| `hermes-bootstrap.sh` or any infra script | No | **Yes** |
| `apt install`, `pip install`, `npm install -g` on the box | No | **Yes** |

If in doubt, staging-test it. Staging is cheap insurance.

---

## The 9-step flow

```
1. open feature branch in the relevant repo
2. push to origin, open PR                              ← reviewers see diff while staging test runs
3. CI runs mocked tests on PR (existing pnpm -r test)
4. on staging EC2 via SSM: git fetch && git checkout <branch> && build
5. restart staging units; smoke via desktop app + browser cowork
6. iterate until green; capture every non-git change in
   docs/staging/<branch-name>-changes.md, commit to the branch
7. PR contains: code diff + staging-changes manifest + green smoke
8. reviewer approves, merge to main                     ← reviewer rejects PRs missing manifest
9. prod deploy = git pull on prod EC2 + walk the manifest's
   non-git steps + restart units
```

---

## Step 4 — push branch to staging

Both branches share the same GitHub origin. There is **no** separate `staging` git remote — staging just checks out whatever's on origin.

Open an SSM shell to staging:

```bash
aws ssm start-session --target i-0c2c974ff571162eb --region us-east-1 \
  --document-name AWS-StartInteractiveCommand \
  --parameters 'command=["sudo -iu ubuntu"]'
```

(Instance ID is the current `finny-staging`; check `aws ec2 describe-instances --filters Name=tag:env,Values=staging` if it changes after a refresh.)

Then on the box:

```bash
cd /opt/finny
git fetch origin
git checkout <branch>
pnpm install --frozen-lockfile
pnpm -C bridge build
exit  # back to your local shell, then:
```

```bash
# Restart units (run via SSM send-command from your laptop, or as ubuntu via SSM shell):
aws ssm send-command --instance-ids i-0c2c974ff571162eb --document-name AWS-RunShellScript \
  --parameters 'commands=["sudo systemctl restart finny-mcp","sudo -iu ubuntu systemctl --user restart hermes-gateway hermes-dashboard"]'
```

If the branch touches `finny-hermes` or `finny-hermes-config`, see `[[ec2-editing-workflow]]` in your global memory for the per-repo branch+commit+push pattern (those repos are checked out under `~/.hermes/` on the box, not `/opt/finny`).

---

## Step 5 — smoke

Two surfaces, both required (the production traffic path is browser cowork → MCP; the desktop dashboard is for chat-driven exercise of the gateway):

### Public MCP (browser Claude cowork)

```bash
# Public TLS + OAuth metadata (from anywhere):
curl -sS https://finny.staging.11mirror.com/.well-known/oauth-protected-resource | jq .resource
# expect "https://finny.staging.11mirror.com/", NOT prod

# MCP endpoint (RFC 9728 challenge):
curl -sSI https://finny.staging.11mirror.com/mcp | grep -iE 'www-authenticate|http/'
```

Then in **Claude.ai → Settings → Connectors → Add custom connector**:
- Name: `Finny Staging`
- Remote MCP server URL: `https://finny.staging.11mirror.com/mcp`
- **Advanced settings → OAuth Client ID and OAuth Client Secret are mandatory.** The bridge does not advertise `/register` (DCR off in default deploys), so Claude.ai needs the credentials directly. Get them from staging without leaking through transcript:

  ```bash
  aws ssm start-session --target i-0c2c974ff571162eb
  sudo grep -E '^MCP_CLIENT_ID|^MCP_CLIENT_SECRET' /opt/finny/bridge/.env
  exit
  ```

After Add: Claude.ai shows "Connected" with 5 tools. Exercise at least `finny_query` end-to-end (read-only NetSuite query) to confirm the bridge → gateway → NetSuite path.

### Tailnet dashboard (desktop app)

```bash
# From any tailnet device (e.g. your Mac):
curl -s http://100.112.31.24:9119/ | grep -o '__HERMES_SESSION_TOKEN__="[^"]*"' \
  | sed 's/.*="\([^"]*\)"/\1/'
```

Paste the session token into the Hermes desktop app's "Session token" field (Settings → Gateway → Remote → URL `http://100.112.31.24:9119`). Token rotates on every dashboard restart — re-paste after refresh / reboot / unit restart. (v0.14 limitation; newer Hermes adds basic-auth env vars per the public docs.)

### No-Slack-bleed sanity check

Search prod Slack channels during the staging test window. **Expect zero new bot messages tied to staging activity.** If any appear, the active profile on staging is wrong — the `staging` profile must be active (not `finny`). Check via:

```bash
sudo -iu ubuntu /home/ubuntu/.hermes/hermes-agent/venv/bin/hermes profile list
# expect ◆ on staging
```

---

## Step 6 — capture non-git changes

Copy `docs/staging/MANIFEST-TEMPLATE.md` to `docs/staging/<branch-name>-changes.md`. Fill it in **as you go**, not at the end — it's much easier to capture an env edit when you make it than to reconstruct it later.

If you made zero non-git changes, the file still goes in the PR with the line:
> No non-git changes — git merge + standard restart is sufficient.

This is mandatory. The manifest's existence is the contract; an empty body is fine.

### What counts as a non-git change

- `~/.hermes/.env` or `~/.hermes/profiles/<name>/.env` edits — list keys only, never values
- `/opt/finny/bridge/.env` edits — same rule
- systemd unit file edits (`/etc/systemd/system/*.service` or `~/.config/systemd/user/*.service`)
- Caddyfile edits
- `apt install` / `pip install` / `npm install -g`
- `systemctl enable` / `disable` state changes
- IAM policy changes
- Security-group ingress changes
- DNS record changes

### Secrets discipline

Never paste env-file values into the manifest, the PR, or any chat transcript. Per `[[never-expose-secrets]]`: SSM logs command bodies, so secrets must transit via `EnvironmentFile` or SecureString parameter, never as args. Manifest entries should say "added key `FOO`" or "rotated `BAR`", not the value.

---

## Step 9 — prod deploy

After merge:

```bash
# Open SSM to prod:
aws ssm start-session --target i-0ef58962b09d490ee --region us-east-1 \
  --document-name AWS-StartInteractiveCommand \
  --parameters 'command=["sudo -iu ubuntu"]'

cd /opt/finny
git fetch origin
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm -C bridge build
```

Then walk the manifest's "Non-git changes" section **in order**. Each step should be applied to prod exactly as it was applied to staging.

Restart units:

```bash
sudo systemctl restart finny-mcp
sudo -iu ubuntu systemctl --user restart hermes-gateway
# Do NOT restart hermes-dashboard on prod — prod doesn't run one.
```

Verify prod still green:

```bash
curl -sSI https://finny.prod.11mirror.com/mcp | grep -iE 'www-authenticate|http/'
```

5-tool smoke against prod via your usual cowork connector.

---

## Snapshot refresh

Cadence: **≤14 days, or before testing any branch >7 days old.** A stale staging baseline weakens "worked in staging" silently.

Procedure: `docs/staging/snapshot-refresh-checklist.md`. The checklist is itself a manifest — every Phase 2 edit captured there must run on the new staging box. ~30 minutes per refresh.

After refresh:
- Old staging instance terminated (EBS snapshot kept for ~1 deploy cycle as insurance, then deleted).
- New staging EC2 has a different instance ID — update the SSM commands in this doc if it changed.
- Tailscale IP usually stays the same (`100.112.31.24`), but verify with `tailscale ip -4` on the new box; update `~/.config/systemd/user/hermes-dashboard.service` ExecStart if it changed.

---

## Rollback

If a prod deploy goes wrong, the manifest is also your rollback script:

1. `git revert <merge-sha>` on each repo with changes (per the manifest's "Git changes" section).
2. Walk the manifest's "Non-git changes" section **in reverse order**, applying inverse operations (uninstall packages you installed, revert env edits to the previous values, undo systemd unit edits).
3. Restart `finny-mcp` and `hermes-gateway`.
4. Verify prod 5-tool smoke green.

If staging itself is wedged: `aws ec2 reboot-instances --instance-ids i-0c2c974ff571162eb`. If staging is past saving, take a fresh AMI snapshot of prod and rebuild via the snapshot-refresh checklist.

---

## Two-listener model (why two surfaces?)

Staging exposes two things, deliberately:

- **Public MCP** at `https://finny.staging.11mirror.com/mcp` (Caddy + TLS + staging OAuth client) — this is the **production traffic path**. Browser Claude cowork connects here via Custom Connector. You test what real users will hit.
- **Tailnet dashboard** at `http://100.112.31.24:9119` — Hermes desktop app connects here. Dashboard has no public listener; tailnet is the trust boundary. Used for chat-driven exercise of the gateway and for inspecting agent state.

Both are necessary for full smoke. The MCP path doesn't exercise the same UI flows as the dashboard, and the dashboard chat doesn't go through the bridge. Run both.

---

## Known gotchas (caught at first build)

These bit us during the initial Phase 1–3 build. They're documented in the spec addendum and the snapshot-refresh checklist; surfacing them here so you don't re-discover them.

1. **DNS is `finny.staging.11mirror.com`**, not `staging.finny.11mirror.com`. (Mirrors `finny.prod.11mirror.com` shape; lives in Route53 zone `staging.11mirror.com`.)
2. **Caddyfile must be a transparent reverse proxy** — `reverse_proxy 127.0.0.1:3000` for the entire site, no path filtering. Filtering breaks OAuth (Caddy returns empty 200s for unfiltered paths, bridge never sees `/register` etc., Claude.ai shows `registration_endpoint_missing`).
3. **Custom Connector "Advanced settings" is mandatory** — the OAuth Client ID + Secret fields are collapsed and look optional. They aren't. The bridge has DCR off by default.
4. **Hermes profile env quirk** — when a non-default profile is active, Hermes loads env from `~/.hermes/profiles/<name>/.env`, **NOT** the global `~/.hermes/.env`. NetSuite/Hindsight/GitHub credentials must be copied into the profile dir. Snapshot-refresh checklist §6 has the idempotent recipe.
5. **Don't "fix" the venv layout on staging.** `[[hermes-venv-mismatch]]` memory framed `/home/ubuntu/hermes-venv/` as wrong; on prod that's the venv the gateway actually runs from and where NetSuite tooling works. Staging mirrors prod. If the venv layout ever needs fixing, do it on prod first via the staging-promotion flow, never as a staging-only divergence.
6. **Desktop app v0.14 always runs the agent locally.** Even with "Remote gateway" set, the chat agent loop runs on your Mac. The remote toggle observes the remote dashboard process but doesn't route the chat. This is fine because the production traffic path is via the bridge/MCP, not the dashboard. Revisit when Hermes is upgraded.
7. **Dashboard binds directly to the tailnet IP**, not localhost behind Caddy. Hermes v0.14 has a Host-header DNS-rebinding guard that rejects requests where `Host:` ≠ bind host; reverse-proxying through Caddy 4xx'd everything. Tailscale is the trust boundary.

---

## Files in this directory

- `README.md` — this file (operator's how-to)
- `MANIFEST-TEMPLATE.md` — copy this when starting a staging test
- `snapshot-refresh-checklist.md` — full Phase 1+2 build procedure (re-apply on every refresh)
- `<branch-name>-changes.md` — per-branch manifests (one per PR that staging-tested)

---

## Related

- Spec: `docs/superpowers/specs/2026-06-15-staging-architecture-design.md`
- Plan: `docs/superpowers/plans/2026-06-14-staging-architecture.md`
- Memory: `[[staging-promotion-discipline]]`, `[[ec2-ops]]`, `[[ec2-editing-workflow]]`, `[[never-expose-secrets]]`, `[[hermes-venv-mismatch]]`
