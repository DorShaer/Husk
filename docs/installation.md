# Installation

Husk ships as a packaged Electron binary on three platforms. Pick the one that fits and skip everything else.

## Linux

| Format | Use when | Notes |
|--------|---------|-------|
| `Husk-<v>.AppImage` | You want zero install, double-click and run | `chmod +x` once, then double-click. Self-contained. Auto-update works. |
| `husk_<v>_amd64.deb` | Debian / Ubuntu / Mint | `sudo apt install ./husk_<v>_amd64.deb`. Auto-update is not supported on .deb; the in-app pill falls back to the releases page. |
| `husk-<v>.x86_64.rpm` | Fedora / RHEL / openSUSE | `sudo dnf install ./husk-<v>.x86_64.rpm`. Same auto-update caveat as .deb. |

**Sandbox helper.** Electron's chrome-sandbox needs to be setuid root for hardened mode. Husk runs fine without it (`--no-sandbox` is auto-applied), and `install.sh` will tell you the one-time `sudo chown root:root && sudo chmod 4755` command if you want to enable it.

**inotify limits.** If a Linux box has many Electron apps open you can hit `inotify_user_instances`. `run.sh` warns on launch when the kernel limit is below 256 and prints the `sysctl fs.inotify.max_user_instances=1024` fix.

## macOS

| Format | Use when | Notes |
|--------|---------|-------|
| `Husk-<v>.dmg` | Intel Mac | Drag to Applications. **Right-click > Open** the first time (Gatekeeper will challenge an unsigned dmg). |
| `Husk-<v>-arm64.dmg` | Apple Silicon | Same flow. Arm64 native. |
| `Husk-<v>-mac.zip` | You want a portable copy | Unzip and double-click. |

**Voice on macOS.** Husk uses the built-in `say` command. No download. Voice toggles on instantly with a curated list (Samantha, Alex, Daniel, Karen, Moira, Tessa, Victoria).

**Code signing.** Today's mac builds are unsigned; auto-update inside Husk is disabled on macOS until we have an Apple Developer ID. The update pill falls back to "open releases page".

## Windows

| Format | Use when | Notes |
|--------|---------|-------|
| `Husk Setup <v>.exe` | Most users | NSIS installer; pick install dir, creates Start menu and desktop shortcuts. Auto-update works. |
| `Husk-<v>-win.zip` | Portable | Unzip, run `Husk.exe`. No registration. |

**PATH and PATHEXT.** Husk looks for `claude.cmd` / `copilot.cmd` / etc. via PATHEXT (`.CMD`, `.BAT`, `.EXE`). If you installed an agent CLI via npm globally, it's already on PATH. If not, the first-launch wizard offers a one-click `npm install -g`.

## Install from source (developers)

```bash
git clone https://github.com/DorShaer/Husk.git husk
cd husk
./install.sh        # registers Husk with the OS + bootstraps PAI into ~/.claude/
# or
./run.sh            # dev mode, no system registration
```

`install.sh` detects `uname` and runs the right registration model:
- Linux: wrapper at `~/.local/bin/husk`, `.desktop` entry, hicolor PNG icon, optional GNOME favorites pin.
- macOS: wrapper at `~/.local/bin/husk` plus a real `~/Applications/Husk.app` bundle (with `.icns` generated from the source PNG when `iconutil` + `sips` are present).
- Windows: not supported by `install.sh`; use the packaged `.exe` instead.

Both Linux and macOS source installs run `npm install` and `npm run rebuild` (electron-rebuild against electron's Node ABI) on the first install.

## Uninstall

```bash
./uninstall.sh             # removes the launcher, OS registration, config, voice models
./uninstall.sh --keep-data # preserves ~/.config/husk/ and the Piper voices
```

The project directory and `node_modules/` are always left intact so `./install.sh` can re-run.

## Updates

Husk shows a small `v0.3.0` pill in the topbar. When a newer version is on the Releases page, the pill grows a soft pulsing orange dot and reads `v0.3.1 available →`. Click it to see release notes and install.

- Windows NSIS and Linux AppImage update in-place: download, click "Restart and install", relaunched on the new version.
- `.deb`, `.rpm`, and unsigned macOS dmg can't auto-update; the popover swaps to "Open releases page".
- Husk checks once at boot (4s after launch) and again every 6 hours. No telemetry; the request is straight to the GitHub Releases API.
