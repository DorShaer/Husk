# Iceberg Workflow — SystemsThinking

## Purpose

Walk down from visible **events** to the **mental models** that produced them. Most analysis stops at the top layer; durable fixes live at the bottom two.

The Iceberg Model (popularized by Michael Goodman and the Academy for Systemic Change) asserts that 90% of what generates behavior is below the waterline. Treating symptoms leaves the generator intact, which is why "the same thing keeps happening."

## Invocation

This workflow is invoked:
1. **Directly by the user:** "iceberg this", "walk down the iceberg", "why does this keep happening"
2. **By the Algorithm** when OBSERVE capability scan selects SystemsThinking with a recurring-problem signal
3. **By the RootCauseAnalysis skill** — its Postmortem workflow hands off to Iceberg when patterns repeat across incidents

## The Four Layers

```
╱═══════════════════════════════════╲
│        LAYER 1: EVENTS            │  ← What happened? (visible, reactive)
╲═══════════════════════════════════╱
        │ "Why did this happen?"
        ▼
╱═══════════════════════════════════╲
│        LAYER 2: PATTERNS          │  ← What has happened over time?
╲═══════════════════════════════════╱
        │ "What's generating this pattern?"
        ▼
╱═══════════════════════════════════╲
│       LAYER 3: STRUCTURES         │  ← What rules, incentives, feedback loops?
╲═══════════════════════════════════╱
        │ "What beliefs make this structure feel correct?"
        ▼
╱═══════════════════════════════════╲
│     LAYER 4: MENTAL MODELS        │  ← What assumptions generate the structure?
╲═══════════════════════════════════╱
```

**Intervention leverage increases as you descend.** Event-layer fixes are reactive and don't prevent recurrence. Structure-layer fixes change the generator. Mental-model-layer fixes change what the organization *believes*, which transforms the whole cascade.

## Execution

A done analysis fills the output block below. Walk each layer down, then walk back up with an intervention at each. The layer probes and tests:

**Layer 1 — Event.** One sentence, specific with date/time/scope. "A 14-minute outage of the payments service on 2026-04-12 at 23:51 UTC" beats "reliability issues."

**Layer 2 — Pattern.** Has this shape happened before — over what window, under what conditions, frequency rising/flat/falling, similar in adjacent systems? No pattern means this is a single incident, not an iceberg; hand to RootCauseAnalysis/Postmortem. Pattern shapes: recurring (same shape, intermittent), escalating (worse each time), shifting (symptom moved, rhythm identical), seasonal/triggered (tied to a schedule, release, or team event).

**Layer 3 — Structure.** What rules, incentives, flows, or feedback loops generate the pattern? Name at least three candidates across: feedback loops, incentives, information/resource/authority flows, delays (the action→feedback gap, often the hidden cause), thresholds, ownership boundaries and their gaps, codified rules, resource allocation. **The test: remove the symptom and leave the structure intact — would a new symptom of the same shape appear elsewhere? If yes, that structure is the generator.**

**Layer 4 — Mental model.** What belief makes the structure feel natural? These are invisible to the people holding them — they feel like "how things are," not "what we believe." Probe: what would we have to believe for this structure to make sense; what does it treat as scarce vs. abundant; whom does it trust; whose voice does it amplify; what time horizon does it optimize? Common shapes: "we don't have time for X," "quality is QA's job," "moving fast beats moving carefully," "prevention isn't visible; fixing is."

**Intervention.** Walk back up with a candidate at each layer. Mental-model shift is highest leverage and hardest (what belief must change, who must see it differently, what evidence would shift it); structural fix changes the generator (flip a loop's polarity, tighten a delay, re-cut incentives or boundaries); event patch is fastest and lowest — legitimate only when the structural fix it defers is named and on the roadmap. Never ship an event patch that silently consents to recurrence.

## Output

```
🧊 ICEBERG ANALYSIS: [topic]

EVENTS (Layer 1):
- [Specific event 1]
- [Related event 2]
- ...

PATTERN (Layer 2):
- Time window: [e.g., 3 recurrences in 6 weeks]
- Shape: [recurring / escalating / shifting / seasonal]
- Trigger conditions: [what predicts it]

STRUCTURE (Layer 3):
- Primary generator: [feedback loop / incentive / flow / delay / rule]
- Contributing structures: [list]
- Test: if we remove the symptom, would this structure produce another?

MENTAL MODEL (Layer 4):
- Belief that makes the structure feel correct: [...]
- Who holds it: [...]
- What evidence would shift it: [...]

INTERVENTION CANDIDATES:
- Event-layer patch: [quick fix, explicitly deferred]
- Structural fix: [the real lever]
- Mental-model shift: [the durable change]

RECOMMENDED: [which layer to target given cost/benefit]
```

## Worked Example

```
EVENT: p99 latency spike in checkout service on 2026-04-11 caused cart abandonment

PATTERN:
- 4 p99 spikes in checkout in last 8 weeks
- Each time, fixed with a cache warm-up or pod resize
- Frequency is flat, not declining
- All spikes occur within 20min of a deploy

STRUCTURE:
- Feedback loop: deploy → cold cache → latency spike → ops response → warm-up → resolved. Loop never detects until after it damages users.
- Incentive: deploy velocity is measured; deploy safety is not (no SLO for post-deploy p99)
- Boundary: cache layer owned by infra; checkout owned by product. No team owns "the deploy behavior of the cache."
- Delay: 6-minute gap between cold cache and human response

MENTAL MODEL:
- Belief: "deploys are safe if tests pass"
- Held by: eng leadership, because CI is green
- Shift requires: evidence that tests don't cover cache warmth — a single p99 chart overlaid with deploy events does it

INTERVENTIONS:
- Event-layer patch (deferred): continue manual warm-ups — DO NOT keep doing only this
- Structural: add post-deploy p99 gate that blocks traffic shift until warm; name an owner for deploy-time cache behavior
- Mental-model: share p99-vs-deploy chart with leadership; add "post-deploy stability" to deploy definition of done

RECOMMENDED: structural fix (post-deploy p99 gate + ownership). Patches alone are consent to recurrence.
```

## Common Mistakes

- **Stopping at Layer 2.** "It keeps happening on deploys" is a pattern, not a structure. Push to the feedback loop / incentive.
- **Listing "people" as a structure.** Individuals are events. The structure is what the organization requires of them.
- **Conflating mental models with opinions.** "Team members disagree about X" is noise. The mental model is what the organization's *structure* believes, which may differ from what individuals articulate.
- **Naming a hero intervention at Layer 4 you can't actually make.** "We need to change the culture" is a cop-out if there's no concrete action. Culture-layer interventions must still have a specific first move.
- **Skipping the pattern check.** If there's no pattern, this isn't an iceberg problem — it's an incident. Use RootCauseAnalysis/Postmortem.

## Integration

- Feeds **CausalLoop** when Layer 3 structure is a feedback loop that deserves explicit diagramming.
- Feeds **FindArchetype** when Layer 2 pattern matches a known systems archetype.
- Handoffs to **RootCauseAnalysis/Postmortem** if the investigation reveals a single incident rather than a pattern.
- Output informs **ISC criteria** in OBSERVE — structural criteria, not just symptom criteria.

## Attribution

Iceberg Model popularized in *The Fifth Discipline Fieldbook* (Senge et al., 1994); four-layer formulation from Michael Goodman / Academy for Systemic Change. Leverage-by-layer principle: Donella Meadows, *Thinking in Systems*.
