---
name: audit
description: Deep source code audit of a specific component or file. Identify vulnerabilities, trace data flow, find missing security checks. Use when you have source code to review.
user-invocable: true
allowed-tools: Read, Grep, Glob, Write, Agent, Bash
---

Audit the following for security vulnerabilities: $ARGUMENTS

Rules:

1. Read the code first. Understand what it does before looking for bugs.

2. For each potential finding, trace the full data flow from user input to sink. Do not report anything you cannot trace end-to-end.

3. Check for:
   - Missing input validation or sanitization
   - Authentication and authorization bypasses
   - SSRF (look for HTTP requests where the URL or hostname comes from user input, check if UrlBlocker or equivalent is used correctly, check if return values are discarded)
   - Injection (SQL, command, template, LDAP, XPath)
   - Path traversal and file access
   - Race conditions and TOCTOU gaps
   - Deserialization issues
   - Cryptographic weaknesses
   - Information disclosure

4. For each finding, write:
   - The vulnerable file and line numbers
   - What the bug is (one sentence)
   - The data flow (source to sink)
   - How to trigger it (attack scenario)
   - What an attacker gains
   - Severity estimate (Critical/High/Medium/Low)
   - Whether a fix exists elsewhere in the codebase for the same pattern

5. Compare with known fix patterns in the codebase. If a security fix was applied to one code path, check if the same pattern exists unfixed in related paths.

6. Write results to `audit_<component>.md` in the current directory. Rank findings by severity. No filler.
