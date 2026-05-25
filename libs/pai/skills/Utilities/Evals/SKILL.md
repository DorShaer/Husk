---
name: Evals
description: Objective eval metrics via code/model/human graders with pass@k/pass^k scoring. USE WHEN eval, evaluate, test agent, benchmark, verify behavior, regression test, capability test, run eval, compare models, compare prompts, create judge, create use case, view results, failure to task, suite manager, transcript capture, trial runner.
---

## Customization

**Before executing, check for user customizations at:**
`~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/Evals/`

If this directory exists, load and apply any PREFERENCES.md, configurations, or resources found there. These override default behavior. If the directory does not exist, proceed with skill defaults.

### ALGORITHM Integration

Evals is a verification method for THE ALGORITHM ISC rows:

```bash
# Run eval and update ISC row
bun run ~/.claude/skills/Utilities/Evals/Tools/AlgorithmBridge.ts -s regression-core -r 3 -u
```

ISC rows can specify eval verification:
```
| # | What Ideal Looks Like | Verify |
|---|----------------------|--------|
| 1 | Auth bypass fixed | eval:auth-security |
| 2 | Tests all pass | eval:regression |
```

---

## Available Graders

### Code-Based (Fast, Deterministic)

| Grader | Use Case |
|--------|----------|
| `string_match` | Exact substring matching |
| `regex_match` | Pattern matching |
| `binary_tests` | Run test files |
| `static_analysis` | Lint, type-check, security scan |
| `state_check` | Verify system state after execution |
| `tool_calls` | Verify specific tools were called |

### Model-Based (Nuanced)

| Grader | Use Case |
|--------|----------|
| `llm_rubric` | Score against detailed rubric |
| `natural_language_assert` | Check assertions are true |
| `pairwise_comparison` | Compare to reference with position swap |

---

## Domain Patterns

Pre-configured grader stacks for common agent types:

| Domain | Primary Graders |
|--------|-----------------|
| `coding` | binary_tests + static_analysis + tool_calls + llm_rubric |
| `conversational` | llm_rubric + natural_language_assert + state_check |
| `research` | llm_rubric + natural_language_assert + tool_calls |
| `computer_use` | state_check + tool_calls + llm_rubric |

See `Data/DomainPatterns.yaml` for full configurations.

---

## Task Schema (YAML)

```yaml
task:
  id: "fix-auth-bypass_1"
  description: "Fix authentication bypass when password is empty"
  type: regression  # or capability
  domain: coding

  graders:
    - type: binary_tests
      required: [test_empty_pw.py]
      weight: 0.30

    - type: tool_calls
      weight: 0.20
      params:
        sequence: [read_file, edit_file, run_tests]

    - type: llm_rubric
      weight: 0.50
      params:
        rubric: prompts/security_review.md

  trials: 3
  pass_threshold: 0.75
```

---

## Resource Index

| Resource | Purpose |
|----------|---------|
| `Types/index.ts` | Core type definitions |
| `Graders/CodeBased/` | Deterministic graders |
| `Graders/ModelBased/` | LLM-powered graders |
| `Tools/TranscriptCapture.ts` | Capture agent trajectories |
| `Tools/TrialRunner.ts` | Multi-trial execution with pass@k |
| `Tools/SuiteManager.ts` | Suite management and saturation |
| `Tools/FailureToTask.ts` | Convert failures to test tasks |
| `Tools/AlgorithmBridge.ts` | ALGORITHM integration |
| `Data/DomainPatterns.yaml` | Domain-specific grader configs |

---

## Key Principles (from Anthropic)

1. **Start with 20-50 real failures** - Don't overthink, capture what actually broke
2. **Unambiguous tasks** - Two experts should reach identical verdicts
3. **Balanced problem sets** - Test both "should do" AND "should NOT do"
4. **Grade outputs, not paths** - Don't penalize valid creative solutions
5. **Calibrate LLM judges** - Against human expert judgment
6. **Check transcripts regularly** - Verify graders work correctly
7. **Monitor saturation** - Graduate to regression when hitting 95%+
8. **Build infrastructure early** - Evals shape how quickly you can adopt new models

---

## Related

- **ALGORITHM**: Evals is a verification method
- **Science**: Evals implements scientific method
- **Browser**: For visual verification graders
