---
last_updated: 2026-07-11
last_updated_by: kai
convention: pai-freshness-v1
version: 1.0.22
---

# Pulse Metadata Surface — Badges, Strips, Panels

> **The catalog of everything Pulse surfaces about a session, ISA, or Algorithm run.** Every badge, strip, and panel maps to specific frontmatter or session metadata. This doc tells you (1) what visual elements exist, (2) what data each consumes, (3) where the data is set, (4) implementation status.

> **Source of truth for visual layout:** `LIFEOS/PULSE/Observability/src/app/agents/page.tsx` (tab strip) and per-dashboard components in `LIFEOS/PULSE/Observability/src/components/activity/`.

---

## Core Principle — Surface the Journey

Every LifeOS primitive is **current state → ideal state, articulated as ISCs, pursued through verifiable iteration**. This is the Life OS loop (`LIFEOS/DOCUMENTATION/LifeOs/LifeOsThesis.md`) rendered at session scale. The Pulse metadata surface exists to make that journey legible at every level:

- **Where are we?** (current state, current phase, progress)
- **Where are we going?** (ideal state, goal anchor, ISCs)
- **How did we get here?** (mode chosen, capabilities invoked, iterations completed)
- **What confidence do we have?** (Forge audit verdict, divergence risk, density score)

The components below surface those four questions across the Pulse UI.

---

## Badge Catalog

Compact pills/chips that fit in session rows and headers. One badge = one piece of metadata.

| Badge | Data source (ISA frontmatter) | Component | Status |
|-------|------------------------------|-----------|--------|
| **EffortBadge** | `effort:` (standard/extended/advanced/deep/comprehensive) | `EffortBadge.tsx` | shipped |
| **ModeBadge** | `mode:` (iterate/optimize/ideate/loop) | `ModeBadge.tsx` | shipped (covers Algorithm mode) |
| **PresetBadge** | `algorithm_config.preset` (dream/explore/directed/surgical/cautious/aggressive) | `PresetBadge.tsx` | shipped |
| **ResponseModeBadge** | `response_mode:` (minimal/native/algorithm) — **NEW v2.10** | NOT YET BUILT | planned next-ISA |
| **AlgorithmModeBadge** | `algorithm_mode:` — **NEW v2.10** alias of `mode:` for clarity | NOT YET BUILT | planned next-ISA (may share `ModeBadge` impl) |
| **GoalBadge** | presence of `principal_stated_goal:` (v6.4.0) | NOT YET BUILT | planned next-ISA |
| **DensityBadge** | `density_score:` + `divergence_risk:` (v6.5.0) | NOT YET BUILT | planned next-ISA |
| **IterationBadge** | `iteration:` (current iteration number for loop mode) | NOT YET BUILT | paired with LoopRunner.ts |
| **ForgeAuditBadge** | Forge audit verdict (pass/concerns/fail) recorded in `## Verification` | NOT YET BUILT | planned next-ISA |

### Badge color conventions

Colors map to LifeOS dimensions (`var(--health)`, `var(--money)`, etc.) per `LIFEOS/PULSE/Observability/src/app/agents/page.tsx` `dimColors`. Each tab's badges adopt that tab's color tint. Cross-tab badges (Effort, Density) use neutral colors with dimension-tinted backgrounds.

---

## Strip Catalog

Horizontal full-width visualizations that span the session card or dashboard row.

| Strip | Data source | Component | Status |
|-------|-------------|-----------|--------|
| **QuickPulseStrip** | live system metrics | `QuickPulseStrip.tsx` | shipped |
| **PhaseProgressStrip** | `phase:` (1 of 7 visualized) | NOT YET BUILT | planned next-ISA |
| **JourneyStrip** | `current_state:` → ISC progress → `ideal_state:` — **NEW v2.10** | NOT YET BUILT | planned next-ISA |
| **CapabilitiesStrip** | `capabilities_invoked:` array — **NEW v2.10** | NOT YET BUILT | planned next-ISA |
| **IterationHistoryStrip** | `## Iteration History` section (Loop mode) | NOT YET BUILT | paired with LoopRunner.ts |
| **IntensityBar** | tool-call rate over time | `IntensityBar.tsx` | shipped |
| **FocusIndicator** | phase + ISA presence | `FocusIndicator.tsx` | shipped |

### JourneyStrip — the headline new visualization

The Journey Strip is the visual embodiment of LifeOS's core "current → ideal state" primitive. Layout sketch:

```
┌─────────────────────────────────────────────────────────────────┐
│  CURRENT STATE                                       IDEAL STATE │
│  "47 type errors blocking deploy"      "Zero errors, CI passing" │
│                                                                   │
│  ● ━━━ ● ━━━ ● ━━━ ○ ━━━ ○ ━━━ ○ ━━━ ○ ━━━ ○ ━━━ ○ ━━━ ○        │
│  ISC-1   ISC-2   ISC-3   ISC-4   ...           ...   ISC-11      │
│         (passed)                                                  │
│                                                                   │
│  3 of 11 ISCs verified  ·  phase: execute  ·  iter 1             │
└─────────────────────────────────────────────────────────────────┘
```

