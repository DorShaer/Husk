# Fishbone Workflow — RootCauseAnalysis

## Purpose

Construct a **fishbone (Ishikawa) diagram** — a cause-and-effect map that organizes contributing factors into named categories. Unlike 5 Whys, which follows a single linear chain, Fishbone is deliberately **breadth-first**: it forces you to consider all categories of cause before drilling down.

Best tool when multiple stakeholders contribute domain knowledge, the problem plausibly has causes in more than one category, or you need a structured brainstorm before narrowing.

## Invocation

- "Fishbone," "Ishikawa," "cause-and-effect diagram"
- "What are all the things that could contribute to this?"
- Multiple stakeholders need to contribute
- Before running 5 Whys — to avoid fixating on one cause category prematurely
- Quality / defect investigation where the failure mode could come from several sources

## The Structure

```
                  People              Process             Material
                     │                   │                   │
               ┌─────┴─────┐       ┌─────┴─────┐       ┌─────┴─────┐
               │           │       │           │       │           │
               │           │       │           │       │           │
        ─ ─ ─ ─┴─ ─ ─ ─ ─ ─┴─ ─ ─ ─┴─ ─ ─ ─ ─ ─┴─ ─ ─ ─┴─ ─ ─ ─ ─ ─┼─ ─ ─ ─ ▶ PROBLEM
                                                                    │
               │           │       │           │       │           │
               │           │       │           │       │           │
               └─────┬─────┘       └─────┬─────┘       └─────┬─────┘
                     │                   │                   │
                  Machine           Measurement         Environment
```

Problem at the "head" (right). Categories as major "bones." Specific causes as sub-bones within each category.

## Choosing a Category Set

Ishikawa himself recommended **adapting categories to context**. Standard sets:

### 6 M's — Manufacturing / Technical Systems (default for software)

| Category | Covers |
|----------|--------|
| **Manpower (People)** | Skills, training, experience, fatigue, motivation, staffing levels |
| **Machine (Equipment)** | Hardware, software, tooling, calibration, version, configuration |
| **Method (Process)** | Procedures, workflows, instructions, algorithms, runbooks |
| **Material** | Inputs, dependencies, third-party libraries, data quality |
| **Measurement** | Metrics, monitoring, testing, instrumentation accuracy |
| **Mother Nature (Environment)** | Network conditions, load, ambient variables, seasonal effects |

### 4 P's — Service / Customer-Facing Industries

| Category | Covers |
|----------|--------|
| **People** | Staff, customers, stakeholders |
| **Process** | Workflows, procedures, SLAs |
| **Policies** | Rules, standards, governance |
| **Procedures** | Specific runbooks, scripts |

### 8 M's — Extended Manufacturing

6 M's + **Management** (decisions, priorities, resource allocation) + **Maintenance** (upkeep, patching, lifecycle)

### 8 P's — Business / Marketing Strategy

Product/Service, Price, Place, Promotion, People, Process, Physical Evidence, Partners

**For software incidents**, 6 M's is almost always the right starting point. Adapt if the problem is clearly not fitting (e.g., pure process failure → use 4 P's).

## Execution

### Step 1: Write the Problem Statement

Place at the head of the fish. Must be measurable and specific.

```
PROBLEM: [Precise, observable statement]
```

### Step 2: Select Category Set

Based on problem type. Document the choice in output.

### Step 3: Brainstorm Causes Within Each Category

**Rules:**
- **No evaluation during brainstorm.** Every candidate is captured.
- **Multiple stakeholders contribute.** Different expertise surfaces different categories.
- **Use sticky notes / whiteboard.** Visual helps.
- **Empty category is a signal.** If People has zero causes, either this isn't a People problem or you need different experts in the room.

For each category, ask:
- What in this category could have contributed?
- What is unusual, stressed, or recently changed in this category?
- What would need to be true for this category to be a cause?

### Step 4: Develop Sub-Bones (Nested 5 Whys)

For each cause, ask "Why does this happen?" 2-3 times. This is where **5 Whys nests inside Fishbone** — each category branch gets its own small Whys chain.

```
Category: Process
  ├─ Cause: Deploy runbook missing
  │    └─ Why: Template predates current architecture
  │         └─ Why: No owner for runbook maintenance
  ├─ Cause: Rollback procedure untested
  │    └─ Why: Never run in prod
  │         └─ Why: Fear of causing secondary incident
```

### Step 5: Prioritize Using Pareto

Not all identified causes matter equally. Apply Pareto analysis:

1. **Quantify** each cause — frequency from incident history, estimated impact, or expert estimate.
2. **Sort descending** by quantity.
3. **Calculate cumulative percentage.**
4. **Identify the vital few** (typically top 3-5 causes that account for 80% of impact).
5. Focus remediation on the vital few; park the rest.

