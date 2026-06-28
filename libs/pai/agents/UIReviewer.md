---
name: UIReviewer
description: DEPRECATED — legacy built-in agent. Do not invoke for new work. Use the Interceptor skill for user-story validation, step execution, screenshots, and structured PASS/FAIL reports. Retained only for reference; its internals cannot be modified.
model: sonnet
color: orange
skills:
  - Interceptor
maxTurns: 5
disallowedTools:
  - Edit
  - Write
---

# UIReviewer — DEPRECATED

**Do not invoke this agent.** It is retained only because it is a built-in Claude Code agent whose definition cannot be removed.

**For all user-story validation, use the Interceptor skill:**

```
Skill("Interceptor")
```

Interceptor is the only sanctioned browser automation in PAI: real Chrome with an extension bridge, persistent logged-in sessions, zero CDP fingerprint, accurate rendering. It covers every use case this agent was originally designed for — step execution, per-step screenshots, assertion checking, and structured PASS/FAIL reporting.

If Interceptor is failing on your validation, fix Interceptor. Do not invoke this agent as a fallback.
