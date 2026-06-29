# Brain cron-corrections manifest — pointer

The full deploy manifest for `brain/cron-corrections-2026-06-29` (95 files, content + atomic_fetch refactor) lives in the **finny-hermes-config** repo at:

[`docs/staging/brain-cron-corrections-2026-06-29-changes.md`](https://github.com/Postergully/finny-hermes-config/blob/brain/cron-corrections-2026-06-29/docs/staging/brain-cron-corrections-2026-06-29-changes.md) (PR [#3](https://github.com/Postergully/finny-hermes-config/pull/3))

Per the staging-promotion rule (CLAUDE.md), the manifest must live in the merged branch — and the merged branch is in finny-hermes-config, not finny-claude-plugin. This file exists in `finny-claude-plugin/docs/staging/` only as a cross-repo index pointer.

## Why a pointer

Both repos share `docs/staging/` as a manifest convention because the **operator** reads them when deciding to deploy. Without a pointer here, the next operator audit would think the brain manifest was missing.

## Summary (full content at the link above)

- 95 files: content (60+), atomic_fetch.py refactor (206→352 lines), 7 new pytest files, new CI workflow, CODEOWNERS, 38-line .gitignore overhaul
- Stagesnap profile deletion (444MB) — already done 2026-06-29
- Smoke-test results: 3/5 clean pass, 2/5 partial-but-graceful
- 7 non-blocking follow-up TODOs
