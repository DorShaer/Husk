---
provenance: template
---

# FLOWS

**Purpose:** Branching workflow definitions that compose actions into processing graphs with conditional routing, parallel execution, and error handling.

**What lives here:** A `flow-index.json` registry plus one yaml file per flow. Each flow describes the directed graph of actions, the routing conditions between them, where parallel branches fan out and join, and how failures propagate. Flows are the right tool when a workflow needs decisions, retries, or concurrent steps; reach for PIPELINES when the work is purely linear.

**How it gets populated:** By the user explicitly, or by skills that ship their own flow definitions. New flows are added by dropping a yaml file in this dir and registering it in `flow-index.json`.

**Sample state for fresh installs:** Empty / Just this README. Real content appears as you use LifeOS.
