---
provenance: template
---

# CUSTOMIZATIONS

User-specific extensions of LifeOS system components. The LifeOS framework ships with generic skills, agents, action runners, and pipeline executors. This directory holds the per-user content that those generic components layer over at runtime — the things that make *your* LifeOS different from every other LifeOS install.

## Contract

Anything running a system component MUST look here for user content that applies to **this principal but not every LifeOS user.**

- **Skills** read `CUSTOMIZATIONS/SKILLS/<SkillName>/` for per-user preferences, source lists, voice profiles, project names, and other context the public skill body cannot contain. The skill body stays generic; the user file overlays at runtime.
- **Arbol** reads `CUSTOMIZATIONS/ARBOL/` for the user's actions, pipelines, flows, and worker code. Resolution order is always personal-first: `CUSTOMIZATIONS/ARBOL/ACTIONS/<name>` overrides `LIFEOS/ARBOL/Actions/<name>`; same for `PIPELINES/` and `FLOWS/`. The user copy wins.

## Structure

```
CUSTOMIZATIONS/
├── SKILLS/      ← per-skill override files (one subdir per customized skill)
└── ARBOL/       ← user actions, pipelines, flows, and Arbol worker code
    ├── ACTIONS/
    ├── PIPELINES/
    ├── FLOWS/
    └── (worker code: Workers/, cli/, scripts/, etc.)
```

## Why This Lives Under USER

`LIFEOS/USER/` holds everything specific to one principal. `CUSTOMIZATIONS/` is the part of USER that other system components read on every invocation — not standalone reference data (`CONTACTS.md`, `OPINIONS.md`) but live overlays that change how LifeOS behaves for this user.

## When To Add Something Here

- A skill needs your taste, your source list, your projects, or your voice → write a `SKILLS/<SkillName>/PREFERENCES.md` (or whatever file that skill documents reading).
- You want to override a system action or pipeline with your own version → drop the override in `ARBOL/ACTIONS/<name>` or `ARBOL/PIPELINES/<name>.yaml`. The runner picks yours first.
- You want a brand-new action or pipeline that only makes sense for you → same — put it under `ARBOL/`. There's no "personal vs. user" split; if it's yours, it goes here.

## When NOT To Put Something Here

- Reference data the user just **reads** (identity, projects, contacts, opinions, TELOS) — that's a sibling of `CUSTOMIZATIONS/`, not a child. Customizations are about *behavior*, not *facts*.
- One-off experiments → use `MEMORY/WORK/{slug}/` instead and promote to `CUSTOMIZATIONS/` if it earns its keep.
