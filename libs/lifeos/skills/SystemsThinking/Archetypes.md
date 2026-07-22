# SystemsThinking — Archetypes Reference

The ten canonical systems archetypes (Senge, Goodman, Kiefer, Kemeny, codified in *The Fifth Discipline*, 1990; expanded by Braun, 2002). Each archetype is a **template** — recognizing the template suggests the intervention.

Structure-first: every archetype is defined by its feedback-loop shape, not by its surface symptoms. Two different archetypes can have similar-looking symptoms but different generating structures.

---

## 1. Fixes That Fail

**Loop structure:** B (symptom fix) + R with delay (unintended consequence).

**Behavior:** Quick fix relieves symptom short-term. Delayed side effects worsen the underlying problem. More fixes required. Side effects compound.

**Recognition:** "We keep fixing this and it keeps coming back bigger." Each fix requires more force than the last. Energy spent on remediation rather than prevention.

**Example 1 — Manufacturing:** Antibiotics for viral respiratory infections. Symptom relief (real). No pathogen addressed (fix fails underlying problem). Repeated prescribing selects for antibiotic resistance (unintended consequence).

**Example 2 — Software:** Adding timeouts to flaky distributed calls. Short-term: calls complete. Long-term: timeouts mask real latency; services drift to worse performance; eventually total outage.

**Example 3 — Business:** Cutting engineering headcount to hit Q4 margins → reduces short-term burn → increases engineering bottleneck → product velocity drops → revenue falls → need deeper cuts.

**Canonical intervention:**
- Surface and accept the delay explicitly. Ask "what are the second-order effects of this fix in 6 months?" before implementing.
- Find a fundamental solution that doesn't trigger the consequence.
- Accept short-term pain to stop the cycle.
- If a quick fix is unavoidable, explicitly time-box it and commit to a fundamental solution on a deadline.

---

## 2. Shifting the Burden

**Loop structure:** Two balancing loops (symptomatic B + fundamental B) + one reinforcing loop where the symptomatic solution atrophies the fundamental capability.

**Behavior:** Symptomatic solution is fast and feels effective. It atrophies the fundamental solution capability. The more successful the symptomatic solution, the less capable the system becomes of addressing root causes. Eventually the system is entirely dependent on the symptomatic fix.

**Recognition:** "We'll do it properly once we get through this crisis." The crisis never ends. "The hack became the system." "Only Alice knows how to run it."

**Example 1 — Medical:** Opioids for chronic pain. Fast symptomatic relief. Atrophies patient's investment in physical therapy, behavioral change (fundamental). Dependency develops.

**Example 2 — Software:** Technical ops team firefighting production incidents. Symptomatic: on-call engineers fix issues manually. Fundamental: proper observability, automated remediation, root-cause engineering. The more symptomatic succeeds (fires put out), the less organizational pressure to invest in fundamental. On-call burns out; system becomes fragile.

**Example 3 — Business:** Consultants hired to solve what should be internal capability. Over time, internal capability atrophies. Consultant dependency increases. Cost increases. Internal capability never develops.

**Canonical intervention:**
- Sunset dates on symptomatic solutions.
- Explicit investment in fundamental capability even while symptomatic fix is in place.
- Measure the atrophy explicitly — track whether fundamental capacity is growing or shrinking.

---

## 3. Limits to Growth (a.k.a. Limits to Success)

**Loop structure:** R (growth engine) + B (limiting constraint, often delayed).

**Behavior:** System grows initially, then growth slows as limiting constraint activates. If actors push harder (trying to maintain growth by pushing on the growth engine), growth continues briefly then collapses.

**Recognition:** "We used to 10x. Now we barely 1.5x. Nothing we try helps." "We just need to push harder and growth will come back."

**Example 1 — Startup:** Growth hitting hiring capacity (see `Workflows/CausalLoop.md` worked example). Each new hire costs more in coordination than they contribute in output once past size 12-15.

**Example 2 — Sales:** Sales team pushing harder as growth slows — not realizing the constraint is delivery capacity. More sales = more delivery failures = reputation damage = harder to sell.

**Example 3 — Product:** SaaS product growth hitting infrastructure limits; team velocity hitting cognitive load limits.

**Canonical intervention:**
- The leverage is **never** on the reinforcing loop. It is on the limiting constraint.
- Identify the limit (balancing loop) before it activates.
- Attack the limit directly — change the constraint, raise the ceiling.
- Pushing harder on the growth engine always makes the eventual collision with the limit more severe.

---

## 4. Tragedy of the Commons

