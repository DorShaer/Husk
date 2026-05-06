#!/usr/bin/env bash
# Husk uninstaller. Removes the launcher and platform-specific app
# registration, plus config / voice / cache by default. Pass --keep-data
# to preserve config and voice data. The project directory and node_modules
# are always left intact (re-install via ./install.sh uses them).
set -e

APP_ID="husk"
APP_NAME="Husk"
PLATFORM="$(uname -s)"

WRAPPER="$HOME/.local/bin/$APP_ID"
CONFIG_DIR="$HOME/.config/$APP_ID"
DATA_DIR="$HOME/.local/share/$APP_ID"
TMP_DIR="/tmp/$APP_ID"

# Linux-specific
DESKTOP_FILE="$HOME/.local/share/applications/$APP_ID.desktop"
LINUX_ICON_FILE="$HOME/.local/share/icons/hicolor/256x256/apps/$APP_ID.png"

# macOS-specific
MAC_APP_BUNDLE="$HOME/Applications/$APP_NAME.app"

KEEP_DATA=0
[ "$1" = "--keep-data" ] && KEEP_DATA=1

C_OK='\033[0;32m'; C_WARN='\033[1;33m'; C_DIM='\033[2m'; C_RST='\033[0m'

removed=0
remove_path() {
    if [ -e "$1" ]; then
        rm -rf "$1" && echo -e "${C_OK}removed${C_RST} $1" && removed=$((removed+1))
    fi
}

# Common: wrapper + tmp dir
remove_path "$WRAPPER"
remove_path "$TMP_DIR"

# Platform-specific app registration
case "$PLATFORM" in
    Linux)
        remove_path "$DESKTOP_FILE"
        remove_path "$LINUX_ICON_FILE"
        # Drop GNOME favorite if present
        if command -v gsettings >/dev/null 2>&1; then
            CURRENT=$(gsettings get org.gnome.shell favorite-apps 2>/dev/null || echo "")
            if echo "$CURRENT" | grep -q "$APP_ID.desktop"; then
                NEW=$(echo "$CURRENT" | sed "s/'$APP_ID.desktop',\? *//;s/, *]/]/")
                gsettings set org.gnome.shell favorite-apps "$NEW" 2>/dev/null \
                    && echo -e "${C_OK}removed${C_RST} from GNOME favorites" || true
            fi
        fi
        # Refresh caches
        command -v update-desktop-database >/dev/null 2>&1 \
            && update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
        command -v gtk-update-icon-cache >/dev/null 2>&1 \
            && gtk-update-icon-cache -tf "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
        ;;
    Darwin)
        remove_path "$MAC_APP_BUNDLE"
        # Tell Launch Services to forget the bundle
        LSREG=/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister
        [ -x "$LSREG" ] && "$LSREG" -u "$MAC_APP_BUNDLE" 2>/dev/null || true
        ;;
esac

# User data (default: removed; --keep-data preserves)
if [ "$KEEP_DATA" -eq 0 ]; then
    remove_path "$CONFIG_DIR"
    remove_path "$DATA_DIR"
else
    echo -e "${C_DIM}keeping config: $CONFIG_DIR${C_RST}"
    echo -e "${C_DIM}keeping data:   $DATA_DIR${C_RST}"
fi

if [ "$removed" -eq 0 ]; then
    echo -e "${C_WARN}!${C_RST} Husk was not installed (nothing to remove)"
else
    echo
    echo -e "${C_OK}Husk uninstalled${C_RST}"
    echo "  Project directory and node_modules left intact at: $(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [ "$KEEP_DATA" -eq 1 ]; then echo "  Config and voice data kept (--keep-data)"; fi
fi
exit 0
