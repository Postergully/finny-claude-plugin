---
description: Send a message to Hermes
argument-hint: <message>
---

# /claw:chat

Send a message to your Hermes assistant and get a response.

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

Calls `hermes_chat` (sync) or `hermes_chat_async` (for long tasks) and returns the response.
