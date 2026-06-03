# hermes-handoff

Skills, prompts, and configuration artifacts authored on the
**cowork plugin** side of this repo to be **handed off to the Hermes
agent (Finny)** for installation in her own skill directory.

This folder is the source of truth for what Finny needs to know on the
agent side to play well with the MCP bridge and the cowork client.
Versioned per artifact so we can iterate without ambiguity.

## Layout

```
hermes-handoff/
  README.md                          # this file
  <skill-name>/
    CHANGELOG.md                     # semver history for this skill
    v1.0.0/
      SKILL.md                       # the skill body
      AGENTS-md-snippet.md           # install instructions
    v1.1.0/
      SKILL.md
      AGENTS-md-snippet.md
```

Each skill gets its own folder. Each version of a skill gets its own
sub-folder. Old versions are kept frozen — never edit them in place.

## Current skills

| skill | latest | spec |
|---|---|---|
| `cowork-mcp-client` | `v1.0.0` | `docs/superpowers/specs/2026-06-03-finny-cowork-mcp-client-skill-design.md` |

## Hand-off workflow

1. Author the skill in a new version folder under
   `hermes-handoff/<skill-name>/vX.Y.Z/`.
2. Write a design spec in `docs/superpowers/specs/YYYY-MM-DD-<topic>.md`
   describing the goal, the contract, and the bump rationale.
3. Update the skill's `CHANGELOG.md`.
4. Commit on a feature branch, open PR, get review.
5. After merge, hand the version folder to Finny's maintainer for
   installation in the Hermes skill directory.
6. Verify in production per the verification steps in the skill's
   `AGENTS-md-snippet.md`.

## Versioning policy

Semver per skill:

- **Patch** (`v1.0.x`): wording fixes, no contract change.
- **Minor** (`v1.x.0`): additive — new sections, new dos/don'ts.
- **Major** (`vx.0.0`): breaking — contract changes that require Finny
  to behave differently. Coordinate with a bridge release.

## Why a separate folder, not `plugin/skills/`?

`plugin/skills/` is the **cowork-side** skill set — what the client
agent loads. This folder is **agent-side** — what Finny loads. Different
audiences, different runtimes, different update cadences. Keeping them
separate prevents accidental cross-wiring.
