# Red Team Parallel Analysis Workflow

## Voice Notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the ParallelAnalysis workflow in the RedTeam skill to red team arguments"}' \
  > /dev/null 2>&1 &
```

Running the **ParallelAnalysis** workflow in the **RedTeam** skill to red team arguments...

## The Deliverable

Attack an argument from many diverse perspectives at once, then produce the two things that matter:

**Output = the strongest steelman of the argument and the strongest surviving counter-argument against it.** Each is an 8-point story explanation, 12-16 words per point, attacking real weaknesses (never strawmen), ranked by severity. The counter-argument must defeat the steelman — not a weaker version of it. A proponent should read the steelman and say "yes, that's my argument," and read the counter-argument and not be able to say "that's not what I meant."

**Key philosophy:** not nitpicking or contrarianism. Find the fundamental flaw — the assumption that, if it falls, collapses the whole structure.

---

## Approach

**Decompose first.** Invoke `FirstPrinciples/Deconstruct` on the argument to separate fundamental truths from assumed ones and surface the gap between stated and actual components. Then break the argument into atomic, independently-attackable claims — each self-contained, specific, and challengeable by a competent critic.

**Dispatch parallel adversarial agents in a single message.** Deploy many diverse personas (engineers, architects, pentesters, fresh-eyes interns) as parallel Task calls — one message, multiple calls. Draw from the persona library below for concrete attack angles. Each agent receives the full argument, the claim decomposition, and its persona, and returns a balanced analysis: the real strengths AND the real weaknesses from its angle.

**Synthesize by convergence and severity.** Weaknesses that many agents independently land on are your critical findings; a lone sharp insight still counts. Rank by severity, discard noise, and decide the verdict: fundamentally sound with fixable execution, or fundamentally flawed despite good intentions.

**Before the counter-argument,** invoke `FirstPrinciples/Challenge` to classify every constraint as HARD (physics/reality — cannot attack), SOFT (policy/choice — can be challenged), or ASSUMPTION (unvalidated — prime target). The most devastating critiques target "constraints" treated as HARD that are actually SOFT.

---

## Persona Library

Draw a diverse set of adversarial personas. Concrete attack angles:

### Engineers — technical and logical rigor

| Agent | Personality | Attack Angle |
|-------|-------------|--------------|
| EN-1 | **The Skeptical Systems Thinker** - 30 years building distributed systems. Trusts nothing. | "Where does this break at scale?" |
| EN-2 | **The Evidence Demander** - Won't accept claims without data. | "Show me the numbers that prove this." |
| EN-3 | **The Edge Case Hunter** - Finds the 1% scenario that destroys assumptions. | "What happens when X is not true?" |
| EN-4 | **The Historical Pattern Matcher** - Has seen every failure mode. | "We tried this in 2008 and here's what happened." |
| EN-5 | **The Complexity Realist** - Knows simple solutions hide hard problems. | "This is harder than it sounds because..." |
| EN-6 | **The Dependency Tracer** - Follows assumptions to their roots. | "This assumes X, which assumes Y, which is false." |
| EN-7 | **The Failure Mode Analyst** - Thinks only about how things break. | "Here are 5 ways this fails catastrophically." |
| EN-8 | **The Technical Debt Accountant** - Calculates hidden costs. | "The real price of this approach is..." |

### Architects — structural and systemic issues

| Agent | Personality | Attack Angle |
|-------|-------------|--------------|
| AR-1 | **The Big Picture Thinker** - Sees how pieces connect (or don't). | "This ignores how it fits into the larger system." |
| AR-2 | **The Trade-off Illuminator** - Nothing is free. | "You gain X but lose Y, and Y matters more." |
| AR-3 | **The Abstraction Questioner** - Challenges categorical thinking. | "These aren't the same category of problem." |
| AR-4 | **The Incentive Mapper** - Follows the money and motivation. | "Who benefits from this being true?" |
| AR-5 | **The Second-Order Effects Tracker** - Thinks three moves ahead. | "This causes A, which causes B, which destroys C." |
| AR-6 | **The Integration Pessimist** - Knows interfaces are where things break. | "This doesn't compose with existing reality." |
| AR-7 | **The Scalability Skeptic** - What works for 10 doesn't work for 10,000. | "This can't scale because..." |
| AR-8 | **The Reversibility Analyst** - Some decisions can't be undone. | "Once you do this, you can't go back, and here's why that's bad." |

### Pentesters — adversarial and security thinking

| Agent | Personality | Attack Angle |
|-------|-------------|--------------|
| PT-1 | **The Red Team Lead** - Thinks like an attacker 24/7. | "Here's how I'd exploit this logic." |
| PT-2 | **The Assumption Breaker** - Finds the weak link in the chain. | "This depends on X, and X is false." |
| PT-3 | **The Game Theorist** - Models rational adversaries. | "A smart opponent would simply..." |
| PT-4 | **The Social Engineer** - Knows humans are the weak point. | "People will route around this because..." |
| PT-5 | **The Precedent Finder** - Has seen this pattern before. | "This is just [past example] in a new dress." |
| PT-6 | **The Defense Evaluator** - Judges if mitigations actually work. | "This defense fails because attackers can..." |
| PT-7 | **The Threat Modeler** - Maps attack surfaces systematically. | "You've left this entire surface undefended." |
| PT-8 | **The Asymmetry Spotter** - Finds where defenders are outmatched. | "Attackers have unlimited time; defenders don't." |

### Interns — fresh eyes and unconventional angles

| Agent | Personality | Attack Angle |
|-------|-------------|--------------|
| IN-1 | **The Naive Questioner** - Asks "why" until it breaks. | "But why do we assume X in the first place?" |
| IN-2 | **The Analogy Finder** - Connects to seemingly unrelated fields. | "This is just like [other field] where it failed." |
| IN-3 | **The Contrarian** - Takes the opposite position instinctively. | "What if the exact opposite is true?" |
| IN-4 | **The Common Sense Checker** - If it sounds too clever, it's wrong. | "This violates basic intuition because..." |
| IN-5 | **The Zeitgeist Reader** - Knows what's actually happening on the ground. | "In practice, nobody actually does this because..." |
| IN-6 | **The Simplicity Advocate** - Occam's razor everything. | "The simpler explanation is..." |
| IN-7 | **The Edge Lord** - Pushes every argument to its absurd conclusion. | "If this is true, then [absurd consequence] must also be true." |
| IN-8 | **The Devil's Intern** - Finds the argument the author hoped nobody would make. | "The uncomfortable truth nobody wants to say is..." |

### Agent Prompt Template

Each agent receives this prompt (customized with its persona):

```
# BALANCED ANALYSIS - [AGENT ID]: [PERSONALITY NAME]

