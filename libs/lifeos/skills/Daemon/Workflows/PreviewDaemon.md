# PreviewDaemon Workflow

**Purpose:** Show what an UpdateDaemon would change without writing or deploying anything.

## Trigger Phrases

- "preview daemon"
- "preview daemon update"
- "what would daemon update look like"
- "daemon diff"

## Process

### Step 1: Run Aggregator in Preview Mode

```bash
bun ${LIFEOS_SKILL_DIR}/Tools/DaemonAggregator.ts --diff ${LIFEOS_USER_DIR}/Daemon/daemon.md --verbose
```

### Step 2: Show Section-by-Section Summary

Present changes grouped by section:
- Which sections have new content
- Which sections are unchanged
- How many security redactions would be applied
- Source data freshness per section

### Step 3: Highlight Risks

Flag any sections where:
- Content is older than 30 days
- Security filter made redactions (show what was caught)
- LifeOS source file is missing

## Output Format

```
Daemon Preview — what would change:

  [ABOUT]: unchanged
  [MISSION]: 2 goals updated from TELOS
  [FAVORITE_BOOKS]: +2 new (from TELOS/BOOKS.md)
  [RECENT_IDEAS]: 10 new ideas (title + thesis)
  [CURRENTLY_WORKING_ON]: 6 themes from last 14 days
  [WISDOM]: 5 quotes added

  Security: 0 redactions needed
  Sources: all present and fresh

  To apply: run "update daemon"
```
