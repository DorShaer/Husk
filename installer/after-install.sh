#!/bin/bash
# Post-install: install icon at standard hicolor sizes GNOME/KDE recognise,
# then refresh caches so the icon appears immediately without a logout.
SRC="/usr/share/icons/hicolor/1024x1024/apps/husk.png"
if [ -f "$SRC" ]; then
  for SIZE in 512x512 256x256 128x128 64x64 48x48; do
    DIR="/usr/share/icons/hicolor/${SIZE}/apps"
    mkdir -p "$DIR"
    cp "$SRC" "${DIR}/husk.png"
  done
fi
if command -v update-desktop-database &>/dev/null; then
  update-desktop-database /usr/share/applications/ || true
fi
if command -v gtk-update-icon-cache &>/dev/null; then
  gtk-update-icon-cache -q /usr/share/icons/hicolor/ || true
fi
