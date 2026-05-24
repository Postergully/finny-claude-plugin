---
name: hermes-management
description: This skill should be used when the user wants to interact with Hermes, delegate tasks to their AI assistant, or check gateway status. Activates for AI assistant delegation and orchestration.
---

When the user wants to interact with Hermes or delegate tasks, use the Hermes MCP tools.

## When to Use This Skill

Activate when the user:

- Wants to chat with Hermes ("Ask Claw to...", "Tell my assistant...")
- Delegates tasks ("Have Hermes research...", "Let Claw handle...")
- Checks status ("Is Hermes running?")
- Manages tasks ("Check task progress", "Cancel that task")

## Tools Reference

| Task | Tool |
|------|------|
| Chat (sync) | `hermes_chat` |
| Chat (async) | `hermes_chat_async` |
| Task status | `hermes_task_status` |
| List tasks | `hermes_task_list` |
| Cancel task | `hermes_task_cancel` |
| Gateway health | `hermes_status` |

## Sync vs Async

**Use sync (`hermes_chat`):**
- Quick questions
- Simple commands
- When you need immediate response

**Use async (`hermes_chat_async`):**
- Research tasks
- Long-running operations
- Tasks that might timeout

## Example Workflows

**Quick question:**
```
hermes_chat message="What's the weather?"
```

**Long task:**
```
hermes_chat_async message="Research competitors and write a report"
→ { task_id: "task_abc123" }

hermes_task_status task_id="task_abc123"
→ { status: "running" }

# ... poll until complete ...

hermes_task_status task_id="task_abc123"
→ { status: "completed", result: "..." }
```
