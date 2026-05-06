---
name: report
description: Write a bug bounty report for submission to HackerOne, Bugcrowd, or similar platform. Use when a vulnerability has been confirmed and needs to be reported.
user-invocable: true
allowed-tools: Read, Write, Edit, Grep, Glob
---

Write a bug bounty report for: $ARGUMENTS

Rules:

1. Follow the platform's template. For HackerOne, use their standard sections: Summary, Steps to reproduce, Impact, Examples, Current bug behavior, Expected correct behavior, Relevant logs/screenshots, Output of checks.

2. Steps to reproduce must be copy-paste. Every command should be runnable as-is. A reviewer with no context should be able to follow them on a fresh machine and see the same result.

3. Do not use sub-headings (#### or deeper) inside the Steps to reproduce section. Use numbered steps in plain text or bold.

4. Writing style: professional, direct, first person where natural. No em dashes, no double dashes, no emojis, no asterisk emphasis. No filler phrases like "it should be noted that" or "it is worth mentioning". State facts.

5. The Summary should be 2-3 sentences max. Lead with what the bug is, not background.

6. Impact section: list concrete things an attacker can do. Not theoretical risks. What data do they get, what access do they gain, what can they do with it.

7. Include the actual proof (log output, screenshots, terminal output) in the Relevant logs section. Use code blocks.

8. CVSS scoring: set the highest score that can be reasonably argued. Do not be conservative. Let the program adjust downward if they disagree. If there is ambiguity in a CVSS metric, choose the interpretation that gives the higher score.

9. Save to `hackerone_report.md` (or `bugcrowd_report.md`, etc) in the current directory.

10. After writing the report, provide the following HackerOne submission fields separately so they can be copy-pasted into the form:

    TITLE: a short title under 70 characters

    SEVERITY: the full CVSS vector string and score, with justification for each metric

    WEAKNESS: the CWE number and name (e.g. CWE-863 Incorrect Authorization)

    IMPACT: a 2-3 sentence impact statement for the HackerOne impact field

    ASSET: which in-scope asset is affected (e.g. gitlab.com, github.com)

    These fields go at the end of the report file under a "Submission fields" section.
