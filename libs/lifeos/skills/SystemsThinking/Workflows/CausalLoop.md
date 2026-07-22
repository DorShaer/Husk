# CausalLoop Workflow — SystemsThinking

## Purpose

Build a **Causal Loop Diagram (CLD)** of the system in question — variables connected by arrows labeled with polarity, organized into **reinforcing (R)** and **balancing (B)** loops. The CLD makes the generators of behavior visible in a way prose cannot.

CLDs are the working language of system dynamics (Forrester, Meadows, Senge). They let you simulate second- and third-order effects before committing to an intervention.

## Invocation

Invoked for:
- Mapping the dynamics behind a recurring behavior (usually after Iceberg finds a structural generator)
- Previewing unintended consequences of a planned intervention
- Explaining why a counterintuitive dynamic occurs (growth stalls, quality decays, "fixes" fail)
- Any problem where multiple variables interact with delays

## Notation

```
  A  ──(+)──▶  B        A increases → B increases (same direction)
                         A decreases → B decreases

  A  ──(−)──▶  B        A increases → B decreases (opposite direction)
                         A decreases → B increases

  A  ═══(+/−)═══▶  B    Same as above but with a DELAY (drawn thicker or with ||)


  Loop labels:
  (R) Reinforcing — same-direction cycle, amplifies change, exponential
  (B) Balancing — opposite-direction cycle, goal-seeking, stabilizes
```

**Polarity test for arrows:**
- Change A. Does B change *in the same direction*? → **(+)**
- Change A. Does B change *in the opposite direction*? → **(−)**

**Loop-type test (count the minus signs):**
- Even number (including 0) of (−) arrows in the loop → **Reinforcing (R)**
- Odd number of (−) arrows in the loop → **Balancing (B)**

## Execution

A done CLD fills the output block below, built to answer one specific question. The probes and tests:

**Question.** Every CLD answers one specific question — without it the diagram sprawls. ("Why does release velocity plateau past a certain team size?" / "What happens if we double the rate limit?" / "Why does tech debt accelerate even though we pay some down each quarter?")

**Variables.** 5-15 quantities that can rise or fall over time. Nouns, not verbs ("Team size," not "Hiring"); directional; observable or inferable. Include soft variables — trust, morale, perceived urgency, customer satisfaction — dropping them only if they genuinely don't influence the dynamics, never because they're hard to measure. Fewer high-quality variables beat exhaustive lists.

**Arrows.** Direct causation only — no correlation, and draw A→C→B through C rather than as one arrow. Assign polarity (+/−) by the test above. Mark delays (═══ or ||) when the effect takes significantly longer than the system's rhythm. Every arrow needs a one-sentence mechanism — if you can't state it, the arrow is wrong.

**Loops.** Trace cycles back to their start; label R (even count of − arrows) or B (odd); give each a short name capturing the *dynamic*, not the variables ("Success-to-success," "Coordination tax," "Capacity drift"). Un-named loops are untracked.

**Dynamics.** Per loop: what does a reinforcing loop amplify, toward what limit; toward what goal does a balancing loop pull, and what sets the goal; where are the delays and what do they produce (oscillation, overshoot, slow response)? Name the dominant loop now and which will dominate as variables change — many behaviors flip (reinforcing early for growth, balancing later for limits: the "limits to growth" archetype).

**Intervention.** Simulate the change on the CLD before recommending it: directly affected variable → first-order downstream (via which arrows) → second-order (loops now pull differently) → third-order (new equilibrium after delays complete). Every non-trivial intervention triggers at least one balancing loop; if you can't find it, you haven't looked hard enough. Note side effects on untargeted variables.

## Output

```
🔄 CAUSAL LOOP DIAGRAM: [topic]

QUESTION: [what this CLD answers]

VARIABLES:
- [var1], [var2], [var3], ...

ARROWS (source → target, polarity, delay?):
- [A] →(+) [B]
- [B] →(−) [C] (delay)
- ...

LOOPS:
- R1 "Success-to-success": A → B → C → A (reinforcing)
  Dynamic: amplifies early wins, accelerates until limit
- B1 "Coordination tax": A → D → E → A (balancing)
  Dynamic: opposes growth, scales with team size

DOMINANT LOOP: [which is driving behavior now]
EMERGING DOMINANT LOOP: [which will dominate as system grows]

INTERVENTION ANALYSIS:
- Proposed: [X]
- Intended effect: [Y]
- Unintended: [which loop pushes back]
- Recommended: [attack the balancing loop directly, or accept tradeoff]
```

