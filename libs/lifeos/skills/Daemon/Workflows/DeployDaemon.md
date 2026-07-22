# DeployDaemon Workflow

**Purpose:** Deploy the daemon website and sync data to MCP KV store. Does NOT aggregate or modify content — use UpdateDaemon for that.

## Trigger Phrases

- "deploy daemon"
- "push daemon"
- "ship daemon"

## Process

### Step 1: Push Website to GitHub

```bash
cd ~/Projects/daemon && git add -A && git commit -m "Deploy daemon $(date +%Y-%m-%d)" && git push
```

Pre-commit hook runs automatically and blocks sensitive data. Cloudflare Pages auto-deploys on push.

### Step 2: Sync Data to MCP KV Store

```bash
cd ${LIFEOS_SKILL_DIR}/Mcp && bun install && bun update-daemon
```

This runs the existing pipeline: sync integrations, aggregate daemon.md + integrations, validate with Zod, upload to Cloudflare KV.

### Step 3: Verify Deployment

```bash
curl -s -o /dev/null -w "%{http_code}" https://daemon.example.com
```

```bash
curl -s https://mcp.daemon.example.com \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_about","arguments":{}},"id":1}' | head -c 200
```

## Notes

- If only website UI changed (no content): Step 1 is sufficient
- If daemon.md content changed: Both steps needed
- Run **UpdateDaemon** workflow FIRST if you want to aggregate fresh LifeOS data
