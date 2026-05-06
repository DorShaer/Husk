---
name: recon
description: Research a bug bounty target program. Gather scope, payout table, past CVEs, top researchers, vulnerability patterns, and attack surface. Use when starting work on a new target.
user-invocable: true
allowed-tools: WebSearch, WebFetch, Read, Write, Bash, Grep, Glob, Agent
---

Research the bug bounty program for: $ARGUMENTS

Do the following:

1. Find the program page (HackerOne, Bugcrowd, or self-hosted). Get the full scope (in-scope domains, repos, asset types), out-of-scope items, and rules of engagement.

2. Get the bounty payout table with exact dollar amounts per severity level. Note any special categories (token disclosure, self-XSS, dangling DNS, etc).

3. Find all public CVEs for this target from the last 2 years. For each CVE, note the type, CVSS, affected component, and a one-line description. Focus on Critical and High severity.

4. Identify vulnerability patterns: which bug classes appear most often, which components are hit repeatedly, which researchers found the top bugs.

5. Find public writeups, disclosed HackerOne reports, and blog posts about past findings on this target.

6. Identify the highest-risk attack surface areas based on the pattern analysis.

7. Write the results to a file called `RESEARCH.md` in the current directory. Use a clean format with tables where appropriate. No filler text.

Do not include opinions or predictions. Stick to facts and data.
