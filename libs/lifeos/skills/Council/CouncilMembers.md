# Council Members

Council members are custom agents you write inline, then launch with `subagent_type: "general-purpose"`. There is no composition tool and no trait matrix — you write each member's brief directly, tailored to the topic. A capable model writes a sharper, more topic-specific persona than any generic trait lookup, so this is both simpler and better.

## Why inline briefs, not built-in types

A bare built-in agent type (or a generic `general-purpose` with no persona) has no stake in the topic and produces bland agreement. Council needs members who disagree on the merits. The friction comes from each member having a distinct role, expertise, and stance — which you supply in the brief. Write four different briefs; never launch four identical agents.

## How to Create Council Members

### Step 1: Analyze the Topic

Decide what perspectives would create the most productive friction for THIS specific debate. Design the roles around the topic, not from a generic list.

**Example — "Should we use WebSockets or SSE?"**
- Real-time systems architect who defends push-first bidirectional transport
- Frontend-DX advocate who wants the simplest thing that ships
- Ops/reliability skeptic who distrusts long-lived connections
- Industry researcher who weighs precedent and adoption data

**Example — "Is AI overhyped?"**
- AI infrastructure builder who ships with these tools daily
- Security practitioner skeptic who has seen the failure modes
- Pragmatic engineer focused on real-world trade-offs
- Evidence-based researcher who wants the numbers

### Step 2: Write Each Member's Brief

For each member, write 2–4 sentences: a name, their role/expertise, the stance they hold, and what they'll push on and attack. That paragraph IS the persona.

Example brief:
> **Mara — real-time systems architect.** Believes push-first. Will defend WebSocket bidirectionality and attack SSE's connection-count limits and reconnection story. Speaks precisely, cites protocol behavior.

### Step 3: Launch with general-purpose

Spawn each member with the brief you wrote as the system context, plus the round instructions and topic. Always `subagent_type: "general-purpose"`.

```typescript
Agent({
  description: "Council member 1 - systems architect",
  prompt: <member brief> + <round instructions> + <topic context>,
  subagent_type: "general-purpose",
  model: "sonnet"
})
```

## Default Perspective Slots

When the user doesn't specify members, cover these four perspectives — but write each one tailored to the topic, not as a generic role:

| Slot | Purpose |
|------|---------|
| **Builder** | Has built things in this domain; argues from what actually ships |
| **Skeptic** | Challenges assumptions, finds the flaws and failure modes |
| **Pragmatist** | Implementation reality, cost, and trade-offs |
| **Analyst** | Data, precedent, and external evidence |

The slots are a starting guide. Adjust the mix to the topic — a pure design question may want two builders and a user advocate instead.
