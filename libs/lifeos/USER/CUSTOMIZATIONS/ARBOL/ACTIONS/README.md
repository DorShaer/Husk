---
provenance: template
---

# ACTIONS

**Purpose:** Reusable action modules — atomic units of work that LifeOS pipelines and flows compose into larger workflows.

**What lives here:** Each action is a self-contained subdir (typically `A_<NAME>/` or grouped under category folders like `extract/`, `format/`, `transform/`) holding an `action.json` manifest and an `action.ts` implementation. Actions take input, perform a single operation, and return output — no side channels, no shared state. Keeping them small and composable is the entire point.

**How it gets populated:** By the user explicitly. You build actions when you need a piece of logic that two or more flows or pipelines will reuse, or when you want one well-tested unit instead of inline code repeated across skills.

**Sample state for fresh installs:** Empty / Just this README. Real content appears as you use LifeOS.
