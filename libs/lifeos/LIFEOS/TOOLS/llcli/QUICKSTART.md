# llcli Quick Start

**The 30-second guide to using llcli**

## Installation

Already done! Located at: `~/.claude/LIFEOS/TOOLS/llcli/`

## Usage

```bash
# Get help
~/.claude/LIFEOS/TOOLS/llcli/llcli.ts --help

# Today's recordings
~/.claude/LIFEOS/TOOLS/llcli/llcli.ts today

# Specific date
~/.claude/LIFEOS/TOOLS/llcli/llcli.ts date 2025-11-17

# Search
~/.claude/LIFEOS/TOOLS/llcli/llcli.ts search "consulting"

# With custom limit
~/.claude/LIFEOS/TOOLS/llcli/llcli.ts today --limit 50
```

## Piping to jq

```bash
# Just titles
~/.claude/LIFEOS/TOOLS/llcli/llcli.ts today | jq -r '.data.lifelogs[].title'

# Count recordings
~/.claude/LIFEOS/TOOLS/llcli/llcli.ts date 2025-11-17 | jq '.data.lifelogs | length'

# Long recordings (>30 min)
~/.claude/LIFEOS/TOOLS/llcli/llcli.ts today | jq '.data.lifelogs[] | select(
  ((.endTime | fromdateiso8601) - (.startTime | fromdateiso8601)) > 1800
)'
```

## Configuration

API key already configured in `~/.claude/.env`:
```bash
LIMITLESS_API_KEY=your_key
```

## Full Documentation

See: `~/.claude/LIFEOS/TOOLS/llcli/README.md`
