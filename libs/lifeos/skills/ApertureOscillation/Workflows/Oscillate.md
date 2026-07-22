# Oscillate Workflow — Aperture Oscillation

## Purpose

Answer one question at two scope levels — narrow (component-first) and wide (system-first) — then output where the two answers diverge. The divergence is the deliverable: design tensions, a scope recommendation, and a coherence verdict that neither scope surfaces alone.

## Invocation

1. **Directly** by the user: "use aperture oscillation on this", "oscillate scope on this"
2. **By the Algorithm** during OBSERVE or THINK when ApertureOscillation capability is selected
3. **By other skills** that need scope-coherence analysis before committing to an approach

## Inputs

- **Tactical Target:** The specific thing being built, designed, or decided. The narrow, concrete question.
- **Strategic Context:** The bigger-picture goal, system vision, or purpose the tactical target serves.
- **Current State (optional):** Any existing ISC criteria, approach decisions, or constraints already established.

If invoked without explicit inputs, extract them from the conversation: tactical = the specific ask being worked on; strategic = the broader goal, system, or vision in context (CLAUDE.md, TELOS, project context).

If the tactical target and strategic context are essentially the same thing (no meaningful scope difference), abort and recommend IterativeDepth instead.

## What a done oscillation looks like

The output must exhibit three properties:

1. **A narrow answer** to the question with the component as primary and the system as background — capturing what the thing naturally wants to be: its own logic, patterns, conventions, interfaces, and what a good implementation looks like in isolation.

2. **A wide answer** to the *same* question with the system as primary and the component derived from it — capturing what the system needs from the component: coherence with adjacent pieces, alignment demands, and constraints the bigger picture imposes that local thinking misses.

3. **A synthesis** that names every point where the two answers diverge, gives each divergence a resolution, and ends on a coherence verdict (ALIGNED or DIVERGENT). If the two answers agree, "no divergence" is itself the finding — state it; it means tactical and strategic are already coherent.

The two passes must genuinely differ in what they treat as primary — a wide answer that just restates the narrow one means the scope shift didn't happen. Push each framing until it produces something the other wouldn't.

## Output

Frame both inputs, then report results in this shape:

```
🔭 APERTURE OSCILLATION
 🎯 Tactical Target: [the specific thing — 1-2 sentences]
 🌐 Strategic Context: [the bigger picture — 1-2 sentences]

── Narrow (component-first) ──
[what the component wants to be, on its own logic]

── Wide (system-first) ──
[what the system needs the component to be]

── Synthesis ──
Divergences: [each point where narrow and wide disagree]

⚡ DESIGN TENSIONS:
[each tension + resolution recommendation]

📋 ISC IMPLICATIONS:
[new / refined / anti- criteria surfaced by the oscillation]

Coherence: [ALIGNED | DIVERGENT — one-line verdict]
💡 Key Insight: [the most important thing single-scope analysis would have missed]
```

## Integration with Algorithm Phases

When the Algorithm selects ApertureOscillation, it runs at one of two integration points:

- **During OBSERVE (before ISC):** tactical target = the user's request, strategic context = project/TELOS/conversation context. Surfaces design tensions before ISC criteria are written, so the criteria are informed by the scope oscillation.
- **During THINK (before approach commitment):** tactical target = the proposed approach, strategic context = broader system/project goals. Validates that the approach serves both local and system needs before it's committed.

## Combining with IterativeDepth

Complementary, not competing:

- **IterativeDepth first** — understand the problem from multiple analytical angles.
- **ApertureOscillation second** — validate that the proposed solution serves both local and system needs.

At Deep (E4) or Comprehensive (E5) effort, using both in sequence produces the richest requirement set: IterativeDepth discovers the full problem space, ApertureOscillation ensures the solution fits the system.

## Agent Mode (for Algorithm delegation)

When spawning an agent to run ApertureOscillation, brief it with the two inputs and the done-definition above:

```
CONTEXT: Perform Aperture Oscillation — answer one question at two scope
levels to surface design tensions between local component logic and
system-level coherence.

TACTICAL TARGET: {specific thing being built}
STRATEGIC CONTEXT: {bigger-picture goal or system vision}

DELIVERABLE: a narrow (component-first) answer, a wide (system-first) answer
to the same question, and a synthesis naming every divergence with a
resolution and a coherence verdict (ALIGNED | DIVERGENT). Report design
tensions and ISC implications.
SLA: Complete within 45 seconds.
```
