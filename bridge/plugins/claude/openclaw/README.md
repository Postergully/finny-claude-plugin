# OpenClaw Plugin for Claude Code

Connect Claude Code to your OpenClaw AI assistant instance. Chat, check status, and delegate tasks.

## What's Included

- **MCP Server** - Connects Claude Code to OpenClaw gateway
- **Skills** - Auto-triggers for OpenClaw interactions
- **Agents** - `task-delegator` for async task management
- **Commands** - `/claw:chat`, `/claw:status`

## Installation

```bash
claude plugin install openclaw
```

**Required environment variables:**
```
OPENCLAW_URL=http://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=your-gateway-token
```

## Commands

### /claw:chat

Send a message to OpenClaw:

```
/claw:chat What's the weather like?
```

### /claw:status

Check OpenClaw gateway health:

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
openclaw_chat_async message="Complex research task..."
→ Returns task_id

openclaw_task_status task_id="..."
→ Check progress
```

## Links

- [Repository](https://github.com/freema/openclaw-mcp)
- [OpenClaw](https://github.com/openclaw/openclaw)
