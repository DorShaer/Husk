# FindArchetype Workflow — SystemsThinking

## Purpose

Match the observed system behavior to one of the ~10 canonical **systems archetypes**. Archetypes are the recurring structural patterns that Senge and others codified: once you recognize the archetype, the canonical intervention is already documented. You don't have to reinvent it.

This is the fastest, highest-leverage systems-thinking workflow when the pattern is common — which it usually is.

## Invocation

- "Systems archetype"
- "Fixes that fail," "shifting the burden," "tragedy of the commons," "limits to growth," "escalation" (user naming an archetype)
- "Why does this keep happening?" combined with clear recurring pattern
- After CausalLoop, to check whether the loop structure matches a known archetype

## The Archetypes

### 1. Fixes That Fail (a.k.a. Fixes That Backfire)

**Structure:** Problem → Quick fix → Problem relieved (short term) → Unintended consequence → Problem worsens (long term).

**Classic signs:**
- A fix worked initially but the problem returned larger
- Each fix requires more force than the last
- Energy is spent on remediation rather than prevention

**Recognition:** "We keep fixing this and it keeps coming back bigger."

**Canonical intervention:**
- Identify the unintended consequence of the fix
- Find a fundamental solution that doesn't trigger the consequence
- Accept short-term pain to stop the cycle
- If a quick fix is unavoidable, explicitly time-box it and commit to a fundamental solution on a deadline

**Example:** Adding timeouts to flaky distributed calls. Short-term: calls complete. Long-term: timeouts mask real latency, services drift to worse performance, eventually total outage. Fix: address actual latency cause (often a database or an upstream bottleneck), not the symptom.

---

### 2. Shifting the Burden

**Structure:** A problem can be solved by a **symptomatic solution** (fast, shallow) OR a **fundamental solution** (slow, deep). The symptomatic solution creates dependency, atrophies the capacity for fundamental solutions, and eventually the fundamental solution becomes impossible.

**Classic signs:**
- Heavy reliance on a workaround
- Team loses the skill to do it "the right way"
- The burden shifts from problem-solver to problem-depender

**Recognition:** "The hack became the system." "Only Alice knows how to run it."

**Canonical intervention:**
- Deliberately invest in the fundamental solution even though the symptomatic one is cheaper short-term
- Put the symptomatic solution on a sunset timer
- Measure the atrophy explicitly — track whether the fundamental capacity is growing or shrinking

**Example:** Relying on one senior engineer to diagnose production incidents. Short-term: fast resolution. Long-term: team never learns diagnosis, the senior engineer burns out, the team is now incapable. Fix: enforce rotation and documentation even when it slows resolution.

---

### 3. Limits to Growth (a.k.a. Limits to Success)

**Structure:** A reinforcing loop of growth hits a balancing loop of limits. Growth slows or reverses as the limit activates.

**Classic signs:**
- Early growth was exponential
- Growth is now linear, flat, or declining
- The thing that worked initially no longer works
- Doing more of what worked makes it worse

**Recognition:** "We used to 10x. Now we barely 1.5x. Nothing we try helps."

**Canonical intervention:**
- Don't push harder on the reinforcing loop (it's exhausted)
- Identify the limit (balancing loop)
- Attack the limit directly — change the constraint, raise the ceiling
- Often requires structural change, not more effort

**Example:** Adding engineers past team size 12-15 (see `CausalLoop.md` worked example). Fix: attack coordination cost, not hiring throttle.

---

### 4. Tragedy of the Commons

**Structure:** A shared resource is used individually rationally, but collectively destroyed. Each actor's gain is local; the cost is distributed.

**Classic signs:**
- Shared resource (staging environment, shared service, common infrastructure, database)
- Each team optimizes locally; resource degrades for all
- "Nobody owns it" / "It's always broken"

**Recognition:** "Staging is a wasteland." "The shared cache is always full." "Everyone blames everyone else."

**Canonical intervention:**
- Make the commons non-shared (partition, quota, per-team instance)
- Or: make individual use visible and collectively managed (observability + governance)
- Or: assign ownership with budget and authority
- Or: price the commons (charge-back, resource budgets)

**Example:** A shared test database. Each dev writes data; nobody cleans up; tests get slower; everyone blames "the test database." Fix: ephemeral per-branch databases, or named owner + automated cleanup.

---

### 5. Escalation

**Structure:** Two actors respond to each other's threats or investments. Each escalation triggers a larger counter-escalation. Driven by mutual reinforcing loops.

**Classic signs:**
- Arms race dynamics
- Feature wars with a competitor
- Alerting escalation (more alerts → alert fatigue → more alerts to "make sure you see it")
- Price wars

**Recognition:** "Both sides are doing more, nobody is winning."

**Canonical intervention:**
- Unilateral de-escalation (break the symmetry)
- Reframe the goal (compete on a different axis)
- Find a higher-order cooperation (both sides benefit from stopping)

**Example:** Alerting system bloat — every postmortem adds alerts; alert fatigue increases; incidents missed; postmortems add more alerts. Fix: alert-budget with forced decommission; alert quality metric.

---

### 6. Success to the Successful

**Structure:** Two actors compete for a limited resource. Whoever gets more early wins more future allocations. The gap widens.

**Classic signs:**
- A team / product / feature that got initial attention gets disproportionate ongoing attention
- "The rich get richer, the poor get poorer" dynamic
- Neglected areas decay and receive even less

**Recognition:** "Feature A has 3 PMs and Feature B has none, even though Feature B is more strategic."

**Canonical intervention:**
- Change allocation from competitive (winner takes more) to independent (each gets what it needs)
- Explicit re-balancing events (budget reallocations, leadership attention shifts)
- Measure absolute value, not relative — prevent relative comparison from determining allocation

