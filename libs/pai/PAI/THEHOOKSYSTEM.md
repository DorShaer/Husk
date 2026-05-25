# Hook System

> **PAI 4.0** — This system is under active development. APIs, configuration formats, and features may change without notice.

**Event-Driven Automation Infrastructure**

**Location:** `~/.claude/hooks/`
**Configuration:** `~/.claude/settings.json`
**Status:** Active - 20 hooks running in production

---

## Overview

The PAI hook system is an event-driven automation infrastructure built on Claude Code's native hook support. Hooks are executable scripts (TypeScript/Python) that run automatically in response to specific events during Claude Code sessions.

**Core Capabilities:**
- **Session Management** - Auto-load context, capture summaries, manage state
- **Voice Notifications** - Text-to-speech announcements for task completions
- **History Capture** - Automatic work/learning documentation to `~/.claude/MEMORY/`
- **Multi-Agent Support** - Agent-specific hooks with voice routing
- **Tab Titles** - Dynamic terminal tab updates with task context
- **Unified Event Stream** - All hooks emit structured events to `events.jsonl` for real-time observability

**Key Principle:** Hooks run asynchronously and fail gracefully. They enhance the user experience but never block Claude Code's core functionality.

---

## Available Hook Types

Claude Code supports the following hook events:

### 1. **SessionStart**
**When:** Claude Code session begins (new conversation)
**Use Cases:**
- Load PAI context from `PAI/SKILL.md`
- Initialize session state
- Capture session metadata

**Current Hooks:**
```json
{
  "SessionStart": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "${PAI_DIR}/hooks/KittyEnvPersist.hook.ts"
        },
        {
          "type": "command",
          "command": "${PAI_DIR}/hooks/LoadContext.hook.ts"
        }
      ]
    }
  ]
}
---

## Shared Libraries

The hook system uses shared TypeScript libraries to eliminate code duplication:

### `hooks/lib/learning-utils.ts`
Shared learning categorization logic.

```typescript
import { getLearningCategory, isLearningCapture } from './lib/learning-utils';

// Categorize learning as SYSTEM (tooling/infra) or ALGORITHM (task execution)
const category = getLearningCategory(content, comment);
// Returns: 'SYSTEM' | 'ALGORITHM'

// Check if response contains learning indicators
const isLearning = isLearningCapture(text, summary, analysis);
// Returns: boolean (true if 2+ learning indicators found)
```

**Used by:** RatingCapture, WorkCompletionLearning

### `hooks/lib/time.ts`
Shared PST timestamp utilities.

```typescript
import {
  getPSTTimestamp,    // "2026-01-10 20:30:00 PST"
  getPSTDate,         // "2026-01-10"
  getYearMonth,       // "2026-01"
  getISOTimestamp,    // ISO8601 with offset
  getFilenameTimestamp, // "2026-01-10-203000"
  getPSTComponents    // { year, month, day, hours, minutes, seconds }
} from './lib/time';
```

**Used by:** RatingCapture, WorkCompletionLearning, SessionSummary

### `hooks/lib/identity.ts`
Identity and principal configuration from settings.json.

```typescript
import { getIdentity, getPrincipal, getDAName, getPrincipalName, getVoiceId } from './lib/identity';

const identity = getIdentity();    // { name, fullName, displayName, voiceId, color }
const principal = getPrincipal();  // { name, pronunciation, timezone }
```


### `PAI/Tools/Inference.ts`
Unified AI inference with three run levels.

```typescript
import { inference } from '../PAI/Tools/Inference';

// Fast (Haiku) - quick tasks, 15s timeout
const result = await inference({
  systemPrompt: 'Summarize in 3 words',
  userPrompt: text,
  level: 'fast',
});

// Standard (Sonnet) - balanced reasoning, 30s timeout
const result = await inference({
  systemPrompt: 'Analyze sentiment',
  userPrompt: text,
  level: 'standard',
  expectJson: true,
});

