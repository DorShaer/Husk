<!-- Fictitious example. "Cardinal" is a teaching project name; any resemblance to real products or organizations is coincidental. The example.com domain is RFC 2606 reserved. -->
---
task: "Build the Cardinal brand identity system from blank canvas to first 5 surfaces"
slug: 20260203-141200_cardinal-brand-identity-launch
project: Cardinal
effort: deep
effort_source: explicit
phase: execute
progress: 18/56
mode: interactive
started: 2026-02-03T22:12:00Z
updated: 2026-04-19T11:30:00Z
---

## Problem

Cardinal is a six-person fintech startup at `cardinal.example.com` building a single-purpose product: helping new immigrants in the US open their first investment account in under 10 minutes. They have a working product, three angel investors, and a logo their cofounder drew on a napkin. The napkin logo does not survive contact with a 16px favicon, the website uses three different shades of blue depending on which page you land on, and the most recent investor email signed off with a tone the founder describes as "bank-stiff" while the homepage hero copy describes the product as "your most encouraging financial friend." Every surface contradicts the others.

The product is good. The first 200 users love it. But Cardinal is about to do its first proper marketing push — App Store launch, Hacker News post, paid social on three platforms, partner co-marketing with two community organizations — and the brand cannot sustain that level of exposure. A user who taps the App Store icon, lands on the website, opens the welcome email, and reads the founder's tweet should feel like all four were written and designed by the same intentional person. Right now, four random pieces of clip art communicating four random feelings.

## Vision

The founder's mom — who has never used the product and doesn't know what it does — sees the new logo on a coffee shop sticker, says "oh, that's pretty," and a week later texts her son a photo of the same logo on a bus shelter ad asking "is that yours?" That recognition with no prior priming is the target. When the founder opens the brand kit on launch day and clicks through the homepage, the App Store screenshots, the welcome email, the partner one-pager, and the launch tweet, the experience reads as a single voice across five surfaces. Euphoric surprise: the cofounder who drew the napkin logo says "I don't even miss it."

## Out of Scope

- Product UI redesign. The brand work informs the existing app's color and type tokens but does not redesign the in-app onboarding flows.
- Naming. The name "Cardinal" stays. No naming exploration, no trademark refile.
- Internationalization of brand voice. English only for v1; Spanish-language voice work happens after launch.
- Motion design system. Static brand only. After-effects, Lottie, and animated logos are post-launch.
- Photography library. Stock placeholders are acceptable for the first five surfaces; bespoke photo direction comes later.
- Sub-brand exploration. No "Cardinal for Business," "Cardinal Pro," "Cardinal Wealth" — single master brand only.
- Print collateral beyond the partner one-pager. No business cards, no event signage, no swag.

## Principles

- **A brand is a recognition system, not a logo.** The logo is one of seven elements; the system is the contract.
- **Constraint produces character.** A two-color palette with one weight of one typeface usually beats six colors and three weights. We start under-decorated and earn additions.
- **Voice lives in word choice, not in adjectives about voice.** "Direct, warm, never patronizing" is what we write under our own paragraph; the test is that someone given the guide can write a paragraph indistinguishable from the founder's.
- **Every artifact must survive its smallest size.** If the logo doesn't read at 16px, it doesn't read. If the type system doesn't work in a 13px form label, it doesn't work.
- **Open-source defaults.** Type, palette, and icon system must work without paid foundry licenses for early-stage runway, and remain swap-in compatible with paid alternatives later.
- **The brand is borrowed from the user, not invented for them.** Voice and tone derive from the language the first 200 users use to describe the product, not from a moodboard.

## Constraints

- Single sans-serif type family for the entire system (display + body + UI). Two weights maximum.
- Two-color core palette plus a neutral scale of 5 steps. No third hue introduced before launch.
- Logo must remain recognizable at 16×16px and in 1-bit black-and-white.
- Type family must have an SIL Open Font License (OFL) version available; no paid-only foundry dependencies in v1.
- Voice guide ships as a single page with worked examples; no 60-page brand book.
- Brand kit is delivered as a Figma file at `figma.com/cardinal-brand-v1` and a GitHub repo at `github.example.com/cardinal/brand-v1` (mirrored, both public).
- Color contrast must pass WCAG 2.2 AA for all text + background combinations the system can produce.
- All five launch surfaces (homepage hero, App Store screenshot set, welcome email, partner one-pager, launch tweet) ship from the same kit on the same day.
- No AI-generated illustrations in the launch surfaces. Hand-drawn or geometric only.