## Worked Example — Team Growth Paradox

```
QUESTION: Why does engineering velocity plateau past team size 12-15?

VARIABLES:
- Team size
- Output (features shipped/week)
- Hiring budget
- Pending features backlog
- Coordination cost per engineer
- Per-engineer output
- Onboarding load

ARROWS:
- Team size →(+) Total output
- Total output →(+) Revenue/success
- Revenue →(+) Hiring budget
- Hiring budget →(+) Team size  (delay: hiring pipeline)
- Pending features →(+) Hiring budget
- Team size →(+) Coordination cost per engineer
- Coordination cost →(−) Per-engineer output
- Per-engineer output →(+) Total output
- Team size →(+) Onboarding load
- Onboarding load →(−) Per-engineer output (delay: ramp-up period)

LOOPS:
- R1 "Success → hiring → output": Team size → Total output → Revenue → Hiring budget → Team size (reinforcing; drives growth)
- B1 "Coordination tax": Team size → Coordination cost → Per-engineer output → Total output → (pulls back against R1 via less hiring demand pressure)
- B2 "Onboarding drag": Team size → Onboarding load → Per-engineer output → Total output (balancing, delayed)

DOMINANT LOOP: R1 dominant early; B1 and B2 dominant once team > 12.

INTERVENTION ANALYSIS:
- Proposed: hire more engineers to ship more features.
- Intended: Total output ↑
- Unintended: Coordination cost ↑ faster than Total output; at some point Total output flat-lines or declines (policy resistance)
- Recommended: Don't attack R1 (slowing hiring just slows the dynamic). Attack B1 directly: invest in coordination mechanisms (async docs, modular architecture, team topology) that break the "team size → coordination cost" arrow.
```

This is Meadows' **"Limits to Growth"** archetype — see `FindArchetype` workflow for the canonical intervention template.

## CLD Conventions

- **Horizontal layout** when possible; feedback loops naturally form ovals
- **Reinforcing loops** often drawn with circular arrow symbol ↻ in center with "R"
- **Balancing loops** often drawn with "=" or scales symbol with "B"
- **Delays** drawn with double lines on the arrow ═══ or `||`
- **Exogenous variables** (outside the model) drawn without incoming arrows, in a distinct color/shape
- **Stocks** (accumulations) vs **Flows** (rates) — advanced stock-and-flow notation; use when the CLD underdetermines behavior

## Rendering via Art Skill

To render a CLD as an actual diagram:

```bash
# Use Art skill with Mermaid or diagram rendering
Skill("Art", "Mermaid flowchart showing causal loop diagram with R1 and B1 loops, variables: [list], arrows with polarity: [list]")
```

## Common Mistakes

- **Too many variables.** A 20-variable CLD is illegible. Start with 5-7; add only if the loops don't reproduce observed behavior.
- **Correlation drawn as causation.** Every arrow needs a mechanism. "They move together" isn't enough.
- **Missing delays.** Most "surprise" dynamics come from unacknowledged delays. When behavior oscillates or overshoots, look for a delay you didn't mark.
- **Drawing only reinforcing loops.** Real systems always have balancing loops somewhere. If your CLD has none, you've missed something.
- **Static snapshot, not dynamic.** The CLD is a generator of behavior over time, not a state diagram.
- **Confusing event causation with structural causation.** "The deploy caused the outage" is event-level; the CLD should show why the deploy *process* causes outages repeatedly.

## Integration

- Feeds **FindLeverage** — once the CLD is drawn, Meadows' leverage points apply (which variable, arrow, loop, or boundary gives the most leverage).
- Feeds **FindArchetype** — many CLDs match a named archetype; if so, use the canonical intervention.
- Called from **Iceberg** when Layer 3 structure is a feedback loop.
- Renderable via **Art** — Mermaid / diagram output.

## Attribution

Causal Loop Diagrams: Jay Forrester (*Industrial Dynamics*, 1961), Dennis Meadows et al. (*Limits to Growth*, 1972), Peter Senge (*The Fifth Discipline*, 1990). Modern reference: John Sterman, *Business Dynamics* (2000).
