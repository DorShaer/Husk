# FaultTree Workflow — RootCauseAnalysis

## Purpose

Construct a **Fault Tree Analysis (FTA)** — a top-down, deductive, Boolean-logic diagram that decomposes an undesired top event into its contributing events using logic gates. Developed at Bell Laboratories in 1961 for the Minuteman missile program; standardized in IEC 61025, NRC NUREG-0492 (nuclear), SAE ARP4761 (aerospace).

Unlike 5 Whys (linear) or Fishbone (categorical), FTA captures **Boolean structure**: which combinations of events *must* occur for the top event to happen. The key insight: incidents rarely have one cause; they have **minimal cut sets** — the smallest sets of basic events whose joint occurrence produces the top event.

## Invocation

- "Fault tree," "FTA," "fault tree analysis"
- Safety-critical or security-critical system
- Complex multi-path failure where multiple defenses could each have prevented it
- Need quantitative probability estimate for a failure mode
- Systems with redundancy — need to reason about which defense combinations must all fail

**Not for:** fast operational triage. FTA is thorough but time-intensive; construction typically 2-8 hours.

## The Structure

```
                       [ TOP EVENT ]
                            │
                          (Gate)
                   ┌────────┼────────┐
                   │        │        │
              [Event A] [Event B] [Event C]
                   │
                 (Gate)
              ┌────┴────┐
              │         │
         [Basic 1]  [Basic 2]
```

**Terminology:**
- **Top event** — the undesired outcome at the root of the tree
- **Intermediate events** — internal nodes, decomposed further
- **Basic events** — leaf nodes; cannot or need not be decomposed further; have assignable probabilities
- **Gates** — Boolean operators between levels

## The Logic Gates

### OR Gate

**Symbol:** Shape resembling a plus / pointed top.

**Semantics:** Top event occurs if **any** input occurs.

```
Top
 │
(OR)
 ├── A
 ├── B
 └── C

Top occurs if A OR B OR C.
```

**Meaning:** Each input alone is sufficient. **No redundancy.** Models single-point-of-failure structures.

### AND Gate

**Symbol:** Flat-bottom, rounded top.

**Semantics:** Top event occurs only if **all** inputs occur (usually simultaneously).

```
Top
 │
(AND)
 ├── A
 ├── B
 └── C

Top occurs only if A AND B AND C (all three).
```

**Meaning:** All defenses must fail. **Defense-in-depth.** Models redundant protection.

### Priority AND Gate

**Semantics:** All inputs must occur **in a specific sequence**. Order matters.

Useful when "A before B causes the problem" but "B before A does not."

### Inhibit Gate

**Semantics:** Output occurs only if input occurs AND a **conditioning event** is present.

Models conditional failures — a failure mode that's only exposed under certain conditions.

### Exclusive OR

Rare in FTA — used when top event occurs if exactly one (but not both) of two inputs occurs.

## Execution

### Step 1: Define the Top Event Precisely

The top event must be **specific, observable, and measurable**. Vague top events produce incoherent trees.

```
TOP EVENT: [specific undesired outcome]
```

Good: "User's payment is charged but order is not recorded."
Bad: "Payment problems."

### Step 2: Identify Immediate Causes and Logic

For the top event, ask: "What direct causes produce this event, and in what logical combination?"

- Are all causes necessary together? → **AND**
- Is any one cause sufficient alone? → **OR**
- Is there a priority sequence? → **Priority AND**
- Is there a conditioning factor? → **Inhibit**

Draw the gate and its inputs. Do not decompose further yet — just one level deep.

### Step 3: Recursive Decomposition

For each non-basic intermediate event, repeat Step 2. Ask: what causes *this* event?

Continue until every leaf is a **basic event**:
- A basic event has a known or estimable probability
- OR a basic event is at the appropriate level of abstraction for this analysis

**Stop conditions for a branch:**
- Reach a physical component failure with a known probability
- Reach a human error with a statistical rate
- Reach a condition outside the system boundary (environmental, supply chain)
- Reach a level where further decomposition adds no analytical value

### Step 4: Identify Minimal Cut Sets

A **cut set** is a set of basic events whose joint occurrence causes the top event. A **minimal cut set** is a cut set from which no member can be removed without breaking the causation.

**Why it matters:** Minimal cut sets identify the smallest combinations of failures that cause the top event. A system with many 1-event cut sets is fragile. A system with all cut sets containing 3+ events has strong defense-in-depth.

**How to find them** (for small trees, by hand):
- Under an OR gate, each input generates its own cut sets
- Under an AND gate, combine cut sets from each input (Cartesian product)
- For large trees, use MOCUS algorithm or FTA software

### Step 5: Quantitative Analysis (if probabilities available)

For each basic event, assign a probability P(event). Propagate upward using Boolean algebra:

- **OR gate:** P(output) = 1 - ∏(1 - P(input_i))
  (Approximate for small probabilities: P(output) ≈ Σ P(input_i))
- **AND gate:** P(output) = ∏ P(input_i)  (assuming independence)

**Critical caveat:** Boolean propagation assumes statistical **independence** of basic events. In real systems, events are often correlated (common-mode failures). When events share a root cause, they are not independent, and the AND gate is far more probable than ∏ suggests. Flag common-mode possibilities explicitly.

### Step 6: Prioritize Mitigation

For each minimal cut set:
- Quantify: what is P(cut set)?
- Rank: which cut sets have highest probability?
- Identify leverage: can any single basic event within the cut set be dramatically reduced?

