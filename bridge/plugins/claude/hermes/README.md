# Hermes Plugin for Claude Code

Connect Claude Code to your Hermes AI assistant instance. Chat, check status, and delegate tasks.

## What's Included

- **MCP Server** - Connects Claude Code to Hermes gateway
- **Skills** - Auto-triggers for Hermes interactions
- **Agents** - `task-delegator` for async task management
- **Commands** - `/claw:chat`, `/claw:status`

## Installation

```bash
claude plugin install hermes
```

**Required environment variables:**
```
FINNY_UPSTREAM_URL=http://127.0.0.1:8642
FINNY_UPSTREAM_TOKEN=your-gateway-token
```

## Commands

### /claw:chat

Send a message to Hermes:

```
/claw:chat What's the weather like?
```

### /claw:status

Check Hermes gateway health:

```
/claw:status
```

## Agents

Spawn the task delegator for long-running tasks:

```
spawn task-delegator to research and summarize the latest AI news
spawn task-delegator to monitor my inbox for the next hour
```

## Async Tasks

For long operations, use async mode:

```
hermes_chat_async message="Complex research task..."
→ Returns task_id

hermes_task_status task_id="..."
→ Check progress
```

## Links

- [Repository](https://github.com/freema/hermes-mcp)
- [Hermes](https://github.com/hermes/hermes)
