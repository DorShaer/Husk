# PAI Threat Model

**10 attack chains against PAI infrastructure. Honest about residual risk.**

Risk scores: **L** (low), **M** (medium), **H** (high), **C** (critical) — based on likelihood x impact.

---

## Attack Chains

### 1. Direct Prompt Injection via Fetched Content
**Risk: H** | Attacker embeds "ignore previous instructions" in a webpage/API response the AI fetches.

- **Defenses:** ContentScanner (PostToolUse, InjectionInspector) injects warning. PromptGuard (UserPromptSubmit) catches injection in user prompts before processing. System prompt STOP and REPORT protocol. Pattern matching for known injection phrases.
- **Residual:** PostToolUse cannot block — content is already in context. Novel injection phrasing bypasses regex patterns. If AI follows the injected instruction despite the warning, all downstream walls are compromised because the AI crafts its own tool calls.

### 2. Credential Exfiltration via Bash
**Risk: M** | Manipulated AI reads `.env` or credentials and includes them in an outbound command.

- **Defenses:** `.env` in `zeroAccess` (PatternInspector blocks at Read/Write/Edit level). `.mcp.json` in `confirmAccess` (prompts user). PatternInspector blocks `cat/grep/source .env`. EgressInspector blocks credential strings (`sk_live_`, `sk-ant-`, `PRIVATE KEY`) in Bash commands. Outbound POST/nc/sendmail alerts logged. PromptGuard catches exfiltration intent in user prompts.
- **Residual:** Credentials already in shell environment (`$STRIPE_KEY`) can be expanded by the shell without appearing as literal strings in the command. Bash can read `.env` via indirect methods not covered by patterns (e.g., `while read line; do echo $line; done < .env`).

### 3. Multi-Step Infrastructure Destruction
**Risk: M** | Attack spreads destructive operations across multiple tool calls, each individually safe.

- **Defenses:** `noDelete` on `~/.claude/PAI/**` and `~/.claude/hooks/**`. Hard-blocked recursive deletion patterns. `readOnly` on security configs.
- **Residual:** SecurityPipeline is stateless — checks one call at a time. Removing files one-by-one (non-recursive `rm` on individual files) within `noDelete` paths is blocked, but content can be overwritten via Edit/Write since those paths are not `readOnly`. An attacker could hollow out files without deleting them.

### 4. Security Config Tampering
**Risk: L** | AI modifies `patterns.yaml` or hook files to weaken its own security.

- **Defenses:** `patterns.yaml` and security hook files are `readOnly`. Critical file deletion is hard-blocked. ConfigAudit logs settings.json changes. RulesInspector enforces natural language rules from SECURITY_RULES.md.
- **Residual:** The AI could ask {{PRINCIPAL_NAME}} to temporarily remove `readOnly` protection (social engineering the principal). If `settings.json` itself is modified to remove hook registrations, security hooks stop running entirely — ConfigAudit would log this but cannot prevent it.

### 5. Shell Obfuscation Bypass
**Risk: M** | Attacker crafts shell commands that perform blocked operations but don't match regex patterns.

- **Defenses:** Broad pattern coverage for known dangerous operations. Path normalization prevents traversal.
- **Residual:** Shell offers unlimited obfuscation: variable expansion (`$'\x72\x6d'`), aliases, eval, base64 decode piped to sh, heredocs, brace expansion. Pattern matching is fundamentally incomplete against a motivated attacker with shell access.

### 6. MCP Tool Exploitation
**Risk: M** | Malicious or compromised MCP server executes operations outside SecurityPipeline coverage.

- **Defenses:** `mcp__*` wildcard in permissions. MCP tools that trigger Bash/Write/Edit are caught by SecurityPipeline on those inner tool calls.
- **Residual:** `mcp__*` wildcard doesn't match plugin-sourced tools (Claude Code bug). MCP tools that perform operations server-side (not via inner tool calls) bypass SecurityPipeline entirely. The AI trusts MCP tool output the same as any other tool output.

### 7. Subagent Manipulation
**Risk: M** | Prompt injection targets a subagent which has less context about security protocols.

- **Defenses:** SecurityPipeline runs on subagent tool calls (same hooks fire). System prompt is inherited by subagents.
- **Residual:** Subagents have smaller context windows and may lose track of security instructions during long operations. A subagent processing attacker-controlled content may be more susceptible to injection than the primary agent.

### 8. Audit Trail Poisoning
**Risk: L** | Attacker floods security logs with false events to obscure real attacks, or corrupts log format.

- **Defenses:** `MEMORY/SECURITY/**` is `readOnly` — existing logs cannot be modified or deleted. Individual timestamped files prevent corruption of the full log.
- **Residual:** New log files can still be created (append-only). Nobody reads logs automatically — flooding is low-value because there is no automated alerting to overwhelm. The real weakness is that logs are only useful in post-incident review.

### 9. Environment Variable Exposure
**Risk: L** | AI dumps environment variables containing API keys via `printenv`/`env`/`set`.

- **Defenses:** Standalone `printenv`, `env`, `set` commands are alerted. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` is set in settings.json.
- **Residual:** `echo $SPECIFIC_VAR` is not alerted. Environment variables can be read one at a time without triggering the full-dump alert. The scrub setting reduces but does not eliminate exposure.

### 10. Social Engineering the Principal
**Risk: L** | AI is manipulated into asking {{PRINCIPAL_NAME}} to perform dangerous actions himself (disable security, approve destructive operations).

- **Defenses:** System prompt rules instruct the AI to recognize and resist manipulation. ContentScanner warns about injection in fetched content. PromptGuard catches injection in user prompts.
- **Residual:** If the AI frames a request convincingly ("I need you to temporarily remove the readOnly protection to fix a critical bug"), {{PRINCIPAL_NAME}} might comply. This is outside the system's control — it is a human judgment call. The confirm tier being intentionally empty means there is no "are you sure?" checkpoint for the principal.

---

## Risk Summary

| # | Chain | Risk | Strongest Defense | Biggest Gap |
|---|-------|------|-------------------|-------------|
| 1 | Prompt injection | **H** | ContentScanner + PromptGuard + STOP protocol | ContentScanner is advisory only (PostToolUse) |
| 2 | Credential exfil | **M** | PatternInspector zeroAccess + EgressInspector + PromptGuard | Shell variable expansion |
| 3 | Multi-step destruction | **M** | noDelete + readOnly paths | Stateless per-call checking |
| 4 | Config tampering | **L** | readOnly on security files | settings.json hook removal |
| 5 | Shell obfuscation | **M** | Broad regex coverage | Regex is fundamentally incomplete |
| 6 | MCP exploitation | **M** | SecurityPipeline on inner calls | Plugin tool wildcard bug |
| 7 | Subagent manipulation | **M** | Hooks fire on subagent calls | Reduced context = weaker protocol adherence |
| 8 | Audit poisoning | **L** | readOnly append-only logs | No automated log review |
| 9 | Env var exposure | **L** | Dump alerting + env scrub | Per-variable reads undetected |
| 10 | Social engineering | **L** | System prompt resistance | Human judgment is the final gate |

---

## Design Principles

- **Block catastrophic, prompt for sensitive, alert suspicious, allow everything else.** Minimal confirm tier for sensitive-but-needed files.
- **Honest about gaps.** This system stops accidents and opportunistic attacks. It does not stop a determined attacker who controls content the AI reads.
- **Defense in depth, not defense in perfection.** Each wall catches what the others miss. No single wall is sufficient alone.
