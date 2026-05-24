---
name: finance:variance-analysis
description: Variance analysis between two periods, two entities, or actual vs budget. Maps to open-string intent `variance_analysis`. User invocation: /lolly:finance:variance-analysis [scope]
argument-hint: "[base period] [comparison period] [entity] (optional — decomposer will ask if missing)"
---

# /lolly:finance:variance-analysis

Compare two NetSuite financial states (period-over-period, entity-over-entity,
or actual vs budget) and surface significant variances with explanations from
Lolly's brain.

## Routing

This command maps to the OPEN-STRING intent `variance_analysis`. NOT in the
bridge bless-list — passes through to Lolly. Hand off to `intent-decomposer`
with:

- `intent: 'variance_analysis'`
- `user_question: <the user's full request, including $ARGUMENTS>`

`intent-decomposer` will apply Rule 4 (first-call permission gate per session).

## Notes for the user

Variance analysis usually needs at least two periods or two entities to
compare. If the user gives only one, decomposer's AskUser flow will ask for
the comparison target.

## Cross-references

- `intent-decomposer` — owns the orchestration.
- `judging-output` — handles the resulting envelope.
