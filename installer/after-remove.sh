#!/bin/bash
# Post-remove: clean up icon copies at standard sizes, then refresh caches.
for SIZE in 512x512 256x256 128x128 64x64 48x48; do
  rm -f "/usr/share/icons/hicolor/$SIZE/apps/husk.png"
done
if command -v update-desktop-database &>/dev/null; then
  update-desktop-database /usr/share/applications/ || true
fi
if command -v gtk-update-icon-cache &>/dev/null; then
  gtk-update-icon-cache -q /usr/share/icons/hicolor/ || true
fi
