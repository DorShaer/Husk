# Postmortem Workflow — RootCauseAnalysis

## Purpose

Produce a structured, **blameless** written record of an incident — its impact, timeline, contributing factors, resolution, and follow-up actions. Grounded in Google SRE practice, Etsy's debriefing facilitation work (John Allspaw), and Sidney Dekker's *Field Guide to Understanding Human Error*.

The postmortem is the wrapper for other RCA tools. Inside the postmortem, use 5 Whys, Fishbone, Kepner-Tregoe as appropriate to investigate the causes.

**The goal is systemic learning, not individual accountability.** Postmortems that drift into blame produce worse postmortems, not better behavior.

## Invocation

- "Postmortem," "incident review," "blameless postmortem"
- Production incident with user-visible impact
- Security incident
- Data loss or near-miss
- Novel failure mode (even without customer impact, if it could have been worse)
- Any incident where on-call had to intervene

## Google SRE Trigger Criteria

Run a postmortem when any of:
- User-visible downtime or degradation above a threshold
- Data loss of any kind
- On-call engineer intervention required
- Novel failure mode (first occurrence of this type)
- A monitoring failure (incident should have been detected sooner)
- Anything that should not have happened by the system's own design expectations

**Default to running one.** The cost of skipping is high (missed learning); the cost of running is a few hours.

## The Blameless Principle

**Definition (Google SRE):** A written record of an incident, its impact, the actions taken to resolve it, the root causes, and the follow-up actions — conducted **without indicting any individual for bad behavior.**

**Why blameless works:** When engineers fear blame, they under-report, hide contributing information, and avoid honest analysis. Blameless culture makes it psychologically safe to expose the full causal picture, including the engineer's own decision-making under incomplete information.

**Blameless ≠ accountability-free.** Action items have owners and deadlines. What blameless excludes: personal judgments, punitive framing, "why did you do that?" questions directed at individuals.

**Etsy rule:** "Once you welcome people into the room and set expectations about the mindset they should be in (blameless) and the outcome (learning), there's really only one thing to focus on: discovering the story behind the story."

### Facilitation Rules

- No "why did you do that?" directed at individuals
- Instead: "What did you see? What did you know? What were you trying to accomplish?"
- Reconstruct the timeline *forward*, not backward — fight hindsight bias
- Study the "sharp end" (Dekker) — what was it like to be the on-call engineer, in that moment, with what they knew?
- Separate this meeting from any performance conversation. Never combine them.

## Execution

### Phase 1: Timeline Reconstruction (before investigation)

Reconstruct what happened in chronological order. Include:

- Every signal that was available to responders
- Every action taken
- Every communication (chat messages, phone calls, alerts)
- Decision points — what information was available at each?

**Tools:** Incident channel transcript, alert history, deploy logs, on-call notes, chat logs.

**Critical:** Reconstruct the timeline *before* hypothesizing about causes. If you start with a cause hypothesis, you will unconsciously organize the timeline to support it.

### Phase 2: Investigate Causes (using 5 Whys, Fishbone, KT as appropriate)

For each contributing thread, run the appropriate sub-workflow:

- Clear single-thread cause → **5 Whys** (`FiveWhys.md`)
- Multiple suspected categories → **Fishbone** (`Fishbone.md`)
- "Works on X, not Y" subtle defect → **Kepner-Tregoe** (`KepnerTregoe.md`)
- Complex multi-path failure → **Fault Tree** (`FaultTree.md`)

**Multiple contributing factors is the default.** Modern SRE postmortems list *contributing factors* (plural), not a single root cause. Will Gallego's 2018 piece "No, Seriously. Root Cause is a Fallacy" codified this.

### Phase 3: Classify the Failure Modes

For each contributing factor, classify:

- **Proximate cause** — the immediate trigger
- **Contributing factor** — conditions that enabled the trigger or worsened its impact
- **Detection failure** — why wasn't this caught sooner?
- **Response failure** — why did recovery take longer than expected?

Each category gets independent corrective actions. You might fix the proximate cause, improve detection, and improve runbook — separately.

### Phase 4: Apply Swiss Cheese Model (James Reason)

Most incidents aren't caused by a single failure — they occur when **holes in multiple layers of defense align simultaneously**.

Map the defenses that existed:

```
SWISS CHEESE MAP:

Defensive layer 1: [what was supposed to prevent this]
- Hole: [why it didn't]

Defensive layer 2: [next defense]
- Hole: [why it didn't]

Defensive layer 3: [next defense]
- Hole: [why it didn't]

[Incident occurred when holes aligned]
```

**Active failures** (what a human did) + **latent conditions** (what the system allowed) both contribute. Fix latent conditions — they've been present for years and caused this only when activated by a particular active failure. Fixing them prevents a whole class of future incidents.

### Phase 5: Generate Action Items

Each action item gets:

- **Owner** — a specific person (not a team)
- **Deadline** — a specific date
- **Verification** — how we'll know it's done
- **Strength rating** — how much it reduces recurrence probability

**Action strength hierarchy** (strongest to weakest):

| Strength | Type | Example |
|----------|------|---------|
| **Strongest** | Eliminate | Remove the capability to do the wrong thing entirely |
| Strong | Force function | Require another step that blocks the wrong path |
| Strong | Automation | Replace human vigilance with a check |
| Medium | Simplify | Reduce the number of ways to get it wrong |
| Medium | Standardize | Make the right way the default |
| Weak | Training | Educate people about the risk |
| **Weakest** | Reminder | Email, poster, documentation |

**Rule:** If your top action items are "training" and "documentation," go back. You have weak actions. They rely on the same human vigilance that failed this time.

### Phase 6: Write the Document

