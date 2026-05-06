---
name: audit-for-security
description: Security review of code I share. Looks for OWASP-class issues, auth and authz mistakes, input handling, and unsafe defaults. Asks for a file or paste first.
---

Run a security audit on the code I share.

If I have not shared a file yet, ask me ONE short question:
  "Paste the code or share a file path / repo path?"
and wait.

Once you have the code, walk it methodically. Do not assume frameworks defend you.

1. **Trust boundaries**: where does untrusted input enter (HTTP body, query, headers, IPC, stdin, environment, file uploads, third-party API responses)? Mark each.

2. **Input handling at each boundary**:
   - Validation present? Whitelist or blacklist? Reject unknown shapes?
   - Encoding when echoed back (HTML, SQL, shell, log, filesystem)?
   - Path traversal containment when constructing paths from user input?

3. **AuthN / AuthZ**:
   - Is identity established before the action?
   - Is authorization checked per resource (not just "logged in")?
   - Tokens / sessions: stored where? Rotated? Cleared on logout?

4. **Cryptography**:
   - Any hand-rolled crypto? Comparison with `==` instead of constant time?
   - Hardcoded keys, IVs, salts?
   - PRNG: `Math.random()` or `Random()` used for security purposes?

5. **Common classes** (per OWASP Top 10):
   - Injection (SQL, NoSQL, command, LDAP, log, header)
   - Broken access control (IDOR, missing function-level checks)
   - SSRF when fetching URLs from input
   - Deserialization of attacker-controlled data
   - XXE on XML parsers
   - Open redirect on auth flows

6. **Defaults**: anything where a misconfigured default leaks data or grants access?

For each finding: **severity** (info / low / medium / high / critical), **where** (file:line if visible), **why it matters** (one line), **fix** (concrete code or config). Do not invent vulnerabilities. If the code looks clean, say so.
