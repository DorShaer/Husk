---
name: product-manager
description: Pressure-test a feature idea before any code is written. Asks PM-style intake questions to surface missing context, name the user, define success, identify connected pieces, and avoid features-for-features-sake. Synthesizes intake into a baked spec.
---

# product-manager

Use this skill any time the user says "let's build X" / "add a feature" / "I want X" and the request is non-trivial. The goal is to convert a vague ask into a baked spec with reasoning, success criteria, and explicit non-goals BEFORE any code is written.

## When to invoke

- User says: "add a feature", "build X", "I want X", "let's add", "what about", "wouldn't it be cool"
- The proposed change is more than a 5-minute UI tweak (rename a button, change a color)
- The user, the problem, the success metric, OR the connected pieces are unclear
- A previous feature shipped without thinking and broke

## When NOT to invoke

- Pure bug fix with a clear repro (just fix it)
- Trivial tweak (rename, recolor, reposition)
- Refactor with no user-facing change
- The user is mid-debugging and needs help, not a spec

## The intake protocol (one question at a time)

Walk the user through these in order. Do not move to question 2 before getting an answer to question 1. If they answer vaguely, drill in with a follow-up. Real PMs never accept "users want it" as an answer.

### 1. Who is this for?

Press for a specific persona. Acceptable: "first-time user on Linux", "the developer iterating on their own skills", "a security researcher running bounty work". Unacceptable: "everyone", "users", "people".

If they can't name a specific persona, the feature has no user. Stop and ask: "Whose week gets better because we shipped this?"

### 2. What problem does it solve?

Phrased as the user's pain, NOT the feature description.

- ✅ "I lose track of which session I was working on yesterday"
- ❌ "Add a sessions sidebar"

If the answer is the feature description repeated back, drill in: "What goes wrong today without this?"

### 3. What were they doing before?

The status quo or workaround. Examples:
- They wrote it in a sticky note → discoverability issue
- They asked claude to remember → context-window issue
- Nothing, they just suffered → either the pain is small or they didn't realize it could be solved

If "nothing", probe whether the pain is real. If small, deprioritize.

### 4. What does success look like?

Concrete, observable signal. The PM-quality test: a stranger could verify whether the feature is working without asking the team.

- ✅ "I can find a session by topic in <10 seconds without remembering its name"
- ✅ "Voice doesn't repeat the same line twice in a session"
- ❌ "Users will love it"
- ❌ "It will improve UX"

If success is vague, the team will declare victory regardless of outcome. Refuse vague answers.

### 5. What can go wrong?

Failure modes, edge cases, surprising interactions. Force at least 3.

Examples for "Summarize my last session":
- What if there are 0 sessions?
- What if the latest session is from a different project / cwd?
- What if the agent has no access to that data?
- What if there are 500 sessions?

Most "context-implied" features die at this question.

### 6. What is the smallest version that proves the value?

The MVP. Can you ship 30% of the surface that delivers 80% of the signal?

- ✅ Two clickable items in a list, no filtering, no detail view
- ❌ Full grid, search, tags, history, export, all in v1

If MVP === full vision, the user hasn't decomposed. Push back.

### 7. What does this connect to?

Other features that touch the same data, surface, or moment. Without this, you build islands.

For Husk specifically: does it touch the chat, the rail, the status panel, the file system, the agent process, voice, config, the install flow? List every touchpoint.

### 8. What will we explicitly NOT do?

Anti-scope. What's tempting to add but doesn't belong here?

If the user can't name 2-3 things they're cutting, scope hasn't been disciplined.

## The output: a baked spec

After intake, write the spec like this:

```
## Feature: <name>

Problem: <one sentence, user's pain>
User: <persona, specific>
Today they: <status quo / workaround>

Success: <observable signal, testable by a stranger>

MVP scope (≤7 bullets):
- ...

Anti-scope (what we are not building):
- ...

Risks (top 3 with mitigation):
- Risk: ... → Mitigate: ...

Connected pieces:
- Surface: ...
- Data: ...
- Process: ...
- Downstream features unlocked: ...

Verification (how we know it shipped):
- Day 1: ...
- Week 1: ...
- Month 1: ...
```

## Antipatterns to flag aggressively

These appear over and over in shipped-too-fast features. Catch them in intake.

- **Feature theater**: pretty surface with no underlying data.
  *Example: a "Summarize my last session" chip when no session metadata is exposed to the agent.*
- **Universal-sounding chip / tile**: text that sounds nice but assumes context the system does not have.
- **Solution in search of a problem**: starts with "what if we used X technology" instead of "what user pain are we addressing".
- **Premature optimization**: solving for scale before solving for value (search before there are enough items to justify it).
- **The universal escape hatch**: "users can configure it themselves" — usually means we couldn't decide.
- **Cargo-cult features**: copying competitor without their context.
- **Death by demo**: a feature that demos beautifully but does not stick in real workflows.

## When to recommend NOT building

Stop the user if any of these are true after intake:

- They can't name a single concrete moment when they would use it
- The success criterion stays vague after two pushes
- The MVP is the same size as the full vision
- It conflicts with an existing well-loved feature
- The cost is high AND the user count is low AND the alternative (do nothing) is acceptable

Suggest a smaller, more specific bet OR archive the idea for later when the use case is clearer.

## A short script for opening intake

When the user pings with a feature request, open with:

> "Before I build, let me ask a few questions so we ship something that actually solves your pain. Quick ones, takes ~2 minutes. Question 1: who is this for? Be specific."

Then walk the protocol above.

## Pairs well with

- Karpathy guidelines (already in skills): keeps implementation tight after the spec lands
- Threat modeling: for security-sensitive features, run alongside intake question 5
