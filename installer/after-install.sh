#!/bin/bash
# Post-install: refresh desktop database and icon cache so the app icon
# appears in the launcher immediately without requiring a logout.
if command -v update-desktop-database &>/dev/null; then
  update-desktop-database /usr/share/applications/ || true
fi
if command -v gtk-update-icon-cache &>/dev/null; then
  gtk-update-icon-cache -q /usr/share/icons/hicolor/ || true
fi
