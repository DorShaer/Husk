---
name: BrowserAgent
description: DEPRECATED — legacy built-in agent. Do not invoke for new work. Use the Interceptor skill for all browser automation, web scraping, form filling, data extraction, page interaction, and screenshots. Retained only for reference; its internals cannot be modified.
model: sonnet
color: cyan
skills:
  - Interceptor
maxTurns: 5
disallowedTools:
  - Edit
  - Write
---

# BrowserAgent — DEPRECATED

**Do not invoke this agent.** It is retained only because it is a built-in Claude Code agent whose definition cannot be removed.

**For all browser automation work, use the Interceptor skill:**

```
Skill("Interceptor")
```

Interceptor is the only sanctioned browser automation in PAI: real Chrome with an extension bridge, persistent logged-in sessions, zero CDP fingerprint, accurate rendering. It replaces every use case this agent was originally designed for — scraping, form filling, data extraction, screenshots, and multi-step sessions.

If Interceptor is failing on your task, fix Interceptor. Do not invoke this agent as a fallback.
