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

# Expose a `husk` command on PATH. electron-builder installs the binary under
# /opt and registers only a .desktop entry, so the package alone leaves no
# terminal launcher. Symlink into /usr/local/bin to match the wrapper the source
# installer creates. `ln -sf` also repoints a symlink left by an earlier package.
if [ -x "/opt/husk/husk" ]; then
  mkdir -p /usr/local/bin
  ln -sf /opt/husk/husk /usr/local/bin/husk || true
fi

# Remove the capitalised install dir an earlier package may have left behind.
if [ -d "/opt/Husk" ] && [ -d "/opt/husk" ]; then
  rm -rf "/opt/Husk" || true
fi

# The package ships a real icon at every hicolor size, so none is generated here.
# An icon directory whose image is a different size than the directory claims is
# not a working icon: the desktop downscales a megabyte for a 48px dock slot, and
# a size-strict environment ignores it entirely.
#
# Restore any size that is missing. dpkg runs the OLD package's post-remove AFTER
# unpacking the new files, so upgrading from a package whose post-remove deleted
# these would otherwise leave the icon gone. The sized icons ship inside the app,
# so restoring one needs no image tooling on this machine.
ICON_SRC="/opt/husk/resources/icons"
for SIZE in 1024x1024 512x512 256x256 128x128 64x64 48x48 32x32 24x24 16x16; do
  DEST_DIR="/usr/share/icons/hicolor/$SIZE/apps"
  DEST="$DEST_DIR/husk.png"
  [ -f "$DEST" ] && continue
  [ -f "$ICON_SRC/$SIZE.png" ] || continue
  mkdir -p "$DEST_DIR"
  cp "$ICON_SRC/$SIZE.png" "$DEST" || true
done
if command -v update-desktop-database &>/dev/null; then
  update-desktop-database /usr/share/applications/ || true
fi
if command -v gtk-update-icon-cache &>/dev/null; then
  # -f, so a cache built against the previous package's icons is rewritten rather
  # than kept because its timestamp still looks current.
  gtk-update-icon-cache -qf /usr/share/icons/hicolor/ || true
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