**Loop structure:** Each actor has R (individual gain from shared resource) + B (resource degradation from total use). Actors experience own gain immediately but share degradation cost collectively.

**Behavior:** Rational individual actors over-exploit shared resource until it collapses. No actor is irrational. The system structure produces the outcome regardless of intentions.

**Recognition:** Shared resource (staging environment, shared service, common infrastructure). Each team optimizes locally; resource degrades for all. "Nobody owns it." "Everyone is extracting too much but no one wants to go first in cutting back."

**Example 1 — Environmental:** Overfishing. Groundwater depletion.

**Example 2 — Software:** Shared engineering resources in large organizations (everyone requests more compute from the shared cluster; no one individually restrains use). Open-source maintainer burnout (everyone consumes, few contribute back). Shared test database (each dev writes data; nobody cleans up; tests get slower).

**Example 3 — Ops:** Shared QA environment in a software organization. Each team schedules tests when needed. Total test runs exceed capacity. Queue grows. Feedback slows. Everyone's velocity drops — but no one team individually caused it.

**Canonical intervention:**
- Privatize the commons (each actor manages own resource). Partition, quota, per-team instance.
- Visibility into shared resource consumption + governance (usage limits, taxation, quotas, pricing).
- Assign ownership with budget and authority.

---

## 5. Escalation

**Loop structure:** Two reinforcing loops, each driven by one actor's position relative to the other's.

**Behavior:** Actor A's actions perceived as threatening by Actor B. B responds. A perceives B's response as escalation. A escalates further. Loop accelerates.

**Recognition:** "Both sides are doing more, nobody is winning." "We're just responding to what they did."

**Example 1 — Competition:** Arms races. Pricing wars. Vendor lock-in negotiation spirals.

**Example 2 — Software:** Feature parity races with a competitor — each adding features to match the other, neither driven by user need, both making their products bloated. Alerting system bloat — every postmortem adds alerts; alert fatigue increases; incidents missed; postmortems add more alerts.

**Example 3 — HR:** Salary ratchet between two companies competing for the same talent pool.

**Canonical intervention:**
- Unilateral de-escalation (break the symmetry; one side absorbs a round without responding, with explicit signaling).
- Reframe the goal (compete on a different axis).
- Find a higher-order cooperation (both sides benefit from stopping).
- Recognition that the loop is operating — naming it publicly changes behavior.

---

## 6. Success to the Successful

**Loop structure:** Two reinforcing loops sharing a finite resource, competing.

**Behavior:** Initial small advantages compound into structural dominance. The winner wins bigger over time. The loser's resource atrophy is self-confirming.

**Recognition:** "The rich get richer" operating as a structural feature, not an accident. "Team A has 3 PMs and Team B has none, even though Team B is more strategic."

**Example 1 — Finance:** Capital markets (returns attract capital, larger capital base earns larger returns). Network effects (larger network more valuable, attracts more users).

**Example 2 — Organizational:** Teams with good reputations get allocated the interesting projects, develop more skill, get better reputations. Teams with poor reputations get the maintenance work, further eroding reputation.

**Example 3 — Products:** Two products sharing an engineering team. Product A ships fast, gets more engineers, ships faster. Product B starves despite strategic importance.

**Canonical intervention:**
- Change allocation from competitive (winner takes more) to independent (each gets what it needs).
- Explicit portfolio policy; rotation requirements; resource floor.
- Measure absolute value, not relative — prevent relative comparison from determining allocation.
- External regulations (antitrust) are attempts to break this loop at scale.

---

## 7. Drifting Goals (a.k.a. Eroding Goals)

**Loop structure:** Two balancing loops — one improving performance, one reducing the goal.

**Behavior:** Goal is set. Reality falls short. Instead of closing the gap, the goal is lowered. Repeated indefinitely, "quality" or "standard" drifts downward. The path of least resistance is always lowering the goal.

**Recognition:** "We've had to be realistic about what's achievable" — repeated over years. "We used to care about X, but we've learned to be realistic."

**Example 1 — Software:** Customer response time SLAs. Target was 2 hours. Consistently missing. Quietly raised to 4 hours. Missing that. Raised to 8 hours. Customer churn begins — the degradation was invisible inside the loop.

**Example 2 — Software quality:** Team sets defect-per-release target of 10. Release ships with 25. Instead of fixing process (hard), team reclassifies 15 as "known issues" (easy). Next release targets 25. Standards drift downward indefinitely.

**Example 3 — Ops:** Test suite runtime used to be 2 min; drifted to 20 min; now nobody tests locally.

