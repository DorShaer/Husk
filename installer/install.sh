#!/usr/bin/env bash
# Husk, production installer. Detects the OS and registers Husk the way
# that OS expects: a .desktop entry on Linux, a Husk.app bundle on macOS.
# Everything else (deps, native rebuild, wrapper, LifeOS bootstrap) is shared.
set -e

# This script lives in installer/, so the project root is its parent.
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_ID="husk"
APP_NAME="Husk"
PLATFORM="$(uname -s)"

BIN_DIR="$HOME/.local/bin"
WRAPPER="$BIN_DIR/$APP_ID"

C_OK='\033[0;32m'; C_INFO='\033[0;36m'; C_WARN='\033[1;33m'; C_DIM='\033[2m'; C_RST='\033[0m'
info() { echo -e "${C_INFO}▸${C_RST} $1"; }
ok()   { echo -e "${C_OK}✓${C_RST} $1"; }
warn() { echo -e "${C_WARN}!${C_RST} $1"; }
dim()  { echo -e "${C_DIM}$1${C_RST}"; }

cd "$APP_DIR"

# Pinned SHA-256 of the upstream bun installer script revision we
# accept. ensure_bun verifies the downloaded file against this constant
# before running it. Procedure for bumping is in installer/lib/verify.sh.
BUN_INSTALLER_URL="https://bun.sh/install"
BUN_INSTALLER_SHA256="bab8acfb046aac8c72407bdcce903957665d655d7acaa3e11c7c4616beae68dd"

# shellcheck source=installer/lib/verify.sh
. "$APP_DIR/installer/lib/verify.sh"

case "$PLATFORM" in
    Linux)  ok "Detected Linux" ;;
    Darwin) ok "Detected macOS" ;;
    *)      warn "Detected $PLATFORM (best-effort, no native registration)" ;;
esac

# ─── Node.js gate ──────────────────────────────────────────────────
# Everything below (npm install, @electron/rebuild) needs Node 20.19 or newer.
# Electron's own installer require()s an ESM-only module, which node supports by
# default only from 20.19, so an older 20.x clears a major-only check and then
# dies on a raw ERR_REQUIRE_ESM part-way through npm install. Check the minor too.
NODE_MIN_MAJOR=20
NODE_MIN_MINOR=19
if ! command -v node >/dev/null 2>&1; then
    echo -e "\033[0;31m✗\033[0m Node.js ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}+ is required but was not found."
    dim "  Install the current LTS from https://nodejs.org"
    dim "  or with nvm:  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install --lts"
    dim "  Prefer no install at all? Grab a prebuilt release instead:"
    dim "  https://github.com/DorShaer/Husk/releases"
    exit 1
fi
NODE_VER="$(node --version 2>/dev/null | sed 's/^v//')"
NODE_MAJOR="${NODE_VER%%.*}"
NODE_MINOR="${NODE_VER#*.}"; NODE_MINOR="${NODE_MINOR%%.*}"
case "$NODE_MAJOR" in (*[!0-9]*|'') NODE_MAJOR=0 ;; esac
case "$NODE_MINOR" in (*[!0-9]*|'') NODE_MINOR=0 ;; esac
if [ "$NODE_MAJOR" -lt "$NODE_MIN_MAJOR" ] \
   || { [ "$NODE_MAJOR" -eq "$NODE_MIN_MAJOR" ] && [ "$NODE_MINOR" -lt "$NODE_MIN_MINOR" ]; }; then
    echo -e "\033[0;31m✗\033[0m Node.js ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}+ is required; found v${NODE_VER}."
    dim "  Upgrade to the current LTS from https://nodejs.org (or: nvm install --lts)"
    dim "  Prebuilt releases need no Node at all: https://github.com/DorShaer/Husk/releases"
    exit 1
fi
ok "Node.js v${NODE_VER}"

# ─── 0. Prerequisites: jq + bun ────────────────────────────────────
# jq: the bundled statusline parses Anthropic OAuth usage with it; without
#     jq the 5h/7d limits never get cached.
# bun: LifeOS hooks are #!/usr/bin/env bun (RatingCapture, LearningSync, etc).
#     Without bun, no rating capture, learning is empty.
#
# Both are auto-installed when missing using the platform's native package
# manager. Failures here are logged but never abort the rest of the install,
# Husk's core still works without them, just with degraded LifeOS features.

