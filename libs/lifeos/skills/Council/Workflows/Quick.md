# Quick Workflow

Fast single-round perspective check. Use for sanity checks and quick feedback.

## Voice Notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the Quick workflow in the Council skill to get fast perspectives"}' \
  > /dev/null 2>&1 &
```

Running the **Quick** workflow in the **Council** skill to get fast perspectives...

## Prerequisites

- Topic or question to evaluate
- Optional: Custom council members

## Members

Write 4 member briefs inline (name + role + stance), then launch with `general-purpose`. See `CouncilMembers.md`.

## Execution

### Step 1: Write & Announce Quick Council

Write 4 member briefs tailored to the topic, then announce:

```markdown
## Quick Council: [Topic]

**Council Members:** [List member names with one-line roles]
**Mode:** Single round (fast perspectives)
```

### Step 2: Parallel Perspective Gathering

Launch all council members in parallel using `subagent_type: "general-purpose"`.

**Each agent prompt includes the member's brief PLUS:**
```
QUICK COUNCIL CHECK

Topic: [The topic]

[Relevant context for the topic]

Give your immediate take from your specialized perspective:
- Key concern, insight, or recommendation
- 30-50 words max
- Be direct and specific

This is a quick sanity check, not a full debate.
```

### Step 3: Output Perspectives

```markdown
### Perspectives

**[Agent 1 Name] ([traits]):**
[Brief take]

**[Agent 2 Name] ([traits]):**
[Brief take]

**[Agent 3 Name] ([traits]):**
[Brief take]

**[Agent 4 Name] ([traits]):**
[Brief take]

### Quick Summary

**Consensus:** [Do they generally agree? On what?]
**Concerns:** [Any red flags raised?]
**Recommendation:** [Proceed / Reconsider / Need full debate]
```

## When to Escalate

If the quick check reveals significant disagreement or complex trade-offs, recommend:

```
This topic has enough complexity for a full council debate.
Run: "Council: [topic]" for 3-round structured discussion.
```

## Timing

- Total: 15-30 seconds (single parallel round)

## Done

Quick perspectives gathered. Use for fast validation; escalate to DEBATE for complex decisions.