- Left endpoint: `current_state:` one-liner from frontmatter
- Right endpoint: `ideal_state:` one-liner (aligned with `principal_stated_goal:` when set)
- Dots: ISCs in order, filled when passed, hollow when open
- Bottom row: progress count, current phase, iteration (Loop only)

Fallback when `current_state` / `ideal_state` absent: render just the ISC dot progression with the task description as endpoint labels.

---

## Panel Catalog

Multi-line expandable detail views shown on session click.

| Panel | Data source | Component | Status |
|-------|-------------|-----------|--------|
| **PhaseDetailPanel** | full phase history with timing | `PhaseDetailPanel.tsx` | shipped |
| **GoalPanel** | `principal_stated_goal:` + signal type + locked timestamp | NOT YET BUILT | planned next-ISA |
| **DecisionsPanel** | `## Decisions` section | NOT YET BUILT | planned next-ISA |
| **ChangelogPanel** | `## Changelog` section (Deutsch format entries) | NOT YET BUILT | planned next-ISA |
| **VerificationPanel** | `## Verification` section + Forge/Grok audit results | NOT YET BUILT | planned next-ISA |
| **IterationHistoryPanel** | `## Iteration History` section (Loop mode) | NOT YET BUILT | paired with LoopRunner.ts |

---

## Tab-Level Surfaces (one per Pulse mode)

| Tab | Dashboard component | Surfaces |
|-----|---------------------|----------|
| **Iterate** | `UnifiedWorkDashboard` | all default-mode work, current Algorithm run, ISC progress |
| **Optimize** | `OptimizeDashboard` | optimize sessions, score curves, experiment history |
| **Ideate** | `NoveltyDashboard` (`/novelty`) | ideate sessions, candidate gallery, EVOLVE / META-LEARN deltas |
| **Loop** | `LoopDashboard` | loop sessions, iteration counter, halt conditions, asymptote detection |
| **Native** | `NativeDashboard` | NATIVE-mode sessions, quick-task chatter, no-ISA work |

---

## Cross-cutting Metadata Sources

| Source | Where it lives | What it provides |
|--------|----------------|------------------|
| **ISA frontmatter** | `MEMORY/WORK/{slug}/ISA.md` or `<project>/ISA.md` | core fields (task, effort, phase, mode, progress, started, updated) + v6.4.0 goal fields + v6.5.0 density fields + v2.10 response/journey fields |
| **session metadata** | `MEMORY/STATE/work.json` | session registry, used for NATIVE sessions without ISAs |
| **ISA body sections** | same ISA file, body | `## Decisions`, `## Changelog`, `## Verification`, `## Iteration History` (Loop only) |
| **TheRouter additionalContext** _(RETIRED 2026-07-11)_ | `TheRouter.hook.ts` (deleted) | Historical: response mode, tier, goal signal, density gate eligibility — set per-prompt. Mode/tier classification was abolished 2026-07-11; no successor emits this. |
| **work.json phase history** | `hooks/lib/isa-utils.ts::appendPhase()` | phase transitions with timing — drives PhaseProgressStrip |

---

## Implementation Status — What Ships When

| Wave | Items | Trigger |
|------|-------|---------|
| **Already shipped** | EffortBadge, ModeBadge, PresetBadge, QuickPulseStrip, IntensityBar, FocusIndicator, PhaseDetailPanel, six-tab UI | current Pulse |
| **Next ISA (paired with v6.6.0 doctrine bump)** | ResponseModeBadge, AlgorithmModeBadge, GoalBadge, DensityBadge, JourneyStrip, CapabilitiesStrip, GoalPanel, DecisionsPanel, ChangelogPanel, VerificationPanel | requires v2.10 frontmatter fields population by ISA skill + ISASync hook |
| **Paired with LoopRunner.ts ship** | IterationBadge, IterationHistoryStrip, IterationHistoryPanel | requires LoopRunner.ts populating `## Iteration History` section |
| **Lower priority** | CatoBadge (verdict surfacing), Goal filter pill on Agents page | small additions |

---

## Cross-references

- ISA Format Spec: `LIFEOS/DOCUMENTATION/Isa/IsaFormat.md`
- Algorithm Modes: `LIFEOS/ALGORITHM/modes/README.md`
- Pulse System overview: `LIFEOS/DOCUMENTATION/Pulse/PulseSystem.md`
- DA subsystem (design): `LIFEOS/DOCUMENTATION/Pulse/DaSubsystem.md`
- Terminal tabs (kitty integration): `LIFEOS/DOCUMENTATION/Pulse/TerminalTabs.md`
- Current Algorithm doctrine: `LIFEOS/ALGORITHM/v8.4.0.md`
