#!/bin/bash
# Post-install: configure Chromium's sandbox, install icons, refresh caches,
# and pin to the GNOME Dash.

# Chromium's SUID sandbox helper must be owned by root with mode 4755.
# electron-builder injects this into its DEFAULT deb/rpm postinst, but supplying
# a custom afterInstall script REPLACES that default, so we must set it here
# ourselves. Without it the app aborts immediately on launch (only the launcher
# icon shows, no window) with:
#   FATAL ... The SUID sandbox helper binary was found, but is not configured
#   correctly ... /opt/husk/chrome-sandbox is owned by root and has mode 4755.
SANDBOX="/opt/husk/chrome-sandbox"
if [ -f "$SANDBOX" ]; then
  chown root:root "$SANDBOX" || true
  chmod 4755 "$SANDBOX" || true
fi

# Expose a `husk` command on PATH. electron-builder installs the binary to
# /opt/husk and registers only a .desktop entry, so a fresh package gives no
# terminal launcher. Symlink into /usr/local/bin so `husk` works from a shell,
# matching the wrapper the source installer (install.sh) creates.
# `ln -sf` also repoints the symlink left by pre-2.8.9 packages, which installed
# to the capitalised /opt/Husk and would otherwise dangle after this upgrade.
if [ -x "/opt/husk/husk" ]; then
  mkdir -p /usr/local/bin
  ln -sf /opt/husk/husk /usr/local/bin/husk || true
fi

# Drop the old capitalised install dir if an upgrade left it behind.
if [ -d "/opt/Husk" ] && [ -d "/opt/husk" ]; then
  rm -rf "/opt/Husk" || true
fi

# Install icon at standard hicolor sizes GNOME/KDE recognise,
# then refresh caches so the icon appears immediately without a logout.
SRC="/usr/share/icons/hicolor/1024x1024/apps/husk.png"
if [ -f "$SRC" ]; then
  for SIZE in 512x512 256x256 128x128 64x64 48x48; do
    DIR="/usr/share/icons/hicolor/$SIZE/apps"
    mkdir -p "$DIR"
    cp "$SRC" "$DIR/husk.png"
  done
fi
if command -v update-desktop-database &>/dev/null; then
  update-desktop-database /usr/share/applications/ || true
fi
if command -v gtk-update-icon-cache &>/dev/null; then
  gtk-update-icon-cache -q /usr/share/icons/hicolor/ || true
fi

# Pin to GNOME Dash. Runs as root via sudo so we need the real user's session.
REAL_USER="${SUDO_USER:-}"
if [ -z "$REAL_USER" ]; then
  REAL_USER=$(logname 2>/dev/null || true)
fi
if [ -n "$REAL_USER" ] && command -v gsettings &>/dev/null; then
  REAL_UID=$(id -u "$REAL_USER" 2>/dev/null || true)
  if [ -n "$REAL_UID" ]; then
    DBUS="unix:path=/run/user/$REAL_UID/bus"
    CURRENT=$(sudo -u "$REAL_USER" DBUS_SESSION_BUS_ADDRESS="$DBUS" \
      gsettings get org.gnome.shell favorite-apps 2>/dev/null || true)
    if [ -n "$CURRENT" ] && ! echo "$CURRENT" | grep -q "husk.desktop"; then
      NEW=$(echo "$CURRENT" | sed "s/]$/, 'husk.desktop']/")
      sudo -u "$REAL_USER" DBUS_SESSION_BUS_ADDRESS="$DBUS" \
        gsettings set org.gnome.shell favorite-apps "$NEW" 2>/dev/null || true
    fi
  fi
fi
