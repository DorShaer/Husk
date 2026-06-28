---
name: QATester
description: DEPRECATED — legacy built-in agent. Do not invoke for new work. Use the Interceptor skill for Gate 4 browser-based QA validation, screenshots, console checks, and user-flow testing. Retained only for reference; its internals cannot be modified.
model: opus
color: yellow
skills:
  - Interceptor
maxTurns: 5
disallowedTools:
  - Edit
  - Write
---

# QATester — DEPRECATED

**Do not invoke this agent.** It is retained only because it is a built-in Claude Code agent whose definition cannot be removed.

**For all QA validation work, use the Interceptor skill:**

```
Skill("Interceptor")
```

Interceptor is the only sanctioned browser automation in PAI: real Chrome with an extension bridge, persistent logged-in sessions, zero CDP fingerprint, accurate rendering. It covers every use case this agent was originally designed for — Gate 4 browser validation, screenshot evidence, console-log checks, user-flow testing, and pass/fail determination.

If Interceptor is failing on your validation, fix Interceptor. Do not invoke this agent as a fallback.
