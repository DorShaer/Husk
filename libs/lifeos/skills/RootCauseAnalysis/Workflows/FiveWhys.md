# FiveWhys Workflow — RootCauseAnalysis

## Purpose

Walk a causal chain from symptom to systemic cause by repeatedly asking "Why?" The goal is not five questions — it is reaching an **actionable systemic cause**, which usually requires 4-7 iterations with at least one branch.

Originated with Sakichi Toyoda in the 1930s and embedded in the Toyota Production System by Taiichi Ohno as "the basis of Toyota's scientific approach." Simple, fast, low-overhead. Best first tool for most incidents.

## Invocation

- "5 whys," "five whys," "do a 5 whys"
- Single-thread incident with known-proximate cause
- Quick operational triage when time is short
- As a sub-step inside Fishbone (each category bone gets a 5 Whys)

## Method

Ask "Why?" down the causal chain until you reach an actionable systemic cause. The `Output Format` below is the deliverable shape — WHY 1..N, branches, root cause(s), corrective actions, forward-read validation. Four rules govern where the chain starts, forks, and stops:

**Problem statement — specific, observable, measurable.** A vague statement produces a vague chain.
- Bad: "Reliability is down."
- Good: "The payments service returned HTTP 500 for 14 minutes starting 2026-04-12 23:51 UTC, affecting 3,412 user checkouts."

**Stop condition — actionable AND systemic, both required.** One without the other means keep going.
- Actionable but not systemic ("patch this specific line") → stopped too shallow.
- Systemic but not actionable ("humans make mistakes") → went too deep, back up one level.

**Branch where the chain forks.** A perfectly linear 5 Whys is the most common failure mode — it usually means you took the most obvious answer and ignored the others. At each "Why?", check for multiple valid answers and record both branches. **Converging branches that share a common ancestor mark a high-leverage systemic cause: one fix closes multiple failure paths.**

**Validate by reading forward.** Read bottom-to-top as "Because X, therefore Y, ..., therefore problem." If the forward read doesn't hold, there's a logical jump — fix it before concluding.

**Optional — Five Hows.** After the root cause, apply "How do we prevent this?" five times to the fix, so the solution is as rigorous as the diagnosis.

## Output Format

```
🔍 5 WHYS ANALYSIS: [problem, 12 words]

PROBLEM: [precise statement]

CHAIN:
- WHY 1: [cause]
- WHY 2: [cause of WHY 1]
- WHY 3: [cause of WHY 2]
- WHY 4: [cause of WHY 3]
- WHY 5: [cause of WHY 4 — root]

BRANCHES: [if any]
- At WHY N:
  ├─ Branch A: ...
  └─ Branch B: ...

ROOT CAUSE(S): [systemic, actionable]
- [Cause 1]
- [Cause 2]  ← if branches converged

CORRECTIVE ACTIONS:
- [Specific action — owner — deadline]
- [Specific action — owner — deadline]

VALIDATION (read forward):
Because [root], therefore [WHY 4], therefore [WHY 3], ..., therefore [problem].
```

## Worked Example — Software Incident

```
PROBLEM: Production API returned HTTP 500 on 1,200 requests during 2026-04-12 14:00-14:14 UTC.

CHAIN:
- WHY 1: The payments database connection pool was exhausted.
- WHY 2: Query execution time spiked from 40ms p99 to 3,800ms p99.
- WHY 3: Queries were doing a full table scan on orders table.
- WHY 4: Missing index on `(customer_id, created_at)` — a frequently-joined column pair.
- WHY 5: Schema migration that added the new join pattern shipped without creating the index.
- (WHY 6 would be):  Migration PR template did not require EXPLAIN ANALYZE on new query patterns.

ROOT CAUSE: Migration review process has no query-plan analysis step.

CORRECTIVE ACTIONS:
- Add `EXPLAIN ANALYZE` output to migration PR template — owner: platform — deadline: Apr 18
- Backfill missing index now — owner: payments oncall — deadline: today
- Add runtime query-plan monitoring with alerting on new full scans — owner: observability — deadline: Apr 25

VALIDATION: Because migrations don't require query plans, the index was missed, which caused full scans, which spiked query time, which exhausted the pool, which returned 500s.
```

## Common Mistakes

- **Stopping at blame.** If the chain ends at "engineer made a mistake," ask one more why. Systems allow mistakes; root cause is in the system.
- **Skipping levels.** Jumping from symptom to a distant conclusion ("deploys are bad!") sounds deep but skips mechanism. Each "why" must be the *direct* cause of the one above it.
- **Single-chain bias.** Most real incidents branch. A perfectly linear 5 Whys is suspicious — it usually means you picked the most obvious branch and ignored others.
- **Stopping at "that's just how it is."** If the answer doesn't suggest an action, it's not the root cause.
- **Hindsight bias.** You know the outcome. The engineer didn't. Ask "what would this person have reasonably believed at this moment?" not "why didn't they see it?"
- **Generating corrective actions that rely on human vigilance.** "Train people harder" / "remind everyone" are the weakest actions. Prefer automation, checks, or process changes that make the failure hard to repeat.

## When NOT to Use 5 Whys

- **Safety-critical systems.** Use Fault Tree Analysis; 5 Whys cannot give probability estimates.
- **Complex distributed systems with crossing service boundaries.** Use Apollo/RealityCharting or Fishbone + Postmortem. Single-thread assumption breaks down.
- **Subtle "works here but not there" defects.** Use Kepner-Tregoe IS/IS-NOT.
- **When you don't have the domain knowledge.** The method cannot go deeper than the investigator's knowledge. Get experts in the room, or switch to Fishbone where multiple experts contribute.

## Integration

- **Nests inside Fishbone** — each major category bone gets its own 5 Whys for depth
- **Nests inside Postmortem** — the "causes" section of a postmortem usually uses 5 Whys internally
- **Feeds SystemsThinking/Iceberg** — if the chain keeps branching into structural causes, escalate to Iceberg analysis

## Attribution

Sakichi Toyoda (1930s, Toyota Industries). Formalized in Taiichi Ohno's *Toyota Production System: Beyond Large-Scale Production* (1988). Teruyuki Minoura's critiques on single-chain bias are canonical limits. "Five Hows" variant from lean manufacturing practice.
