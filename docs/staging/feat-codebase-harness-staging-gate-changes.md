# feat/codebase-harness-staging-gate — staging changes

No non-git changes — `git merge` + standard restart on prod is sufficient.

This PR only adds tooling under `.claude/` (workflow + skill scaffolds the Claude
loop runtime reads). Nothing here ships to the `finny-mcp` systemd unit, the
`hermes-gateway` user unit, or the Caddy vhost. There is no staging EC2 step to
replay.

Why this manifest exists anyway: the patch in this PR makes
`ship-change.js` itself refuse to open a PR without a manifest. We eat our own
dogfood — pure-code PRs still produce the stub so prod deploys are never
silently untracked.
