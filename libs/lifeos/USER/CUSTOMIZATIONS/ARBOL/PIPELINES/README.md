---
provenance: template
---

# PIPELINES

**Purpose:** Sequential processing chains that compose actions into linear workflows where the output of one action feeds directly into the next.

**What lives here:** A `pipeline-index.json` registry plus one yaml file per pipeline. Each pipeline declares an ordered list of actions and the input/output contract between them. Pipelines are deliberately simpler than FLOWS — no branching, no conditionals, no parallel fan-out. If the work is "do A, then B, then C," a pipeline is the right shape.

**How it gets populated:** By the user explicitly, or by skills that ship their own pipeline definitions. Add a pipeline by dropping a yaml file in this dir and registering it in `pipeline-index.json`.

**Sample state for fresh installs:** Empty / Just this README. Real content appears as you use LifeOS.
