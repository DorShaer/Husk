---
name: Context Search
description: Search prior work to add context to a request, or browse previous sessions on a topic. Use before/after a request to ground it in past work, or standalone to recall and familiarize before asking.
argument-hint: [topic]
---

# Context Search — Redirect

This command has been migrated to the **ContextSearch** skill for improved performance and expanded search coverage.

**Invoke the skill directly:**

Use the Skill tool to invoke ContextSearch with the provided arguments:

```
Skill("ContextSearch", "$ARGUMENTS")
```

The ContextSearch skill provides 3-tier search across LifeOS memory (PRDs, learning, relationships), Claude Code defaults (history, project memories), and git history (current project + 13 cross-project repos).