# Decide whether to prefix install commands with sudo. Skip when already
# running as root (containers, restricted CI) or when sudo isn't on PATH.
SUDO=""
if [ "$(id -u 2>/dev/null)" != "0" ] && command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
fi

_install_jq_linux() {
    # Each branch is wrapped in `|| true` so a failing package manager call
    # never aborts the install (set -e at the script top would otherwise
    # bubble the error up and stop everything). The post-install
    # `command -v jq` check in ensure_jq is the source of truth.
    if   command -v apt-get >/dev/null 2>&1; then ($SUDO apt-get update -qq >/dev/null 2>&1 || true); $SUDO apt-get install -y jq || true
    elif command -v dnf     >/dev/null 2>&1; then $SUDO dnf install -y jq || true
    elif command -v yum     >/dev/null 2>&1; then $SUDO yum install -y jq || true
    elif command -v pacman  >/dev/null 2>&1; then $SUDO pacman -S --noconfirm jq || true
    elif command -v zypper  >/dev/null 2>&1; then $SUDO zypper install -y jq || true
    elif command -v apk     >/dev/null 2>&1; then $SUDO apk add --no-cache jq || true
    else warn "No supported package manager found (apt/dnf/yum/pacman/zypper/apk). Install jq manually."; fi
    return 0
}

_install_jq_mac() {
    if command -v brew >/dev/null 2>&1; then brew install jq || true
    elif command -v port >/dev/null 2>&1; then $SUDO port install jq || true
    else warn "Homebrew not detected. Install Homebrew (https://brew.sh) and re-run, or run 'brew install jq' yourself."; fi
    return 0
}

ensure_jq() {
    if command -v jq >/dev/null 2>&1; then
        ok "jq present ($(jq --version 2>/dev/null || echo unknown))"
        return 0
    fi
    info "Installing jq (the statusline needs it for the Anthropic usage cache)..."
    case "$PLATFORM" in
        Linux)  _install_jq_linux ;;
        Darwin) _install_jq_mac ;;
        *) warn "Auto-install not supported on $PLATFORM. Install jq manually."; return 1 ;;
    esac
    if command -v jq >/dev/null 2>&1; then
        ok "jq installed"
    else
        warn "jq install command finished but jq is still not on PATH; continuing without it. The usage cache will not refresh until you install it."
        return 1
    fi
}

_ensure_unzip() {
    # The bun installer extracts a zip; on minimal distros (containers, fresh
    # WSL, Alpine) unzip is not present and the installer aborts. Pull it in
    # quietly first so the bun step can succeed.
    if command -v unzip >/dev/null 2>&1; then return 0; fi
    case "$PLATFORM" in
        Linux)
            if   command -v apt-get >/dev/null 2>&1; then $SUDO apt-get install -y unzip || true
            elif command -v dnf     >/dev/null 2>&1; then $SUDO dnf install -y unzip || true
            elif command -v yum     >/dev/null 2>&1; then $SUDO yum install -y unzip || true
            elif command -v pacman  >/dev/null 2>&1; then $SUDO pacman -S --noconfirm unzip || true
            elif command -v zypper  >/dev/null 2>&1; then $SUDO zypper install -y unzip || true
            elif command -v apk     >/dev/null 2>&1; then $SUDO apk add --no-cache unzip || true
            fi
            ;;
        Darwin)
            # macOS ships unzip in the base system; nothing to do.
            ;;
    esac
    return 0
}

ensure_bun() {
    if command -v bun >/dev/null 2>&1; then
        ok "bun present ($(bun --version 2>/dev/null || echo unknown))"
        return 0
    fi
    info "Installing bun (LifeOS hooks need it for rating capture and learning)..."
    if ! command -v curl >/dev/null 2>&1; then
        warn "curl is required to install bun. Install curl, or install bun manually from https://bun.sh"
        return 1
    fi
    _ensure_unzip
    # Download the bun installer to a temp file and check its SHA-256
    # against the pinned constant before running it.
    local installer_tmp
    if ! installer_tmp=$(mktemp 2>/dev/null); then
        warn "Could not create temp file for bun installer; continuing without bun."
        return 1
    fi
    if ! download_and_verify "$BUN_INSTALLER_URL" "$BUN_INSTALLER_SHA256" "$installer_tmp"; then
        warn "bun installer SHA-256 did not match the pinned value (expected $BUN_INSTALLER_SHA256). Skipping. To update the pin, see installer/lib/verify.sh."
        rm -f "$installer_tmp"
        return 1
    fi
    if ! bash "$installer_tmp"; then
        warn "bun installer reported a failure; continuing without bun. LifeOS hooks will not run until bun is installed."
        rm -f "$installer_tmp"
        return 1
    fi
    rm -f "$installer_tmp"
    if [ -x "$HOME/.bun/bin/bun" ]; then
        export PATH="$HOME/.bun/bin:$PATH"
        ok "bun installed at $HOME/.bun/bin (added to PATH for this session)"
    else
        warn "bun install completed but $HOME/.bun/bin/bun is missing; LifeOS hooks will not run until you install bun manually."
        return 1
    fi
}

