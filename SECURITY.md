# Security

Husk is a desktop wrapper around a CLI agent. It runs entirely on your machine. This document describes the threat model, what Husk does to protect you, what it does not, and how to report an issue.

## Threat model

Husk's job is to give a CLI AI agent a usable surface. That means:

- It spawns and controls a child process (`claude`, `copilot`, `codex`, `aider`, `gemini`) inside a real PTY.
- It reads and writes user data under `~/.claude/`, `~/.config/husk/`, and `~/.local/share/husk/`.
- It downloads optional components on user request: Piper TTS binary and voice models on Linux and Windows.
- It writes MCP server entries (including their environment variables and HTTP headers, which may carry API keys or OAuth tokens) into the active agent's own config file: `~/.claude.json` for claude, `~/.copilot/mcp-config.json` for copilot, `~/.gemini/settings.json` for gemini.
- It executes user-provided commands when configured. The agent CLI is launched with the per-platform spawn rules described under "Process model" in [`docs/architecture.md`](docs/architecture.md); user-supplied MCP server commands are stored verbatim in the agent's own config and are run by the agent, not by Husk.

In scope for hardening:

- Local privilege boundary: data Husk writes should not leak to other local users.
- Renderer isolation: a malicious skill description, session title, PTY-injected payload, or clickable URL should not pivot into Node or OS execution.
- Safe IPC surface: every `window.husk.*` API validates input and refuses paths outside its intended directory.
- Supply chain for fetched scripts: any script Husk's installer runs from a third-party URL is pinned to a known hash.

Out of scope:

- A user account on the machine that has already been taken over by someone else.
- Mitigating malicious agent CLIs the user explicitly configures and runs.
- Network-level threats against the agent or the MCP servers it talks to.

## What Husk does

**Electron hardening**
- `contextIsolation: true`, `nodeIntegration: false` on the renderer.
- Preload exposes a narrow `window.husk` API; the renderer never sees `require`, `process`, or Node globals.
- `Content-Security-Policy` restricts the renderer:
  - `script-src 'self'` (no inline scripts, no remote scripts).
  - `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com` (we set `style="..."` from JS for dynamic UI; the single remote style origin is Google Fonts).
  - `font-src 'self' data: https://fonts.gstatic.com`.
  - `img-src 'self' data:`, `connect-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`.
- `webSecurity` is left at the default (on).
- DevTools is disabled in packaged builds (`webPreferences.devTools: !app.isPackaged`). The View menu entry, `F12`, and `Ctrl+Shift+I` are all no-ops in shipped installers. Source-tree runs (`./scripts/run.sh`) keep DevTools for development.
- External URL clicks (plain-text URLs and OSC 8 hyperlinks emitted by the agent) route through a confirm dialog that shows the full URL before `shell.openExternal` runs. The renderer cannot open a URL silently.

**File permissions**
- `~/.config/husk/` is created with mode 0700.
- `~/.config/husk/config.json` is written with mode 0600.
- `~/.claude.json`, `~/.copilot/mcp-config.json`, and `~/.gemini/settings.json` (which hold MCP env vars and HTTP headers, often API keys) are written with mode 0600. Husk re-chmods these files on every write to repair pre-existing loose permissions.

**Path containment in IPC handlers**
- `sessions:delete` rejects any path that is not under `~/.claude/projects/` and does not end in `.jsonl`. It also shows a native confirmation dialog before unlinking; the preload API exposes no way for the renderer to suppress the dialog.
- `context:remove` refuses any path outside `~/.claude/MEMORY/CONTEXT/`.
- `fs:dropFile` rejects basenames containing `..`, slashes, or backslashes; resolves the destination and verifies it stays inside the target directory.
- `skills:create` validates the name against `^[a-z][a-z0-9-]*$` before creating a directory.
- `mcp:add` validates the server id against `^[a-zA-Z0-9_-]+$` and refuses to overwrite an existing entry.
- Workflows imported from external JSON go through a sanitizer (`src/lib/workflow-graph.js`) that drops unknown node types and rejects edges that point at non-existent nodes.