// Smart (Opus) - deep reasoning, 90s timeout
const result = await inference({
  systemPrompt: 'Strategic analysis',
  userPrompt: text,
  level: 'smart',
});

// Result shape
interface InferenceResult {
  success: boolean;
  output: string;
  parsed?: unknown;  // if expectJson: true
  error?: string;
  latencyMs: number;
  level: 'fast' | 'standard' | 'smart';
}
```

**Used by:** RatingCapture, UpdateTabTitle, SessionAutoName

---

## Unified Event System

Alongside existing filesystem state writes (algorithm-state JSON, PRDs, session-names.json, etc.), hooks can emit structured events to a single append-only JSONL log. This provides a unified observability layer without replacing any existing state management.

### Components

| File | Purpose |
|------|---------|
| `${PAI_DIR}/hooks/lib/event-types.ts` | TypeScript discriminated union of all PAI event types (22 interfaces covering algorithm, work, session, rating, learning, voice, PRD, doc, build, system, tab, hook error, and custom events) |
| `${PAI_DIR}/hooks/lib/event-emitter.ts` | `appendEvent()` utility that writes typed events to `${PAI_DIR}/MEMORY/STATE/events.jsonl` |

### Usage in Hooks

Hooks call `appendEvent()` as a secondary write **alongside** their existing state writes. The emitter is synchronous, fire-and-forget, and silently swallows errors so it never blocks or crashes a hook.

```typescript
import { appendEvent } from './lib/event-emitter';

// Inside an existing hook, AFTER the normal state write:
appendEvent({ type: 'work.created', source: 'PRDSync', slug: 'my-task' });
```

### Event Structure

Every event has a common base shape plus type-specific fields:
- `timestamp` (ISO 8601) -- auto-injected by `appendEvent()`
- `session_id` -- auto-injected from `CLAUDE_SESSION_ID` env
- `source` -- the hook or handler name that emitted the event
- `type` -- dot-separated topic (e.g., `algorithm.phase`, `work.created`, `voice.sent`, `rating.captured`)

Events use a dot-separated topic hierarchy for filtering. A `custom.*` escape hatch allows arbitrary extension without modifying the type system.

### Event Type Categories

| Category | Types | Emitting Hooks |
|----------|-------|----------------|
| `work.*` | created, completed | PRDSync, SessionCleanup |
| `session.*` | named, completed | SessionCleanup |
| `rating.*` | captured | RatingCapture |
| `learning.*` | captured | WorkCompletionLearning |
| `prd.*` | synced | PRDSync |
| `doc.*` | integrity | DocIntegrity |
| `build.*` | rebuild | BuildCLAUDE (SessionStart handler) |
| `system.*` | integrity | IntegrityCheck |
| `settings.*` | counts_updated | UpdateCounts |
| `tab.*` | updated | TabState, UpdateTabTitle |
| `hook.*` | error | Any hook (error reporting) |
| `custom.*` | user-defined | Extensibility escape hatch |

### Consuming Events

```bash
# Live tail (real-time monitoring)
tail -f ~/.claude/MEMORY/STATE/events.jsonl | jq

# Filter by type
tail -f ~/.claude/MEMORY/STATE/events.jsonl | jq 'select(.type | startswith("algorithm."))'

# Programmatic (Node/Bun fs.watch)
import { watch } from 'fs';
import { getEventsPath } from './hooks/lib/event-emitter';
watch(getEventsPath(), (eventType) => { /* read new lines */ });
```

### Key Principles

- **Additive only** -- events supplement existing state files, they never replace them
- **Append-only** -- `events.jsonl` is an immutable log, never rewritten or truncated by hooks
- **Graceful failure** -- write errors are swallowed; events are observability, not critical path
- **One file** -- all event types go to a single `events.jsonl` for simple tailing and watching

---

**Last Updated:** 2026-02-25
**Status:** Production - 15 hooks emitting 22 event types across 14 categories
**Maintainer:** PAI System
