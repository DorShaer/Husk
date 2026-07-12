# Architecture

Husk is an Electron app that wraps a CLI agent inside a real PTY and adds a UI surface around it. The agent itself is unmodified.

## Repo layout

```
husk/
├── src/                       Application source
│   ├── main.js                Electron main process: PTY, IPC, agent control, MCP, updates
│   ├── preload.js             contextBridge -> window.husk; default UI scale
│   ├── lib/                   Pure helpers, unit-tested
│   │   ├── shell-quote.js     POSIX argv serializer
│   │   ├── path-confine.js    resolveInside / isInside under a root
│   │   ├── pty-spawn.js       Per-platform pty.spawn argv assembly
│   │   ├── user-path.js       Inherit shell PATH on GUI launch
│   │   ├── agent-md.js        Agent markdown frontmatter parser
│   │   ├── workflow-graph.js  Sanitize, migrate, traverse, route
│   │   ├── mcp-status.js      Parse `claude mcp list` output into a status map
│   │   ├── mcp/               Per-agent MCP adapters
│   │   │   ├── index.js       getAdapter(agentCommand) selector
│   │   │   ├── common.js      Shared shape, read/write, build helpers
│   │   │   ├── claude.js      ~/.claude.json + `claude mcp list`
│   │   │   ├── copilot.js     ~/.copilot/mcp-config.json (no live probe)
│   │   │   ├── gemini.js      ~/.gemini/settings.json (no live probe)
│   │   │   └── stub.js        Empty-list stub for codex / aider
│   │   ├── autonomy/          Autopilot safety: budget, hash-chained audit, snapshot, supervisor
│   │   └── ...                ~20 more helpers (autopilot-*, agent-*, git-porcelain, fuzzy,
│   │                          highlight, lang-detect, recap-extract, plugins, ...)
│   └── renderer/              Single-page Electron view
│       ├── index.html
│       ├── app.js
│       ├── styles.css
│       ├── assets/            App-time assets (logo)
│       └── vendor/            Bundled xterm.js + addons
├── libs/
│   └── pai/                   Bundled PAI framework, third-party
├── installer/
│   ├── husk-icon.png          Source for OS icons (1024x1024)
│   ├── after-install.sh       deb / rpm post-install
│   ├── after-remove.sh        deb / rpm post-remove
│   ├── prompts/               Curated default Husk prompts (seed -> ~/.config/husk/prompts/)
│   └── lib/                   verify.sh / verify.ps1 download-and-verify helpers
├── test/
│   ├── unit/                  node:test unit tests against src/lib/
│   └── e2e/                   Playwright smoke that boots real Electron
├── docs/                      You are here
├── install.sh / run.sh / uninstall.sh
├── install.ps1                Windows source-install
├── .github/                   CI: lint, security, release, dependabot
├── package.json               electron-builder config + scripts
├── README.md
├── SECURITY.md
└── LICENSE
```

## Process model

```
+--------------------+       IPC       +-----------------------+
|   Electron main    |  <----------->  |       Renderer        |
|   src/main.js      |                 |    src/renderer/      |
|                    |                 |                       |
|  - node-pty        |   PTY stream    |  - chat surface       |
|  - per-platform    |  ------------>  |  - agents + workflows |
|    spawn (see lib) |                 |  - skills + prompts   |
|  - IPC handlers    |                 |  - sessions + files   |
|  - MCP adapters    |                 |  - MCP + preferences  |
|  - voice           |                 |  - status panel       |
|  - updates         |                 |                       |
+--------------------+                 +-----------------------+
         |                                        |
         v                                        v
   ~/.claude/*                             contextBridge
   ~/.config/husk/*                        window.husk API
   ~/.local/share/husk/*                   (src/preload.js)
```

- **Main process (`src/main.js`).** Owns OS-facing concerns: spawns the agent CLI inside a `node-pty` PTY, owns IPC handlers, reads and writes user data under `~/.claude/`, `~/.config/husk/`, and `~/.local/share/husk/`. Single source of truth for the agent process tree.
- **Preload (`src/preload.js`).** A small bridge. Exposes `window.husk` via Electron's `contextBridge`. The renderer never gets `require`, `process`, or Node globals.
- **Renderer (`src/renderer/`).** Single-page Electron view. xterm.js terminal mounts on the Chat page; the rail navigates between Chat, Agents, Workflows, Autopilot, Projects, Prompts, Skills, MCP, Plugins, Files, Sessions. Preferences open as a modal, not a page. CSS lives in `styles.css`; vendored xterm in `vendor/`.

