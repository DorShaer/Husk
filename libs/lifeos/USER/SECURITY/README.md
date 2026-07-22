---
provenance: template
---

# SECURITY — Pattern Rules and Permission Cache

This directory holds the rules that gate every Bash, Write, Edit, and Read
operation. The `SecurityPipeline.hook.ts` (PreToolUse) reads `PATTERNS.yaml`
on every tool call and **fails closed** if the file is missing or corrupt.
Treat this directory as load-bearing.

## Files

| File | What it does |
|------|---------------|
| `PATTERNS.yaml` | Block / alert / trusted regex rules for Bash and path access. **Required.** |
| `SECURITY_RULES.md` | Free-form policy doc — readable rules the LLM can quote when it asks for permission. Optional. |
| `permission-cache.yaml` | Auto-managed by `Safety.hook.ts` (PermissionRequest path). Caches sha-keyed "allow" decisions per (tool, body). Don't edit by hand. |

## Customization

The shipped `PATTERNS.yaml` is a generic safe default — it blocks
catastrophic operations (recursive `rm /`, disk wipes, repository
deletion, exfiltration of known credential prefixes) and alerts on
suspicious patterns (curl-pipe-shell, force-push, drop database, etc.).

To adapt it to your environment, edit the three sections:

- **`bash.trusted`** — patterns that should bypass all checks. Add tools
  you use constantly that the alert rules would otherwise log noisily.
- **`bash.blocked`** — patterns that must never execute. These are
  silently denied; nothing prompts the user.
- **`bash.alert`** — patterns that are allowed but logged for audit.
- **`paths.zeroAccess` / `alertAccess` / `confirmAccess`** — file-path
  rules. Read by the path inspector when a tool tries to touch a file.

After editing, the next Bash call uses the new rules — no daemon restart
needed (the inspector re-reads on every call).

## Failure mode

If `PATTERNS.yaml` is missing, malformed, or you accidentally delete the
zero-access list, every Bash tool call returns:

```
[LifeOS SECURITY] 🚨 BLOCKED: CRITICAL: Security patterns file missing — fail-closed
```

Restore the file (the public default lives at `Templates/USER/SECURITY/`
inside the `<your-release-skill>` skill, or pull a copy from a backup `.claude*` dir).

## Privacy

Nothing in this directory ships in a public LifeOS release. The release
builder overlays a generic public default scaffold; your customized rules
stay on your machine.
