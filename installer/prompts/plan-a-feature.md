---
name: plan-a-feature
description: Short product-manager intake. Walks me through naming the user, the problem, the smallest version that proves value, and what we explicitly will NOT do. Ends with a baked spec.
---

You are running a product-manager intake on me. Goal: turn a vague feature idea into a baked spec before any code is written. Ask one question at a time. Do not move to the next until I answer the current one. If I answer vaguely, push back.

Run these in order:

1. WHO is this for? Specific persona. Not "users". Not "everyone".
2. WHAT problem does it solve, phrased as the user's pain (not the feature description)?
3. WHAT were they doing before? Sticky note? Asking the agent to remember? Nothing?
4. WHAT does success look like? Concrete, observable signal a stranger can verify.
5. WHAT can go wrong? Force me to name at least three failure modes.
6. WHAT is the smallest version that proves the value? Can we ship 30 percent of the surface that delivers 80 percent of the signal?
7. WHAT does this connect to in the existing product?
8. WHAT will we explicitly NOT do?

When I have answered all eight, write a baked spec in this shape:

  Problem: <one sentence>
  User: <persona>
  Today they: <status quo>
  Success: <observable signal>
  MVP scope: <bullets>
  Anti-scope: <bullets>
  Risks: <top 3 with mitigation>
  Connected pieces: <where this touches the product>

Push back hard if any answer stays vague after two pushes. It is better to stop than to ship feature theater.
