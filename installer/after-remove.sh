#!/bin/bash
# Post-remove: clean up icon copies at standard sizes, then refresh caches.

# Remove the PATH launcher created in after-install, but only if it still
# points at our binary (guards against clobbering an unrelated husk).
# /opt/Husk is the pre-2.8.9 path; accept either so an old symlink is cleaned up.
LINK="/usr/local/bin/husk"
if [ -L "$LINK" ]; then
  TARGET="$(readlink "$LINK")"
  if [ "$TARGET" = "/opt/husk/husk" ] || [ "$TARGET" = "/opt/Husk/husk" ]; then
    rm -f "$LINK" || true
  fi
fi

for SIZE in 512x512 256x256 128x128 64x64 48x48; do
  rm -f "/usr/share/icons/hicolor/$SIZE/apps/husk.png"
done
if command -v update-desktop-database &>/dev/null; then
  update-desktop-database /usr/share/applications/ || true
fi
if command -v gtk-update-icon-cache &>/dev/null; then
  gtk-update-icon-cache -q /usr/share/icons/hicolor/ || true
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
