# Security Hooks — What Actually Runs

## SecurityPipeline (ACTIVE — ENFORCES)

- **Type:** Command hook (subprocess, not HTTP)
- **File:** `~/.claude/hooks/SecurityPipeline.hook.ts`
- **Matchers:** Bash, Write, Edit, MultiEdit, Read (PreToolUse entries in settings.json)
- **Enforcement:** `exit(2)` kills the tool call before execution. This is a hard block that Claude Code cannot override.
- **Architecture:** InspectorPipeline with three inspectors in priority order:
  - **PatternInspector** (priority 100) — regex matching against `patterns.yaml` for commands and path access tiers
  - **EgressInspector** (priority 90) — outbound data controls, credential string detection in Bash commands
  - **RulesInspector** (priority 50) — sends tool call + `SECURITY_RULES.md` to fast model for BLOCK/ALLOW classification
  Pipeline short-circuits on deny, merges to strictest result.
- **Config:** Loads ONE patterns file (USER first, system fallback). See `patterns.yaml`.
- **Fail mode:** Fail-CLOSED. Missing/broken patterns file = all operations blocked.
- **Performance:** ~50ms per tool call (Bun process spawn + cached YAML + inspector chain)

### What it catches
- Bash: blocked command patterns (rm -rf critical dirs, disk ops, repo exposure)
- Bash: alert patterns (force push, pipe to shell, DB drops) — logged, not blocked
- Bash: credential strings in commands (sk_live_, PRIVATE KEY, etc.) via EgressInspector
- Bash: natural language rule violations via RulesInspector
- Write/Edit: zeroAccess paths (credentials) — blocked
- Write/Edit: confirmAccess paths (.mcp.json) — prompts user
- Write/Edit: readOnly paths (/etc) — blocked
- Write/Edit: noDelete paths (hooks, PAI, .git) — blocked on delete only
- Read: zeroAccess paths — blocked
- Read: confirmAccess paths — prompts user

### What it does NOT catch
- Commands constructed across multiple tool calls
- Writes to PAI infrastructure paths (auto-bypassed via PAI_INFRA_PREFIXES in PatternInspector)
- Prompt injection in tool outputs (that's ContentScanner's job)
- Malicious code patterns in files being written (no AST analysis)

## ContentScanner (ACTIVE — WARNS — detects injection in tool output)

- **Type:** Command hook (subprocess)
- **File:** `~/.claude/hooks/ContentScanner.hook.ts`
- **Matchers:** WebFetch, WebSearch (PostToolUse — sync on these; async catch-all for others)
- **Enforcement:** Warning injection via `hookSpecificOutput`. Cannot block (PostToolUse limitation).
- **Architecture:** Runs standalone InjectionInspector on tool output content.
- **What it detects:** instruction overrides, system impersonation, dangerous action directives, urgency manipulation, hidden instruction patterns
- **What it does:** Injects security warning into conversation context + logs to `MEMORY/SECURITY/`
- **Fail mode:** Fail-open. Scanner errors don't block tool calls.
- **Performance:** <5ms for clean content, <10ms for flagged content
- **Replaces:** PromptInjectionScanner.hook.ts (v3.1)

## SmartApprover (ACTIVE — ENFORCES — permission classification)

- **Type:** Command hook (subprocess)
- **File:** `~/.claude/hooks/SmartApprover.hook.ts`
- **Matchers:** Write, Edit, MultiEdit, Bash (PermissionRequest)
- **Enforcement:** `permissionDecision: 'allow'` for trusted paths and read ops; `permissionDecision: 'ask'` for non-trusted write ops.
- **Architecture:** Three-tier classification:
  1. Trusted workspace paths (~/.claude/, ~/Projects/, ~/LocalProjects/) → auto-approve (no LLM)
  2. Non-trusted paths → haiku classifies read vs write
  3. Read → auto-approve; Write → prompt user
- **Cache:** Permission decisions cached to `USER/SECURITY/permission-cache.yaml` to avoid repeat LLM calls.
- **Fail mode:** Fail-open (if classification fails, falls through to Claude Code native permission prompt).
- **Replaces:** TrustedWorkspaceApprover.hook.ts (v3.1)

## PromptGuard (ACTIVE — ENFORCES — user prompt scanning)

