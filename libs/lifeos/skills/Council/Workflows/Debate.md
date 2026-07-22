# Debate Workflow

Full structured multi-agent debate with 3 rounds and visible transcript.

## Voice Notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the Debate workflow in the Council skill to run multi-agent debate"}' \
  > /dev/null 2>&1 &
```

Running the **Debate** workflow in the **Council** skill to run multi-agent debate...

## Prerequisites

- Topic or question to debate
- Optional: Custom council member descriptions (otherwise auto-composed)

## Members

Council members are custom agents you write inline, then launch with `subagent_type: "general-purpose"`. Write four different briefs tailored to the topic — a bare built-in type with no persona produces bland agreement. See `CouncilMembers.md`.

## Execution

### Step 0: Write the Council Members

Before any debate rounds, analyze the topic, decide the 4 perspectives that create the most productive friction, and write a brief for each: a name, their role/expertise, the stance they hold, and what they'll push on. No tool call — you write these directly. See `CouncilMembers.md` for the slot guidance and an example brief.

### Step 1: Announce the Council

Output the debate header with the member names:

```markdown
## Council Debate: [Topic]

**Council Members:** [List member names with their one-line role descriptions]
**Rounds:** 3 (Positions -> Responses -> Synthesis)
```

### Step 2: Round 1 - Initial Positions

Launch 4 parallel Agent calls (one per composed council member).

**CRITICAL: Use `subagent_type: "general-purpose"` for ALL agents. NEVER use built-in types.**

**Each agent prompt includes the member's brief PLUS:**
```
COUNCIL DEBATE - ROUND 1: INITIAL POSITIONS

Topic: [The topic being debated]

[Full topic context — include relevant background, data, quotes, etc. that the agent needs to form an informed opinion]

Give your initial position on this topic from your specialized perspective.
- Speak in first person as your character
- Be specific and substantive (100-150 words)
- State your key concern, recommendation, or insight
- You'll respond to other council members in Round 2
```

**Output each response as it completes:**
```markdown
### Round 1: Initial Positions

**[Agent 1 Name] ([trait description]):**
[Response]

**[Agent 2 Name] ([trait description]):**
[Response]

**[Agent 3 Name] ([trait description]):**
[Response]

**[Agent 4 Name] ([trait description]):**
[Response]
```

### Step 3: Round 2 - Responses & Challenges

Launch 4 parallel Agent calls with Round 1 transcript included.

**Each agent prompt includes the member's brief PLUS:**
```
COUNCIL DEBATE - ROUND 2: RESPONSES & CHALLENGES

Topic: [The topic being debated]

Here's what the council said in Round 1:
[Full Round 1 transcript]

Now respond to the other council members:
- Reference specific points they made ("I disagree with [Name]'s point about X...")
- Challenge assumptions or add nuance
- Build on points you agree with
- Maintain your specialized perspective
- 100-150 words

The value is in genuine intellectual friction -- engage with their actual arguments.
```

### Step 4: Round 3 - Synthesis

Launch 4 parallel Agent calls with Round 1 + Round 2 transcripts.

**Each agent prompt includes the member's brief PLUS:**
```
COUNCIL DEBATE - ROUND 3: SYNTHESIS

Topic: [The topic being debated]

Full debate transcript so far:
[Round 1 + Round 2 transcripts]

Final synthesis from your perspective:
- Where does the council agree?
- Where do you still disagree with others?
- What's your final recommendation given the full discussion?
- 100-150 words

Be honest about remaining disagreements -- forced consensus is worse than acknowledged tension.
```

### Step 5: Council Synthesis

After all rounds complete, synthesize the debate:

```markdown
### Council Synthesis

**Areas of Convergence:**
- [Points where 3+ agents agreed]
- [Shared concerns or recommendations]

**Remaining Disagreements:**
- [Points still contested between agents]
- [Trade-offs that couldn't be resolved]

**Recommended Path:**
[Based on convergence and weight of arguments, the recommended approach is...]
```

## Timing

- Writing member briefs: inline (orchestrator writes 4 briefs)
- Round 1: ~10-20 seconds (parallel)
- Round 2: ~10-20 seconds (parallel)
- Round 3: ~10-20 seconds (parallel)
- Synthesis: ~5 seconds

**Total: 40-90 seconds for full debate**

## Done

Debate complete. The transcript shows the full intellectual journey from initial positions through challenges to synthesis.
