# UpdateDaemon Workflow

**Purpose:** Aggregate LifeOS system data, apply security filter, preview for approval, then deploy to daemon.example.com and MCP API.

## Trigger Phrases

- "update daemon"
- "refresh daemon"
- "update my daemon"
- "sync and update daemon"

## Process

### Step 1: Run Aggregator

```bash
bun ${LIFEOS_SKILL_DIR}/Tools/DaemonAggregator.ts --preview --verbose
```

This reads from:
- TELOS (missions, goals, books, movies, wisdom)
- Knowledge archive (recent Ideas — title + thesis only)
- PROJECTS.md (public projects only)
- Recent work sessions (abstracted to topic themes)
- Existing daemon.md (preserves manually curated sections)

The SecurityFilter runs automatically and reports any redactions.

### Step 2: Show Diff Against Current

```bash
bun ${LIFEOS_SKILL_DIR}/Tools/DaemonAggregator.ts --diff ${LIFEOS_USER_DIR}/Daemon/daemon.md
```

Present the diff to the user showing:
- New content added
- Content removed
- Sections updated
- Any security redactions applied

Keep the review to **one screen max**. Summarize changes by section, don't dump raw content.

### Step 3: Get Approval

Ask the user to confirm the update. Show:
- Section-by-section summary of what changed
- Number of security redactions applied
- Any warnings (stale sections, missing sources)

**Do not proceed without explicit approval.**

### Step 4: Write Updated daemon.md

```bash
bun ${LIFEOS_SKILL_DIR}/Tools/DaemonAggregator.ts --output ${LIFEOS_USER_DIR}/Daemon/daemon.md
```

### Step 5: Sync to Public Repo

Copy the filtered daemon.md to the public website repo:

```bash
cp ${LIFEOS_USER_DIR}/Daemon/daemon.md ~/Projects/daemon/public/daemon.md
```

### Step 6: Deploy

Run the existing deploy pipeline:

```bash
cd ~/Projects/daemon && git add -A && git commit -m "Update daemon data $(date +%Y-%m-%d)" && git push
```

Then sync to MCP KV:

```bash
cd ${LIFEOS_SKILL_DIR}/Mcp && bun install && bun update-daemon
```

### Step 7: Verify

Confirm both endpoints are live:
- Website: `curl -s -o /dev/null -w "%{http_code}" https://daemon.example.com`
- MCP API: `curl -s https://mcp.daemon.example.com -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_about","arguments":{}},"id":1}' | head -c 200`

## Example Response

```
Running the **UpdateDaemon** workflow in the **Daemon** skill to aggregate and deploy...

Aggregated LifeOS data:
  Books: 12 | Movies: 8 | Ideas: 10 | Work themes: 6 | Wisdom: 5

Security filter: clean (no redactions needed)

Changes vs current daemon:
  + Added 3 new recent ideas
  + Updated work themes (4 new, 2 removed)
  ~ Books list merged (2 new from TELOS)
  = Mission, location, predictions unchanged

Approve this update? [Waiting for the user]

[After approval]
  Wrote daemon.md (4,832 bytes)
  Deployed to Cloudflare Pages
  Synced to MCP KV
  Website: 200 OK
  MCP API: responding
```