info "Checking prerequisites (jq, bun)..."
ensure_jq || true
ensure_bun || true

# ─── 1. Dependencies (all platforms) ──────────────────────────────
if [ ! -d node_modules ] || [ ! -f node_modules/node-pty/build/Release/pty.node ]; then
    info "Installing Node dependencies..."
    npm install --no-audit --no-fund
    info "Rebuilding node-pty for Electron's Node ABI..."
    npx --yes @electron/rebuild -f -w node-pty
    ok "Dependencies installed"
else
    ok "Dependencies already installed"
fi

# ─── 2. Sandbox helper check (Linux only; macOS uses its own sandbox model) ─
if [ "$PLATFORM" = "Linux" ]; then
    SANDBOX_BIN="$APP_DIR/node_modules/electron/dist/chrome-sandbox"
    if [ -e "$SANDBOX_BIN" ]; then
        OWNER=$(stat -c '%U' "$SANDBOX_BIN" 2>/dev/null || echo "")
        PERMS=$(stat -c '%a' "$SANDBOX_BIN" 2>/dev/null || echo "")
        if [ "$OWNER" = "root" ] && [ "$PERMS" = "4755" ]; then
            ok "Sandbox helper is setuid root (secure mode)"
        else
            warn "Sandbox helper not setuid, app will run with --no-sandbox (fine for personal use)"
            dim "  To enable secure sandbox: sudo chown root:root \"$SANDBOX_BIN\" && sudo chmod 4755 \"$SANDBOX_BIN\""
        fi
    fi
fi

# ─── 3. Wrapper script (all platforms) ─────────────────────────────
# The desktop icon launches this with a stripped PATH (no shell rc), so a
# node installed via nvm/fnm is invisible and run.sh's Node-20 gate fails
# silently. Bake the install-time node dir into the wrapper's PATH so the GUI
# launch uses the same node the terminal install validated.
mkdir -p "$BIN_DIR"
NODE_BIN_DIR="$(dirname "$(command -v node)")"
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
# Auto-generated by Husk install.sh, do not edit by hand
export PATH="$NODE_BIN_DIR:\$PATH"
cd "$APP_DIR"
exec ./scripts/run.sh
EOF
chmod +x "$WRAPPER"
ok "Wrapper installed: $WRAPPER"
case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) warn "$BIN_DIR is not on your PATH. Add it to your shell rc to launch Husk by name." ;;
esac

# ─── 4. LifeOS bootstrap (all platforms) ───────────────────────────
# Husk ships with a copy of LifeOS by Daniel Miessler. We copy the runtime,
# agents, commands, hooks, skills, and a CLAUDE.md template into ~/.claude/
# on first install. Existing files are never overwritten, if you have your
# own ~/.claude/, we only add what is missing. Keep this in step with
# bootstrapPaiIfNeeded() in src/main.js, which is the same install for
# packaged builds.
LIFEOS_BUNDLE="$APP_DIR/libs/lifeos"
CLAUDE_DIR="$HOME/.claude"
if [ -d "$CLAUDE_DIR/PAI" ]; then
    # An install predating this version keeps the older framework under PAI/
    # with a CLAUDE.md addressing it. Adding the new tree alongside would leave
    # two frameworks and a routing file naming only the old one, so leave it be.
    info "Existing PAI install found at $CLAUDE_DIR/PAI, leaving it untouched"
