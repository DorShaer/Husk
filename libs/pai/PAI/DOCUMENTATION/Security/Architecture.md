# PAI Security Architecture v4.0

## Inspector Pipeline Model

v4.0 replaces the v3.1 "walled defense" model (SecurityValidator, PromptInjectionScanner, TrustedWorkspaceApprover, ExfiltrationScanner) with a composable **Inspector Pipeline**. Each inspector is a standalone module with a priority, a name, and an `inspect()` method that returns allow/deny/require_approval/alert. The pipeline orchestrator runs inspectors in priority order, short-circuits on deny, and merges to the strictest result.

### Pipeline Core

| File | What it is |
|------|-----------|
| `hooks/security/types.ts` | `Inspector` interface, `InspectionContext`, `InspectionResult`, `SecurityEvent` |
| `hooks/security/pipeline.ts` | `InspectorPipeline` orchestrator — priority sort, short-circuit deny, merge logic |
| `hooks/security/logger.ts` | Unified event logging to `MEMORY/SECURITY/YYYY/MM/` |

### Inspectors

| Inspector | Priority | What it does |
|-----------|----------|-------------|
| `PatternInspector` | 100 | Regex matching against `patterns.yaml` — blocked/alert/trusted command patterns, path access tiers (zeroAccess, confirmAccess, readOnly, noDelete) |
| `EgressInspector` | 90 | Outbound data controls — detects credential strings in Bash commands, blocks exfiltration of sensitive data |
| `RulesInspector` | 50 | Sends tool call + `SECURITY_RULES.md` to a fast model for BLOCK/ALLOW classification. Disabled when rules file is empty. |
| `InjectionInspector` | — | Scans tool output for prompt injection patterns. Used by ContentScanner (PostToolUse), not the PreToolUse pipeline. |

---

## What Actually Enforces Security

| Mechanism | Hook Event | Enforcement | How it works |
|-----------|-----------|-------------|-------------|
| **SecurityPipeline.hook.ts** | PreToolUse | Hard block (`exit(2)`) | Spawns InspectorPipeline with Pattern(100), Egress(90), Rules(50). Evaluates every Bash, Write, Edit, MultiEdit, Read tool call. Blocked = process killed before execution. |
| **ContentScanner.hook.ts** | PostToolUse | Warning injection | InjectionInspector scans WebFetch/WebSearch output for prompt injection. Injects warnings via `hookSpecificOutput`, logs detections. Cannot block (PostToolUse limitation). |
| **SmartApprover.hook.ts** | PermissionRequest | Auto-approve or ask | Trusted workspace paths (~/.claude/, ~/Projects/, ~/LocalProjects/) auto-approve. Non-trusted paths classified as read (auto-approve) or write (prompt user) via haiku. Permission cache avoids repeat LLM calls. |
| **PromptGuard.hook.ts** | UserPromptSubmit | Block or warn | Two-tier: heuristic pre-filter (<1ms) checks for injection/evasion/exfiltration patterns, then haiku semantic analysis (~1-2s) on flagged prompts. Can block before Claude processes the prompt. |
| **SkillGuard** | PreToolUse | Deny response | Pulse HTTP route. Blocks `keybindings-help` (1 false-positive skill). |
| **AgentGuard** | PreToolUse | Warning only | Pulse HTTP route. Warns on foreground non-fast agents. Does NOT block. |
| **ConfigAudit.hook.ts** | PreToolUse | Logging | Logs changes to `settings.json`. Does not block. |
| **Security protocol** | Session start | AI self-enforcement | `PAISECURITYSYSTEM.md` loaded at startup. Claude reads and follows instructions. |

## What Does NOT Enforce Anything

- **ARCHITECTURE.md** (this file) — documentation only
- **HOOKS.md** — documentation only
- **QUICKREF.md** — documentation only
- **README.md** — documentation only
- **COMMANDINJECTION.md** — AI reads it, no code enforces it
- **patterns.example.yaml** — never loaded (USER patterns.yaml exists and takes priority)

---

## SecurityPipeline: The Primary Hard Enforcement

```
Claude Code → PreToolUse event → spawns SecurityPipeline.hook.ts
  |
  stdin: {tool_name, tool_input, session_id}
  |
  InspectorPipeline.run(context):
    PatternInspector (priority 100):
      Bash commands:
        1. Strip env var prefixes (prevents LANG=C rm -rf / bypass)
        2. Check trusted patterns → fast-path allow
        3. Check blocked patterns → deny (exit 2)
        4. Check alert patterns → alert (log, allow)
        5. Default → allow
      Write/Edit/Read paths:
        1. PAI_INFRA_PREFIXES check → fast-path allow
        2. Check zeroAccess → deny (exit 2)
        3. Check confirmAccess → require_approval (prompt user)
        4. Check readOnly (write/delete) → deny (exit 2)
        5. Check noDelete (delete) → deny (exit 2)
        6. Default → allow
    EgressInspector (priority 90):
      1. Scan Bash commands for credential strings (sk_live_, PRIVATE KEY, etc.)
      2. Detect exfiltration vectors (curl POST, nc, sendmail with sensitive data)
      3. Block or alert based on severity
    RulesInspector (priority 50):
      1. Load SECURITY_RULES.md (natural language rules)
      2. Send tool call + rules to fast model
      3. Return BLOCK or ALLOW based on LLM classification
      4. Disabled if rules file empty (zero cost)
  |
  Pipeline merges results → strictest wins:
    deny → exit(2) HARD BLOCK
    require_approval → permissionDecision: ask
    alert → log to MEMORY/SECURITY/, allow
    allow → allow
```

