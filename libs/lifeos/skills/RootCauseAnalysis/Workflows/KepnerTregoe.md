# KepnerTregoe Workflow — RootCauseAnalysis

## Purpose

Identify the cause of a **deviation** — something that was working and stopped, or something that works in one context but not another — by rigorously specifying what IS the problem and what IS NOT, then finding the **distinction** and the **change**.

From Charles Kepner and Benjamin Tregoe, *The Rational Manager* (1965). The method was derived from behavioral research on how effective managers actually solve problems vs. how they *think* they solve them — particularly powerful for subtle, intermittent, or environment-specific defects.

## Core Principle

Every problem is a **deviation from expected performance**. Every deviation has a specific cause that *changed* something. The IS/IS-NOT framework surfaces that change by defining exactly where and when the deviation exists — and where it does not.

**The critical question:** what is **different** between where the problem exists and where it doesn't?

## Invocation

- "Kepner-Tregoe," "KT analysis," "IS/IS-NOT"
- "This works here but not there"
- "It failed this time but worked yesterday"
- Intermittent defects, environment-specific failures
- Defects where "we didn't change anything" (you did — find what)
- Hard-to-reproduce bugs

## The IS/IS-NOT Matrix

Four dimensions:

| Dimension | IS | IS NOT | Distinction | Change |
|-----------|----|----|------|--------|
| **What** | The specific thing that's wrong | Similar things that are fine | What makes the problem unique | What changed to produce that uniqueness |
| **Where** | The location / environment where it occurs | Similar locations where it doesn't | Geographical/environmental differentiator | What changed in that location |
| **When** | The times it happens | Times it doesn't | Temporal differentiator | What changed at/before that time |
| **Extent** | Magnitude / frequency / size | Comparative scale | Degree differentiator | What changed to alter degree |

## Execution

### Step 1: State the Deviation

```
DEVIATION: [what was expected vs. what is happening]
```

Example:
- Expected: p99 latency < 300ms in all regions.
- Actual: p99 latency = 2,500ms in us-east-1a only, after 18:00 UTC, for requests hitting service version 3.4.2.

### Step 2: Build the IS/IS-NOT Matrix

Fill the matrix methodically. **The IS NOT column is equally important as IS** — it defines the boundary of the problem.

Each cell should be specific and comparable to its opposite.

### Step 3: Identify Distinctions

For each dimension, ask: **what is different between IS and IS NOT?**

- What's different about *this* service vs. similar services that are fine?
- What's different about *this* region vs. others?
- What's different about *this* time vs. times it didn't happen?
- What's different about *this* extent vs. baseline?

Distinctions are features **unique to the problem's presence**. Non-distinctions (things that are the same in both IS and IS NOT columns) cannot be causes.

### Step 4: Identify Changes

For each distinction, ask: **what changed recently in this area?**

Changes are the mechanism by which the cause was introduced into the system.

Scope of "recently": usually the window between "last known good" and "first observed bad." Longer windows for slow-drift problems.

**Changes to look for:**
- Deploys, releases, configuration updates
- Schedule changes (cron jobs, batch processes)
- Environmental changes (load, weather, external dependencies)
- Personnel changes (new team member, shift change, vacation coverage)
- Data changes (schema migrations, new data volumes, new users)
- Hardware changes (instance type, network path, storage)
- Calendar events (month-end, quarter-end, holiday traffic)

### Step 5: Generate Possible Causes

For each change, ask: **how could this change have caused the observed deviation?**

A possible cause must have a plausible mechanism. "We changed X" is correlation; "X causes Y because mechanism" is a hypothesis.

### Step 6: Test Each Possible Cause