**Example:** Two products sharing an engineering team. Product A ships fast, gets more engineers, ships faster; Product B starves despite strategic importance. Fix: allocate by strategic value, not velocity.

---

### 7. Drifting Goals (a.k.a. Eroding Goals)

**Structure:** A goal is set. Reality falls short. Instead of closing the gap, the goal is lowered. Repeated indefinitely, "quality" or "standard" drifts downward.

**Classic signs:**
- SLAs are met because SLAs keep dropping
- "Normal" performance is worse than it used to be
- Nobody remembers when quality was the current definition

**Recognition:** "Our standard used to be 99.9%. Then 99.5%. Now nobody talks about it."

**Canonical intervention:**
- Anchor the goal externally (industry benchmark, competitor, first-principles calculation)
- Make drift visible — dashboard the historical goal line, show the erosion
- Build capacity to close the gap rather than lower the goal

**Example:** Test suite runtime used to be 2 min; drifted to 20 min; now nobody tests locally. Fix: hard target ("CI must be <5min by Q3") and invest structurally.

---

### 8. Growth and Underinvestment

**Structure:** Growth creates demand. Demand exceeds capacity. Investment in capacity lags (due to delays or perceived cost). Customers leave; growth stalls. Investment no longer feels justified.

**Classic signs:**
- Onboarding is overwhelmed
- Support queue is always behind
- Capacity was "just about to be added" for quarters
- Growth slowed and now there's "no need to invest"

**Recognition:** "We grew too fast to support, now we're slow because we're not supporting well."

**Canonical intervention:**
- Invest in capacity *during* growth, not after
- Measure capacity as a leading indicator, not a lagging one
- Accept that capacity investment must exceed current load

**Example:** Customer support team stays flat as user base 5x's. Response times crater. Churn rises. Growth stalls. "No need for more support, growth is flat." Fix: hire capacity proactively; measure support saturation, not ticket count.

---

### 9. Accidental Adversaries

**Structure:** Two parties who should cooperate (allies, partners, teammates) end up working against each other due to hidden feedback loops. Each party's local fix creates friction for the other.

**Classic signs:**
- Two teams / departments / partners with aligned goals, but friction
- Each is defensively protecting its own workflow
- Communication has collapsed into blame

**Recognition:** "Infra and product used to work together. Now each protects its own territory."

**Canonical intervention:**
- Surface the hidden dependency
- Make the shared goal explicit and measurable
- Create a shared scoreboard where both succeed or fail together
- Explicit interfaces and contracts replace informal cooperation

**Example:** Platform team optimizes for stability (rejects risky launches); product team optimizes for velocity (works around platform). Each action makes the other's job harder. Fix: shared launch readiness review with both goals counted.

---

### 10. Policy Resistance

**Structure:** A policy or intervention is resisted by the system — multiple actors adjust their behavior to neutralize it. Net effect: little or no change, often with negative side effects.

**Classic signs:**
- Intervention had no measurable effect
- Unintended workarounds appeared
- "Gaming" the metric

**Recognition:** "We added the control; nothing changed; people just routed around it."

**Canonical intervention:**
- Understand who is resisting and why (their incentives)
- Align with the resistors' incentives rather than fighting them
- Change the goal, not the control

**Example:** Code review policy to reduce bugs. Developers add LGTM without reading. Bug rate unchanged. Fix: measure review depth (time spent, comments added); make code complexity visible to reviewers.

---

## Matching

Describe the behavior in 2-4 sentences (what's happening, over what period, who's involved, what's been tried), then walk the archetype list matching on *mechanism*, not surface symptoms — two archetypes can show the same visible symptoms from different structures. A match yields the canonical intervention plus its adaptation to context; the point is the fix applied, never the label named and abandoned. No match → build a CLD from scratch (`CausalLoop.md`); the behavior may be a composite of two archetypes or genuinely novel.

**Negative test:** does the intervention address the underlying loop (not a symptom) and account for the delays, and can you find any record of it helping similar situations? If not, you've probably misidentified the archetype.

## Output

```
🧩 ARCHETYPE MATCH: [name]

BEHAVIOR DESCRIPTION:
[What is happening, 2-4 sentences]

WHY THIS ARCHETYPE:
- Signature: [structural signature that matches]
- Evidence: [observable pattern]
- Dynamic: [reinforcing + balancing loops involved]

CANONICAL INTERVENTION:
[From archetype documentation]

ADAPTATION TO CONTEXT:
- First move: [specific action]
- Measure of success: [how you'll know it's working]
- Timeline: [when to re-evaluate]

RISK: [which other archetype could be mimicked — second-order check]
```

## Common Mistakes

- **Seeing archetypes everywhere.** Not every recurring problem is an archetype. If the match is forced, fall back to CausalLoop.
- **Naming the archetype but not applying the intervention.** The point is the canonical fix, not the label.
- **Ignoring the delay structure.** Delays are integral to most archetypes. If the timing doesn't match, the archetype probably doesn't either.
- **Skipping the CLD check.** Archetypes are CLD templates. Draw your specific CLD and verify it maps to the archetype's CLD, not just in words.

## Integration

- Entry point from **Iceberg** (Layer 3 structure resembles an archetype)
- Entry point from **CausalLoop** (drawn CLD resembles an archetype template)
- Exit to **FindLeverage** for intervention prioritization
- Reference: `../Archetypes.md` for full archetype structures with CLD templates

## Attribution

Systems archetypes: Peter Senge, *The Fifth Discipline* (1990); William Braun, *The System Archetypes* (2002). Original case studies: System Dynamics Society; Pegasus Communications.
