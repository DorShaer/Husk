# Claude Design Capabilities

Canonical reference for what Claude Design does, its access tiers, and its known limits. Source: the official Anthropic announcement at https://www.anthropic.com/news/claude-design-anthropic-labs (April 17, 2026) and related coverage.

## What It Is

Claude Design is an Anthropic Labs product accessed at **claude.ai/design** and in the Claude desktop app sidebar (all paid tiers, as of the June 2026 update). The web/desktop surface is a natural-conversation palette UI plus a drag-and-drop WYSIWYG canvas (added June 2026). There is no public REST API; the June 2026 update reportedly added `/design` and `/design-sync` commands inside Claude Code (see June 2026 Update below). We don't track or pin the underlying model — we drive whatever is live.

## What It Produces

- Interactive prototypes
- Product wireframes
- Design exploration artifacts
- Pitch decks and slides
- Marketing collateral and one-pagers
- Code-powered prototypes that can incorporate voice, video, shaders, 3D, and built-in AI
- Polished presentations
- Static visuals (not animated — no Lottie/Rive output)

## Accepted Inputs

- Text prompts describing the desired design
- Images and sketches (uploaded files)
- Documents: DOCX, PPTX, XLSX
- Codebase links or uploaded code folders
- Website captures (via claude.ai's built-in web tool)
- Existing designs for modification and iteration
- Brand folders containing logos, fonts, style references

## Export / Output Formats

| Format | Use case |
|--------|----------|
| Internal URL | Share within organization, view/edit permissions |
| Folder | Local file export |
| **Canva** | Collaborative editing, marketing refinement |
| PDF | Client deliverables, print |
| PPTX | Presentation decks |
| Standalone HTML | One-off static pages |
| **Claude Code handoff bundle** | Production code pipeline — structured for `frontend-design` plugin |
| ZIP | Bundled asset export |

## Key Capabilities

### Design System Extraction During Onboarding

"Claude builds a design system for your team by reading your codebase and design files. Every project after that uses your colors, typography, and components automatically."

- Multiple systems per team (e.g., marketing + dashboard)
- Refinable over time via conversational iteration

### Live Refinement

- Inline comments on specific elements
- Direct text editing in-place
- Adjustment knobs for spacing, color, layout (live, non-destructive)
- Conversational prompts for structural changes

### Organization-Scoped Sharing

- Private by default
- View-only share
- Edit-access share
- Enterprise admin gating

### Claude Code Handoff

> "Claude packages everything into a handoff bundle that you can pass to Claude Code with a single instruction."

This is the load-bearing integration point between Claude Design (concept/design) and Claude Code (production). The `frontend-design` plugin (installed via Anthropic's official plugins marketplace) auto-activates when the bundle lands in Claude Code.

## Access Tiers

| Tier | Access |
|------|--------|
| **Free / Starter** | No access |
| **Pro** | Included — standard usage limits (insufficient for sustained pro use) |
| **Max** | Included — recommended for daily professional use |
| **Team** | Included |
| **Enterprise** | OFF by default; admins enable in Organization settings. One-time credit (~20 typical prompts) expiring July 17, 2026 |

As of the June 2026 update, Claude Design usage shares one pool with claude.ai chat, Claude Code, and Cowork — it is no longer a separate quota.

## Known Limits (as of launch, April 2026)

- **No real-time multiplayer collaboration** (unlike Figma). Sharing is async via URL.
- **No animation output** — Lottie, Rive, WebGL shaders beyond declarative CSS/JS are not first-class outputs.
- **No precision print output** — professional designers have reported it misses pixel-level constraints for print work.
- **Generic aesthetic without a design system** — if onboarding is skipped, output drifts toward generic defaults.
- **Edge cases require explicit prompting** — responsive breakpoints, contrast ratios, dark-mode behavior all need to be called out.
- **High token burn** — generation is heavy and now draws from the shared chat/Code/Cowork pool; sustained use exhausts Pro-tier limits fast.

## June 2026 Update (press-shorthand "Claude Design 2.0")

Anthropic shipped a major update around June 17-20, 2026. "2.0" is press shorthand, not an official name; the URL stayed `claude.ai/design`. Sourced from third-party coverage (Technobezz, explainx.ai, Digital Trends), not yet in Anthropic's official release notes — treat the CLI-command claims as medium confidence until verified in the harness.

- **Design-system imports + auto-validation** — import a system from a GitHub repo, design files, or raw uploads; Claude validates output against it before showing results. Overlaps our `ExtractDesignSystem` workflow.
- **Admin governance** — admins can lock one approved design system company-wide.
- **WYSIWYG canvas editor** — drag, resize, align controls; no longer prompt-only.
- **`/design-sync` (Claude Code)** — bidirectional sync: pull codebase design system into Claude Design, or push built output back.
- **`/design` (Claude Code)** — create/edit/sync designs from the Claude Code terminal.
- **Expanded export destinations** — Adobe, Base44, Canva, Gamma, Lovable, Miro, Replit, Vercel, Wix, plus PDF/PPTX.
- **Shared token pool** — usage now shares limits with chat, Claude Code, and Cowork.
- **Desktop app sidebar** — available in the Claude desktop app on all paid tiers.

Verified sources: [Technobezz](https://www.technobezz.com/news/anthropic-launches-claude-design-update-with-direct-pipeline-to-claude-code) · [explainx.ai](https://www.explainx.ai/blog/claude-design-june-2026-update-design-sync-2026) · [Digital Trends](https://www.digitaltrends.com/computing/claude-design-will-now-stick-to-your-brand-guidelines-instead-of-generic-ai-mockups).

## Strategic Context

Mike Krieger (Anthropic CPO, ex-Instagram co-founder) led the product. He resigned from Figma's board three days before launch, and Figma stock fell ~7% on announcement day. The product is widely framed as a direct Figma competitor for early-stage design exploration, though Anthropic positions it as complementary rather than replacement.

## Relationship to `frontend-design` Plugin

These are two separate products that form a pipeline:

| Layer | Product | Surface | Role |
|-------|---------|---------|------|
| Concept + design | **Claude Design** | claude.ai/design | Visual exploration, prototypes, design system |
| Production code | **`frontend-design` plugin** | Claude Code (auto-activates) | Turns handoff bundles into production-grade code |

The Webdesign skill orchestrates both.