**Key insight:** Eliminating one basic event from a 3-event cut set *collapses* its probability dramatically. Focus mitigation on the cheapest-to-eliminate basic event within the highest-probability cut set.

## Output Format

```
🌲 FAULT TREE ANALYSIS: [top event]

TOP EVENT: [...]

TREE:
  [Top]
    │
   (OR)
    ├── Intermediate A
    │     │
    │    (AND)
    │     ├── Basic 1  (P = 0.01)
    │     └── Basic 2  (P = 0.05)
    │
    ├── Intermediate B
    │     │
    │    (OR)
    │     ├── Basic 3  (P = 0.02)
    │     └── Basic 4  (P = 0.03)
    │
    └── Basic 5 (P = 0.001)

MINIMAL CUT SETS:
1. {Basic 1, Basic 2} — P = 5.0e-4
2. {Basic 3} — P = 0.02
3. {Basic 4} — P = 0.03
4. {Basic 5} — P = 1.0e-3

TOP EVENT PROBABILITY (approx): ~0.054 per event exposure

PRIORITY MITIGATION:
1. Basic 4 — highest single-event cut set; eliminate or reduce
2. Basic 3 — second-highest single; same logic
3. {Basic 1, Basic 2} — 2-event AND, acceptable if independence holds
   ⚠ Common-mode check: are 1 and 2 truly independent?

COMMON-MODE FAILURES (flagged):
- [Potential correlated failure between events, explained]

RECOMMENDED ACTIONS:
- Eliminate single-event cut sets first
- Harden against common-mode failures
- Add defenses that raise smallest cut-set size
```

## Worked Example — Payment Processing Unavailable

```
TOP EVENT: User payment processing unavailable for > 60 seconds.

TREE:
  [Payment unavailable]
     │
    (OR)
     ├── API gateway failure
     │     │
     │    (OR)
     │     ├── Gateway service down (P=0.0001)
     │     └── DNS resolution failure (P=0.00001)
     │
     ├── Payment service failure
     │     │
     │    (OR)
     │     ├── Service crash (P=0.0005)
     │     └── Config pushed wrong (P=0.0001)
     │
     └── Database unavailable
           │
          (AND)
           ├── Primary DB failure (P=0.001)
           ├── Replica promotion failure (P=0.01)
           └── Manual intervention not executed in SLA (P=0.1)

MINIMAL CUT SETS:
1. {Gateway service down} — P = 1.0e-4
2. {DNS resolution failure} — P = 1.0e-5
3. {Service crash} — P = 5.0e-4
4. {Config pushed wrong} — P = 1.0e-4
5. {Primary DB, Replica promotion, Manual intervention} — P = 1.0e-6

INSIGHT:
- The AND gate on DB failure collapses its probability to 1e-6 (defense-in-depth working)
- The OR gates on API gateway and payment service are weak (1-event cut sets)
- Payment service crash is the single highest-probability cut set (P = 5e-4)

PRIORITY:
1. Reduce P(payment service crash) — add crash watchdog, faster restart, circuit breaker
2. Reduce P(gateway service down) — redundant gateway instances
3. Replica promotion failure is high (P=0.01) — improve promotion automation, but AND gate makes this lower priority
```

## Common Mistakes

- **Confusing OR with AND.** OR = single point of failure; AND = defense-in-depth. Getting this wrong inverts the analysis.
- **Assuming independence.** Real failures have common modes — shared deploys, shared dependencies, shared power. An AND gate is only as strong as its independence assumption.
- **Decomposing too deep.** "Electron did the wrong thing" is not a useful basic event. Stop at components with known failure rates.
- **Using FTA for non-quantitative problems.** If you have no probability data, the quantitative benefit is lost; 5 Whys or Fishbone may suffice.
- **Neglecting human-error basic events.** Software FTA often skips human errors (deploy mistakes, misconfigurations) — these are frequently the largest basic-event probabilities.
- **Static tree.** FTA must be updated as the system changes. An old tree analyzing an old architecture is misleading.

## When to Use FTA

| Use FTA when... | Use alternative when... |
|-----------------|--------------------------|
| Safety- or security-critical | Everyday operational issue |
| Probability estimates needed | Qualitative understanding sufficient |
| Complex multi-path failures | Single-thread failures |
| Redundant defenses exist | No redundancy — OR gate dominates |
| Time permits (hours-days) | Triage (minutes) |

## Tool Support

For non-trivial trees, use dedicated FTA software:
- **SAPHIRE** (free, NRC-distributed) — nuclear/aerospace
- **FaultTree+** (commercial) — engineering
- **EC FTA** (open source) — research
- **Graphviz/d2/Mermaid** — sketching only; no cut set calculation

For simple trees (< 20 basic events), manual analysis is feasible.

## Integration

- **Entry from Postmortem** — when the incident has redundant defenses that all failed
- **Pairs with FMEA** — FMEA enumerates failure modes; FTA traces consequences
- **Feeds SystemsThinking** — if common-mode failures keep appearing, the structure is generating them; escalate to CausalLoop / Archetypes

## Attribution

H.A. Watson, Bell Telephone Laboratories (1961), original FTA development for U.S. Air Force Minuteman program. Formalized in IEC 61025 (*Fault tree analysis*), NRC NUREG-0492, SAE ARP4761 (aerospace safety). Canonical modern reference: W.E. Vesely et al., *Fault Tree Handbook* (NUREG-0492, NRC, 1981).
