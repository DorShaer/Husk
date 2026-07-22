#!/usr/bin/env bash
# Pin.sh — pin the built Interceptor Chrome extension into the skill, scrubbing
# absolute user paths so re-pinning never reintroduces a /Users/<name>/ leak.
#
# Why a pinned copy and not a symlink:
#   - Chrome disables unpacked extensions on every manifest version bump, so a
#     stable on-disk copy beats a live symlink that shifts under Chrome.
#   - The public LifeOS release ships this skill, so Extension/ must contain the
#     actual files — a symlink to a local build dir is useless to other users.
#
# Why the scrub:
#   The upstream build (esbuild) bakes absolute node_modules paths into bundled
#   CommonJS wrappers, e.g. `var __dirname = "/Users/<you>/.../ocrad.js"`. That
#   path is vestigial in a browser context but leaks a username into a public
#   skill. This script neutralizes every such literal on each pin so the leak
#   cannot come back the next time someone rebuilds and re-pins.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$(cd "$SCRIPT_DIR/.." && pwd)/Extension"
SRC="${INTERCEPTOR_SRC:-$HOME/Projects/interceptor}/extension/dist"

# Relativize a $HOME-rooted path to ~. Do NOT use ${x/#$HOME/~}: bash 5.2+
# tilde-expands the replacement back to an absolute /Users path, which silently
# defeats the leak scrub below and trips the FATAL guard (2026-07-04).
rel_home() { case "$1" in "$HOME"/*) printf '~%s' "${1#"$HOME"}";; *) printf '%s' "$1";; esac; }

if [ ! -d "$SRC" ]; then
  echo "FATAL: build dir not found: $SRC" >&2
  echo "  Build first (Update workflow step 3), or set INTERCEPTOR_SRC." >&2
  exit 1
fi

echo "Pinning extension"
echo "  from: $(rel_home "$SRC")"
echo "  to:   $(rel_home "$DEST")"

mkdir -p "$DEST"
# Copy build → Extension. Keep profile-data/ (runtime, gitignored); leave
# PINNED_FROM.txt to the regeneration step below.
rsync -a --delete \
  --exclude 'profile-data' \
  --exclude 'PINNED_FROM.txt' \
  "$SRC"/ "$DEST"/

# Scrub absolute home paths baked into JS string literals → neutral ".".
# esbuild emits these as quoted literals, so matching the quoted form keeps the
# scrub precise: it won't touch URLs (which never start with a bare /Users//home)
# or unrelated text. The backref \1 requires the same quote to close the string.
find "$DEST" -type f -name '*.js' -print0 | while IFS= read -r -d '' f; do
  perl -i -pe 's{(["\x27])(?:/Users|/home)/[^"\x27]*\1}{$1.$1}g' "$f"
done

# Provenance — RELATIVE source path only (never an absolute /Users path).
VERSION="$(grep '"version"' "$DEST/manifest.json" | head -1 | sed -E 's/.*"version": *"([^"]+)".*/\1/')"
SHA="$(find "$DEST" -type f -not -name 'PINNED_FROM.txt' | sort | xargs shasum -a 256 | shasum -a 256 | cut -d' ' -f1)"
cat > "$DEST/PINNED_FROM.txt" <<EOF
Pinned from: $(rel_home "$SRC")
Manifest version: $VERSION
Content SHA256: $SHA
Pinned at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
Reason: Chrome disables unpacked extensions on every manifest version bump.
Refresh by re-running this command intentionally (Update workflow).
EOF

# Fail loud if any ABSOLUTE home path survived. Anchored so a URL path segment
# (preceded by a host char, e.g. "host.tld/u/keep") does NOT false-trip — only a
# real home filesystem path like /Users/<name>/... or /home/<name>/... does.
LEAKS="$(find "$DEST" -type f -print0 \
  | xargs -0 perl -ne 'print "$ARGV:$.: $_" if m{(?<![A-Za-z0-9._-])(?:/Users|/home)/[A-Za-z0-9._-]+/}' 2>/dev/null || true)"
if [ -n "$LEAKS" ]; then
  echo "FATAL: absolute home path(s) survived the scrub:" >&2
  printf '%s\n' "$LEAKS" >&2
  exit 2
fi

echo "✓ pinned + scrubbed (v$VERSION, sha ${SHA:0:12})"
