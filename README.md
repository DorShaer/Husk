<div align="center">

<img src="src/renderer/assets/husk-logo.png" alt="Husk" width="100" />

# Husk

**A desktop home for your CLI agent.**

Husk wraps `claude`, `copilot`, `codex`, `aider`, or any other terminal-based AI agent in a clean Electron window with a real PTY, drag-drop file context, voice output, session resume, and a one-glance dashboard. The reasoning, thinking format, and Algorithm phase machine are bundled in. Clone, install, run.

</div>

---

## Why Husk

CLI agents are powerful and free. But they live in a black-on-black terminal that newcomers find intimidating, lose track of work in, and never discover the features of. Husk keeps the agent exactly as it is and adds the surface that makes it usable: file drops, persistent sessions, a status panel, a skills view, voice readback, and an installer that takes care of itself. If you can already use the terminal, Husk does not get in your way. If you cannot, Husk makes the same agent approachable.

## Features

- **Real PTY, not a fake terminal.** Husk spawns the actual `claude` (or whichever CLI you choose) inside `xterm.js` using `node-pty` plus `script(1)` for proper controlling-terminal handoff. Full ANSI, full TUI, real session resume.
- **Pick any CLI.** Default is `claude`, but you can set the agent command in Preferences. Anything that runs in a terminal works: `copilot`, `codex`, `aider`, `gemini`, your own wrapper script.
- **Reasoning and thinking baked in.** Husk ships with a complete reasoning + Algorithm + skills layer so the agent thinks deeply out of the box. No extra install, no separate setup. The framework is dropped into `~/.claude/` on first run.
- **Name your agent.** First-run prompt asks what to call it. Husk injects a runtime override so the agent introduces itself by your chosen name and not as the upstream persona.
- **Drag-drop context.** Drop any file on the window, it is copied into your agent's memory directory and announced in the chat.
- **Prompts page (Skills).** Shows every installed agent skill plus your personal Husk-managed prompts in one unified list. One-click "Use" button injects any prompt into the live chat. Toggle on/off in place with an animated switch. Create new prompts from the UI.
- **Sessions page.** Reads your agent's session log, decodes original project paths, and resumes any prior conversation in the original working directory using a real `--resume <id>` invocation.
- **Files page.** A scoped tree browser rooted wherever you choose, so you can drop files into the chat or open them in your OS file manager.
- **Live status panel.** Shows location, time, build versions, tool counts, usage, memory totals, and a learning sparkline updated every few seconds.
- **Voice readback (optional).** Local-only Piper TTS. No API key, no network at runtime. One click to install, one toggle to use. When enabled, Husk speaks the trailing summary line of each response.
- **Themed and accent-aware.** Dark and light theme, five accent palettes. Brand wordmark stays orange regardless of accent.
- **Animated everywhere.** Every toggle in the product uses one shared iOS-style switch with the same easing curve.
- **Zoom controls.** `Ctrl/Cmd` with `+` / `-` / `0` or the topbar buttons. The whole UI scales, including the terminal.
- **Welcome screen with opt-out.** First-time users get a soft landing with a Launch button. Power users tick the box and never see it again.
- **One-shot installer.** `./install.sh` drops a launcher into `~/.local/bin`, adds a desktop entry with the app icon, bootstraps PAI into `~/.claude/`, and offers to pin Husk to GNOME favorites. `./uninstall.sh` removes everything cleanly, with `--keep-data` if you want to preserve your voice models and config.
- **Sandboxed Linux launch.** Detects when `chrome-sandbox` is not setuid root and passes `--no-sandbox` automatically, so Husk runs out of the box on most distros.

## Install

```bash
git clone https://github.com/DorShaer/Husk.git husk
cd husk
./install.sh
```

The installer takes care of `npm install`, native module rebuild for `node-pty`, the desktop entry, the icon, and the PAI bootstrap into `~/.claude/`. After it finishes, Husk is in your application launcher.