**Critical:** Pareto identifies *which* causes to focus on; it does not tell you *why* those causes occur. Always follow with 5 Whys depth on the vital few.

### Step 6: Verify the Top Causes

**Do not assume causation.** For each vital-few cause, plan verification:

```
CAUSE: [description]
VERIFICATION PLAN: [how we'll test whether this is actually a contributing cause]
- Evidence needed: [data/observation required]
- Test: [experiment or historical query]
- Expected outcome if cause is real: [prediction]
```

## Output Format

```
🐟 FISHBONE ANALYSIS: [problem]

PROBLEM: [precise statement]
CATEGORY SET: [6M / 4P / 8M / 8P / custom]

CAUSE MAP:

People:
- [Cause A1]
  └─ Why: [depth]
- [Cause A2]

Machine:
- [Cause B1]
- [Cause B2]

Method:
- [Cause C1]
  └─ Why: [depth]
    └─ Why: [depth]

Material:
- [Cause D1]

Measurement:
- [Cause E1]

Environment:
- [Cause F1]

PARETO (top causes by impact):
| Cause | Impact | Cumulative % |
|-------|--------|--------------|
| [C1]  | 45%    | 45%          |
| [B2]  | 25%    | 70%          |
| [A1]  | 15%    | 85%          |  ← 80% threshold above this line
| [D1]  | 10%    | 95%          |
| ...   | ...    | ...          |

VITAL FEW (primary focus):
1. [Cause] — verification plan: [...]
2. [Cause] — verification plan: [...]
3. [Cause] — verification plan: [...]

CORRECTIVE ACTIONS: [after verification, each verified cause gets an action]
```

## Worked Example — Elevated p99 Latency Post-Deploy

```
PROBLEM: Checkout service p99 latency spiked from 200ms to 3,200ms after deploy on 2026-04-10.

CATEGORY SET: 6 M's

CAUSE MAP:

Manpower (People):
- Deploying engineer was new to this service; unfamiliar with async-only pattern
- Reviewer approved the PR without running benchmarks

Machine:
- Instance type selected in Terraform was t3.small (underpowered for new workload)
- Connection pool sized for previous traffic pattern

Method:
- No canary release process — 100% of traffic shifted at once
- No pre-deploy performance smoke test

Material:
- New dependency introduced a synchronous external API call (was async in prior version)
- Shared library version upgraded; deprecated async API

Measurement:
- Percentile latency not in pre-deploy runbook check (only mean latency)
- No alert on p99 deviation during rollout

Environment:
- Deploy occurred during peak traffic window (14:00 UTC)
- External dependency had elevated latency that day (not factored in)

PARETO:
| Cause | Est. impact | Cumulative |
|-------|-------------|------------|
| Synchronous external call (Material) | 65% | 65% |
| No canary (Method) | 15% | 80% |
| t3.small instance (Machine) | 10% | 90% |
| Peak deploy window (Environment) | 5% | 95% |
| Others | 5% | 100% |

VITAL FEW:
1. Synchronous external call — verification: review diff; run local benchmark comparing sync vs. async
2. No canary process — verification: historical: have past full-traffic deploys also spiked?
3. Instance type — verification: redeploy to t3.medium; compare

CORRECTIVE ACTIONS:
- Convert external call back to async — owner: checkout — deadline: Apr 15
- Implement canary (10% → 50% → 100% with p99 gate) — owner: platform — deadline: Apr 30
- Instance sizing in Terraform per-service review — owner: infra — deadline: May 5
```

## Common Mistakes

- **Forcing causes into categories.** If a cause doesn't fit any category, consider adding a new one — don't distort the cause.
- **Empty categories ignored.** An empty category often means you need a different expert. Don't just move on.
- **Pareto skipped.** Without prioritization, you try to fix everything and fix nothing.
- **Verification skipped.** A cause on the diagram is a hypothesis, not a conclusion. Test the top candidates before committing to remediation.
- **Category choice wrong.** 6 M's for a pure policy problem produces a distorted diagram. Pick (or adapt) the right categories.
- **Single-session work.** For complex incidents, the initial fishbone is draft 1. New evidence in subsequent sessions often reshapes the diagram.

## Integration

- **5 Whys nests inside** — each sub-bone can become its own 5 Whys chain
- **Pareto nests inside** — quantitative prioritization step
- **Postmortem wraps Fishbone** — Postmortem uses Fishbone for the "contributing factors" section
- **Feeds SystemsThinking** — if multiple fishbone causes point to structural issues, escalate to Iceberg

## Attribution

Kaoru Ishikawa, first used at Kawasaki Steel Works (1943), formally presented 1945, codified in *Guide to Quality Control* (JUSE Press, 1968) as one of the seven basic quality tools. Category-set variants from American Society for Quality (ASQ) training literature and AIAG manufacturing standards.
