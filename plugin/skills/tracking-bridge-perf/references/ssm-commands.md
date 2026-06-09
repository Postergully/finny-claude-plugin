# SSM Commands — Ready to Paste

All commands target prod EC2 `i-0ef58962b09d490ee` in `us-east-1`. Use `AWS-RunShellScript` for non-interactive execution; `start-session` is interactive and won't work in scripted flows.

## Two-step pattern

Every command returns a `CommandId`. Sleep 5–8 s, then poll `get-command-invocation`:

```bash
CID=$(aws ssm send-command --instance-ids i-0ef58962b09d490ee --region us-east-1 \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["<your shell command>"]' \
  --query "Command.CommandId" --output text)
echo "CID=$CID"
sleep 6
aws ssm get-command-invocation --command-id "$CID" --instance-id i-0ef58962b09d490ee \
  --region us-east-1 \
  --query "{status:Status,out:StandardOutputContent,err:StandardErrorContent}" \
  --output json
```

## Common windows

### Last 60 minutes — quick health check

```bash
sudo journalctl -u finny-mcp --since "60 min ago" -o cat 2>&1 \
  | node /opt/finny/bridge/scripts/analyze-gateway-log.mjs
```

### Last 24 hours — daily/weekly review

```bash
sudo journalctl -u finny-mcp --since "24 hours ago" -o cat 2>&1 \
  | node /opt/finny/bridge/scripts/analyze-gateway-log.mjs
```

⚠ If a deploy happened in the window, the analyzer will mix old + new code records. Check the restart timestamp first (see "Find restart" below) and tighten if needed.

### Since deploy

```bash
# 1. Find the latest "Starting hermes-mcp" line
sudo journalctl -u finny-mcp -o cat | grep -n "Starting hermes-mcp" | tail -3

# 2. Use the timestamp from journalctl --since "<HH:MM>" or "<YYYY-MM-DD HH:MM>"
sudo journalctl -u finny-mcp --since "<HH:MM>" -o cat 2>&1 \
  | node /opt/finny/bridge/scripts/analyze-gateway-log.mjs
```

### Specific incident window (narrow)

```bash
sudo journalctl -u finny-mcp --since "<start-time>" --until "<end-time>" -o cat 2>&1 \
  | node /opt/finny/bridge/scripts/analyze-gateway-log.mjs
```

## Sanity-check counts

Before trusting an analyzer report, confirm sample size:

```bash
WINDOW="60 min ago"
echo "gateway_call lines:"
sudo journalctl -u finny-mcp --since "$WINDOW" -o cat 2>&1 | grep -c '"kind":"gateway_call"'
echo "gateway_query_aggregate lines:"
sudo journalctl -u finny-mcp --since "$WINDOW" -o cat 2>&1 | grep -c '"kind":"gateway_query_aggregate"'
```

If `gateway_call > 2× aggregate`, you're spanning pre-deploy logs. Tighten the window.

## Inspect raw records

### Last N JSONL records of either kind

```bash
sudo journalctl -u finny-mcp --since "60 min ago" -o cat 2>&1 \
  | grep -E '"kind":"gateway_call"|"kind":"gateway_query_aggregate"' \
  | tail -10
```

### Just the aggregates (one per query)

```bash
sudo journalctl -u finny-mcp --since "60 min ago" -o cat 2>&1 \
  | grep '"kind":"gateway_query_aggregate"'
```

### Pretty-print the last aggregate

```bash
sudo journalctl -u finny-mcp --since "60 min ago" -o cat 2>&1 \
  | grep '"kind":"gateway_query_aggregate"' \
  | tail -1 \
  | python3 -m json.tool
```

## Filter by signal

### Find all correction-retry calls

```bash
sudo journalctl -u finny-mcp --since "24h ago" -o cat 2>&1 \
  | grep '"kind":"gateway_call"' \
  | grep '"correction_retry":true'
```

### Find all sessions created in the window

```bash
sudo journalctl -u finny-mcp --since "24h ago" -o cat 2>&1 \
  | grep '"kind":"gateway_call"' \
  | grep '"session_created":true'
```

### Find slow queries (initial-phase > 180s)

```bash
sudo journalctl -u finny-mcp --since "24h ago" -o cat 2>&1 \
  | grep '"kind":"gateway_query_aggregate"' \
  | python3 -c '
import sys, json
for line in sys.stdin:
    try:
        rec = json.loads(line)
    except Exception:
        continue
    initial = rec["aggregate"]["phases"]["initial"]["latency_ms"]
    if initial > 180_000:
        print(f"{rec[\"ts\"]} session={rec[\"aggregate\"][\"session_id\"]} initial={initial}ms")
'
```

### Find envelope parse failures (correction-retry-then-still-fail)

```bash
sudo journalctl -u finny-mcp --since "24h ago" -o cat 2>&1 \
  | grep -E "envelope_parse_failed"
```

## Combined-signal queries

### "Spawning fresh session per rejection" check

This is the question from the original spec — does the bridge create a new session AND mark it as a correction retry on the same record?

```bash
sudo journalctl -u finny-mcp --since "24h ago" -o cat 2>&1 \
  | grep '"kind":"gateway_call"' \
  | grep '"correction_retry":true' \
  | grep '"session_created":true' \
  | wc -l
```

A count of **0** confirms the bridge reuses sessions on correction retry (the expected behavior; design verified). Non-zero would be a real bridge bug — investigate `bridge/src/mcp/tools/_shared/chatPipeline.ts` correction-retry path.

## Tail live (during testing)

For watching while you issue queries from cowork:

```bash
# This is non-interactive but blocks — only run if you can keep the session open.
# In production debugging, use bridge-watch.mjs instead.
sudo journalctl -u finny-mcp -f -o cat 2>&1 \
  | node /opt/finny/bridge/scripts/bridge-watch.mjs
```

For SSM `send-command` you can't tail live — use `bridge-watch.mjs` from a manual SSM session if needed.

## Filesystem checks

### Verify the deployed code matches main

```bash
cd /opt/finny && git rev-parse HEAD && git status -sb
```

### Check service status + uptime

```bash
systemctl is-active finny-mcp
systemctl status finny-mcp --no-pager | head -10
```

### Health probes

```bash
curl -sS http://127.0.0.1:3000/ready    # bridge readiness (probes hermes)
curl -sS http://127.0.0.1:3000/health   # bridge process liveness
curl -sS http://127.0.0.1:8642/health   # gateway liveness
```

## When to stop using this and use a real metrics pipeline

If the user is doing this analysis weekly or noticing patterns hard to spot in JSONL → time to ship a Grafana dashboard or push gateway records to CloudWatch Metrics. Out of scope for this skill, but worth flagging if the manual loop gets old.