### PAI Infrastructure Bypass

Writes to these paths skip ALL PatternInspector validation (fast-path):
- `~/.claude/PAI/MEMORY/`
- `~/.claude/PAI/`
- `~/.claude/PAI/hooks/`
- `~/.claude/PAI/skills/`

This means the PatternInspector cannot protect PAI infrastructure files from being overwritten. The `noDelete` rule for `~/.claude/PAI/**` only applies to the Delete path action, and the fast-path bypass runs before `noDelete` is checked. (EgressInspector and RulesInspector still run on these paths.)

### Pattern Loading

Cascade, not merge. First file found wins:
1. `USER/SECURITY/PATTERNS.yaml` -- currently active
2. `PAISECURITYSYSTEM/patterns.example.yaml` -- fallback, never loaded

If neither exists or YAML parsing fails → fail-CLOSED (all operations blocked).

### Confirm Patterns

The Bash `confirm` category exists in the pattern schema but is intentionally empty for commands. The `confirmAccess` path tier uses `permissionDecision: "ask"` to prompt for sensitive-but-needed files (`.mcp.json`). This gives the user control without hard-blocking legitimate operations.

---

## ContentScanner: Prompt Injection Defense

### Layer 1: AI Protocol (session context)
`DOCUMENTATION/Security/SecuritySystem.md` is loaded into session context at startup via `loadAtStartup.files` in settings.json → executed by `LoadContext.hook.ts`. Contains unified security instructions including injection defense, command safety, and architecture overview.

### Layer 2: Runtime Scanner (PostToolUse)
`ContentScanner.hook.ts` runs the InjectionInspector after WebFetch and WebSearch tool calls. It scans returned content for common injection patterns (instruction overrides, system impersonation, dangerous action directives, urgency manipulation, hidden instructions).

When patterns are detected:
- Injects a security warning into conversation context via `hookSpecificOutput`
- Logs the detection to `MEMORY/SECURITY/` with matched patterns and source
- Does NOT block (PostToolUse cannot block — content is already received)

Claude gets both proactive instructions (startup protocol) and reactive warnings (scanner hook). The scanner cannot prevent Claude from reading injected content, but it flags it in real-time so the AI protocol has an immediate reinforcement signal.

---

## PromptGuard: Input-Side Defense

`PromptGuard.hook.ts` runs on UserPromptSubmit — before Claude processes the user's prompt. Two-tier analysis:

1. **Heuristic pre-filter** (<1ms): regex patterns for injection phrases, evasion techniques (base64, hex encoding), exfiltration intent (send/post/upload + sensitive data references), and sensitive data mentions.
2. **Haiku semantic analysis** (~1-2s): only runs when heuristics flag the prompt. Asks a fast model whether the prompt contains exfiltration or injection intent.

Verdicts: SAFE (pass through), WARN (inject advisory), BLOCK (reject prompt).

This catches attacks at the input boundary — before they enter Claude's context.

---

## SmartApprover: Permission Intelligence

`SmartApprover.hook.ts` runs on PermissionRequest for Write, Edit, MultiEdit, and Bash tool calls.

1. **Trusted workspace paths** (~/.claude/, ~/Projects/, ~/LocalProjects/) → auto-approve immediately. No LLM call.
2. **Non-trusted paths** → haiku classifies as read or write operation.
3. **Read operations** → auto-approve (low risk).
4. **Write operations** → let the user decide (`permissionDecision: ask`).

Permission cache persists classifications to avoid repeat LLM calls for the same tool/path combinations.

---

## Command Injection Defense: Reference Only

`DOCUMENTATION/Security/CommandInjection.md` is NOT loaded at startup. It's available via CONTEXT_ROUTING.md for manual reference when writing code. No linter, no runtime check, no enforcement.

The SecurityPipeline's PatternInspector `alert` patterns for `curl|sh` and `wget|bash` provide some coverage for the most common shell piping attacks, but this is pattern-matching on the final command, not validation of code being written.

---

## Logging

All security events (from any inspector or hook) are logged to:
```
MEMORY/SECURITY/YYYY/MM/security-{eventType}-{summary}-{timestamp}.jsonl
```

Each event records: timestamp, sessionId, eventType (block/confirm/alert/allow/injection/exfiltration), inspector name, tool, target, reason, findingId, actionTaken.

No alerting system reads these logs. They exist for manual review only.
