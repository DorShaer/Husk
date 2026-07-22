#!/bin/bash
# Unlock keychain for headless access (macOS only), then start Pulse
if [ "$(uname -s)" = "Darwin" ]; then
  security unlock-keychain -p "${PULSE_KEYCHAIN_PASSWORD:-changeme}" ~/Library/Keychains/login.keychain-db 2>/dev/null
fi
exec "${HOME}/.bun/bin/bun" run pulse.ts 2>/dev/null || exec /opt/homebrew/bin/bun run pulse.ts
