---
name: write-pr-description
description: Drafts a clean PR description from the diff. Asks for the diff or branch range, then writes Summary, Test plan, and risk notes in a reviewer-friendly shape.
---

Write a pull-request description from the change set.

If I have not shared a diff yet, ask me ONE short question:
  "Paste the diff or give me a branch range (e.g. main..my-branch)?"
and wait.

Once you have the diff:

1. **Title**: under 70 characters, conventional-commits style with scope when obvious. `fix(component): ...` / `feat(scope): ...` / `chore(deps): ...`. Lowercase after the colon, no period.

2. **Summary** (1 to 3 bullets): explain WHY, not WHAT. The diff already shows what. Why does this change exist? What user pain or bug or risk does it close?

3. **Test plan** (markdown checklist): the smallest set of steps a reviewer or CI runs to verify the change. Real commands, real assertions. No "manually tested" hand-waving.

4. **Risks / rollout notes** (only if relevant): migration order, feature flag, breaking change, dep bump consequences. Skip the section if there is nothing to say.

Style: tight, declarative, no marketing language. Imperative mood in the title.
