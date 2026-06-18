# Per-branch staging change manifest — TEMPLATE

> Copy this file to `docs/staging/<branch-name>-changes.md` when you start staging-testing a branch.
> Commit it to the branch alongside your code changes.
> The PR is incomplete without it. Reviewer rejects PRs missing this file.

---

# Staging changes: `<branch-name>`

**Date tested:** `<YYYY-MM-DD>` → `<YYYY-MM-DD>`
**Tested by:** `<name>`
**Staging snapshot baseline:** prod AMI `<ami-id>` (taken `<date>`)
**PR:** `#<pr-number>`

## Git changes (replay via merge)

- `finny-claude-plugin@<branch>`: `<commit shas or "see PR #N">`
- `finny-hermes@<branch>`: `<shas, or "no changes">`
- `finny-hermes-config@<branch>`: `<shas, or "no changes">`
- `netsuite-kb@<branch>`: `<shas, or "no changes">`

## Deploy decision

> Pick one. The operator running `deploy-runbook.md` reads this section to decide deploy timing.

- [ ] **Deploy immediately after merge** — PR is independent, ship it as soon as merged
- [ ] **Hold for batch** — safe to merge but wait for the next batched deploy window
- [ ] **Hotfix** — deploy ASAP, do not batch with anything else
- [ ] **Reconciliation deploy** — special case (e.g., byte-equality reconciliation); see deploy-runbook.md byte-equality flow

## Non-git changes (replay manually on prod, in order)

> These run during step 9b (deploy), NOT at merge time. Merge to main does not trigger any of these.
> If empty: write **"No non-git changes — `git pull` on `deployed` + standard restart is sufficient."**

1. `<file or surface>`: `<change>`
   - **Command run:** `<exact command, redact secrets>`
   - **Why:** `<one line>`
2. `<...>`
3. `sudo systemctl daemon-reload && sudo systemctl restart <unit>`

Examples of things that **must** appear here when applicable:
- `~/.hermes/.env` or `~/.hermes/profiles/<name>/.env` edits (any new key, any value change — never paste actual secrets, list keys only)
- `/opt/finny/bridge/.env` edits
- systemd unit file edits (`/etc/systemd/system/*.service` or `~/.config/systemd/user/*.service`)
- Caddyfile edits
- `apt install` / `pip install` / `npm install -g` (anything outside the source repos)
- `systemctl enable` / `disable` state changes
- IAM policy changes
- Security-group ingress changes
- DNS record changes

## What was tested on staging

- [ ] 5-tool smoke (`finny_query`, `finny_report`, `finny_task_status`, `finny_continue`, `finny_remember`) via browser Claude cowork at `https://finny.staging.11mirror.com/mcp`
- [ ] Desktop dashboard chat works against tailnet IP
- [ ] No-Slack-bleed sanity check (no bot messages in prod Slack during the staging window)
- [ ] `<feature-specific test 1>`
- [ ] `<feature-specific test 2>`

## Skipped on prod (staging-only changes)

> Things you did on staging for testing/debug that should **NOT** carry to prod.

- `<e.g. extra debug logging, lower TTLs, test data seeded>`
- If empty: **"None."**

## Rollback

- `git revert <merge-sha>` on each repo with changes.
- Revert non-git changes in reverse order:
  1. `<reverse step 3>`
  2. `<reverse step 2>`
  3. `<reverse step 1>`
- Restart units: `<list>`

## Notes / surprises

> Anything weird that happened during staging-test that future-you (or a teammate) should know.
> If empty: leave the heading and write "None."