**Process isolation**
- The PTY child runs as the user, no elevation, no setuid.
- The spawn is per-platform (see [`docs/architecture.md`](docs/architecture.md) for the rationale). macOS spawns the agent binary directly with an argv array. Linux wraps with `/usr/bin/script` to establish a controlling terminal. Windows resolves the agent name through PATHEXT and spawns the executable directly when possible, falling back to `cmd.exe /c` only when no resolved path is found. None of these paths interpolate user-controlled text into a shell command line.
- On window close or quit, Husk SIGTERMs the PTY's process group then SIGKILLs after a 250 ms grace period (`killPtyTree`). A single-instance lock prevents accidental process pile-up.
- `mcp:health` is dispatched through a per-agent adapter (`src/lib/mcp/`). The claude adapter shells out to `claude mcp list` with no user-controlled arguments; the copilot and gemini adapters read their config file and report `configured` without a live probe; other agents return an empty list.

**Voice subsystem**
- Piper (Linux and Windows) and `say` (macOS) are spawned with `spawn()` and an argv array, not `exec()` with a shell string, so user-supplied text reaches the binary as a discrete argv entry and never through a shell.

**Installer dependency pinning**
- `install.sh` and `install.ps1` fetch any third-party installer (for example the bun script) to a temp file and verify its SHA-256 against a constant pinned in the script before executing. The helpers live in `installer/lib/verify.sh` and `installer/lib/verify.ps1`. The pinning policy and how to refresh a pin are documented at the top of those files.

**Release artifact integrity**
- Every GitHub Release ships a `SHA256SUMS` file covering every binary in the release.
- Every release artifact is signed with a Sigstore-backed build provenance attestation tied to the workflow run that produced it (via `actions/attest-build-provenance`). Users can verify with `gh attestation verify <file> --repo DorShaer/Husk`.
- `electron-builder` is invoked with `--publish never` so the release notes and uploads have a single writer (the release workflow), and the notes themselves come from the annotated git tag, not auto-generated text.

**Dependencies**
- `npm audit --audit-level=high` runs on every push and pull request in `.github/workflows/security.yml`; a high or critical advisory blocks the PR.
- GitHub Actions are pinned by commit SHA. Dependabot opens weekly grouped PRs for npm minor and patch, plus action minor and patch; majors are human-authored.
- The production dependency tree is intentionally small: `@xterm/*`, `node-pty`, `electron-updater`, `drawflow`.

## What Husk does not do

- **No code signing or notarization on macOS.** The mac `.dmg` and `.zip` are unsigned. Gatekeeper will challenge them on first launch. See the README's "macOS first launch" section for the bypass. Apple Developer ID signing is on the roadmap; in-app auto-update on macOS is disabled until then and the update pill falls back to the releases page.
- **No SHA verification on Piper or voice-model downloads.** The Piper archive (Linux tarball, Windows zip) and `.onnx` models come from `github.com/rhasspy/piper` and `huggingface.co` over HTTPS, but Husk does not pin a hash for them. A compromise of those release assets would be honored.
- **No renderer sandbox.** Husk runs with `sandbox: false` because node-pty's preload needs it. `contextIsolation` and CSP still apply.
- **No encryption at rest of MCP secrets.** MCP env vars and HTTP headers are stored in `~/.claude.json`, `~/.copilot/mcp-config.json`, or `~/.gemini/settings.json` at mode 0600 in plaintext, which matches the on-disk format of the agent CLIs themselves. If you need stronger protection, keep secrets in your OS keychain and reference them via env vars in the MCP entry.
- **No fine-grained permission prompts inside the agent's own tool calls.** Husk does not interpose between the agent and its tool calls; tool gating is whatever the agent CLI provides.

## Reporting a security issue

Please do not file security issues as public GitHub issues.

Email: `85877103+DorShaer@users.noreply.github.com`

Include:
- A short description.
- Steps to reproduce, ideally with a minimal Husk config or PTY input.
- The platform you tested on (Linux distro and version / macOS version / Windows version, Husk version, Node version).
- Whether you have a candidate fix.

You will get an acknowledgement within a few days, and credit in the release notes if you would like.
