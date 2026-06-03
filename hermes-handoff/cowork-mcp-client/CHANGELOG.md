# cowork-mcp-client — changelog

Semver. Each release is a frozen folder under this directory.

## v1.0.0 — 2026-06-03

Initial release. Hand-off artifact for Finny / Hermes side.

**Contents:**

- `SKILL.md` — full skill body. Sections: role as MCP brain, the 5
  client-facing tools, envelope contract invariants, `finny_progress`
  emission cadence, `needs_input` clarification loop, `running` task
  semantics, dos and don'ts, error code mapping, session-end reflection
  trigger.
- `AGENTS-md-snippet.md` — one-line reference to add to Finny's
  `AGENTS.md`, plus install + verification instructions.

**Design spec:**
`docs/superpowers/specs/2026-06-03-finny-cowork-mcp-client-skill-design.md`

**Bump rules:**

- **Patch** (`v1.0.x`): wording fixes, clarifications, no contract change.
- **Minor** (`v1.x.0`): new sections, new dos/don'ts, new error codes,
  additive only. Finny can upgrade in place.
- **Major** (`vx.0.0`): contract changes that require Finny to behave
  differently (new mandatory emit, removed status value). Coordinated
  with a bridge release.
