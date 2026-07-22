# Installation

The one-liner picks the right build for the machine it lands on. Everything below is the manual path.

```bash
# Linux and macOS
curl -fsSL https://dorshaer.github.io/Husk/install.sh | bash
```

```powershell
# Windows
irm https://dorshaer.github.io/Husk/install.ps1 | iex
```

The Releases page is https://github.com/DorShaer/Husk/releases. Filenames follow `husk-v<version>-<os>-<arch>.<ext>`.

## Linux

Only x86_64 is published today: there is no arm64 Linux build, and the binaries are glibc-linked so musl distros (Alpine) cannot run them.

| Format | Use when | Notes |
|--------|----------|-------|
| apt repo | Debian / Ubuntu / Mint | The one-liner's default. `apt upgrade` keeps Husk current. Installs to `/opt/husk`. |
| `husk-v<version>-linux-x86_64.AppImage` | Zero install, no root | Needs `libfuse2` (Ubuntu 24.04 ships fuse3 only: `sudo apt install libfuse2`). The installer places it at `~/.local/share/husk/Husk.AppImage` under a version-less name, which is what lets in-app auto-update replace it in place. |
| `husk-v<version>-linux-amd64.deb` | Debian / Ubuntu, manual | `sudo apt install ./husk-v<version>-linux-amd64.deb` |
| `husk-v<version>-linux-x86_64.rpm` | Fedora / RHEL / openSUSE | `sudo dnf install ./husk-v<version>-linux-x86_64.rpm` |

**Updating.** On `.deb` and `.rpm` the in-app updater installs through the system package manager, so the desktop asks for your password once. If that prompt is dismissed or your desktop has no polkit agent, Husk tells you and hands you the command to finish it yourself (`sudo apt install --only-upgrade husk`). AppImage updates apply in place with no prompt.

**Sandbox helper.** Electron's `chrome-sandbox` needs to be setuid root for hardened mode. Husk runs fine without it (`--no-sandbox` is auto-applied), and `install.sh` will tell you the one-time `sudo chown root:root && sudo chmod 4755` command if you want to enable it.

**inotify limits.** If a Linux box has many Electron apps open you can hit `inotify_user_instances`. `run.sh` warns on launch when the kernel limit is below 256 and prints the `sysctl fs.inotify.max_user_instances=1024` fix.

## macOS

| Format | Use when | Notes |
|--------|----------|-------|
| `husk-v<version>-mac-arm64.dmg` | Apple Silicon | Drag to Applications, then see the first-launch step below. |
| `husk-v<version>-mac-x64.dmg` | Intel Mac | Same flow as Apple Silicon. |
| `husk-v<version>-mac-arm64.zip` / `husk-v<version>-mac-x64.zip` | You want a portable copy | Unzip and double-click. |

**macOS first launch (unsigned builds).** The `.dmg` is unsigned today. Drag Husk to Applications, try to open it, click **Cancel** on the Gatekeeper prompt, then open **System Settings > Privacy & Security**, scroll down, and click **Open Anyway**. A second prompt confirms and Husk launches normally from then on. Faster path if you live in the terminal:

```bash
xattr -dr com.apple.quarantine /Applications/Husk.app
```

**Voice on macOS.** Husk uses the built-in `say` command. No download. Voice toggles on instantly with a curated list (Samantha, Alex, Daniel, Karen, Moira, Tessa, Victoria).

**Code signing.** macOS builds are unsigned today; in-app auto-update on macOS is disabled until we have an Apple Developer ID. The update pill falls back to "open releases page".

## Windows

| Format | Use when | Notes |
|--------|----------|-------|
| `husk-v<version>-win-x64.exe` | Most users | NSIS installer; pick install dir, creates Start menu and desktop shortcuts. Auto-update works. |
| `husk-v<version>-win-x64.zip` | Portable | Unzip, run `Husk.exe`. No registration. |

**PATH and PATHEXT.** Husk looks for `claude.cmd` / `copilot.cmd` / `claude.exe` / etc. by walking `PATH` and applying `PATHEXT` itself, then spawning the resolved file directly. If you installed an agent CLI via npm globally, it is already on `PATH`. If not, the first-launch wizard offers a one-click `npm install -g`.

## Verifying your download

Every release ships a `SHA256SUMS` file plus Sigstore build-provenance attestations bound to the workflow run that produced the artifacts.

```bash
# Checksum
sha256sum -c SHA256SUMS

# Sigstore build provenance (requires gh CLI 2.49+)
gh attestation verify husk-v<version>-linux-x86_64.AppImage --repo DorShaer/Husk
```

The provenance verifier checks that the artifact really came out of the GitHub Actions workflow on `DorShaer/Husk` rather than a hand-uploaded file.

## Install from source (developers)

Full step-by-step guide, including building your own packages and troubleshooting: [build-from-source.md](build-from-source.md). Short version:

```bash
git clone https://github.com/DorShaer/Husk.git husk
cd husk
./installer/install.sh   # registers Husk with the OS and bootstraps LifeOS into ~/.claude/
# or
./scripts/run.sh         # dev mode, no system registration
```

`install.sh` detects the platform with `uname` and runs the right registration model:
- Linux: wrapper at `~/.local/bin/husk`, a `.desktop` entry, a hicolor PNG icon, and an optional GNOME favorites pin.
- macOS: wrapper at `~/.local/bin/husk` plus a real `~/Applications/Husk.app` bundle (with `.icns` generated from the source PNG when `iconutil` and `sips` are present).
- Windows: `install.sh` does not run on Windows; use `install.ps1` (PowerShell source install, same SHA-256-pinned dependency fetching) or the packaged `.exe`.

Both Linux and macOS source installs run `npm install` and `npm run rebuild` (electron-rebuild against Electron's Node ABI) on the first install.

Any third-party script the installer fetches (currently just the bun installer) is downloaded to a temp file and SHA-256-verified against a pin in `install.sh` before it runs. See `installer/lib/verify.sh` and `installer/lib/verify.ps1` for the pinning policy and how to refresh a pin.

## Uninstall

```bash
./installer/uninstall.sh             # removes the launcher, OS registration, config, voice models
./installer/uninstall.sh --keep-data # preserves ~/.config/husk/ and the Piper voices
```

The project directory and `node_modules/` are always left intact so `./installer/install.sh` can re-run.
If the checkout itself lives inside a path the uninstaller would normally clean
(for example `~/.local/share/husk`), that cleanup is skipped and a warning is
printed rather than deleting the project.

## Updates

Husk shows a small version pill in the topbar. When a newer version is on the Releases page, the pill grows a soft pulsing orange dot and reads `vX.Y.Z available`. Click it to see release notes and install.

- Windows NSIS and Linux AppImage update in-place: download, click "Restart and install", relaunched on the new version.
- `.deb`, `.rpm`, and unsigned macOS `.dmg` cannot auto-update; the popover swaps to "Open releases page".
- Husk checks once at boot (4s after launch) and again every 6 hours. No telemetry; the request goes straight to the GitHub Releases API.
