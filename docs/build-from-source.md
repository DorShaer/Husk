# Build Husk from source

Step-by-step guide from a fresh clone to a running app or an installable package. Every step is copy-paste.

## 1. Prerequisites

| Tool | Version | Check | Get it |
|------|---------|-------|--------|
| git | any recent | `git --version` | your package manager |
| Node.js | **20.19 or newer** (22 LTS recommended) | `node --version` | https://nodejs.org or `nvm install --lts` |
| npm | ships with Node | `npm --version` | comes with Node |

Node older than 20.19 fails mid-build with a raw `ERR_REQUIRE_ESM` trace. Check the version first.

Linux also needs the native-module toolchain for `node-pty` (skip if you have build tools already):

```bash
# Debian / Ubuntu
sudo apt install build-essential python3

# Fedora / RHEL
sudo dnf install make gcc-c++ python3
```

macOS needs the Xcode command line tools: `xcode-select --install`.

Windows: use `installer/install.ps1` from PowerShell instead of the steps below; it fetches pinned dependencies and registers Husk for you.

## 2. Clone

```bash
git clone https://github.com/DorShaer/Husk.git husk
cd husk
```

## 3. Install dependencies

```bash
npm install
npm run rebuild   # rebuilds node-pty against Electron's Node ABI
```

`npm run rebuild` is required once after every `npm install` and after every Electron version bump. Without it the terminal pane cannot spawn.

## 4. Run it

Pick one:

```bash
# Dev mode: runs from the source tree, no system registration.
# Also does step 3 for you on first run.
./scripts/run.sh

# Desktop install: registers a launcher, icon, and .desktop entry
# (Linux) or an ~/Applications/Husk.app bundle (macOS).
./installer/install.sh
```

`run.sh` is the loop for hacking on the code: edit, relaunch, repeat. `install.sh` is for using your build day to day.

## 5. Build installable packages (optional)

```bash
npm run dist:linux   # .deb + .AppImage + .rpm into dist/
npm run dist:mac     # .dmg + .zip
npm run dist:win     # NSIS .exe + portable .zip
```

Notes:

- Build on the OS you are targeting; cross-building is not supported.
- The `.rpm` target needs `rpmbuild` on the build machine (`sudo apt install rpm` or `sudo dnf install rpm-build`). Without it the deb and AppImage still build; the run just ends with an rpm error you can ignore.
- Artifacts land in `dist/` as `husk-v<version>-<os>-<arch>.<ext>`.

Install your own package:

```bash
sudo apt install ./dist/husk-v*-linux-amd64.deb    # Debian / Ubuntu
sudo dnf install ./dist/husk-v*-linux-x86_64.rpm   # Fedora / RHEL
```

## 6. Verify the build

```bash
npm test           # unit tests, runs in about a second
npm run test:e2e   # Playwright smoke that boots the real app
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ERR_REQUIRE_ESM` during `npm run dist:*` | Node older than 20.19 | upgrade Node, re-run |
| Terminal pane empty, pty errors in console | `node-pty` built for the wrong ABI | `npm run rebuild` |
| `The SUID sandbox helper binary was found, but...` | `chrome-sandbox` not setuid root | harmless; `run.sh` auto-applies `--no-sandbox`, or `sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox` |
| AppImage refuses to start | missing `libfuse2` | `sudo apt install libfuse2` |
| Desktop icon does nothing after a source install | GUI launches strip the shell PATH, so an nvm-installed Node is invisible | re-run `./installer/install.sh`; the wrapper bakes the Node location into its PATH |
| Sluggish or failing file watching with many Electron apps open | low inotify limit | `sudo sysctl fs.inotify.max_user_instances=1024` |

## Uninstall

```bash
./installer/uninstall.sh             # removes launcher, OS registration, config, voice models
./installer/uninstall.sh --keep-data # keeps ~/.config/husk/ and downloaded voices
```

The clone and `node_modules/` are always left intact, so `./installer/install.sh` can re-run.
