# TreeOfThoughts Workflow

## Voice Notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the TreeOfThoughts workflow in the BeCreative skill to explore solution paths"}' \
  > /dev/null 2>&1 &
```

Running **TreeOfThoughts** in **BeCreative**...

---

**When to use:** Complex creative problem-solving where multiple solution paths must be explored and balanced before committing.

## Instruction

Inside extended thinking, branch: identify 3-5 fundamentally different approaches, expand the promising ones into variations, evaluate each on both creativity and viability, then synthesize the best elements into one solution. Prepend the challenge to:

```markdown
DEEP THINKING + TREE OF THOUGHTS
1. Branch into 3-5 fundamentally different approaches.
2. Expand the promising branches into variations and sub-approaches.
3. Evaluate every path on creativity AND viability.
4. Synthesize the strongest elements into one solution.

## Challenge
[Complex creative challenge]
```

## Done when

- The branches are fundamentally different strategies, not variants of one.
- The final solution names which branch(es) it draws from and why.
- The synthesis is both novel and practical against the challenge's constraints.

## Best For

- Complex strategic decisions
- Multi-constraint optimization
- High-stakes innovation where several factors must balance