**A valid cause must:**
- Explain *all* entries in the IS column (why did it produce all these symptoms?)
- Be consistent with *all* entries in the IS NOT column (why didn't it affect these?)

**Eliminate causes that can't explain both sides.** A cause that explains IS but predicts problems in areas that are actually fine (IS NOT) is falsified.

This "explain both sides" test is the heart of KT. It is what distinguishes KT from weaker methods that accept the first plausible correlation.

### Step 7: Verify the Surviving Cause

Confirm the identified cause produces the problem when present and doesn't when absent. Ideally: revert the change in a test environment and observe recovery.

## Output Format

```
🔬 KEPNER-TREGOE ANALYSIS: [deviation]

DEVIATION:
- Expected: [...]
- Actual: [...]

IS/IS-NOT MATRIX:

| Dimension | IS | IS NOT | Distinction | Change |
|-----------|----|----|------|--------|
| What      | [specific]  | [similar OK] | [diff]      | [change in that area] |
| Where     | [location]  | [elsewhere OK] | [diff]      | [change in that location] |
| When      | [time]      | [other times OK] | [diff]   | [change at/before] |
| Extent    | [magnitude] | [baseline] | [diff]      | [change in scale] |

DISTINCTIONS:
- [D1]
- [D2]
- [D3]

CHANGES (candidates):
- [C1] — in area of [D1]
- [C2] — in area of [D2]

POSSIBLE CAUSES:
- [Cause A] — from change [C1] — mechanism: [...]
- [Cause B] — from change [C2] — mechanism: [...]

TESTING:
- Cause A:
  - Explains IS? ✓ / ✗ — [why]
  - Consistent with IS NOT? ✓ / ✗ — [why]
- Cause B: ...

SURVIVING CAUSE: [the one that explains all]
VERIFICATION PLAN: [how we'll confirm]
```

## Worked Example — Memory Spike

```
DEVIATION:
- Expected: Node.js service holds stable ~400MB heap across all pods.
- Actual: Some pods spike to 2.8GB heap after 18:00 UTC, leading to OOM kill.

IS/IS-NOT MATRIX:

| Dimension | IS                       | IS NOT                          | Distinction                        | Change                                |
|-----------|--------------------------|--------------------------------|------------------------------------|---------------------------------------|
| What      | Heap spike to 2.8GB      | Normal 400MB heap              | Memory grows unboundedly           | Nothing new globally                 |
| Where     | us-east-1a pods          | us-east-1b, us-west-2          | 1a only                            | 1a got rolling deploy first          |
| When      | After 18:00 UTC          | Before 18:00 UTC               | Evening only                       | 18:00 = peak session creation        |
| Extent    | 7x normal heap           | 1x                             | Unbounded growth, not step-up      | — |

DISTINCTIONS:
- D1: Affects only 1a, not other regions
- D2: Only after 18:00 UTC
- D3: Unbounded growth (leak pattern), not one-time jump

CHANGES:
- C1: Service deploy 3.4.2 rolled to 1a first (partial rollout, not yet in other regions)
- C2: 3.4.2 introduced an in-memory session cache
- C3: Session creation peaks at 18:00 UTC (normal daily pattern; not a change, but interacts with C2)

POSSIBLE CAUSES:
- Cause A: 3.4.2's in-memory session cache has no eviction policy; at peak session creation, entries accumulate faster than they expire.

TESTING:
- Cause A:
  - Explains IS What (unbounded heap): ✓ — cache grows without bound
  - Explains IS Where (1a only): ✓ — 3.4.2 only deployed to 1a so far
  - Explains IS When (after 18:00): ✓ — peak session creation overwhelms
  - Explains IS Extent (7x): ✓ — cache can grow arbitrarily large
  - Consistent with IS NOT Where (1b, us-west-2 fine): ✓ — still on 3.4.1, no cache
  - Consistent with IS NOT When (before 18:00 fine): ✓ — lower session rate, growth slower; OOM not yet reached
  - ✓ All consistent.

SURVIVING CAUSE: 3.4.2 introduces session cache without eviction; unbounded at peak load.

VERIFICATION: Pull heap dump from affected pod; expect to see session objects dominating. Check 3.4.2 diff for session cache implementation.

REMEDIATION:
- Immediate: rollback 3.4.2 in 1a
- Structural: add LRU eviction + max-size limit to session cache in 3.4.3
```

## Common Mistakes

- **Sloppy IS NOT column.** The IS NOT column defines the problem boundary. Empty or vague IS NOT = weak analysis.
- **Skipping the "consistent with IS NOT" test.** A cause that explains IS but predicts problems elsewhere that aren't happening is falsified. This test is the method's power.
- **Missing changes.** "Nothing changed" is always wrong in KT — something must have changed, or the deviation would not exist. Keep looking: deploys, cron jobs, data volume, schedule, personnel, external deps.
- **Stopping at first plausible cause.** Test against all dimensions of IS/IS-NOT. Premature conclusions are common.
- **Environmental / temporal blind spots.** People look at deploys but miss schedule-based changes (batch jobs, cron, end-of-month processes). Always scan calendar-triggered changes.
- **Not verifying.** The surviving cause is a hypothesis until tested in reality. Plan verification before acting.

## When KT is the Right Tool

| Use KT when... | Don't use KT when... |
|----------------|----------------------|
| Problem is a *deviation* from known good | Problem is a novel system with no baseline |
| Intermittent / environment-specific | Consistent, reproducible, obvious |
| "Works here but not there" | Complete system failure |
| Subtle, where other methods guess wrong | Time-critical triage |
| You have both IS and IS NOT data | Cannot characterize where it doesn't happen |

## Integration

- **Entry from Postmortem** — when the incident is a deviation with unclear cause
- **Feeds 5 Whys** — once KT finds the change, 5 Whys can go deeper into *why that change wasn't caught*
- **Pairs with Fishbone** — if KT eliminates categories, Fishbone structures what remains
- **Pairs with Observability** — KT requires data about both IS and IS NOT. Poor observability → cannot run KT

## Attribution

Charles H. Kepner and Benjamin B. Tregoe, *The Rational Manager* (McGraw-Hill, 1965); updated *The New Rational Manager* (Princeton Research Press, 1981). Grounded in behavioral research on effective managerial problem-solving vs. self-reported problem-solving. The methodology remains the canonical framework for deviation-based troubleshooting in engineering and operations.
