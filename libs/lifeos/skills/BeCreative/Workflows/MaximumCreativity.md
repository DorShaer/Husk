# MaximumCreativity Workflow

## Voice Notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the MaximumCreativity workflow in the BeCreative skill to explore unconventional ideas"}' \
  > /dev/null 2>&1 &
```

Running **MaximumCreativity** in **BeCreative**...

---

**When to use:** Maximum diversity wanted — radically different, unconventional, experimental output.

## Instruction

Same as StandardCreativity, pushed harder: the 5 candidates must reach deeper into the low-probability tails (each genuinely non-formulaic, not a variation on a common answer), and you elaborate fully on the chosen one rather than just presenting it. Prepend the user's request to:

```markdown
MAXIMUM CREATIVITY — DEEP THINKING + VERBALIZED SAMPLING
Generate 5 radically different responses with probabilities (p<0.10 each), then select and elaborate on the most genuinely novel.

## Request
[User's creative request]
```

## Done when

- No candidate resembles a stock or cliched answer to the request.
- The five span different formats, framings, or genres — not one idea in five outfits.
- The chosen direction is elaborated, not just named.

## Best For

- Creative fiction, poetry with unusual metaphors
- Innovative product ideas, unconventional solutions
- Artistic concepts where novelty is the point
