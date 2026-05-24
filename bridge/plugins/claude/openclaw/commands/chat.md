---
description: Send a message to OpenClaw
argument-hint: <message>
---

# /claw:chat

Send a message to your OpenClaw assistant and get a response.

## Usage

```
/claw:chat <message>
/claw:chat --session=<id> <message>
```

## Examples

```
/claw:chat What's on my calendar today?
/claw:chat --session=main Check my emails
/claw:chat Summarize the project status
```

## What Happens

Calls `openclaw_chat` (sync) or `openclaw_chat_async` (for long tasks) and returns the response.