**Canonical intervention:**
- Anchor goals to external reference points (industry benchmark, competitor, first-principles calculation).
- Make drift visible — dashboard the historical goal line; show the erosion.
- Build capacity to close the gap rather than lower the goal.
- Separate the goal-revision process from the performance process.
- Require explicit approval for goal changes at a level above those affected by the gap.

---

## 8. Growth and Underinvestment

**Loop structure:** R (growth) + B (limiting constraint) + second B (capacity investment that could expand the limit, but only if investment is made).

**Behavior:** Growth is strong, approaches limits. If investment in capacity is made, limits recede, growth continues. If investment is not made (because limits haven't fully activated yet, or because short-term costs are visible while long-term benefits are not), limits bite hard. Growth stalls. Investment no longer feels justified.

**Recognition:** "We'll invest in capacity after we see the growth sustain." Onboarding is overwhelmed; support queue always behind.

**Example 1 — Infrastructure:** Cloud infrastructure scaling decisions. Team that doesn't expand capacity until performance degrades. By the time it degrades, investment timeline (hiring, training, provisioning) is 6-12 months.

**Example 2 — Support:** Customer support team stays flat as user base 5x's. Response times crater. Churn rises. Growth stalls. "No need for more support, growth is flat."

**Example 3 — Talent:** Talent pipeline investment. Technical platform investment as product grows.

**Canonical intervention:**
- Invest in capacity **before** it is needed, using leading indicators of the limiting constraint rather than lagging indicators of its activation.
- Measure capacity as a leading indicator, not a lagging one.
- Accept that capacity investment must exceed current load.
- Investment triggers tied to forward-looking metrics, not lagging performance metrics.

---

## 9. Accidental Adversaries

**Loop structure:** Two parties who should cooperate have hidden reinforcing loops working against each other.

**Behavior:** Two parties with aligned goals end up working against each other. Each party's local fix creates friction for the other. Communication collapses into blame.

**Recognition:** "Infra and product used to work together. Now each protects its own territory."

**Example 1 — Org:** Platform team optimizes for stability (rejects risky launches); product team optimizes for velocity (works around platform). Each action makes the other's job harder.

**Example 2 — Platform/ecosystem:** Platform adds features to compete with developer apps (captures more value). Developers lose revenue, trust platform less, invest less in ecosystem. Platform loses ecosystem richness. Platform doubles down on first-party features. Spiral.

**Canonical intervention:**
- Surface the hidden dependency.
- Make shared goal explicit and measurable.
- Create a shared scoreboard where both succeed or fail together.
- Explicit interfaces and contracts replace informal cooperation.

---

## 10. Policy Resistance

**Loop structure:** A policy / intervention is resisted by the system — multiple actors adjust behavior to neutralize it. Net effect: little or no change, often with negative side effects.

**Behavior:** Intervention had no measurable effect. Unintended workarounds appeared. Metric is gamed.

**Recognition:** "We added the control; nothing changed; people just routed around it." Goodhart's Law in action.

**Example 1 — Software:** Code review policy to reduce bugs. Developers add LGTM without reading. Bug rate unchanged.

**Example 2 — Public policy:** Speed cameras cause drivers to accelerate between them. Performance management systems produce metric-gaming rather than performance improvement.

**Example 3 — Product:** Rate limit to stop abuse creates workarounds (sign up 100 accounts, distribute load) rather than stopping abuse.

**Canonical intervention:**
- Understand who is resisting and why (their incentives).
- Align with the resistors' incentives rather than fighting them.
- Change the goal, not the control.
- Redesign the measurement so it captures the true quality, not a proxy.

---

## Recognition Guide

| Observed behavior | First archetype to check |
|-------------------|--------------------------|
| Same thing keeps recurring, fixes required | Fixes That Fail |
| Dependency on workaround; fundamental capability atrophied | Shifting the Burden |
| Growth slowed; pushing harder doesn't work | Limits to Growth |
| Shared resource degrading; "nobody owns it" | Tragedy of the Commons |
| Both sides doing more, nobody winning | Escalation |
| Winner-take-all dynamics; rich-get-richer | Success to the Successful |
| Standards drift downward over time | Drifting Goals |
| Growth stalls; investment always "just about to happen" | Growth and Underinvestment |
| Allies becoming adversaries | Accidental Adversaries |
| Policy had no effect; behavior routed around it | Policy Resistance |

## Attribution

Systems archetypes: Peter Senge, *The Fifth Discipline* (1990); Senge, Goodman, Kiefer, Kemeny codification. William Braun, *The System Archetypes* (MIT CTL, 2002). Original case studies: System Dynamics Society; Pegasus Communications.