elif [ -d "$LIFEOS_BUNDLE" ]; then
    info "Bootstrapping LifeOS into $CLAUDE_DIR (only adds missing files)..."
    mkdir -p "$CLAUDE_DIR"
    if [ ! -f "$CLAUDE_DIR/CLAUDE.md" ]; then
        cp "$LIFEOS_BUNDLE/CLAUDE.template.md" "$CLAUDE_DIR/CLAUDE.md" 2>/dev/null || true
        ok "Installed CLAUDE.md (you can edit it any time)"
    fi
    # LIFEOS is spelled in caps to match the @LIFEOS/... imports CLAUDE.md
    # carries: on a case-sensitive filesystem any other spelling dangles.
    for SUBDIR in LIFEOS agents commands hooks skills; do
        if [ -d "$LIFEOS_BUNDLE/$SUBDIR" ]; then
            if [ ! -d "$CLAUDE_DIR/$SUBDIR" ]; then
                cp -R "$LIFEOS_BUNDLE/$SUBDIR" "$CLAUDE_DIR/$SUBDIR"
                ok "Installed $SUBDIR/"
            else
                cp -Rn "$LIFEOS_BUNDLE/$SUBDIR/." "$CLAUDE_DIR/$SUBDIR/" 2>/dev/null || true
            fi
        fi
    done
    # The identity scaffold lands inside the runtime tree so the
    # @LIFEOS/USER/... imports resolve without a symlink. Every shipped file is
    # a blank template, and -n means an answered one is never overwritten.
    if [ -d "$LIFEOS_BUNDLE/USER" ]; then
        mkdir -p "$CLAUDE_DIR/LIFEOS/USER"
        cp -Rn "$LIFEOS_BUNDLE/USER/." "$CLAUDE_DIR/LIFEOS/USER/" 2>/dev/null || true
    fi
    # Per-install state the runtime writes into but the bundle never ships.
    for MEMDIR in WORK KNOWLEDGE LEARNING STATE OBSERVABILITY SKILLS; do
        mkdir -p "$CLAUDE_DIR/LIFEOS/MEMORY/$MEMDIR"
    done
    # Agent-instruction files carried inside the bundle belong to the upstream
    # project's own repo, where they steer whoever is editing the framework.
    # Landed in a user's ~/.claude/ they read as standing orders that person
    # never wrote, in the exact place the CLI looks for their own. Writing
    # their instructions is their business. Only the ones we just copied are
    # removed, and only when they still match the bundle byte for byte, so a
    # file the user already had is never touched.
    find "$CLAUDE_DIR" -name 'CLAUDE.md' -not -path "$CLAUDE_DIR/CLAUDE.md" 2>/dev/null | while read -r INSTALLED; do
        REL="${INSTALLED#$CLAUDE_DIR/}"
        SRC="$LIFEOS_BUNDLE/$REL"
        [ -f "$SRC" ] || continue
        cmp -s "$INSTALLED" "$SRC" && rm -f "$INSTALLED"
    done
    ok "LifeOS ready"
fi

# ─── 5. Platform-specific app registration ─────────────────────────
case "$PLATFORM" in
    Linux)
        DESKTOP_DIR="$HOME/.local/share/applications"
        DESKTOP_FILE="$DESKTOP_DIR/$APP_ID.desktop"
        ICON_FILE="$HOME/.local/share/icons/hicolor/256x256/apps/$APP_ID.png"

        # Install each size into the directory that claims it. Dropping the 1024px
        # source into a 256x256 directory, as this once did, means the desktop
        # downscales a megabyte for a dock icon and a size-strict environment
        # ignores it. The sized icons are in the repo, so no image tooling is needed.
        for SIZE in 1024x1024 512x512 256x256 128x128 64x64 48x48 32x32 24x24 16x16; do
            SRC="$APP_DIR/installer/icons/$SIZE.png"
            [ -f "$SRC" ] || continue
            DIR="$HOME/.local/share/icons/hicolor/$SIZE/apps"
            mkdir -p "$DIR"
            cp "$SRC" "$DIR/$APP_ID.png"
        done
        ok "Icons installed under $HOME/.local/share/icons/hicolor"

        mkdir -p "$DESKTOP_DIR"
        cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=$APP_NAME
