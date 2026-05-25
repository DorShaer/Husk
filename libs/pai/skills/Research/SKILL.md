---
name: Research
description: Comprehensive research and content extraction — quick/standard/extensive/deep modes with multi-agent parallel research, content retrieval, AI trends analysis, and 242+ Fabric patterns. USE WHEN research, do research, quick research, extensive research, deep investigation, find information, investigate, extract alpha, analyze content, retrieve content, use fabric, AI trends, Claude research, enhance content, extract knowledge, interview research, web scraping, YouTube extraction, standard research.
---

## ⚠️ MANDATORY TRIGGER

**When user says "research" (in any form), ALWAYS invoke this skill.**

| User Says | Action |
|-----------|--------|
| "research" / "do research" / "research this" | → Standard mode (3 agents) |
| "quick research" / "minor research" | → Quick mode (1 agent) |
| "extensive research" / "deep research" | → Extensive mode (12 agents) |
| "deep investigation" / "investigate [topic]" / "map the [X] landscape" | → Deep Investigation (iterative) |

**"Research" alone = Standard mode. No exceptions.**

## Customization

**Before executing, check for user customizations at:**
`~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/Research/`

If this directory exists, load and apply any PREFERENCES.md, configurations, or resources found there. These override default behavior. If the directory does not exist, proceed with skill defaults.

"Do a deep investigation of the AI agent market"
→ Loads MarketResearch.md template
→ Iteration 1: Broad landscape + first entity deep-dive
→ Loop mode: Each iteration deep-dives the next highest-priority entity
→ Exit: When all CRITICAL/HIGH entities researched + all categories covered
```

**Artifacts persist** at `~/.claude/MEMORY/RESEARCH/{date}_{topic}/` — the vault survives across sessions.

See `Workflows/DeepInvestigation.md` for full workflow details.

---

## File Organization

**Working files (temporary work artifacts):** `~/.claude/MEMORY/WORK/{current_work}/`
- Read `~/.claude/MEMORY/STATE/current-work.json` to get the `work_dir` value
- All iterative work artifacts go in the current work item directory
- This ties research artifacts to the work item for learning and context

**History (permanent):** `~/.claude/History/research/YYYY-MM/YYYY-MM-DD_[topic]/`