- **Type:** Command hook (subprocess)
- **File:** `~/.claude/hooks/PromptGuard.hook.ts`
- **Matchers:** UserPromptSubmit (synchronous — can block)
- **Enforcement:** Can reject user prompts before Claude processes them (BLOCK verdict). Can inject warnings (WARN verdict).
- **Architecture:** Two-tier analysis:
  1. **Heuristic pre-filter** (<1ms) — regex patterns for injection, evasion (base64, hex), exfiltration intent, sensitive data references
  2. **Haiku semantic analysis** (~1-2s) — only runs when heuristics flag the prompt; asks fast model for exfiltration/injection verdict
- **Verdicts:** SAFE (pass), WARN (inject advisory), BLOCK (reject prompt)
- **Fail mode:** Fail-open (heuristic/LLM errors allow prompt through).
- **Replaces:** ExfiltrationScanner.hook.ts (v3.1)

## SkillGuard (ACTIVE — ENFORCES — minor)

- **Type:** Pulse HTTP route (NOT a hook file)
- **Endpoint:** `http://localhost:31337/hooks/skill-guard`
- **Matcher:** Skill (PreToolUse)
- **Enforcement:** Returns `permissionDecision: 'deny'` for blocked skills
- **What it blocks:** `keybindings-help` (1 skill — prevents false-positive invocation from position bias)
- **Fail mode:** Fail-closed.

## AgentGuard (ACTIVE — WARNS — does NOT block)

- **Type:** Pulse HTTP route (NOT a hook file)
- **Endpoint:** `http://localhost:31337/hooks/agent-guard`
- **Matcher:** Agent (PreToolUse)
- **Enforcement:** NONE. Returns `permissionDecision: 'allow'` with warning context.
- **What it does:** Injects a warning message when foreground non-fast agents are spawned.
- **What passes without warning:** background agents, Explore type, haiku model, FAST timing in prompt.
- **Fail mode:** Fail-closed.

## ConfigAudit (ACTIVE — LOGS — does NOT block)

- **Type:** Command hook (subprocess)
- **File:** `~/.claude/hooks/ConfigAudit.hook.ts`
- **Matchers:** Write, Edit targeting settings.json (PreToolUse)
- **Enforcement:** Logging only. Does not block.
- **What it does:** Logs changes to `settings.json` for audit trail.

## Pulse Server (hosts SkillGuard + AgentGuard)

- **Port:** 127.0.0.1:31337 (localhost only)
- **Routes:** `/hooks/skill-guard`, `/hooks/agent-guard`, `/health`
- **Lifecycle:** Managed by Pulse (no separate launchd plist or control script)
- **If Pulse is down:** SkillGuard and AgentGuard fail-closed. All command hooks (SecurityPipeline, ContentScanner, SmartApprover, PromptGuard) are unaffected — they are subprocesses, not HTTP.

## Security Protocol (AI-LEVEL — reinforced by ContentScanner)

- **File:** `DOCUMENTATION/Security/SecuritySystem.md`
- **Loaded by:** `LoadContext.hook.ts` at session start (via `loadAtStartup.files`)
- **What happens:** Unified security instructions injected into Claude's context as a `<system-reminder>`. Covers prompt injection defense, command safety, and security architecture.
- **Runtime reinforcement:** ContentScanner hook provides real-time warnings when injection patterns are detected in tool output, reinforcing the startup protocol.

## Pipeline Infrastructure

| File | What it is |
|------|-----------|
| `hooks/security/types.ts` | Inspector interface, InspectionContext, InspectionResult, SecurityEvent types |
| `hooks/security/pipeline.ts` | InspectorPipeline orchestrator — priority sort, short-circuit deny, merge to strictest |
| `hooks/security/logger.ts` | Unified security event logging to MEMORY/SECURITY/YYYY/MM/ |
| `hooks/security/inspectors/PatternInspector.ts` | Regex matching against patterns.yaml (priority 100) |
| `hooks/security/inspectors/EgressInspector.ts` | Outbound data / credential detection (priority 90) |
| `hooks/security/inspectors/RulesInspector.ts` | Natural language rules via LLM classification (priority 50) |
| `hooks/security/inspectors/InjectionInspector.ts` | Prompt injection pattern detection (used by ContentScanner) |
| `USER/SECURITY/SECURITY_RULES.md` | User-written natural language rules for RulesInspector |
