# IdeaGeneration Workflow

## Voice Notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the IdeaGeneration workflow in the BeCreative skill to brainstorm solutions"}' \
  > /dev/null 2>&1 &
```

Running **IdeaGeneration** in **BeCreative**...

---

**When to use:** Brainstorming, problem-solving, innovation.

## Instruction

Inside extended thinking, generate 5 diverse solution approaches (p<0.10 each) via Verbalized Sampling — pull from different industries, inverted framings, and hidden constraints — then present the strongest with a short reason it's the breakthrough. Prepend the problem to:

```markdown
IDEA GENERATION — DEEP THINKING + VERBALIZED SAMPLING
Generate 5 diverse solution approaches with probabilities (p<0.10 each), then present the most breakthrough one with reasoning.

## Problem
[Problem or challenge description]
```

## Done when

- The 5 approaches rest on different underlying assumptions, not one approach at five scales.
- At least one draws from a domain unrelated to the problem's home field.
- The presented solution says why it beats the conventional answer.

## Best For

- Strategic planning, business innovation
- Technical problem-solving, product development
- Process improvement
