---
name: finance:audit-netsuite
description: Audit-style review of NetSuite records — anomalies, unusual transactions, control gaps. Maps to open-string intent `audit_review`. User invocation: /lolly:finance:audit-netsuite [scope]
argument-hint: "[entity] [period] [audit focus] (optional — decomposer will ask if missing)"
---

# /lolly:finance:audit-netsuite

Run an audit-style review across NetSuite for a given entity and period.
Surfaces anomalies, unusual transactions, and potential control gaps based on
Lolly's brain knowledge of ShareChat's NetSuite tenant.

## Routing

This command maps to the OPEN-STRING intent `audit_review`. NOT in the bridge
bless-list — passes through to Lolly. Hand off to `intent-decomposer` with:

- `intent: 'audit_review'`
- `user_question: <the user's full request, including $ARGUMENTS>`

`intent-decomposer` will apply Rule 4 (first-call permission gate per session),
call discover, drive AskUser, then execute.

## Notes for the user

Audit reviews are typically slower than direct queries (Lolly may pull from
multiple NetSuite endpoints + her brain). Expect 60-120s. Decomposer's
30-60s status hint is a floor, not a ceiling.

## Cross-references

- `intent-decomposer` — owns the orchestration.
- `judging-output` — handles the resulting envelope.