Electron security baseline: `contextIsolation: true`, `nodeIntegration: false`. CSP restricts the renderer to its own origin (no remote scripts). DevTools is off in packaged builds (`devTools: !app.isPackaged`). External URL clicks pass through a confirm dialog before `shell.openExternal`. Full posture in [`../SECURITY.md`](../SECURITY.md).

## PTY and the agent

`spawnPty()` builds the agent command and hands it to `node-pty`. The per-platform argv comes from `src/lib/pty-spawn.js`. The platforms differ because each one needs something different to give the agent a real controlling terminal:

- **Linux:** `pty.spawn('/usr/bin/script', ['-q', '-c', shJoin(agentExe, agentArgs), '/dev/null'])`. GNU `script` does the `setsid + TIOCSCTTY` dance for us. Without it `claude --resume <id>` exits 129. When `/usr/bin/script` is unavailable, the spawn falls back to `pty.spawn('/bin/sh', ['-c', cmdStr])`.
- **macOS:** `pty.spawn(agentExe, agentArgs)`. No shell parser involved. node-pty handles the tty on Darwin, and BSD `script(1)` does not accept `-c`, so the Linux trick is harmful here.
- **Windows:** `pty.spawn(resolvedViaPathExt, agentArgs)` when the program name resolves to a real file. Win32 `CreateProcess` does not honor `PATHEXT`, so a bare `pty.spawn('claude')` would miss `claude.cmd`. `resolveWindowsExe` walks `PATH` and applies `PATHEXT` itself, then spawns the resolved path directly. If no resolution is possible, it falls back to `pty.spawn('cmd.exe', ['/c', rawCmd])`. Persona injection (the agentName plus recap override) is skipped on Windows because cmd.exe quoting plus node-pty's argv-to-cmdline serializer would shatter the long quoted prompt.

When the agent is `claude` (and the user did not pass their own `--settings`), the main process injects:
- an inline `--settings` JSON string overriding `statusLine` to a no-op command (Husk renders its own STATUS panel). claude merges the string over the user's `settings.json`, so every other setting still applies; because it is a string rather than a temp file, claude never writes trust data back into it (see `src/lib/agent-inject.js`);
- an `--append-system-prompt` directive that names the agent according to `cfg.agentName` and (optionally) suppresses recap lines.

## IPC surface

The full `window.husk.*` API exposed through `src/preload.js`:

| Namespace | What |
|-----------|------|
| `pty` | start / write / resize / restart, plus onData / onExit subscriptions |
| `recap` | extract a recap line from terminal rows (in-process, no IPC) |
| `text` | pure text helpers for the Files page: fuzzy filter, syntax highlight, git porcelain parse (in-process, no IPC) |
| `config` | get / set (persisted in `~/.config/husk/config.json` mode 0600) |
| `stats` | location, time, weather, tool counts, learning sparkline, usage |
| `skills` | list (claude + Husk merged) / read / toggle / create |
| `sessions` | list / read / findClaudeId / delete |
| `prds` | enumerate `~/.claude/MEMORY/WORK/<slug>/PRD.md` |
| `plugins` | list / catalog / run / files / readFile / writeFile / openFolder |
| `prompts` | list / create / delete (Husk-managed prompt store) |
| `projects` | list / create / setActive / clearActive / delete |
| `fs` | open / dropFile (path-containment-checked) / listDir / home |
| `context` | list / remove (the rail "In context" backing) |
| `agents` | detect (PATHEXT-aware) / install (npm or pipx, streamed) / install-progress events |
| `workflows` | list / create / update / delete / run / stop, plus generateStepPrompt and per-node and edge progress events |
| `profiles` | list / create / update / delete / activate / deactivate / deactivateAll, plus generate / listImportableAgents / importAgents |
| `repoAgents` | pickDir / scan / install agent files found in a repo |
| `repoMcp` | pickDir / scan / build / install MCP servers found in a repo |
| `autopilot` | start / startCollab / status / revert / apply / discard / history and the run event stream |
| `claudeTrust` | per-folder trust status / accept for the claude CLI |
| `mcp` | catalog / list / add / remove / toggle / health, all dispatched through the active agent's adapter |
| `dialog` / `dialog2` | pickFile / pickDir |
| `voice` | status / install / speak / stop / uninstall, plus progress events |
| `urls` | openExternal (confirm-dialog gated) |
| `updates` | get / check / download / install / openRelease, plus status events |
| `ui` | zoomIn / zoomOut / zoomReset / zoomGet |

