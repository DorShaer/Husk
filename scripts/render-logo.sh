#!/usr/bin/env bash
# Renders every PNG the app and the site need from src/renderer/assets/husk-logo.svg.
# Run after editing the SVG. Needs Chrome (for the render) and Python + Pillow
# (for the downscales, taken from a 2048px master so the small sizes stay sharp).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SVG="$ROOT/src/renderer/assets/husk-logo.svg"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

CHROME="$(command -v google-chrome || command -v chromium || command -v chromium-browser)"

cat > "$WORK/page.html" <<HTML
<style>
  html, body { margin: 0; background: transparent; }
  body { width: 2048px; height: 2048px; display: flex; align-items: center; justify-content: center; }
  img { width: 1700px; }
</style>
<img src="file://$SVG" />
HTML

"$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --default-background-color=00000000 --window-size=2048,2048 \
  --screenshot="$WORK/master.png" "file://$WORK/page.html" 2>/dev/null

python3 - "$WORK/master.png" "$ROOT" <<'PY'
import sys
from PIL import Image

master, root = sys.argv[1], sys.argv[2]
im = Image.open(master).convert('RGBA')

# Trim the transparent margin, then re-pad to a square so the mark keeps the same
# optical weight whatever size it is scaled to.
im = im.crop(im.getbbox())
side = max(im.size) + max(im.size) // 22
canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
canvas.paste(im, ((side - im.width) // 2, (side - im.height) // 2), im)

for s in (16, 24, 32, 48, 64, 128, 256, 512, 1024):
    canvas.resize((s, s), Image.LANCZOS).save(f'{root}/installer/icons/{s}x{s}.png')

canvas.resize((1024, 1024), Image.LANCZOS).save(f'{root}/installer/husk-icon.png')
canvas.resize((512, 512), Image.LANCZOS).save(f'{root}/src/renderer/assets/husk-logo.png')
print('rendered icons 16-1024, husk-icon.png and husk-logo.png')
PY
