# Round Structure

How council debates progress through rounds.

## Members

All council members are custom agents you write inline as briefs, then launch with `general-purpose`. See `CouncilMembers.md`.

## Three-Round Debate Structure

### Round 1 - Initial Positions

Each member gives their take from their specialized perspective. No interaction yet - just establishing positions.

**Goal:** Surface diverse viewpoints before interaction.

### Round 2 - Responses & Challenges

Each agent reads Round 1 transcript and responds to specific points:
- "I disagree with [Agent Name]'s point about X because..."
- "Building on [Agent Name]'s concern about Y..."

**Goal:** Genuine intellectual friction through direct engagement.

### Round 3 - Synthesis & Convergence

Each agent identifies:
- Where the council agrees
- Where they still disagree
- Their final recommendation given the full discussion

**Goal:** Surface convergence and remaining tensions honestly.

## The Value Is In Interaction

Not just collecting opinions - genuine challenges where members with domain-specific knowledge push back on each other's actual points with informed perspectives.

## Timing

| Phase | Duration | Parallelism |
|-------|----------|-------------|
| Write briefs | inline | orchestrator writes 4 briefs |
| Round 1 | 10-20 sec | All agents parallel |
| Round 2 | 10-20 sec | All agents parallel |
| Round 3 | 10-20 sec | All agents parallel |
| Synthesis | 5 sec | Sequential |

**Total: 40-90 seconds for full debate**
