# StandardCreativity Workflow

## Voice Notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the StandardCreativity workflow in the BeCreative skill to apply creative thinking"}' \
  > /dev/null 2>&1 &
```

Running **StandardCreativity** in **BeCreative**...

---

**When to use:** Most creative tasks needing depth and quality — creative writing, high-stakes work, when one polished best answer is needed.

## Instruction

Inside extended thinking, generate 5 internally diverse candidates (p<0.10 each) via Verbalized Sampling, then output the single strongest — polished and refined. Prepend the user's request to:

```markdown
DEEP THINKING + VERBALIZED SAMPLING
Generate 5 diverse responses with probabilities (p<0.10 each), then output the most innovative.

## Request
[User's creative request]
```

## Done when

- The 5 candidates are genuinely distinct from each other, not rephrasings of one idea.
- The surfaced answer is the least-obvious of the five that still fully satisfies the request.

## Best For

- Creative writing (stories, poems, dialogue)
- High-stakes creative work
- When a single polished best answer is needed
