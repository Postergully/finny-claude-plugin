---
name: finance:income-statement
description: Generate a P&L / income statement for ShareChat. Maps to the blessed `p&l_statement` intent. User invocation: /finny:finance:income-statement [scope hints]
argument-hint: "[entity] [period] (optional — decomposer will ask if missing)"
---

# /finny:finance:income-statement

Generate a profit & loss statement for a ShareChat entity over a period.

## Routing

This command maps to the blessed `p&l_statement` intent. Hand off to
`intent-decomposer` with:

- `intent: 'p&l_statement'`
- `user_question: <the user's full request, including $ARGUMENTS>`

The `intent-decomposer` skill owns:
- Calling `finny_query phase: 'discover'` if scope is incomplete.
- Driving an AskUser flow for missing variables (entity, period, consolidated, env).
- Calling `finny_query phase: 'execute'` with full scope.
- Handing the result to `judging-output`.

## Argument handling

If `$ARGUMENTS` includes obvious scope hints (e.g., "ShareChat standalone Q1"),
forward them to `intent-decomposer` as part of `user_question`. The decomposer's
per-intent template for `p&l_statement` knows how to extract them.

If `$ARGUMENTS` is empty, just hand off the bare intent — decomposer will ask
the user.

## Cross-references

- `intent-decomposer` — owns the orchestration.
- `judging-output` — handles the resulting envelope.
