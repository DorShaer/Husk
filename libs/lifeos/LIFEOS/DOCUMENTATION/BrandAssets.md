---
version: 1.0.0
---

# LifeOS Brand Assets

Canonical logo naming for the whole LifeOS project. Use these names everywhere — docs, repos, site, release, design files.

## The two logos

| Name | What it is | File | Use it for |
|------|-----------|------|------------|
| **LifeOS Logo Full** | The block-glyph **plus** the `LifeOS` wordmark | `lifeos-logo-full.png` | The primary logo. Anywhere text fits: site nav (top-left), GitHub repo README header, release README, docs headers, slides. |
| **LifeOS Logo Graphical** | The block-glyph **only** — the ascending staircase of blocks, no text | `lifeos-logo-graphical.png` | Icon / mark contexts: square placements, hero centerpiece, favicons, app icon, avatars, watermarks. |

**Full = blocks + text. Graphical = blocks only.** That is the whole rule.

## Colors

Blues: light-blue wordmark/blocks (`Life`), bright-blue accent (`OS` and lead blocks), dark-navy accent blocks. Transparent background.

## Rules

- **Full is the default.** Reach for Graphical only when there's no room for the wordmark or the wordmark would duplicate nearby text.
- **Never AI-generate these.** They're deterministic block/tile marks — author/edit as precise SVG with the exact brand colors; PNG exports are for placement only (per the brand-asset authoring rule).
- Keep the filenames `lifeos-logo-full.*` and `lifeos-logo-graphical.*` stable across every repo so references don't drift.

## Where they live

- Site: `ourlifeos.ai` → `public/lifeos-logo-full.png` (nav), `public/lifeos-logo-graphical.png` (hero center).
- Public repo + release: `RELEASE_TEMPLATES/lifeos-logo-full.png` → ships as the README header.