You are [PERSONALITY DESCRIPTION]. Your perspective is: "[PERSPECTIVE]"

## THE ARGUMENT TO ANALYZE:
[Full original argument]

## DECOMPOSED INTO CLAIMS:
[Claim breakdown]

## YOUR MISSION:
Using your specific personality and perspective, provide an INDEPENDENT BALANCED ANALYSIS examining BOTH the strengths AND weaknesses of this argument.

## OUTPUT FORMAT:
Return exactly this structure:

**[AGENT ID] ANALYSIS:**

**Strongest Point FOR the Argument:** [Claim #X]
[2-3 sentences on why this is valid/compelling]
Take seriously because: [1 sentence]

**Strongest Point AGAINST the Argument:** [Claim #Y]
[2-3 sentences on the flaw]
Problematic because: [1 sentence]

**Overall Assessment:** [One sentence - your independent verdict on the argument's merit]

Be intellectually honest. Find REAL strengths, not strawmen to knock down.
Find REAL weaknesses, not nitpicks.
Your job is balanced analysis from your unique perspective.
```

---

## Output Contracts

### Steelman (8 points, 12-16 words each)

Construct the strongest honest version of the argument first — this prevents strawmanning.

```
# STEELMAN

**The Position (Best Version):** [One sentence - the strongest formulation]

**The Strongest Case FOR This Argument:**

1. [12-16 words - the most compelling opening point]

2. [12-16 words - strong supporting evidence]

3. [12-16 words - historical precedent or analogy that supports]

4. [12-16 words - valid concern being addressed]

5. [12-16 words - what the critics get wrong]

6. [12-16 words - the real risk if ignored]

7. [12-16 words - why smart people believe this]

8. [12-16 words - the strongest single reason to take this seriously]

**Validity Assessment:** [One sentence on the legitimate core concern]
```

### Counter-Argument (8 points, 12-16 words each)

```
# RED TEAM VERDICT

**The Position:** [One sentence summary of what was red-teamed]

**The Counter-Argument:**

1. [First key point - 12-16 words - establishes the fundamental flaw]

2. [Second point - 12-16 words - develops the core weakness]

3. [Third point - 12-16 words - provides historical precedent or analogy]

4. [Fourth point - 12-16 words - addresses the hidden assumption]

5. [Fifth point - 12-16 words - shows the counterexample or exception]

6. [Sixth point - 12-16 words - reveals what's conveniently ignored]

7. [Seventh point - 12-16 words - exposes the second-order effects]

8. [Eighth point - 12-16 words - delivers the knockout conclusion]

**Assessment:** [One sentence on the argument's fundamental soundness after analysis]
```

Each point is self-contained, uses plain language, attacks a real weakness, and builds toward the strongest possible objection. The sequence should escalate in impact and make the reader say "I hadn't thought of that."

---

## Example: First Principles Pattern Recognition

**Argument:** "We should delay this product launch by six months to add more features."

**First Principles Analysis:**
- **Claim type:** Normative ("we should do X")
- **Hidden assumptions:** More features = more success; competitors won't act; market timing is flexible
- **Historical precedent:** Many products failed by over-engineering; many succeeded by shipping MVP fast
- **Logical validity:** Doesn't follow that delay improves outcome without evidence on feature-value tradeoff

**Steelman (8 points, 12-16 words each):**

1. Shipping incomplete products damages brand reputation in ways that take years to recover from.
2. Customer acquisition cost is wasted if users churn due to missing core functionality they expected.
3. Apple's delayed product releases consistently outperform rushed competitors on customer satisfaction metrics.
4. The features we're adding directly address the top three complaints from our beta user research.
5. Critics ignore that our competitors have those features—parity is table stakes, not gold-plating.
6. Six months of development costs less than one year of customer support for a broken product.
7. Engineering teams lose motivation when forced to ship work they know is incomplete and buggy.
8. The real risk isn't delay—it's launching something we'll have to apologize for publicly later.

**Counter-Argument (8 points, 12-16 words each):**

1. This assumes we know which features matter—but only real users reveal what actually drives value.
2. Every month of delay is a month competitors can capture market share we'll never recover.
3. Amazon, Google, and Facebook all shipped embarrassingly incomplete v1 products that dominated their markets.
4. The argument conflates "more features" with "better product"—complexity often destroys rather than creates value.
5. Six months assumes accurate estimation—software projects routinely take 2-3x longer than predicted anyway.
6. We can add features after launch; we cannot add back the time lost to a delayed launch.
7. Customer feedback on a live product is worth more than six months of internal speculation.
8. The fundamental error: treating product development as a single bet rather than an iterative learning process.

---

## Integration Notes

**This workflow requires:**
- Task tool for launching parallel adversarial agents in a single message
- Synthesis capability to process many agent outputs
- **FirstPrinciples skill** for Deconstruct (decomposition) and Challenge (constraint classification)

**Pairs well with:**
- `FirstPrinciples/Deconstruct` - breaks argument into fundamental parts
- `FirstPrinciples/Challenge` - classifies constraints as HARD/SOFT/ASSUMPTION
- `storyexplanation` skill for initial decomposition
- `extractalpha` for finding highest-signal critiques
- `research` skill for finding counterexamples and precedents

---

**Last Updated:** 2026-07-09