For development you can skip the system install:

```bash
./run.sh
```

This boots Husk in dev mode without registering anything system-wide.

## Uninstall

```bash
./uninstall.sh             # remove launcher, icon, config, voice models
./uninstall.sh --keep-data # preserve config and Piper voices
```

## Usage

1. Launch Husk from your applications menu, or run `husk` from a terminal after installing.
2. On first run, Husk asks for the agent's name (default: Husk) and the agent command (default: `claude`). Both are saved to `~/.config/husk/config.json` and can be edited later in Preferences.
3. Press the Launch button and start chatting. The agent runs in a real PTY, so everything you would normally do in the terminal works: tool calls, slash commands, stdin, ctrl-c, scrollback, keyboard interrupts, the lot.
4. Drag files onto the window to share them with the agent. Use the topbar `+` button as a fallback file picker.
5. Switch pages with the rail or `Alt+1..5`. Open the command palette with `Cmd/Ctrl+K`.

## Architecture

```
husk/
├── src/                       Application source
│   ├── main.js                Electron main process: PTY, IPC, agent control
│   ├── preload.js             contextBridge window.husk surface
│   └── renderer/              UI (single-page Electron view)
│       ├── index.html
│       ├── app.js
│       ├── styles.css
│       ├── assets/
│       └── vendor/            Bundled xterm.js + addons
├── libs/
│   └── pai/                   Bundled PAI framework, third-party
├── installer/                 OS install assets (icon)
├── install.sh / run.sh / uninstall.sh
├── package.json
├── README.md
└── LICENSE
```

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
|  - stats IPC       |                 |  - status panel      |
+--------------------+                 +----------------------+
         |                                       |
         v                                       v
   ~/.claude/*                            contextBridge
   (bootstrapped from                     window.husk API
    libs/pai on first                     (src/preload.js)
    install)
```

- `src/main.js` spawns the chosen CLI via `script -q -c <cmd>` so the agent gets a real controlling terminal. It exposes IPC handlers for skills, sessions, voice, MCP servers, file drops, and live stats.
- `src/preload.js` exposes a narrow `window.husk` API to the renderer through `contextBridge`. The renderer never gets Node access.
- `src/renderer/` is the renderer: a single-page Electron view with rail navigation, an embedded xterm, a status panel, and the Skills / Sessions / Files / MCP / Preferences surfaces.
- `libs/pai/` is the bundled PAI framework, copied into `~/.claude/` on first install. Contains the system prompt, Algorithm phase machine, agents, hooks, lib, and the curated skills set.
- `installer/` holds OS-level install assets (icon for the desktop entry).
- `install.sh` / `run.sh` / `uninstall.sh` are the entry-point scripts and stay at the repo root for easy `git clone && cd && ./install.sh`.

## Configuration

All settings live in `~/.config/husk/config.json` and are editable from the Preferences page:

- **Agent command** and **agent name**
- **Theme** (dark / light) and **accent color** (orange / cyan / indigo / emerald / rose)
- **Voice** (enable, voice model, speaking rate)
- **Show recap line** (when off, suppresses end-of-response summaries)
- **Sidebar default state**, **file tree root**, **show hidden files**

## Privacy

Husk runs entirely on your machine. No telemetry. No analytics. The only network calls are made by the agent CLI itself when it talks to its model provider, and by the optional voice installer when it downloads Piper and a voice model from their public release.

## License

MIT.

## Credits

Husk's reasoning, thinking format, and Algorithm phase machine come from [PAI](https://github.com/danielmiessler/Personal_AI_Infrastructure) and Telos by **Daniel Miessler**. If you find Husk useful go show him some love.

The terminal embedding uses [`xterm.js`](https://github.com/xtermjs/xterm.js), `node-pty`, and `script(1)`. Voice is via [Piper TTS](https://github.com/rhasspy/piper).
