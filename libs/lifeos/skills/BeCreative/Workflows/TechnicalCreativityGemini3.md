# Technical Creativity with Gemini 3 Pro

## Voice Notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the TechnicalCreativityGemini3 workflow in the BeCreative skill to generate technical solutions"}' \
  > /dev/null 2>&1 &
```

Running **TechnicalCreativityGemini3** in **BeCreative**...

---

## When to use

Technical/engineering creativity — algorithms, system architectures, data structures, protocols, performance optimizations. For creative writing, narratives, naming, or marketing angles, use the main skill's creativity workflows instead. This workflow routes generation to Gemini 3 Pro's deep reasoning via the `llm` CLI rather than in-model Verbalized Sampling.

## Tool contract

Invoke Gemini 3 Pro with the problem, its constraints, and success criteria:

```bash
llm -m gemini-3-pro-preview "Generate 5-10 diverse creative technical solutions for this problem:

PROBLEM:
[technical challenge]

CONSTRAINTS:
[hard: latency, throughput, memory, scale, compatibility | soft: cost, maintainability, timeline]

SUCCESS CRITERIA:
[measurable outcomes]

For each solution, provide:
1. Core technical approach (algorithm/architecture)
2. Key innovation — the non-obvious insight or cross-domain connection
3. Trade-offs — performance vs complexity vs cost vs maintainability
4. Implementation difficulty (1-10, with why)
5. Why creative — the non-obvious thinking

Span radical rethinks, hybrid paradigms, counter-intuitive optimizations, novel data-structure applications, and creative protocol designs."
```

## Done when

- Solutions are mutually distinct approaches, not variations on one design.
- Every solution states its trade-offs and an implementation-difficulty score explicitly.
- The recommendation names one approach and justifies it against the stated constraints.

## Output Format

```markdown
## Creative Technical Solutions for: [Problem Name]

### Solution 1: [Descriptive Name]
**Core Approach:** [algorithm/architecture]
**Key Innovation:** [the insight or cross-domain connection]
**Trade-offs:** Performance / Complexity / Cost / Maintainability
**Implementation Difficulty:** [1-10 with explanation]
**Why Creative:** [non-obvious thinking or novel combination]

### Solution 2 … [repeat per solution]

## Recommendation
**Selected Approach:** [Name]
**Justification:** [why it best balances constraints and goals]
**Next Steps:** [1-3 action items]
```

## Example

```bash
llm -m gemini-3-pro-preview "Generate 5 diverse creative caching strategies for this problem:

PROBLEM:
API gateway caches responses for 1M+ unique endpoints. Data updates frequently but follows patterns (time-of-day, cohort, region). Traditional LRU wastes memory on rarely-accessed endpoints.

CONSTRAINTS:
- 2GB RAM cache limit; sub-10ms P99 lookup; 1M+ endpoints; power-law traffic (70% of hits on 5% of endpoints)

SUCCESS CRITERIA:
- 90%+ hit rate for hot data; sub-10ms P99; under 2GB; 50K req/sec

For each solution: 1) core approach 2) key innovation 3) trade-offs 4) difficulty (1-10) 5) why non-obvious.

Consider probabilistic structures, predictive prefetch, multi-tier storage, geographic/temporal sharding."
```

---

**Last Updated:** 2025-11-18
