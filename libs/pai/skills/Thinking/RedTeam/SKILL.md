---
name: RedTeam
description: 32 adversarial agents to destroy weak arguments and find fatal flaws — parallel analysis and adversarial validation. USE WHEN red team, attack idea, counterarguments, critique, stress test, poke holes, devil's advocate, find weaknesses, break this, parallel analysis, adversarial validation.
---

## Customization

**Before executing, check for user customizations at:**
`~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/RedTeam/`

If this directory exists, load and apply any PREFERENCES.md, configurations, or resources found there. These override default behavior. If the directory does not exist, proceed with skill defaults.

Running the **WorkflowName** workflow in the **RedTeam** skill to ACTION...
```

| Trigger | Workflow |
|---------|----------|
| Red team analysis (stress-test existing content) | `Workflows/ParallelAnalysis.md` |
| Adversarial validation (produce new content via competition) | `Workflows/AdversarialValidation.md` |

---

## Quick Reference

| Workflow | Purpose | Output |
|----------|---------|--------|
| **ParallelAnalysis** | Stress-test existing content | Steelman + Counter-argument (8-points each) |
| **AdversarialValidation** | Produce new content via competition | Synthesized solution from competing proposals |

**The Five-Phase Protocol (ParallelAnalysis):**
1. **Decomposition** - Break into 24 atomic claims
2. **Parallel Analysis** - 32 agents examine strengths AND weaknesses
3. **Synthesis** - Identify convergent insights
4. **Steelman** - Strongest version of the argument
5. **Counter-Argument** - Strongest rebuttal

---

## Context Files

- `Philosophy.md` - Core philosophy, success criteria, agent types
- `Integration.md` - Skill integration, FirstPrinciples usage, output format

---

## Examples

**Attack an architecture proposal:**
```
User: "red team this microservices migration plan"
--> Workflows/ParallelAnalysis.md
--> Returns steelman + devastating counter-argument (8 points each)
```

**Devil's advocate on a business decision:**
```
User: "poke holes in my plan to raise prices 20%"
--> Workflows/ParallelAnalysis.md
--> Surfaces the ONE core issue that could collapse the plan
```

**Adversarial validation for content:**
```
User: "battle of bots - which approach is better for this feature?"
--> Workflows/AdversarialValidation.md
--> Synthesizes best solution from competing ideas
```

---

**Last Updated:** 2025-12-20
