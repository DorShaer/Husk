---
version: 1.0.0
---

# ISA Hierarchy & Cross-ISA Integration

> On-demand reference. Single-ISA work is the leaf case and covers virtually all real tasks — 0 of 472 ISAs in the archive use `parent:`/`children:`/Bridge Criteria as of 2026-07-07. The hierarchy machinery below exists for genuinely large builds (a Tolkien-scale world, an enterprise product) and is loaded from here, not from the every-turn Algorithm doctrine. The Algorithm keeps a one-paragraph stub pointing here.

Anything too big for one file — a Tolkien-scale world, an enterprise app, a 500-dev product — is a **tree of ISAs**, not one monolith with 35,000 criteria. The mechanism:

**Linking.** An ISA declares its place in the tree via frontmatter `parent: <slug>` and `children: [<slug>, …]`. The parent holds product intent (a small Goal + a few container ISCs); each child owns one subsystem's closure. Children may have children. Text is cheap and git is easy, so branching/diverging ISAs (Team A's vision vs Team B's) is tracked the same way — divergence is explicit and auditable, never silent drift.

**Constraint inheritance (HARD).** A child ISA's `## Constraints` implicitly include every ancestor Constraint. A child ISC may not violate an inherited Constraint; if it must, that's a parent-level renegotiation logged in the parent's `## Decisions`, not a quiet child override. This is what keeps a 118-subsystem world "speaking the same language."

**Dependencies (`## Dependencies`).** Each ISA states what it needs from siblings/ancestors as machine-readable lines — `requires: auth-isa — valid session-token contract`, `requires: physics-isa — damage constants`. OBSERVE, when the ISA has any `## Dependencies`, loads those declared dependency ISAs into context before scaffolding criteria, so the work is written against the real contracts, not guesses. (In practice the 13 ISAs that use `## Dependencies` name files/tools/CLIs rather than sibling ISA slugs — the same need the THINK-phase Prerequisite Manifest already covers.)

**Bridge criteria (`## Bridge Criteria`).** A leaf ISC verifies a subsystem in isolation. A **bridge ISC** verifies the *seam* between two ISAs and lives in the parent (or the more-central of the two): `- [ ] ISC-N: Bridge: Psionic willpower cost never exceeds the Magic resource budget`, with `anchors_to: cross: magic-isa` in Test Strategy. VERIFY runs bridge criteria as a distinct pass after leaf criteria — integration is a first-class test surface, not an afterthought. Adding psionics to a system that already has magic can't "work sometimes and break on contact"; the bridge ISC is the probe that forbids it.

**Blast-radius (detection, not auto-resolution).** When an ISA with a `parent:`/`children:`/`cross:` relationship changes, a blast-radius pass walks the dependency graph and lists every downstream ISC that now needs re-verification (`changing willpower cost touches magic-isa: 7 ISCs, race-isa: 3, history-isa: 2`). It shows the blast radius before BUILD so the change is a decision, not a surprise. **The system detects and surfaces conflicts; it does not resolve cross-ISA governance conflicts automatically** — which team's conflicting criterion wins is a human call, made visible here instead of buried in ambiguity.

**When to split into a tree (judgment, not a count).** One ISA until a single file stops being legible — usually when Vision/Goal names subsystems that each carry their own Vision, Constraints, and independent test surface. A website is one ISA; an RPG world is a master ISA plus a fleet of subsystem ISAs, each possibly nested. The Interview (E5) surfaces the intended depth; don't pre-split a medium app that fits in one file.
