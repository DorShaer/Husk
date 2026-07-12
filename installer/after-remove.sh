#!/bin/bash
# Post-remove: undo what the post-install added, then refresh caches.

# dpkg runs this on an upgrade too, and it runs it AFTER the new package's files
# are already on disk. Cleaning up there would delete the icons and the launcher
# the new version just installed, and would drop Husk out of the user's dock on
# every single update. Only a real removal cleans up.
case "$1" in
  remove|purge|'') ;;
  *) exit 0 ;;
esac

# Remove the PATH launcher created in after-install, but only if it still
# points at our binary (guards against clobbering an unrelated husk).
# Accept either install dir so a symlink from an earlier package is cleaned up too.
LINK="/usr/local/bin/husk"
if [ -L "$LINK" ]; then
  TARGET="$(readlink "$LINK")"
  if [ "$TARGET" = "/opt/husk/husk" ] || [ "$TARGET" = "/opt/Husk/husk" ]; then
    rm -f "$LINK" || true
  fi
fi

for SIZE in 1024x1024 512x512 256x256 128x128 64x64 48x48 32x32 24x24 16x16; do
  rm -f "/usr/share/icons/hicolor/$SIZE/apps/husk.png"
done
if command -v update-desktop-database &>/dev/null; then
  update-desktop-database /usr/share/applications/ || true
fi
if command -v gtk-update-icon-cache &>/dev/null; then
  gtk-update-icon-cache -qf /usr/share/icons/hicolor/ || true
fi

# Unpin from GNOME Dash.
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
    if [ -n "$CURRENT" ]; then
      NEW=$(echo "$CURRENT" | sed "s/, 'husk.desktop'//g;s/'husk.desktop', //g;s/'husk.desktop'//g")
      sudo -u "$REAL_USER" DBUS_SESSION_BUS_ADDRESS="$DBUS" \
        gsettings set org.gnome.shell favorite-apps "$NEW" 2>/dev/null || true
    fi
  fi
fi
