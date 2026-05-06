# Security

Husk is a desktop wrapper around a CLI agent. It runs entirely on your machine. This document describes the threat model, what Husk does to protect you, what it does not, and how to report a vulnerability.

## Threat model

Husk's job is to give a CLI AI agent a usable surface. That means:

- It spawns and controls a child process (`claude`, `copilot`, `codex`, ...) inside a real PTY.
- It reads and writes user data under `~/.claude/`, `~/.config/husk/`, and `~/.local/share/husk/`.
- It downloads optional components on user request: Piper TTS binary + voice models on Linux.
- It writes to `~/.claude.json` to register MCP servers, including their environment variables and HTTP headers (which may carry API keys / OAuth tokens).
- It executes user-provided commands when configured (the agent command and any custom MCP server's command + args run in `/bin/sh -c` on the user's behalf).

In scope for hardening:

- Local privilege boundary: data Husk writes should not leak to other local users.
- Renderer isolation: a malicious skill description, session title, or PTY-injected payload should not pivot into Node / OS execution.
- Safe IPC surface: every `window.husk.*` API validates input and refuses paths outside its intended directory.

Out of scope (today):

- Defending against an attacker who already controls the user's account on the machine.
- Mitigating malicious agent CLIs the user explicitly configures and runs.
- Network-level threats against the agent or MCP servers themselves.

## What Husk does

**Electron hardening**
- `contextIsolation: true`, `nodeIntegration: false` on the renderer.
- Preload exposes a narrow `window.husk` API; the renderer never sees `require`, `process`, or Node globals.
- `Content-Security-Policy` restricts the renderer:
  - `script-src 'self'` (no inline scripts, no remote scripts).
  - `style-src 'self' 'unsafe-inline'` (we set `style="..."` from JS for dynamic UI; no remote styles).
  - `img-src 'self' data:`, `connect-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`.
- `webSecurity` is left at the default (on).

**File permissions**
- `~/.config/husk/` is created with mode 0700.
- `~/.config/husk/config.json` is written with mode 0600.
- `~/.claude.json` (which holds MCP env vars and HTTP headers, often API keys) is written with mode 0600. Husk also re-chmods these files on every write to repair pre-existing loose permissions.

**Path containment in IPC handlers**
- `sessions:delete` rejects any path that is not under `~/.claude/projects/` and does not end in `.jsonl`. It also requires confirmation via a native dialog before unlinking.
- `context:remove` refuses any path outside `~/.claude/MEMORY/CONTEXT/`.
- `fs:dropFile` rejects basenames containing `..`, slashes, or backslashes; resolves the destination and verifies it stays inside the target directory.
- `skills:create` validates the name against `^[a-z][a-z0-9-]*$` before creating a directory.
- `mcp:add` validates the server id against `^[a-zA-Z0-9_-]+$` and refuses to overwrite an existing entry.

**Process isolation**
- The PTY child runs as the user, no elevation, no setuid.
- On window close or quit, Husk SIGTERMs the PTY's process group then SIGKILLs after a 250 ms grace period (`killPtyTree`). A single-instance lock prevents accidental process pile-up.
- `mcp:health` shells out to `claude mcp list` with no user-controlled arguments.

**Voice subsystem**
- Piper (Linux) and `say` (macOS) are spawned with `spawn()` not `exec()`, so user-supplied text reaches the binary as a discrete argv entry, never through a shell.

**Dependencies**
- `npm audit` is run before each release; the production dependency tree is intentionally small (`@xterm/*`, `node-pty`, plus `electron` as a dev dep).

## What Husk does not do (yet)

- **No code signing or notarization**. The macOS `.app` bundle Husk's installer creates is unsigned. Gatekeeper will challenge it on first launch. Sign locally if your organization requires it.
- **No SHA verification on Piper / voice-model downloads**. The Piper tarball and `.onnx` models come from `github.com/rhasspy/piper` and `huggingface.co` over HTTPS, but Husk does not pin a hash. A compromise of those release assets would be honored.
- **No sandbox on the renderer**. We run with `sandbox: false` because node-pty's preload needs it. `contextIsolation` still applies.
- **No automatic dependency monitoring**. `npm audit` is manual today.
- **No encryption at rest of MCP secrets**. They live in `~/.claude.json` mode 0600 in plaintext, which matches Claude Code's own format. If you need stronger protection, store secrets in your OS keychain and reference them via env vars.

## Reporting a vulnerability

Please do not file vulnerabilities as public issues.

Email: `dor.shaer@gmail.com`

Include:
- A short description of the issue.
- Steps to reproduce, ideally with a minimal Husk config or PTY input.
- The platform you tested on (Linux distro / macOS version, Husk version, Node version).
- Whether you have a candidate fix.

We will acknowledge within a few days, work with you on a fix, and credit you in the release notes if you would like.