## Goal

Deliver a complete Cardinal brand identity v1 — logo (3 lockups), type system (1 family, 2 weights, 6 sizes), color palette (2 hues + 5-step neutral), voice and tone guide (1 page with 6 worked rewrites), and the first 5 marketing surfaces (homepage hero, App Store screenshot set, welcome email, partner one-pager, launch tweet) — all designed against constraints that survive the smallest-size and 1-bit tests, packaged as a Figma file and a public GitHub repo, ready to ship together on the founder-confirmed launch date of April 26, 2026.

## Criteria

- [x] ISC-1: Wordmark and standalone mark exist as separate Figma components with shared baseline.
- [x] ISC-2: Three logo lockups in the kit: horizontal wordmark, stacked wordmark + mark, mark-only.
- [x] ISC-3: Antecedent: logo wordmark renders legibly at 16×16px (probe: Skill('Interceptor') screenshot at `cardinal.example.com/favicon.ico` — three unfamiliar viewers identify "Cardinal" within 5 seconds, ≥2/3 succeed).
- [x] ISC-4: Antecedent: logo mark survives 1-bit black-and-white conversion without losing recognizability (probe: viewer test — 5 people shown 1-bit version next to color version, ≥4/5 say "same logo").
- [x] ISC-5: Logo files exported to SVG (master), PNG @1x/@2x/@3x, and ICO favicon.
- [ ] ISC-6: Logo clear-space rule documented (≥ ½ × cap height on all sides).
- [x] ISC-7: Type family selected with confirmed OFL license (probe: `head -50 fonts/<family>/LICENSE.txt` shows SIL OFL 1.1).
- [x] ISC-8: Type system defines exactly 6 sizes: 12, 14, 16, 20, 28, 44 (px on web; pt on print).
- [x] ISC-9: Type system uses exactly 2 weights: Regular 400 and Semibold 600.
- [ ] ISC-10: Antecedent: body copy at 16px renders cleanly at 1.5× line-height across Chrome, Safari, Firefox latest (probe: Interceptor screenshot diff per browser, no kerning regressions).
- [x] ISC-11: Color palette defines exactly 2 hue tokens: `cardinal-red-600` (primary) and `dawn-500` (secondary).
- [x] ISC-12: Neutral scale defines exactly 5 steps: `ink-900`, `ink-700`, `ink-500`, `ink-300`, `ink-100`.
- [x] ISC-13: Color palette exported as CSS custom properties at `tokens/colors.css`.
- [ ] ISC-14: Color palette exported as Figma styles in the kit file.
- [x] ISC-15: WCAG 2.2 AA contrast confirmed for all foreground/background pairs the system permits (probe: `bun scripts/contrast-check.ts` exits 0).
- [ ] ISC-16: Voice guide exists at `brand/voice.md`, fits on one printed page (≤ 60 lines).
- [ ] ISC-17: Voice guide includes 6 worked rewrites — the same sentence in "off-brand" and "on-brand" form for: confirmation, error, marketing headline, support reply, social caption, legal disclosure.
- [ ] ISC-18: Antecedent: the founder, given a fresh paragraph drafted by an outsider against the voice guide, cannot tell which sentence the outsider wrote vs the founder rewrote (probe: blind A/B test with founder, target ≥ 50% confusion across 10 trials).
- [ ] ISC-19: Voice guide explicitly names 5 things voice does NOT do (anti-voice prompts).
- [x] ISC-20: Homepage hero (`cardinal.example.com/`) uses the new logo, type, and color tokens — no legacy assets.
- [ ] ISC-21: App Store screenshot set (5 screens) designed in the kit, exported at App Store-required resolutions for iPhone 6.7" and 6.1".
- [ ] ISC-22: Welcome email template (`emails/welcome.html`) renders with brand fidelity in Gmail, Apple Mail, Outlook 365 (probe: Litmus screenshot diff across 3 clients).
- [ ] ISC-23: Partner one-pager exists at `brand/partner-one-pager.pdf`, 1 page, prints correctly on US Letter and A4.
- [ ] ISC-24: Launch tweet draft is in the kit at `brand/launch-tweet.md` with associated 1200×675 image.
- [ ] ISC-25: All 5 launch surfaces use the same logo lockup — no variant drift.
- [ ] ISC-26: All 5 launch surfaces use the same hex value for the primary brand color (probe: `bun scripts/surface-color-audit.ts` reports zero deviations from `cardinal-red-600`).
- [ ] ISC-27: All 5 launch surfaces use the same type family at the same weight scale.
- [ ] ISC-28: Anti: the logo mark resembles a generic compass, leaf, or arrow more than the chosen form (probe: viewer test — show mark to 10 people unfamiliar with the brand, ask "what does it look like?", fewer than 3 mention generic shapes).
- [ ] ISC-29: Anti: any launch surface uses a color not in the published palette (probe: surface-color-audit script).
- [ ] ISC-30: Anti: the chosen typeface lacks an OFL or otherwise-redistributable alternative (probe: license header check).
- [ ] ISC-31: Anti: the voice guide reads as so prescriptive that the founder's own writing fails it (probe: founder writes a 3-paragraph product update without referring to the guide; voice guide author scores it; ≤ 1 violation).
- [ ] ISC-32: Anti: the App Store screenshots use placeholder text like "Lorem ipsum" or "Your headline here" anywhere visible.
- [ ] ISC-33: Anti: any surface includes the cofounder's napkin logo (probe: visual diff against retired-asset folder).
- [ ] ISC-34: Anti: the welcome email signs off with the same first-line greeting as any other Cardinal email template (probe: `rg "^Hi there" emails/` returns ≤ 1 match).
- [x] ISC-35: Figma kit file is shared with edit access for the founder and read access for the cofounder + 3 angels.
- [ ] ISC-36: GitHub repo `github.example.com/cardinal/brand-v1` mirrors the Figma kit's exported assets (logo SVG/PNG, color tokens, type tokens, voice guide).
- [ ] ISC-37: README in the brand repo includes a "How to use this kit" section with 4 examples: web, email, print, social.
- [ ] ISC-38: Brand assets repo includes a `LICENSE` for the assets (CC BY 4.0 for marketing usage; logo trademark notice separate).
- [ ] ISC-39: Logo SVG validates as well-formed (probe: `xmllint --noout brand/logo.svg`).
- [ ] ISC-40: Logo SVG file size ≤ 4KB.
- [ ] ISC-41: Favicon at 16×16, 32×32, 48×48 packed into a single .ico file at `cardinal.example.com/favicon.ico`.
- [ ] ISC-42: Apple touch icon at 180×180 served at `cardinal.example.com/apple-touch-icon.png`.
- [ ] ISC-43: Open Graph image at 1200×630 served at `cardinal.example.com/og.png` using the launch lockup.
- [ ] ISC-44: Internal "voice gut-check" form exists in the kit — 4-question checklist anyone on the team runs against any draft before publishing (Is it direct? Warm without being cute? Specific instead of generic? Free of jargon the user wouldn't say?).
- [ ] ISC-45: Tone-by-context table exists in the voice guide: marketing, transactional, error, support, legal — one row each, with do/don't examples.
- [ ] ISC-46: Anti: voice guide adjectives appear as the only definition of voice with zero worked examples (probe: voice guide must contain ≥ 6 sentence-level rewrites in addition to any descriptors).
- [ ] ISC-47: Brand guideline page rendered at `cardinal.example.com/brand` and crawlable.
- [ ] ISC-48: Press kit downloadable as a single ZIP at `cardinal.example.com/press`, includes logos in 3 formats and a 200-word company description.
- [ ] ISC-49: Antecedent: the launch tweet image, when posted to X without context text, draws ≥ 3 unprompted DM replies asking "what's Cardinal?" within 48 hours of test post (probe: founder dry-run on personal account 7 days pre-launch).
- [ ] ISC-50: Three angel investors, given the kit cold (no walkthrough), can identify which surface is on-brand vs a planted decoy in 4 of 5 trials.
- [ ] ISC-51: Cofounder (the napkin-logo author) signs off in writing on the new mark.
- [x] ISC-52: All retired assets (napkin logo, three legacy blues, prior tagline) moved to `brand/_retired/` with a README explaining why.
- [ ] ISC-53: Anti: more than two new colors or new type weights are introduced between v1 lock and launch (probe: git diff on tokens/ between freeze tag and launch tag — line count ≤ 0 additions).
- [ ] ISC-54: A "v1 freeze" tag is cut on the brand repo at least 7 days before launch.
- [ ] ISC-55: Launch retrospective scheduled for May 3, 2026, with the founder, cofounder, and the brand designer.
- [ ] ISC-56: Antecedent: the founder reports the "I don't miss the napkin logo" feeling — captured verbatim in retro notes (probe: retro doc, search for the exact quote or a paraphrase the founder confirms).

## Test Strategy

```yaml
- isc: ISC-3
  type: experiential-probe
  check: legibility at 16px favicon
  threshold: ≥2/3 unfamiliar viewers identify "Cardinal" within 5 seconds
  tool: Skill('Interceptor') screenshot + 3-viewer survey

- isc: ISC-4
  type: experiential-probe
  check: 1-bit B&W recognizability
  threshold: ≥4/5 viewers say "same logo" as color version
  tool: viewer survey

- isc: ISC-7
  type: license-probe
  check: typeface OFL 1.1
  threshold: license header matches "SIL OPEN FONT LICENSE Version 1.1"
  tool: head fonts/<family>/LICENSE.txt

- isc: ISC-15
  type: contrast
  check: WCAG 2.2 AA across all permitted FG/BG pairs
  threshold: zero violations
  tool: bun scripts/contrast-check.ts

- isc: ISC-18
  type: experiential-probe
  check: voice guide reproducibility
  threshold: ≥50% founder confusion across 10 blind A/B trials
  tool: blind A/B test (Outsider draft + Founder rewrite vs Founder draft)

- isc: ISC-26
  type: visual-audit
  check: primary color hex consistency across launch surfaces
  threshold: zero deviations from cardinal-red-600
  tool: bun scripts/surface-color-audit.ts

- isc: ISC-31
  type: anti-probe
  check: voice guide must not over-prescribe
  threshold: ≤1 voice violation in founder's own unguided 3-paragraph draft
  tool: voice author scores founder draft

- isc: ISC-49
  type: experiential-probe
  check: launch tweet image draws unprompted curiosity
  threshold: ≥3 DM replies asking "what is this" within 48 hours
  tool: founder dry-run on personal X account, 7 days pre-launch

- isc: ISC-50
  type: experiential-probe
  check: angels can sort on-brand vs decoy
  threshold: 4 of 5 correct identifications
  tool: 5-trial sort with planted decoys (off-brand color, off-brand voice, off-brand lockup)
```

## Features

```yaml
- name: LogoSystem
  description: Wordmark, standalone mark, three lockups; export pipeline to SVG/PNG/ICO; 16px and 1-bit survival; cofounder sign-off on retired napkin logo.
  satisfies: [ISC-1, ISC-2, ISC-3, ISC-4, ISC-5, ISC-6, ISC-28, ISC-39, ISC-40, ISC-41, ISC-42, ISC-43, ISC-51, ISC-52]
  depends_on: []
  parallelizable: false

- name: TypeAndColorTokens
  description: Single OFL typeface with 2 weights and 6 sizes; 2-hue palette plus 5-step neutral; CSS custom properties + Figma styles; WCAG AA contrast across all permitted pairs.
  satisfies: [ISC-7, ISC-8, ISC-9, ISC-10, ISC-11, ISC-12, ISC-13, ISC-14, ISC-15, ISC-30]
  depends_on: []
  parallelizable: true

- name: VoiceAndTone
  description: One-page voice guide with 6 worked rewrites, anti-voice list, tone-by-context table, voice gut-check checklist; founder reproducibility test.
  satisfies: [ISC-16, ISC-17, ISC-18, ISC-19, ISC-31, ISC-44, ISC-45, ISC-46]
  depends_on: []
  parallelizable: true

- name: LaunchSurfaces
  description: Homepage hero, App Store screenshot set, welcome email, partner one-pager, launch tweet — all built from the kit, all using the same lockup, color, and type weight scale.
  satisfies: [ISC-20, ISC-21, ISC-22, ISC-23, ISC-24, ISC-25, ISC-26, ISC-27, ISC-32, ISC-33, ISC-34]
  depends_on: [LogoSystem, TypeAndColorTokens, VoiceAndTone]
  parallelizable: true

- name: KitDistribution
  description: Figma kit file with appropriate access; mirrored GitHub repo with assets + tokens + voice guide + LICENSE; README with 4 usage examples; brand page on the marketing site; downloadable press ZIP.
  satisfies: [ISC-35, ISC-36, ISC-37, ISC-38, ISC-47, ISC-48]
  depends_on: [LaunchSurfaces]
  parallelizable: false

- name: LaunchGovernance
  description: v1 freeze tag 7 days pre-launch; angel-investor sort test; founder reproducibility check; anti-drift audits; retrospective scheduled and run; the "I don't miss the napkin logo" capture.
  satisfies: [ISC-29, ISC-49, ISC-50, ISC-53, ISC-54, ISC-55, ISC-56]
  depends_on: [KitDistribution]
  parallelizable: false
```

## Decisions

- 2026-02-03 22:12: Single typeface for the whole system over a display + body pairing. The product is small, the team is small, the budget is small, and most "two-typeface" systems reduce to "one of these typefaces does 95% of the work." Pick the one that does both jobs and own the constraint as character.
- 2026-02-09 18:30: Two-hue palette over a richer multi-hue system. The ten Cardinal users we asked described the brand feeling as "warm and not cluttered." A wider palette makes "not cluttered" harder to keep, not easier.
- 2026-02-15 11:45: Voice derives from corpus mining, not from adjectives. Pulled 200 user-written reviews and support replies, ran them through extraction, found that users describe the product with the words "patient," "specific," and "doesn't talk down." Those three words now anchor the guide. Adjectives the founder originally wanted ("bold," "trustworthy," "modern") were rejected because no user used them.
- 2026-02-22 09:00: ❌ DEAD END: Tried building a custom serif display companion to the sans body — 11 days of exploration. Killed because none of the candidate serifs survived the 16px favicon test, and pairing forced lockup variants that broke the "all five surfaces use the same lockup" constraint. The single-typeface decision held.
- 2026-03-01 16:20: refined: ISC-3 and ISC-4 promoted to Antecedent prefix. They are not just probes; they are the preconditions that produce the recognition-without-priming experience the Vision describes. If they fail, the Vision is unreachable regardless of what else passes.
- 2026-03-08 14:00: ❌ DEAD END: Considered a paid foundry license for a typeface the founder loved. Rejected after pricing — $4,800/year for the weights we'd need at the user count we'd reach. Rolled back to OFL alternatives, found one that passed every probe within a week of evaluation, and the founder now prefers it. The constraint produced the better answer.
- 2026-03-15 21:30: refined: added ISC-49 after the cofounder asked "but how do we know the launch tweet will actually work?" Founder dry-run on personal X account is the only honest probe. If the image doesn't draw curiosity from people who don't know what Cardinal is, the brand isn't doing its job, regardless of how much we like it.
- 2026-03-22 10:00: refined: ISC-31 added after the first voice guide draft was so prescriptive that the founder's own writing failed it. The guide must describe the floor of voice, not the ceiling — the founder's natural writing must clear it without effort.
- 2026-04-05 19:45: Cofounder signed off on the new mark in writing. Logged the napkin logo retirement to `_retired/README.md` with the cofounder's quote: "It served us. The new one is the one we needed."
- 2026-04-12 13:00: refined: ISC-50 added — three angels given the kit cold, asked to sort on-brand vs planted decoys. If people who paid for this brand can't tell on-brand from off-brand without a walkthrough, the brand isn't a system yet.

## Changelog

- 2026-02-22 conjectured: a custom serif display face paired with the OFL sans body would give Cardinal a more distinctive editorial voice on marketing surfaces while keeping product UI clean. / refuted by: 11 days of exploration produced no serif candidate that survived the 16px favicon test or the 1-bit survival test; pairing also forced two extra lockups for surfaces where serifs and sans collided, breaking the "single lockup across surfaces" constraint. / learned: the constraints we'd already locked in (16px legibility, 1-bit survival, surface lockup consistency) implicitly forbade dual-typeface systems for our scale. The constraints did the deciding before the moodboard did. / criterion now: ISC-7 / ISC-8 / ISC-9 stand — single OFL family, 2 weights, 6 sizes — and the rejected pairing is documented in `_retired/typeface-exploration.md`.

- 2026-03-01 conjectured: legibility at 16px and 1-bit survival were ordinary verifiable ISCs. / refuted by: the Vision section names a specific experience — recognition without prior priming — and that experience is impossible if the logo can't survive a coffee-shop sticker glance or a low-fidelity reproduction. The probes aren't just verifying; they're naming the precondition for the Vision to be reachable at all. / learned: experiential goals require Antecedent ISCs — preconditions that must hold for the target experience to even be possible. Without them, the Vision is decoupled from the criteria. / criterion now: ISC-3 and ISC-4 carry the `Antecedent:` prefix; ISC-10, ISC-18, ISC-49, ISC-56 added as additional Antecedents anchoring other Vision claims.

- 2026-03-08 conjectured: the brand could afford a paid foundry license for a typeface the founder personally preferred. / refuted by: pricing for the weights and seats we'd need across the lifetime of the early-stage runway came to $4,800/year — disproportionate to the design value gained over OFL alternatives that pass every probe equally well. / learned: paid-only typeface dependencies are a hidden lock-in that compounds at every team-size and surface-count milestone; the OFL constraint isn't a downgrade, it's a future-proofing decision. / criterion now: ISC-7 (OFL license confirmed) is now a hard Constraint; ISC-30 (Anti: typeface lacks OFL alternative) backstops it.

- 2026-03-22 conjectured: the voice guide could safely be prescriptive — the more specific the rules, the more reproducible the voice. / refuted by: the founder's own unguided 3-paragraph product update failed the first draft of the guide on 4 of 9 sentences. A guide that the natural voice fails is a guide that isn't describing the natural voice — it's inventing one. / learned: voice guides describe the floor of acceptable, not the ceiling of ideal. The probe for the guide is whether the person whose voice you're capturing clears it without trying. / criterion now: ISC-31 (Anti: founder's own unguided draft fails the guide) added as a hard probe; voice guide rewritten against this constraint and re-tested.

## Verification

- ISC-1: Figma file `cardinal-brand-v1` shows wordmark and standalone mark as separate components, confirmed via component inspector. Verified 2026-02-26.
- ISC-3: Interceptor screenshot of `cardinal.example.com/favicon.ico` rendered in 3 browsers; viewer survey of 3 unfamiliar designers — 3/3 identified "Cardinal" within 4 seconds. Verified 2026-03-04.
- ISC-4: 1-bit B&W viewer test — 5/5 viewers said "same logo." Verified 2026-03-04.
- ISC-5: `ls brand/logo/` shows `cardinal.svg` (master), `cardinal@1x.png`, `cardinal@2x.png`, `cardinal@3x.png`, `favicon.ico`. Verified 2026-03-09.
- ISC-7: `head -50 fonts/<family>/LICENSE.txt` returns `SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007`. Verified 2026-02-12.
- ISC-13: `cat tokens/colors.css` shows seven `--cardinal-*` and `--ink-*` custom properties matching palette spec. Verified 2026-02-19.
- ISC-15: `bun scripts/contrast-check.ts` exits 0; output confirms 24/24 permitted FG/BG pairs pass WCAG 2.2 AA. Verified 2026-02-19.
- ISC-20: Homepage screenshot diff against staging shows new logo, type tokens, and color tokens; legacy assets purged from `public/`. Verified 2026-04-19.
- ISC-35: Figma share dialog screenshot confirms founder has Edit, cofounder + 3 angels have Read. Verified 2026-02-26.
- ISC-52: `ls brand/_retired/` shows `napkin-logo.png`, `legacy-blues.css`, `prior-tagline.md`, and `README.md` with retirement rationale. Verified 2026-04-05.