```
# Postmortem: [Incident title]

**Date:** YYYY-MM-DD
**Authors:** [list]
**Status:** Draft / Final
**Classification:** Internal / Confidential

## Summary

[1-2 paragraph executive summary. Non-technical stakeholders should be able to read this.]

## Impact

- User-facing: [N users affected, M% of traffic, X minutes]
- Revenue: [$ impact if calculable]
- Data: [any loss, corruption, or exposure]
- On-call: [who paged, for how long]

## Timeline

**All times UTC.**

- `23:47` — Deploy D-1234 pushed to production
- `23:49` — Traffic shift to new version
- `23:51` — First p99 latency alert fires
- `23:52` — On-call paged (Alice)
- `23:53` — Alice acknowledges; begins investigation
- `23:55` — Alice identifies elevated 500s in payments service
- `23:58` — Alice initiates rollback
- `00:01` — Rollback complete; metrics recover
- `00:05` — Incident closed

## Contributing Factors

### Proximate Cause
[What immediately triggered the incident]

### Systemic Factors
[The conditions that made the proximate cause possible or likely]

1. **[Factor 1]**
   - Evidence: ...
   - Why it existed: ...

2. **[Factor 2]**
   - ...

### Detection Gaps
[Why didn't we know sooner?]

### Response Gaps
[Why did recovery take as long as it did?]

## Swiss Cheese Analysis

Defensive layers that existed and the holes in each:

- **Layer 1 — CI gate:** Tests passed; hole — no load tests, didn't cover this query pattern
- **Layer 2 — Canary:** Not used for this deploy; hole — deploy process doesn't require canary for payments service
- **Layer 3 — Pre-deploy runbook:** Runbook doesn't include p99 check; hole — runbook predates p99 monitoring
- **Layer 4 — Monitoring:** p99 alerting did fire but took 2 minutes; hole — alert evaluation window too long

## What Went Well

[Always include. Practices that worked. Morale fuel.]

- Rollback procedure ran cleanly
- On-call response time was under SLA
- Cross-team communication in incident channel was clear

## What Went Poorly

[Blameless. Process failures, not person failures.]

- Deploy process allowed full-traffic cutover without canary
- Runbook was out of date
- Alert evaluation window was too long for this class of problem

## Action Items

| # | Action | Strength | Owner | Deadline | Verification |
|---|--------|----------|-------|----------|--------------|
| 1 | Require canary (10/50/100 with p99 gate) for payments deploys | Automation (Strong) | Platform-eng | Apr 30 | PR merged + canary used on next 3 deploys |
| 2 | Update pre-deploy runbook with p99 check | Standardize (Medium) | Payments-oncall | Apr 18 | Runbook diff merged; team review confirms |
| 3 | Reduce p99 alert evaluation window from 5m to 1m for payments | Simplify (Medium) | SRE | Apr 22 | PagerDuty config diff merged |
| 4 | Backfill missing index | Eliminate (Strongest) | Payments | Today | Index exists; query plan confirms use |
| 5 | Add EXPLAIN ANALYZE to migration PR template | Force function (Strong) | Platform-eng | Apr 25 | PR template updated; next 3 migrations include it |

## Lessons Learned

[What do we know now that we didn't know before?]

- Deploy tests don't cover database query plan regression — we were relying on a latent assumption.
- p99 alerts fired but not fast enough to prevent user impact. Alert latency matters as much as alert accuracy.
- The migration review process was the structural hole — not the engineer, not the deploy.

## Follow-Up

- [ ] Action items tracked in [ticket system]
- [ ] Re-review in 30 days to confirm action completion
- [ ] Pattern check: are similar incidents occurring across other services? (escalate to SystemsThinking if yes)
```

### Phase 7: Distribute and Track

- Publish internally (visibility drives learning)
- Tag in incident-management system
- **Track action items to completion** — postmortems without follow-through are documentation theater
- Revisit at 30 days: did the actions actually prevent the class of failure?

## Common Mistakes

- **Single root cause framing.** Use "contributing factors" (plural). Single-root is almost always wrong.
- **Drifting into blame.** The moment "why did Alice do X?" becomes the focus, the postmortem is compromised. Rewind.
- **Weak action items.** "Training" and "reminders" rely on human vigilance. Rank actions by strength; prefer automation and force functions.
- **Skipping the "what went well" section.** It's not decoration; it reinforces the practices that saved the incident from being worse.
- **No owner or deadline on action items.** Un-owned = un-done.
- **Combining postmortem with performance review.** Never. Different meetings, different participants, different psychological contracts.
- **Hindsight bias in timeline.** "Alice should have noticed X" — at 23:55, with the signals she had, would *you* have? Reconstruct what was known at each moment, not what was discoverable in retrospect.

## Integration

- **Wraps:** 5 Whys, Fishbone, Kepner-Tregoe, Fault Tree — use whichever fits each contributing thread
- **Feeds SystemsThinking** — if the same postmortem-worthy pattern keeps recurring, escalate to Iceberg / FindArchetype
- **Feeds FMEA** — proactive sister tool; postmortem findings reveal failure modes that FMEA should anticipate going forward
- **Tracked in incident system** — Google SRE pattern: postmortem linked to every incident

## Attribution

Google SRE Book (Beyer, Jones, Petoff, Murphy, *Site Reliability Engineering*, O'Reilly 2016), Chapter 15 — canonical modern reference. Etsy debriefing practice (John Allspaw, 2016). Sidney Dekker, *Field Guide to Understanding Human Error* (Ashgate, 2014 — 3rd ed.). Blameless framing from Reason's *Human Error* (1990). Action strength hierarchy adapted from healthcare safety literature (Institute for Safe Medication Practices). "Root cause is a fallacy" framing: Will Gallego, willgallego.com, 2018.
