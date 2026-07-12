#!/usr/bin/env bash
# Renders the 1280x640 social preview card into docs/images/social-preview.png.
# Upload it by hand at GitHub > Settings > General > Social preview; the repo
# cannot pick it up from the tree. Needs Chrome.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/docs/images/social-preview.png"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

CHROME="$(command -v google-chrome || command -v chromium || command -v chromium-browser)"

cat > "$WORK/card.html" <<HTML
<style>
  @font-face {
    font-family: 'Space Grotesk';
    src: url('file://$ROOT/src/renderer/assets/fonts/space-grotesk-latin.woff2') format('woff2');
    font-weight: 300 700;
  }
  * { margin: 0; box-sizing: border-box; }
  body {
    width: 1280px; height: 640px;
    background: #0f0b09;
    font-family: 'Space Grotesk', sans-serif;
    display: flex; align-items: center; gap: 74px;
    padding: 0 104px;
    position: relative; overflow: hidden;
  }
  /* warm light coming off the pod, so the mark sits in the scene */
  .glow {
    position: absolute; left: 60px; top: 50%;
    width: 720px; height: 720px; transform: translateY(-50%);
    background: radial-gradient(circle, rgba(226,130,47,0.30) 0%, rgba(226,130,47,0.10) 42%, rgba(226,130,47,0) 68%);
  }
  .seam {
    position: absolute; inset: 0;
    background: radial-gradient(120% 90% at 15% 50%, rgba(255,150,70,0.08), transparent 60%);
  }
  img { width: 300px; position: relative; }
  .copy { position: relative; }
  .mark {
    font-size: 108px; font-weight: 700; letter-spacing: 0.14em;
    line-height: 1;
    background: linear-gradient(180deg, #ffffff 0%, #d8dbe0 42%, #9aa1ab 78%, #cfd3d9 100%);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  }
  .tag {
    margin-top: 22px;
    font-size: 34px; font-weight: 500; color: #f2e6da; letter-spacing: -0.01em;
  }
  .agents {
    margin-top: 30px; font-size: 21px; font-weight: 400; letter-spacing: 0.05em;
    color: #9c8878;
  }
  .rule {
    margin-top: 34px; width: 96px; height: 4px; border-radius: 4px;
    background: linear-gradient(90deg, #e2822f, #b0521c);
  }
</style>
<div class="glow"></div>
<div class="seam"></div>
<img src="file://$ROOT/src/renderer/assets/husk-logo.svg" />
<div class="copy">
  <div class="mark">HUSK</div>
  <div class="tag">Your terminal, now an AI workspace.</div>
  <div class="agents">claude &middot; copilot &middot; codex &middot; gemini &middot; aider</div>
  <div class="rule"></div>
</div>
HTML

mkdir -p "$(dirname "$OUT")"
"$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --window-size=1280,640 --screenshot="$OUT" "file://$WORK/card.html" 2>/dev/null

echo "wrote $OUT"
