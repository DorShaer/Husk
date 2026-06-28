# PAI Security System v4.0

## What Actually Works

1. **SecurityPipeline hook** (PreToolUse) — InspectorPipeline with PatternInspector(100), EgressInspector(90), RulesInspector(50). Hard-blocks catastrophic bash commands and credential access via `exit(2)`. The only component that can prevent a tool call from executing.
2. **ContentScanner hook** (PostToolUse) — InjectionInspector scans WebFetch/WebSearch output for prompt injection patterns. Injects warnings, logs detections. Cannot block (PostToolUse limitation).
3. **SmartApprover hook** (PermissionRequest) — trusted workspace paths auto-approve; non-trusted paths classified as read (auto-approve) or write (prompt user) via haiku.
4. **PromptGuard hook** (UserPromptSubmit) — two-tier user prompt scanning: heuristic pre-filter (<1ms), then haiku semantic analysis (~1-2s) on flagged prompts. Detects exfiltration intent and prompt injection before Claude processes them.
5. **SkillGuard** — Pulse HTTP route (`localhost:31337/hooks/skill-guard`). Blocks 1 false-positive skill. Minor.
6. **AgentGuard** — Pulse HTTP route (`localhost:31337/hooks/agent-guard`). Warns on foreground agents. Does not block.
7. **Security protocol** — Unified security instructions loaded at startup (AI self-enforcement + hook enforcement).

See `ARCHITECTURE.md` for honest details on what each component does and does not do.

## Public Files (this directory)

| File | What it is |
|------|-----------|
| `ARCHITECTURE.md` | How the system actually works, including limitations |
| `HOOKS.md` | What hooks run, what they enforce, what they don't |
| `PROMPTINJECTION.md` | Generic framework overview (public) |
| `COMMANDINJECTION.md` | Generic framework overview (public) |
| `patterns.example.yaml` | Fallback pattern template (only used if USER file missing) |

## Private Files (USER/SECURITY/)

| File | What it is |
|------|-----------|
| `PAISECURITYSYSTEM.md` | Unified security protocol loaded at startup (all components) |
| `patterns.yaml` | Active security patterns — the actual rules SecurityPipeline enforces |
| `SECURITY_RULES.md` | User-written natural language rules evaluated by RulesInspector via LLM |
| `COMMANDINJECTION.md` | Code safety reference (not auto-loaded, manual reference via CONTEXT_ROUTING) |
| `QUICKREF.md` | What's blocked, logged, and not protected |
| `PROJECTRULES.md` | Project-specific rules (currently empty) |

## Observatory Security Page

The PAI Observatory dashboard includes a dedicated security page at `localhost:31337/security` that provides a visual interface for managing the security system:

- **PATTERNS.yaml editor** — view and edit active security patterns enforced by SecurityPipeline
- **SECURITY_RULES.md editor** — view and edit natural language rules evaluated by RulesInspector
- **Event viewer** — inspect security events and hook activity
- **Hook inspector** — review hook execution details and results

**Deployment:** The Observatory is a Next.js static export. Pulse serves it via a symlink: `Pulse/dashboard/out -> Observability/out`. To deploy changes: `bun run build` in the Observability directory, then `launchctl stop com.pai.pulse && launchctl start com.pai.pulse`.
