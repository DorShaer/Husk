#!/usr/bin/env bash
# Renders every PNG the app and the site need from the mark's SVG sources.
# Run after editing either SVG. Needs Chrome (for the render) and Python + Pillow
# (for the downscales, taken from a 2048px master so the small sizes stay sharp).
#
# Two sources: the full mark for 48px and up, and a simplified one for 16 to 32px,
# where the full mark's detail collapses into a smudge.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASSETS="$ROOT/src/renderer/assets"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

CHROME="$(command -v google-chrome || command -v chromium || command -v chromium-browser)"

render() {
  local svg="$1" out="$2" art="$3"
  cat > "$WORK/page.html" <<HTML
<style>
  html, body { margin: 0; background: transparent; }
  body { width: 2048px; height: 2048px; display: flex; align-items: center; justify-content: center; }
  img { width: ${art}px; }
</style>
<img src="file://$svg" />
HTML
  "$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
    --default-background-color=00000000 --window-size=2048,2048 \
    --screenshot="$out" "file://$WORK/page.html" 2>/dev/null
}

render "$ASSETS/husk-logo.svg" "$WORK/master.png" 1740
render "$ASSETS/husk-logo-small.svg" "$WORK/master-small.png" 1900

python3 - "$WORK/master.png" "$WORK/master-small.png" "$ROOT" <<'PY'
import sys
from PIL import Image

master, master_small, root = sys.argv[1], sys.argv[2], sys.argv[3]

def squared(path, pad_divisor):
    im = Image.open(path).convert('RGBA')
    # Trim the transparent margin, then re-pad to a square so the mark keeps the
    # same optical weight whatever size it is scaled to.
    im = im.crop(im.getbbox())
    side = max(im.size) + max(im.size) // pad_divisor
    canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - im.width) // 2, (side - im.height) // 2), im)
    return canvas

full = squared(master, 9)
small = squared(master_small, 16)   # tighter margin: the art needs the pixels

for s in (16, 24, 32):
    small.resize((s, s), Image.LANCZOS).save(f'{root}/installer/icons/{s}x{s}.png')
for s in (48, 64, 128, 256, 512, 1024):
    full.resize((s, s), Image.LANCZOS).save(f'{root}/installer/icons/{s}x{s}.png')

full.resize((1024, 1024), Image.LANCZOS).save(f'{root}/installer/husk-icon.png')
full.resize((512, 512), Image.LANCZOS).save(f'{root}/src/renderer/assets/husk-logo.png')
print('rendered: 16-32 from the small mark, 48-1024 from the full mark')
PY