GenericName=AI Agent Shell
Comment=Visual desktop shell for Claude Code and other terminal AI agents
Icon=$APP_ID
Exec=$WRAPPER
Terminal=false
Categories=Development;Utility;Network;
StartupNotify=true
StartupWMClass=$APP_ID
Keywords=ai;claude;agent;chat;terminal;husk;
EOF
        chmod +x "$DESKTOP_FILE"
        ok "Desktop entry installed: $DESKTOP_FILE"

        command -v update-desktop-database >/dev/null 2>&1 \
            && update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
        command -v gtk-update-icon-cache >/dev/null 2>&1 \
            && gtk-update-icon-cache -tf "$HOME/.local/share/icons/hicolor" 2>/dev/null || true

        # GNOME favorites (best-effort, opt-in)
        if command -v gsettings >/dev/null 2>&1; then
            CURRENT=$(gsettings get org.gnome.shell favorite-apps 2>/dev/null || echo "")
            if [ -n "$CURRENT" ] && ! echo "$CURRENT" | grep -q "$APP_ID.desktop"; then
                echo
                read -p "Pin Husk to GNOME favorites bar? [Y/n]: " -r REPLY
                if [[ -z "$REPLY" || "$REPLY" =~ ^[Yy]$ ]]; then
                    NEW=$(echo "$CURRENT" | sed "s/]/, '$APP_ID.desktop']/")
                    gsettings set org.gnome.shell favorite-apps "$NEW" 2>/dev/null && ok "Pinned to favorites" || warn "Could not pin (non-GNOME?)"
                fi
            fi
        fi

        LAUNCH_HINT="open the Activities / Apps menu, search '$APP_NAME'"
        ;;
    Darwin)
        # Build a minimal .app bundle in ~/Applications. macOS picks it up in
        # Spotlight, Launchpad, and Finder. The bundle's MacOS launcher just
        # execs our wrapper, which in turn execs run.sh from the source dir.
        APPS_DIR="$HOME/Applications"
        APP_BUNDLE="$APPS_DIR/$APP_NAME.app"
        mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources"

        cat > "$APP_BUNDLE/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>$APP_NAME</string>
    <key>CFBundleDisplayName</key><string>$APP_NAME</string>
    <key>CFBundleIdentifier</key><string>com.husk.app</string>
    <key>CFBundleExecutable</key><string>$APP_NAME</string>
    <key>CFBundleIconFile</key><string>$APP_ID</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>0.2</string>
    <key>CFBundleVersion</key><string>0.2</string>
    <key>LSMinimumSystemVersion</key><string>10.13</string>
    <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF

        cat > "$APP_BUNDLE/Contents/MacOS/$APP_NAME" <<EOF
#!/usr/bin/env bash
# Auto-generated by Husk install.sh
export PATH="$NODE_BIN_DIR:\$HOME/.local/bin:\$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:\$PATH"
cd "$APP_DIR"
exec ./scripts/run.sh
EOF
        chmod +x "$APP_BUNDLE/Contents/MacOS/$APP_NAME"

        # Icon: prefer .icns built via iconutil if available, else fall back to PNG.
        SRC_ICON="$APP_DIR/installer/husk-icon.png"
        if command -v iconutil >/dev/null 2>&1 && command -v sips >/dev/null 2>&1; then
            ICONSET="$(mktemp -d)/$APP_ID.iconset"
            mkdir -p "$ICONSET"
            for SZ in 16 32 64 128 256 512; do
                sips -z $SZ $SZ "$SRC_ICON" --out "$ICONSET/icon_${SZ}x${SZ}.png" >/dev/null 2>&1 || true
                sips -z $((SZ*2)) $((SZ*2)) "$SRC_ICON" --out "$ICONSET/icon_${SZ}x${SZ}@2x.png" >/dev/null 2>&1 || true
            done
            iconutil -c icns "$ICONSET" -o "$APP_BUNDLE/Contents/Resources/$APP_ID.icns" 2>/dev/null \
                && ok "Icon (.icns) generated" \
                || cp "$SRC_ICON" "$APP_BUNDLE/Contents/Resources/$APP_ID.png"
        else
            cp "$SRC_ICON" "$APP_BUNDLE/Contents/Resources/$APP_ID.png"
        fi
        ok "App bundle installed: $APP_BUNDLE"

        # Refresh Launch Services so Spotlight / Finder pick it up immediately.
        LSREG=/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister
        [ -x "$LSREG" ] && "$LSREG" -f "$APP_BUNDLE" 2>/dev/null || true

        LAUNCH_HINT="open Spotlight (⌘+Space) and search '$APP_NAME', or open Launchpad"
        ;;
    *)
        LAUNCH_HINT="run: $WRAPPER"
        ;;
esac

echo
echo -e "${C_OK}═══════════════════════════════════════════════════════${C_RST}"
echo -e "${C_OK}  $APP_NAME installed${C_RST}"
echo -e "${C_OK}═══════════════════════════════════════════════════════${C_RST}"
echo
echo "  Launch:    $LAUNCH_HINT"
echo "  Or run:    $WRAPPER"
echo
echo "  Uninstall: ./installer/uninstall.sh"
echo
