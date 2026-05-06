---
name: submit
description: Pre-submission checklist for a bug bounty report. Validates that the report is complete, the PoC works, evidence is included, and CVSS is set aggressively. Use right before submitting.
user-invocable: true
allowed-tools: Read, Grep, Glob, Bash
---

Run the pre-submission checklist for the report in the current directory.

Check each item and report pass/fail:

1. PoC file exists and has no syntax errors (run python3 -c "import ast; ast.parse(open(...).read())" or equivalent)
2. PoC has no hardcoded credentials or tokens
3. PoC takes all configuration via command-line arguments
4. Report file exists and has all required sections for the target platform
5. Steps to reproduce are numbered and contain runnable commands
6. Impact section lists concrete attacker outcomes (not theoretical)
7. Proof/evidence section contains actual output (not placeholder text)
8. No em dashes, double dashes, emojis, or asterisk emphasis in the report
9. CVSS score is set to the highest defensible value (check: could any metric be argued higher?)
10. The GitLab/target version tested is explicitly stated
11. Affected files and line numbers are listed
12. A suggested fix is included

Print a summary of pass/fail for each item. If anything fails, say exactly what to fix.
