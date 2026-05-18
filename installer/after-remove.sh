#!/bin/bash
# Post-remove: refresh desktop database so the icon is removed from the
# launcher immediately.
if command -v update-desktop-database &>/dev/null; then
  update-desktop-database /usr/share/applications/ || true
fi
if command -v gtk-update-icon-cache &>/dev/null; then
  gtk-update-icon-cache -q /usr/share/icons/hicolor/ || true
fi
