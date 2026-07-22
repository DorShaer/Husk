# DomainSpecific Workflow

## Voice Notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the DomainSpecific workflow in the BeCreative skill to apply domain creativity"}' \
  > /dev/null 2>&1 &
```

Running **DomainSpecific** in **BeCreative**...

---

**When to use:** Creativity scoped to a domain (artistic, business, technical) where the winning candidate must be judged against that domain's own criteria.

## Instruction

Run the standard generate-diverse-candidates move, then evaluate against the domain's success criteria instead of generic novelty — emotional impact and coherence for art, scalability and customer behavior for business, and so on. Prepend the challenge to:

```markdown
DEEP THINKING — [DOMAIN] CREATIVITY
Generate diverse candidates that challenge [domain] conventions, then select the one that best meets [domain] criteria (e.g. emotional impact + coherence for art; scalability + customer behavior for business).

## Challenge
[Domain challenge]
```

## Done when

- Candidates break a real convention of the named domain, not a generic one.
- Selection is justified against domain criteria, not just "most creative."

## Best For

- **Artistic:** visual arts, music, writing, performance, design
- **Business:** strategy, marketing, product, operations, growth
- Any domain with its own bar for "good"
