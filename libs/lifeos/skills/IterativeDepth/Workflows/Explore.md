# Explore Workflow — Iterative Depth

## Purpose

Run N structured exploration passes over the same problem, each from a different lens, to extract richer ISC criteria than single-pass analysis produces.

## Invocation

This workflow is invoked:
1. **Directly** by the user: "use iterative depth on this problem"
2. **By the Algorithm** during OBSERVE phase when the Capability Audit selects IterativeDepth
3. **By other skills** that need enhanced requirement extraction

## Inputs

- **Problem/Request:** The original user request or problem statement
- **Context:** Any available context (conversation history, codebase state, prior work)
- **Lenses:** drawn from `TheLenses.md` — pick the ones the problem calls for

## Execution

Read `TheLenses.md` and select the lenses that fit the problem. Explore the problem through each in turn, carrying the criteria found so far into the next lens so later passes build on earlier ones. Every pass should surface genuinely new criteria; stop adding lenses once a pass only restates what earlier ones found. Lenses can run inline or as parallel background agents.

## Synthesize

After the passes:

1. **Deduplicate:** remove criteria that are semantically identical across lenses.
2. **Merge refinements:** when multiple lenses refined the same criterion, keep the most specific version.
3. **Prioritize:** a criterion surfaced by several lenses ranks higher.
4. **Format:** every criterion in ISC form — 8-12 words, state not action, binary testable.

Return the enriched criteria to the calling context: feed directly into TaskCreate calls when called from Algorithm OBSERVE, or present the set to the user when called standalone.

## Output Format

```
🔍 ITERATIVE DEPTH COMPLETE ({N} lenses applied)

📊 Coverage:
- Lenses used: {list of lens names}
- New criteria discovered: {count}
- Existing criteria refined: {count}
- Anti-criteria discovered: {count}

📋 NEW ISC CRITERIA:
[Use TaskCreate for each, prefixed "ISC-"]

📋 REFINED ISC CRITERIA:
[Use TaskUpdate for each, with evidence of what changed]

📋 NEW ANTI-CRITERIA:
[Use TaskCreate for each, prefixed "ISC-A"]

💡 Key Insight: [The most surprising finding across all lenses — the thing single-pass analysis would have missed]
```

## Integration with Algorithm OBSERVE Phase

When the Capability Audit selects IterativeDepth, it runs after Reverse Engineering and before ISC CREATION, so ISC criteria are informed by multi-angle exploration before they're written rather than corrected after the fact.
