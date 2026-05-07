# Architecture

Husk is an Electron app that wraps a CLI agent inside a real PTY and adds a UI surface around it. The agent itself is unmodified.

## Repo layout

```
husk/
├── src/                       Application source
│   ├── main.js                Electron main process: PTY, IPC, agent control, MCP, updates
│   ├── preload.js             contextBridge -> window.husk; default UI scale
│   └── renderer/              Single-page Electron view
│       ├── index.html
│       ├── app.js
│       ├── styles.css
│       ├── assets/            App-time assets (logo)
│       └── vendor/            Bundled xterm.js + addons
├── libs/
│   └── pai/                   Bundled PAI framework (third-party content)
├── installer/
│   ├── husk-icon.png          Source for OS icons (1024x1024)
│   └── prompts/               Curated default Husk prompts (seed -> ~/.config/husk/prompts/)
├── docs/                      You are here
├── install.sh / run.sh / uninstall.sh
├── .github/                   CI: security analysis, release pipeline, dependabot
├── package.json               electron-builder config + scripts
├── README.md
├── SECURITY.md
└── LICENSE
```

## Process model

```
+--------------------+       IPC       +---------------------+
|   Electron main    |  <----------->  |      Renderer        |
|   src/main.js      |                 |   src/renderer/      |
|                    |                 |                      |
|  - node-pty        |   PTY stream    |  - chat surface      |
|  - script(1)       |  ------------>  |  - skills + prompts  |
|  - skill IPC       |                 |  - sessions          |
|  - session IPC     |                 |  - files tree        |
|  - voice IPC       |                 |  - MCP page          |
|  - mcp IPC         |                 |  - preferences       |
|  - update IPC      |                 |  - status panel      |
+--------------------+                 +----------------------+
         |                                       |
         v                                       v
   ~/.claude/*                            contextBridge
   (bootstrapped from                     window.husk API
    libs/pai on first                     (src/preload.js)
    install)
```

- **Main process (`src/main.js`).** Owns the OS-facing concerns: spawns the agent CLI inside a `node-pty` PTY, owns IPC handlers, reads/writes user data under `~/.claude/`, `~/.config/husk/`, `~/.local/share/husk/`. Single source of truth for the agent process tree.
- **Preload (`src/preload.js`).** Tiny bridge. Exposes `window.husk` via Electron's `contextBridge`. The renderer never gets `require`, `process`, or Node globals.
- **Renderer (`src/renderer/`).** Single-page Electron view. xterm.js terminal mounts on the `Chat` page; the rail navigates between Chat, Skills, Sessions, Files, MCP, Preferences. CSS lives in `styles.css`; vendored xterm in `vendor/`.

Electron security baseline: `contextIsolation: true`, `nodeIntegration: false`. CSP restricts the renderer to its own origin (no remote scripts). See [`../SECURITY.md`](../SECURITY.md) for the full posture.

## PTY and the agent

`spawnPty()` builds the agent command and hands it to `node-pty`. Establishing the controlling terminal differs per platform:

- **Linux:** wrap with GNU `script -q -c <cmd> /dev/null` so node-pty gets a proper `setsid + TIOCSCTTY` (without it, `claude --resume <id>` exits 129).
- **macOS:** `/bin/sh -c <cmd>`. node-pty handles the tty on Darwin, and BSD `script(1)` does NOT accept `-c` (would error with "illegal option"), so the Linux trick is harmful.
- **Windows:** `cmd.exe /c <cmd>`. Win32 `CreateProcess` does NOT honor PATHEXT; it only finds `.exe`. Going through `cmd.exe` walks PATHEXT and finds `claude.cmd`. Persona injection (the agentName + recap override) is skipped on Windows in v0.3.x because cmd.exe's quoting plus node-pty's argv-to-cmdline serializer would shatter the long quoted prompt.

When the agent is `claude` (and the user did not pass their own `--settings`), the main process injects:
- a temp settings file overriding `statusLine` to a no-op (Husk renders its own panel) and bumping `skillListingBudgetFraction` to 0.05 so claude does not silently drop skill descriptions;
- an `--append-system-prompt` directive that names the agent according to `cfg.agentName` and (optionally) suppresses recap lines.

## IPC surface

The full `window.husk.*` API exposed through preload:

| Namespace | What |
|-----------|------|
| `pty` | start / write / resize / restart, plus onData / onExit subscriptions |
| `config` | get / set (persisted in `~/.config/husk/config.json` mode 0600) |
| `stats` | location, time, weather, tool counts, learning sparkline, usage |
| `skills` | list (claude + Husk merged) / read / toggle / create |
| `sessions` | list / read / findClaudeId / delete |
| `prds` | enumerate `~/.claude/MEMORY/WORK/<slug>/PRD.md` |
| `fs` | open / dropFile (path-containment-checked) / listDir / home |
| `context` | list / remove (rail "In context" backing) |
| `agents` | detect (PATHEXT-aware) / install (npm or pipx, streamed) / install-progress events |
| `mcp` | catalog / list / add / remove / toggle / health (parses `claude mcp list`) |
| `dialog` / `dialog2` | pickFile / pickDir |
| `voice` | status / install / speak / stop / uninstall + progress events |
| `updates` | get / check / download / install / openRelease + status events |
| `ui` | zoomIn / zoomOut / zoomReset / zoomGet |

## Where data lives

| Path | What |
|------|------|
| `~/.claude/CLAUDE.md` | The agent's system prompt (claude convention) |
| `~/.claude/skills/` | Auto-loaded claude skills |
| `~/.claude/MEMORY/CONTEXT/` | Files dragged onto Husk for the current chat |
| `~/.claude.json` | claude's user config; Husk writes `mcpServers` here at mode 0600 |
| `~/.config/husk/config.json` | Husk's own preferences, mode 0600 |
| `~/.config/husk/prompts/` | Husk-managed prompts (seeded from `installer/prompts/` on first launch) |
| `~/.local/share/husk/piper/` | Piper TTS binary + voice models (Linux only) |
| `/tmp/husk-<uid>/` | Per-launch settings overrides; mode 0700 dir, 0600 files |

## Packaging

`electron-builder` produces:
- Linux: `AppImage`, `deb`, `rpm`
- macOS: `dmg` and `zip` for both x64 and arm64
- Windows: NSIS `.exe` + portable `zip`

`libs/pai/` and `installer/` are shipped as `extraResources`, not inside the asar, so the main process can copy from `process.resourcesPath/pai/` and `process.resourcesPath/installer/prompts/` into `~/.claude/` and `~/.config/husk/prompts/` on first launch (`bootstrapPaiIfNeeded` and `bootstrapHuskPromptsIfNeeded` in `src/main.js`).

The release workflow in `.github/workflows/release.yml` builds for all three OSes on `git tag v*` push, then `softprops/action-gh-release@v2` creates the GitHub Release with the artifacts attached. `electron-builder` is invoked with `--publish never` so release notes come from a single source (the Releases page) and the in-app updater pulls from there via `electron-updater`.

## Threading and shutdown

- `app.requestSingleInstanceLock()`: second `husk` invocation focuses the existing window instead of starting another process tree.
- `killPtyTree()`: on window close or quit, SIGTERMs the PTY's process group, then SIGKILLs after 250 ms grace. Wired to `window-all-closed`, `before-quit`, `will-quit`, `SIGINT`, `SIGTERM`, `SIGHUP`, `exit`.
- `run.sh` reaps stale Electron processes whose `--app-path` matches the local source dir, so a hard kill from the prior run does not pile up inotify watchers.
