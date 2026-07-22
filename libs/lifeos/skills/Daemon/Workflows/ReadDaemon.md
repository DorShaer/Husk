# ReadDaemon Workflow

**Purpose:** Fetch and display the current state of the live daemon profile.

## Trigger Phrases

- "read daemon"
- "check daemon"
- "what's on my daemon"
- "daemon status"
- "show daemon"

## Process

### Step 1: Fetch Live MCP Data

```bash
curl -s https://mcp.daemon.example.com \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_all","arguments":{}},"id":1}'
```

### Step 2: Parse and Display

Extract the JSON response and display each section with its content length and freshness.

### Step 3: Check Local vs Live

Compare the local `${LIFEOS_USER_DIR}/Daemon/daemon.md` against the live API response to identify drift.

```bash
bun ${LIFEOS_SKILL_DIR}/Tools/DaemonAggregator.ts --sources
```

## Output Format

```
Daemon Status (daemon.example.com)
  Last updated: 2026-04-08T21:45:00Z

  Sections:
    About: 342 chars
    Mission: 256 chars
    Location: Bay Area
    Books: 12 items
    Movies: 8 items
    Predictions: 8 items
    Preferences: 10 items
    Daily Routine: 9 items
    Podcasts: 5 items
    TELOS: populated
    Projects: 8 technical, 3 creative

  Live endpoint: 200 OK
  MCP API: responding
  Local sync: [in sync / X sections drifted]
```