### MCP adapter pattern

`mcp:*` IPC handlers expose one Husk-level MCP registry. Mutating handlers go through `src/lib/mcp/shared.js`, which mirrors add/update/toggle/remove to every write-capable adapter and backfills entries that exist in only one vendor config. Live health still uses the active agent's adapter (`getAdapter(config.agentCommand)`) because only that CLI can report its connection state. The adapters:

| Agent | Config file | Live status probe |
|-------|-------------|------------------|
| `claude` | `~/.claude.json` | yes, parses `claude mcp list` via `src/lib/mcp-status.js` |
| `copilot` | `~/.copilot/mcp-config.json` | no, returns `configured` for every entry |
| `gemini` | `~/.gemini/settings.json` | no, returns `configured` for every entry |
| `codex`, `aider`, any other binary | snippet-only / unsupported write path | empty list for automatic writes; repo install can emit pasteable snippets |

The on-disk shape (`mcpServers` plus the Husk-private `_huskMcpDisabled`) is identical across adapters, so a config written by Husk is readable by the agent CLI directly.

## Where data lives

| Path | What |
|------|------|
| `~/.claude/CLAUDE.md` | The agent's system prompt (claude convention) |
| `~/.claude/skills/` | Auto-loaded claude skills |
| `~/.claude/MEMORY/CONTEXT/` | Files dragged onto Husk for the current chat |
| `~/.claude.json` | claude's user config; Husk writes `mcpServers` here at mode 0600 |
| `~/.copilot/mcp-config.json` | copilot's MCP config; Husk writes here at mode 0600 when the active agent is copilot |
| `~/.gemini/settings.json` | gemini's user settings; Husk touches only `mcpServers` and the disabled sidecar, mode 0600, when the active agent is gemini |
| `~/.config/husk/config.json` | Husk's own preferences, mode 0600 |
| `~/.config/husk/prompts/` | Husk-managed prompts (seeded from `installer/prompts/` on first launch) |
| `~/.local/share/husk/piper/` | Piper TTS binary + voice models (Linux and Windows) |

## Packaging

`electron-builder` produces:
- Linux: `AppImage`, `deb`, `rpm`
- macOS: `dmg` and `zip` for both x64 and arm64
- Windows: NSIS `.exe` and a portable `zip` for x64

Artifact names follow `husk-v${version}-${os}-${arch}.${ext}` (configured under `build.{linux,mac,win}.artifactName` in `package.json`), so a release directory looks like `husk-v2.0.1-linux-x86_64.AppImage`, `husk-v2.0.1-mac-arm64.dmg`, `husk-v2.0.1-win-x64.exe`, etc.

`libs/pai/` and `installer/` are shipped as `extraResources`, not inside the asar, so the main process can copy from `process.resourcesPath/pai/` and `process.resourcesPath/installer/prompts/` into `~/.claude/` and `~/.config/husk/prompts/` on first launch (`bootstrapPaiIfNeeded` and `bootstrapHuskPromptsIfNeeded` in `src/main.js`).

The release workflow in `.github/workflows/release.yml` builds for all three OSes on `git tag v*` push, then:
- generates a `SHA256SUMS` over the release directory,
- signs every artifact with `actions/attest-build-provenance` (Sigstore-backed),
- extracts the release body from the annotated tag message and feeds it to `softprops/action-gh-release@v2` as `body_path`.

`electron-builder` is invoked with `--publish never` so release notes have one writer (the release workflow) and the in-app updater pulls from there via `electron-updater`.

## Threading and shutdown

- `app.requestSingleInstanceLock()`: a second `husk` invocation focuses the existing window instead of starting another process tree.
- `killPtyTree()`: on window close or quit, SIGTERMs the PTY's process group, then SIGKILLs after 250 ms grace. Wired to `window-all-closed`, `before-quit`, `will-quit`, `SIGINT`, `SIGTERM`, `SIGHUP`, `exit`.
- `run.sh` reaps stale Electron processes whose `--app-path` matches the local source dir, so a hard kill from the prior run does not pile up inotify watchers.
