#!/usr/bin/env bash
# Husk: local dev launcher.
# Runs the app from the source tree without registering it as a desktop app.
# Use this while iterating on code. For a real install, run ./installer/install.sh once.
set -e
# This script lives in scripts/, and everything below (node_modules, electron .)
# is resolved from the project root, which is its parent.
cd "$(dirname "$0")/.."

C_OK='\033[0;32m'; C_INFO='\033[0;36m'; C_WARN='\033[1;33m'; C_DIM='\033[2m'; C_RST='\033[0m'

# Node 20+ gate: npm install and @electron/rebuild below both need it, and
# failing here beats failing minutes later with a raw ERR_REQUIRE_ESM trace.
NODE_MIN_MAJOR=20
if ! command -v node >/dev/null 2>&1; then
    echo -e "\033[0;31m✗\033[0m Node.js ${NODE_MIN_MAJOR}+ is required but was not found."
    echo -e "${C_DIM}  Install the current LTS from https://nodejs.org (or: nvm install --lts)${C_RST}"
    exit 1
fi
NODE_VER="$(node --version 2>/dev/null | sed 's/^v//')"
NODE_MAJOR="${NODE_VER%%.*}"
case "$NODE_MAJOR" in (*[!0-9]*|'') NODE_MAJOR=0 ;; esac
if [ "$NODE_MAJOR" -lt "$NODE_MIN_MAJOR" ]; then
    echo -e "\033[0;31m✗\033[0m Node.js ${NODE_MIN_MAJOR}+ is required; found v${NODE_VER}."
    echo -e "${C_DIM}  Upgrade to the current LTS from https://nodejs.org (or: nvm install --lts)${C_RST}"
    exit 1
fi

# First-run only: install dependencies and build the native pty module.
if [ ! -d node_modules ] || [ ! -f node_modules/node-pty/build/Release/pty.node ]; then
    echo -e "${C_INFO}▸${C_RST} Installing dependencies (one-time)..."
    npm install --no-audit --no-fund
    echo -e "${C_INFO}▸${C_RST} Rebuilding node-pty against Electron's Node ABI..."
    npx --yes @electron/rebuild -f -w node-pty
fi

# Detect whether the bundled Electron sandbox helper is setuid root.
# If yes, run with sandbox enabled. If not, fall back to --no-sandbox so the
# app launches without requiring root. Print a one-line hint either way.
SANDBOX_BIN="node_modules/electron/dist/chrome-sandbox"
SANDBOX_OK=0
if [ -e "$SANDBOX_BIN" ]; then
    OWNER=$(stat -c '%U' "$SANDBOX_BIN" 2>/dev/null || echo "")
    PERMS=$(stat -c '%a' "$SANDBOX_BIN" 2>/dev/null || echo "")
    [ "$OWNER" = "root" ] && [ "$PERMS" = "4755" ] && SANDBOX_OK=1
fi

# Reap zombies from previous Husk runs. Closed window does not always reap
# the full electron tree, especially after a hard kill, and stale procs each
# hold inotify watchers + file descriptors. Match by app-path so we never
# touch unrelated electron apps on the system.
APP_PATH=$(realpath "$PWD")
ZOMBIES=$(pgrep -af "electron.*--app-path=$APP_PATH" 2>/dev/null | awk '{print $1}' | grep -v "^$$\$" || true)
if [ -n "$ZOMBIES" ]; then
    COUNT=$(echo "$ZOMBIES" | wc -l)
    echo -e "${C_WARN}!${C_RST} Reaping $COUNT stale Husk process(es) from a previous run..."
    echo "$ZOMBIES" | xargs -r kill -TERM 2>/dev/null || true
    sleep 0.3
    echo "$ZOMBIES" | xargs -r kill -KILL 2>/dev/null || true
fi

# Warn if the kernel's inotify limit is so low that Electron's renderer is
# likely to fail. Default on Ubuntu is 128; if much of it is already used,
# Husk's chrome workers fall back to noisy ENOSPC errors.
if [ -r /proc/sys/fs/inotify/max_user_instances ]; then
    LIMIT=$(cat /proc/sys/fs/inotify/max_user_instances 2>/dev/null || echo 128)
    if [ "$LIMIT" -lt 256 ]; then
        echo -e "${C_DIM}  inotify max_user_instances=$LIMIT (raise to 1024 if you see watcher errors:${C_RST}"
        echo -e "${C_DIM}    sudo sysctl fs.inotify.max_user_instances=1024)${C_RST}"
    fi
fi

echo -e "${C_OK}▸${C_RST} Husk ${C_DIM}(dev mode)${C_RST}"
if [ "$SANDBOX_OK" -eq 1 ]; then
    exec npx electron .
else
    echo -e "  ${C_DIM}sandbox: disabled. To enable, run once:${C_RST}"
    echo -e "  ${C_DIM}sudo chown root:root \"$PWD/$SANDBOX_BIN\" && sudo chmod 4755 \"$PWD/$SANDBOX_BIN\"${C_RST}"
    exec npx electron --no-sandbox .
fi
