# Algorithm Changelog

The doctrine file (`vX.Y.Z.md`) holds **only doctrine** — what the Algorithm does, this run. All change history, migration steps, rollback recipes, and "what did/didn't change" prose live here. New versions add a section to the **Full History** below; the doctrine file stays focused.

## Index (one-line headlines)

### Current

- **v6.3.0** (2026-04-29) — **Thinking-capability vocabulary closed-enumeration release.** Field regression: when {{PRINCIPAL_NAME}} mandated thinking-skill counts at E2+, {{DA_NAME}} routinely produced invented generic labels ("decomposition", "edge-case enumeration", "tradeoff analysis") instead of selecting verbatim entries from the canonical list — meeting the hard floor cosmetically while the actual investments (FirstPrinciples, IterativeDepth, ApertureOscillation, SystemsThinking, RootCauseAnalysis, etc.) sat unused. Root cause: v6.2.0 doctrine pointed at "the table in capabilities.md" but didn't print the closed list inside the doctrine read at run time, and didn't have a name-vs-table check at the OBSERVE→THINK boundary. v6.3.0 fix: (1) the closed enumeration of 19 thinking capabilities is printed verbatim INSIDE `v6.3.0.md` doctrine — IterativeDepth, ApertureOscillation, FeedbackMemoryConsult, Advisor, ReReadCheck, FirstPrinciples, SystemsThinking, RootCauseAnalysis, Council, RedTeam, Science, BeCreative, Ideate, BitterPillEngineering, Evals, WorldThreatModel, Fabric patterns, ContextSearch, ISA; (2) a new Capability-Name Audit Gate fires at OBSERVE→THINK requiring each thinking name in `🏹 CAPABILITIES SELECTED` to appear verbatim in the closed list — phantom names do NOT count toward the floor and are a CRITICAL FAILURE; (3) the Rules section restates the closed list and the phantom rule so it survives compaction; (4) output template requires the literal closed-list name as the leading bolded token. Adding new thinking capabilities now requires editing `capabilities.md` AND bumping the Algorithm minor version + updating doctrine — closed-enum drift is no longer silent. C/R/L: conjectured: pointing at "the table in capabilities.md" was a sufficient binding for thinking-floor selection. refuted_by: across v6.1.0 and v6.2.0 runs the executor met the count by inventing generic labels under tier time pressure; the table reference produced the same drift the closed list was supposed to prevent. learned: the doctrine read at run time must contain the closed enumeration inline — pointers to other files leak vocabulary under pressure. Closed enumerations beat open vocabularies for any rule the model has shown willingness to wallpaper. criterion_now: v6.3.0.md prints the 19-name closed list inline, declares non-list names PHANTOM (CRITICAL FAILURE, doesn't count toward floor), and the OBSERVE→THINK Capability-Name Audit Gate is HARD. Migration: `echo 6.3.0 > LATEST` (LATEST is sole source — no settings.json field per v6.2.0 cleanup). Rollback: `echo 6.2.0 > LATEST`. v6.3.x deferred: hook that audits `🏹 CAPABILITIES SELECTED` blocks against the closed list and emits a phantom-warning to observability, plus CI check that doctrine list = capabilities.md table.

- **v6.2.0** (2026-04-28) — **ISA twelve-section frame + ISA Skill release.** The ISA body grew from five sections (Goal/Context/Criteria/Decisions/Verification) to twelve in fixed order: Problem, Vision, Out of Scope, Principles, Constraints, Goal, Criteria, Test Strategy, Features, Decisions, Changelog, Verification. Three-guardrail taxonomy locks the conceptual surface: **Principles** bind the thinking, **Constraints** bind the solution space, **Out of Scope** binds the vision (anti-vision, declared upfront), **Anti-criteria** bind the test surface (granular `Anti:` ISCs derived from the first three). Tier completeness gate is HARD at every tier (E1 = Goal+Criteria; E2 + Problem + TestStrategy; E3 + Vision + OutOfScope + Constraints + Features; E4 = all twelve; E5 + active Interview workflow before BUILD). New **ISA Skill** at `~/.claude/skills/ISA/` owns the canonical template and six workflows (Scaffold, Interview, CheckCompleteness, Reconcile, Seed, Append) — Algorithm OBSERVE invokes `Skill("ISA")` to scaffold instead of inlining ISA logic; PLAN invokes for ephemeral feature extraction; LEARN routes Decisions/Changelog/Verification entries through the canonical Append writer so the Deutsch conjecture/refutation/learning Changelog format doesn't degrade. **ID-stability rule** — ISC IDs never re-number on edit (splits become ISC-N.M, drops become tombstones), making Reconcile's deterministic merge safe. **Ephemeral feature files** (Ralph Loop / Maestro pattern) formalized — derived views from master, ISC-keyed merge, archived under `_ephemeral/.archive/`. v6.2.x deferred: hook parser updates (`isa-utils.ts`, `ISASync`, `CheckpointPerISC`, `EscalationGate` regex extension), Pulse rendering for project ISAs, ISA skill `Tools/*.ts` CLI implementations, project-ISA seeding migration. Migration: `echo 6.2.0 > LATEST && jq '.pai.algorithmVersion="6.2.0"' settings.json | sponge settings.json && sed -i '' 's|v6.1.0.md|v6.2.0.md|' CLAUDE.md`. Rollback: same command with `6.1.0`/`v6.1.0.md`.

- **v6.1.0** (2026-04-28) — **Thinking-floor hardening.** Field regression: a Deep (E4) framework-comparison task ran with zero thinking-skill invocations because "show your math" was used as a universal escape valve to skip the capability floor entirely. Root cause: v6.0.0 made the entire capability floor soft, including thinking. v6.1.0 splits the floor into two axes: thinking-capability count is now a HARD FLOOR that cannot be relaxed via show-your-math (E2 ≥2, E3 ≥4, E4 ≥6, E5 ≥8 — drawn from the "Thinking & Analysis" table in capabilities.md: IterativeDepth, ApertureOscillation, FirstPrinciples, SystemsThinking, RootCauseAnalysis, Council, RedTeam, Science, BeCreative, Ideate, BitterPillEngineering, Evals, WorldThreatModel, Advisor, FeedbackMemoryConsult, ContextSearch, Fabric patterns). Delegation-capability count remains soft and show-your-math relaxable (E2 ≥1, E3 ≥2, E4 ≥2, E5 ≥4) — sometimes the work is genuinely single-author and delegation adds noise, but thinking depth is structural. Selecting fewer thinking capabilities than the tier requires is now a doctrine violation, not a justification. Migration: `echo 6.1.0 > LATEST && jq '.pai.algorithmVersion="6.1.0"' settings.json | sponge settings.json && sed -i '' 's|v6.0.0.md|v6.1.0.md|' CLAUDE.md`. Rollback: same command with `6.0.0`/`v6.0.0.md`.

- **v6.0.0** (2026-04-27) — **Frame shift release.** ISA elevated to universal primitive with five identities (ideal state articulation, test harness, build verification, done condition, hard-to-vary explanation) — one document, no parallel acceptance.yaml/acceptance.ts artifacts. Unit reframed from "task" to "thing whose ideal state we're articulating": project ISAs at `<project>/ISA.md` for any persistent thing (applications, CLI tools, libraries, content pipelines, infrastructure, the Algorithm itself); task ISAs at `MEMORY/WORK/{slug}/ISA.md` reserved for ad-hoc one-shot work. **Mode-selection regression fixed:** `EscalationGate.hook.ts` (UserPromptSubmit) deterministically floors NATIVE→ALGORITHM via 5 triggers (doctrine-affecting, architectural-locator, multi-project, soft-user-signal, hard-to-vary) plus 3-axis test (retrievability/blast-radius/hard-to-vary depth) for residual cases. Telemetry hook (SessionStart) surfaces last-7d off-ramp failures, closing the feedback loop missing through v5.x. **Capability floors restored** at v4.1.0 numbers, field-validated: E1=0-1 (preserves fast-path), E2≥3, E3≥6, E4≥8 (≥6 thinking + ≥2 delegation), E5≥12 (≥8 thinking + ≥4 delegation). Soft floors with "show your math" override in `## Decisions`. Anti-criteria gate stays at ≥1 with new prose reminder at OBSERVE — no count bump per {{PRINCIPAL_NAME}}'s BPE preference. v6.0.x mechanics deferred: `<project>/ISA.md` parser/hook updates, OBSERVE/PLAN inheritance resolver, Pulse two-home rendering, project ISA seeding migration.

### Prior

- **v5.5.0** (2026-04-27) — BPE compaction continues: dropped the residual `ISC-A-N` numbering convention for anti-criteria.
- **v5.4.0** (2026-04-27) — Unified Learning Router in LEARN phase. Replaces the narrow "Knowledge capture" step (which only wrote to `MEMORY/KNOWLEDGE/`) with a router that handles every kind of learning: knowledge, operational rules, skill gotchas, project state, business facts, identity edits, doctrine changes, hook proposals, permission changes, reflection metrics. Each TYPE has a target PAI surface and a gate (inline write vs. surface-to-user). Routing table mirrors `PAI_SYSTEM_PROMPT.md` "Self-Healing Infrastructure" so Algorithm and constitution agree. Forbidden destination: harness auto-memory dir (already blocked by `autoMemoryEnabled: false` + permissions deny). Documentation sync step (existing) becomes the natural downstream — any inline write to a system file triggers `Skill("<your-release-skill>", "documentation update ...")`. **Drift fix:** `settings.json pai.algorithmVersion` was stuck at `5.2.0` while LATEST/CLAUDE.md said `5.3.0` — bumped to `5.4.0` correctly across all 4 files this release.
- **v5.3.0** (2026-04-27) — BPE-driven removal of ISC category tags `[F]`/`[S]`/`[B]`/`[N]`/`[E]`/`[A]` from the on-disk format. Format collapses to `- [ ] ISC-N: criterion text`. Two doctrinal kinds preserved as prefix conventions, not bracket letters: anti-criteria via `ISC-A-N: Anti: ...` (≥1 required), antecedent via `Antecedent: ...` prefix in description (≥1 required when goal is experiential). Parser (`hooks/lib/isa-utils.ts`) is backward-compatible — legacy bracketed ISAs still parse, the captured `category` field is retained for them but never emitted on new ISAs. Eliminates triple-redundancy of anti-criteria (was `ISC-A-N` + `[N]` tag + `Anti:` prefix); collapses to two surface signals.
- **v5.2.0** (2026-04-26) — Reintroduces per-tier ISC count floors at E2+ as soft minimums on the count axis only: E2 ≥16, E3 ≥32, E4 ≥128, E5 ≥256. E1 stays floor-free. No category percentages, no capability-mix splits — just count. Soft = document under-decomposition in `## Decisions` and proceed; ILA Coverage axis remains the structural enforcer.
- **v5.1.0** (2026-04-26) — Per-step durability via `CheckpointPerISC` hook (PostToolUse on ISA edits, auto-commits per ISC transition with `--no-verify --no-gpg-sign`, sidecar idempotency, allowlist for opt-in repos). Doctrine elsewhere unchanged from v5.0.0.
- **v5.0.0** (2026-04-26) — BPE compaction. Removed prescriptive count floors (ISC counts per tier, min capabilities, category percentages). Replaced with two operational rules: ISC granularity (one binary tool probe each) and capability binding-commitment (named = invoked, no minimum count). Tier time budgets remain the only quantitative anchor. All doctrine preserved verbatim.
- **v4.1.0** (2026-04-23) — Vocabulary release: PRD → ISA (Ideal State Artifact). No doctrine changes.
- **v4.0.1** (2026-04-22) — Patch: `[A]` category parser fix in `prd-utils.ts`, reflection JSONL gains `prd_level_audit` and `hva` fields.
- **v4.0.0** (2026-04-21) — Frame-shift: PRD-as-unit (Coverage / Tightness / Uniqueness — the ISA-Level HVA). Doctrine preamble added.
- **v3.30.0** (2026-04-19) — Hard-to-Vary doctrine grounding (R1 ISC quality gate, R3 `[A]` Antecedent category, R4 per-ISC HVA, R5 Euphoric Surprise prediction, R8 Fluff Sweep).
- **v3.29.0** (2026-04-19) — RR1 Re-Read Check, RR2 Deliverable Manifest tier-extended, RR3 SYNTHESIS auto-load.
- **v3.28.0** (2026-04-17) — Proportional-weight tuning of Effort Levels.
- **v3.27.0** (2026-04-16) — Rule 2a (Cato cross-vendor audit, E4/E5).
- **v3.26.0** (2026-04-15) — T1 Deliverable Manifest, T2 Inline Verification, T3 Reproduce-First blocking.
- **v3.25.0** (2026-04-14) — Capabilities expansion: SystemsThinking, RootCauseAnalysis.
- **v3.24.0** (2026-04-13) — RedTeam-driven hardening patches P1-P5.
- **v3.23.0** (2026-04-12) — Verification Doctrine Rules 1/2/3, Feedback Memory Consult, Parallelism Opportunity Scan.
- **v3.21.0 and earlier** — see individual version files in this directory.

## How to read

- To understand the doctrine **today**: read whatever version `LATEST` points to.
- To understand **why** a rule exists: each rule in the active version carries a one-line `(provenance: ...)` pointer. Chase that into the corresponding section below, or `git log` the rule.
- To **roll back** to a prior version: see the migration recipe in that version's section below. Hooks parse only the ISA frontmatter `effort` enum and ISC checkboxes — both version-stable — so rollback is non-destructive. (v5.3.0 also dropped category tags from the parse contract; legacy bracketed ISAs are still accepted via backward-compat parsing.)

---

## Full History

### v6.1.0 → v6.2.0

v6.2.0 ships the long-running ISA expansion conversation {{PRINCIPAL_NAME}} and {{DA_NAME}} had across the 2026-04-27/28 turn boundary. The doctrine bump preserves v6.1.0's thinking-floor hardening verbatim; everything new is additive.

**The work captured in C/R/L form (eat-our-own-dog-food on the new Changelog format):**

- 2026-04-28 | conjectured: the ISA's five sections (Goal/Context/Criteria/Decisions/Verification) carry enough structure for any project's articulation of ideal state
  refuted by: a long synthesis conversation surfaced that Problem (the why), Vision (the experiential intent), Out of Scope (the anti-vision), Principles (substrate-independent truths), Constraints (immovable architectural mandates), Test Strategy (per-ISC verification), Features (work breakdown with parallelization graph), and Changelog (Deutsch error-correction trail) all serve real, distinct purposes that the five-section frame was silently overloading or missing entirely
  learned: the ISA body needs twelve sections in fixed order, with hard tier-completeness gating that prevents ceremony bloat at E1 (just Goal+Criteria) while requiring full structure at E4/E5 (all twelve, plus active Interview at E5)
  criterion now: v6.2.0.md ISA-as-System-of-Record subsection lists the twelve sections, the IsaFormat.md spec bumps to v2.7 with the full schema, and the Tier Completeness Gate is HARD at every tier

- 2026-04-28 | conjectured: the existing skill-and-hook surface was sufficient infrastructure for the ISA primitive
  refuted by: filesystem check showed no ISA skill on disk, IsaFormat.md was the only documentation, no project ISAs existed anywhere, and the changelog format that v6.2.0 introduces (conjecture/refutation/learning) had no canonical writer
  learned: novel formats degrade without a skill that owns them — the C/R/L Changelog would have diluted to free-form prose within three projects
  criterion now: new `~/.claude/skills/ISA/` skill with Scaffold / Interview / CheckCompleteness / Reconcile / Seed / Append workflows, and Append specifically gates the C/R/L format (refuses partial entries)

- 2026-04-28 | conjectured: Out of Scope and Anti-criteria are the same concept, just at different granularities — both can fold into anti-criteria ISCs
  refuted by: {{PRINCIPAL_NAME}} articulated the distinction directly — Out of Scope is declarative ("we are not building mobile native apps"), anti-criteria are derived testable probes ("`/admin` returns 404")
  learned: the three-guardrail taxonomy needs four surfaces, not three: Principles bind thinking, Constraints bind solution space, Out of Scope binds the vision (anti-vision), Anti-criteria bind the test surface (derived). Out of Scope is its own ISA section, not an ISC type
  criterion now: ISA body has `## Out of Scope` as section 3, distinct from `## Criteria` anti-criteria

- 2026-04-28 | conjectured: ephemeral feature files (Ralph Loop / Maestro pattern) need a separate workflow file in the ISA skill
  refuted by: Scaffold workflow already had to know how to build the master ISA from a prompt; the ephemeral excerpt is the same operation against a feature-scoped subset
  learned: Scaffold owns both halves of the spawn lifecycle; Reconcile owns the merge half. No separate Spawn workflow needed.
  criterion now: Scaffold.md has an "Ephemeral feature mode" section; Reconcile.md is the deterministic ISC-keyed merge — together they form the lifecycle

**The Forge / Advisor / Cato collaboration on this run:**
- Advisor commitment-boundary call before BUILD flagged that the C/R/L format would degrade without a canonical writer → Append.md added during BUILD (closing what would have been ISC-21.2 in retrospect).
- Forge drafted the AlgorithmSystem.md full rewrite (334 lines, swapped from v3.26.0-stale to v6.2.0-current) in parallel with the doctrine spec writes, in 209 seconds.
- Advisor flagged two real risks during the v6.2.0.md write: (1) E1 fast-path bypass risks becoming a doctrine-evasion route — addressed by specifying the bypass as a whitelist condition, not a heuristic; (2) section-name drift between the skill's `canonical-isa.md` and `IsaFormat.md` v2.7 — addressed by writing both with the same twelve-section list in the same order this run.

**v6.2.0 in-flight refactor (LATEST as single source of truth):** initially shipped an `AlgorithmVersionSync.hook.ts` to keep `settings.json .pai.algorithmVersion` synced with `PAI/ALGORITHM/LATEST` on every Write/Edit/MultiEdit. {{PRINCIPAL_NAME}} called Bitter Pill — a hook that synchronizes duplicated state is overhead a smarter design renders unnecessary. Refactored to make LATEST the sole record: statusline reads `cat $PAI_DIR/ALGORITHM/LATEST` directly; `Banner.ts` and `ArchitectureSummaryGenerator.ts::detectAlgorithmVersion()` read LATEST first; `UpdateCounts.ts` no longer mirrors CLAUDE.md regex into settings; `CLAUDE.md MANDATORY FIRST ACTION` became a two-step "Read LATEST → Read v${contents}.md" instruction; `.pai.algorithmVersion` deleted from settings.json; hook + its three Write/Edit/MultiEdit registrations removed. Net change: one source, drift physically impossible. Live-probed end-to-end: bumping LATEST to `6.99.99` flowed through the statusline within one second with no other file touched. Lesson written to v6.2.x doctrine note: when the symptom is "synced field drifted," the right answer is usually to remove the duplicated field, not to add a synchronizer.

**Files updated:**
- NEW: `PAI/ALGORITHM/v6.2.0.md` (doctrine file)
- NEW: `~/.claude/skills/ISA/` (eleven files: SKILL.md, four Examples, six Workflows)
- NEW: `~/.claude/ISA.md` (dog-food: PAI-as-project ISA, seeded via the Seed workflow)
- EDIT: `PAI/ALGORITHM/LATEST` → `6.2.0`
- EDIT: `PAI/ALGORITHM/changelog.md` (this entry, plus Index demotion of v6.1.0 to Prior)
- EDIT: `PAI/DOCUMENTATION/IsaFormat.md` → v2.7 (twelve-section schema + tier completeness gate + ID-stability rule + ephemeral pattern + C/R/L format)
- EDIT: `PAI/DOCUMENTATION/Algorithm/AlgorithmSystem.md` (full rewrite from v3.26.0-stale to v6.2.0-current, via Forge)
- EDIT: `~/.claude/CLAUDE.md` (MANDATORY FIRST ACTION → v6.2.0.md)
- EDIT: `PAI/ALGORITHM/capabilities.md` (Skill("ISA") added to OBSERVE-phase capabilities)
- EDIT: `PAI/ALGORITHM/mode-detection.md` (E1 fast-path bypass specified as whitelist, ISA skill invocation mandatory at E2+)

**v6.2.x deferred (automation surface):**
- `hooks/lib/isa-utils.ts` parser updates for `<project>/ISA.md` discovery and twelve-section parsing
- `hooks/ISASync.hook.ts` extension to project ISAs
- `hooks/CheckpointPerISC.hook.ts` extension to project ISAs
- hooks/PromptProcessing.hook.ts (formerly EscalationGate.hook.ts, now consolidated) regex extension to add Append/Reconcile/Seed triggers
- `PAI/PULSE/Observability/observability.ts` rendering for project ISAs
- `~/.claude/skills/ISA/Tools/*.ts` CLI implementations (Scaffold.ts, Interview.ts, Completeness.ts, Reconcile.ts, Append.ts)
- Project-ISA seeding migration for the ~30 projects in PROJECTS.md (lazy-seed on first task per {{PRINCIPAL_NAME}}'s Q5 answer)

**Migration command (rollback to v6.1.0):**
```bash
echo 6.1.0 > ~/.claude/PAI/ALGORITHM/LATEST && \
  jq '.pai.algorithmVersion="6.1.0"' ~/.claude/settings.json | sponge ~/.claude/settings.json && \
  sed -i '' 's|v6.2.0.md|v6.1.0.md|' ~/.claude/CLAUDE.md
# The ISA skill stays on disk and is harmless under v6.1.0 (skill is invocation-agnostic)
# IsaFormat.md v2.7 is additive — v6.1.0 still parses correctly
# AlgorithmSystem.md is documentation-only — v6.1.0 doesn't depend on it
```

### v5.5.0 → v6.0.0

v6.0.0 is a **frame-shift release** in two coupled moves: (1) closing the v5.0.0 BPE under-cut at the mode-selection layer, and (2) elevating the ISA from "task artifact" to "universal primitive with five identities." Both moves were triggered by the same {{PRINCIPAL_NAME}}-led session — the mode-selection regression was the symptom that forced the deeper architectural conversation.

**The two coupled moves.**

**Move 1 — Mode-selection floor (closes the v5.0.0 → v5.7.0 regression).** v5.0.0 BPE-compacted the Algorithm internals correctly but left the new NATIVE/ALGORITHM/MINIMAL mode-selection gate un-floored. Two un-floored trust layers in series: model picks mode without floor → IF Algorithm, picks capabilities without floor. Either layer failing produces silent under-escalation. v5.2.0 partially restored ISC count floors INSIDE the Algorithm but missed the mode-selection layer entirely. v6.0.0 adds:

- `EscalationGate.hook.ts` (UserPromptSubmit) — five deterministic triggers (doctrine-affecting / architectural-locator / multi-project / soft-user-signal / hard-to-vary explanation work) plus a three-axis NATIVE→ALGORITHM test (Retrievability / Blast-Radius / Hard-to-Vary Depth) for residual cases. Writes `MODE_FLOOR` to additionalContext.
- `EscalationTelemetry.hook.ts` (SessionStart) — scans last 7 days of escalation-gate.jsonl, surfaces "in last 7 days, N prompts triggered floor" so off-ramp failures become visible. The feedback loop missing through v5.x.
- **Capability floors restored** at v4.1.0 numbers, field-validated this session: E1=0-1 (preserves <90s fast-path), E2≥3, E3≥6, E4≥8 (≥6 thinking + ≥2 delegation), E5≥12 (≥8 thinking + ≥4 delegation). Soft floors with explicit "show your math" override required in `## Decisions` if model picks fewer.
- Anti-criteria gate stays at ≥1 (no v3.30 ≥2 restoration per {{PRINCIPAL_NAME}}'s BPE preference). New prose reminder at OBSERVE: "Have you included anti-criteria? What must NOT happen?"

**Move 2 — ISA as universal primitive (frame shift).** The ISA isn't a task artifact — it's THE artifact for any thing whose ideal state we're articulating. It has five identities simultaneously: (1) ideal state articulation (Deutsch hard-to-vary explanation), (2) test harness (ISCs ARE the tests, with named probes), (3) build verification (passing ISCs verifies what was built), (4) done condition (task complete when all ISCs pass), (5) system of record. Forge's pressure-test of an earlier "acceptance.yaml per project" proposal killed that direction — the ISA already covers the surface; inventing a parallel artifact creates a second source of truth that immediately rots. The new structural rule: project ISAs live AT `<project>/ISA.md` (in the project's repo, system of record); task ISAs at `MEMORY/WORK/{slug}/ISA.md` reserved for ad-hoc one-shot work that doesn't belong to a persistent thing. For complex apps, the ISA naturally has many more ISCs because the application logic IS the ideal state — RBAC matrix, perf budgets, security model, auth flow, data integrity, build verification, deploy contract, all encoded as ISCs.

**v6.0.0 ships the FRAME; v6.0.x ships the mechanics.** {{PRINCIPAL_NAME}} signaled "deeper conversation we need to continue" on the mechanics side — `<project>/ISA.md` parser updates, OBSERVE/PLAN inheritance resolver, Pulse two-home rendering, project-ISA seeding migration. v6.0.0 doctrine commits the conceptual move; mechanics earn implementation through continued design conversation.

**What did NOT change:** every other v5.5.0 doctrine. Seven phases, Hard-to-Vary Doctrine preamble, ISA as system of record (extended to two homes, not replaced), the variation test, ISC granularity rule, ISA-Level HVA (Coverage/Tightness/Uniqueness), Verification Doctrine (Rules 1/2/2a/3 + P1-P5 hardening), `[DEFERRED-VERIFY]` ISC status, Inline Verification mandate, Reproduce-First blocking gate, Intent Echo, Reverse Engineering block, Preflight Gates A-D, Deliverable Manifest, Parallelism Opportunity Scan, Re-Read Check, Euphoric Surprise Prediction, Learning Router, Forge/Anvil/Cato bindings, voice-curl format, frontmatter contract, fast-path trigger, the 7/7 SUMMARY block as terminator, the reflection JSONL schema, per-tier ISC count floors at E2+ (16/32/128/256), CheckpointPerISC hook. The two doctrinal minimums survive: anti-criteria ≥1, antecedent ≥1 when experiential.

**Files updated:**
- NEW: `PAI/ALGORITHM/v6.0.0.md` (doctrine file)
- NEW: hooks/EscalationGate.hook.ts (UserPromptSubmit gate — later consolidated into PromptProcessing.hook.ts)
- NEW: hooks/EscalationTelemetry.hook.ts (SessionStart telemetry — later consolidated into PromptProcessing.hook.ts)
- EDIT: `PAI/ALGORITHM/LATEST` → `6.0.0`
- EDIT: `PAI/ALGORITHM/changelog.md` (this entry, plus Index demotion of v5.5.0 to Prior)
- EDIT: `~/.claude/CLAUDE.md` (MANDATORY FIRST ACTION → v6.0.0.md)
- EDIT: `~/.claude/settings.json` (`pai.algorithmVersion` → `6.0.0`, hook registration for new UserPromptSubmit + SessionStart entries)

**Migration command (rollback to v5.5.0):**
```bash
echo 5.5.0 > ~/.claude/PAI/ALGORITHM/LATEST && \
  jq '.pai.algorithmVersion="5.5.0"' ~/.claude/settings.json | sponge ~/.claude/settings.json && \
  sed -i '' 's|v6.0.0.md|v5.5.0.md|' ~/.claude/CLAUDE.md
# Remove the two new hooks from settings.json hook arrays manually
# Hooks themselves can be left on disk (they no-op unless registered)
```

**Provenance:** Direct {{PRINCIPAL_NAME}}-led session 2026-04-27 (this run). Triggered by an under-escalation event in the same session: {{PRINCIPAL_NAME}} asked "where in our ISCs do standing invariants live?" and {{DA_NAME}} answered in NATIVE mode with a 1-paragraph response, when the question genuinely needed E4/E5 doctrinal-design treatment. Root-cause analysis traced the regression to v5.0.0 BPE leaving the mode-selection layer un-floored. The conversation that followed surfaced the deeper insight: the answer to {{PRINCIPAL_NAME}}'s original question wasn't to add a parallel acceptance framework — it was to recognize that the ISA already IS the test harness, and the v5.0.0 cut wasn't the only thing missing. Two coupled fixes from one session.

### v5.4.0 → v5.5.0

v5.5.0 is the **third BPE compaction round on the ISC tagging system**, applied directly to the residual `ISC-A-N` numbering convention that v5.3.0 left in place. Audit logic is identical to v5.3.0's: would a smarter model make this convention unnecessary? Answer: yes — the `Anti:` prose prefix already encodes the gate, and the dual `-A-` namespace was a triple-redundant decoration in disguise.

**What changed (and what didn't).** The `ISC-A-N` numbering is gone. New ISAs number every criterion sequentially as `ISC-N`, anti-criteria included. The `Anti:` prose prefix at the start of the description carries the doctrinal flag alone — the same role `Antecedent:` already played for experiential preconditions. **The ≥1 anti-criterion gate is unchanged.** Splitting Test, Hard-to-Vary Audit, ILA, tier floors, and every other v5.4.0 doctrine survive verbatim.

**Surface format before / after:**

```
v5.4.0:  - [ ] ISC-1: Haiku exists and JSON schema validates
         - [ ] ISC-A-1: Anti: bun build does not error
         - [ ] ISC-7: Antecedent: novel juxtaposition of metric + sketch

v5.5.0:  - [ ] ISC-1: Haiku exists and JSON schema validates
         - [ ] ISC-2: Anti: bun build does not error              (sequential numbering)
         - [ ] ISC-7: Antecedent: novel juxtaposition of metric + sketch
```

The visible win: ISA bodies stop alternating two numbering pools (`ISC-1, ISC-2, ISC-A-1, ISC-3..ISC-12, ISC-A-2, ISC-13...`) and read as one continuous count.

**Migration / parser compatibility.** Both parsers (`hooks/lib/isa-utils.ts` and `PAI/TOOLS/algorithm.ts`) now detect anti-criterion via `Anti:` prefix on the trimmed description. The legacy `id.includes('-A-')` test is retained as a backward-compat fallback so historical ISAs in `MEMORY/WORK/` still classify correctly. Domain-prefixed IDs (`ISC-CLI-3`, `ISC-TIER-1`, etc.) are unaffected — the dropped namespace was only the single-letter `-A-` anti-criterion convention. Historical ISAs are not migrated (frozen records, same precedent as v5.3.0).

**Files updated:**
- `PAI/ALGORITHM/v5.5.0.md` (new doctrine; v5.4.0 copied with the Anti-criterion table row + provenance note rewritten)
- `PAI/ALGORITHM/LATEST` → `v5.5.0`
- `PAI/DOCUMENTATION/IsaFormat.md` (anti-criterion examples + Tags table now show `ISC-N: Anti:`)
- `PAI/DOCUMENTATION/Algorithm/AlgorithmSystem.md` (ISC Quality System Anti-criterion line)
- `PAI/ALGORITHM/optimize-loop.md` (Guard Rails + Eval mode guard rails examples renumbered)
- `PAI/TOOLS/algorithm.ts` (line 558 anti-criterion detector switched to description-prefix; line 717 comment example updated)
- `hooks/lib/isa-utils.ts` (line 243 detector switched to `Anti:` prefix with legacy fallback; comments updated)
- `hooks/lib/isa-template.ts` (template comment block uses sequential `ISC-N: Anti:` example, version note bumped to v5.5.0+)
- `~/.claude/CLAUDE.md` (MANDATORY FIRST ACTION → v5.5.0.md)
- `~/.claude/settings.json` (`pai.algorithmVersion` → `5.5.0`)

**Migration command (rollback):** `echo v5.4.0 > ~/.claude/PAI/ALGORITHM/LATEST && jq '.pai.algorithmVersion="5.4.0"' ~/.claude/settings.json | sponge ~/.claude/settings.json && sed -i '' 's|v5.5.0.md|v5.4.0.md|' ~/.claude/CLAUDE.md`. Hooks need no rollback — both detection paths (legacy `-A-` and new `Anti:` prefix) coexist permanently.

**Provenance:** Direct BPE audit by {{PRINCIPAL_NAME}} against v5.4.0 — surfaced visible inconsistency in `MEMORY/WORK/20260427-040000_skill-convention-audit/ISA.md`'s ISC list (mixing `ISC-1, ISC-2, ISC-A-1, ISC-3..ISC-12, ISC-A-2, ISC-13...`). Five Questions: (1) does the `-A-` ID add information the `Anti:` prefix does not? No. (2) is the parser logic load-bearing on `-A-`? It was, but moving the test to `Anti:` is a one-line change. (3) does the gate (≥1 anti-criterion) require the dual namespace? No — the gate is a count of `Anti:`-prefixed ISCs, however numbered. Conclusion: cut the decoration, keep the gate via prefix. The pattern is now applied three times (v5.0.0 counts, v5.3.0 brackets, v5.5.0 numbering); doctrine is converging on prose-prefix-only as the surface contract.

### v5.2.0 → v5.3.0

v5.3.0 is a **BPE compaction release on the ISC category tag system**. Audit driven by direct user challenge against v5.2.0's `[F]`/`[S]`/`[B]`/`[N]`/`[E]`/`[A]` table: would a smarter model make these tags unnecessary? Answer: yes for four of the six. The other two carried doctrinal gates — the gates survive, the tags don't.

**What changed (and what didn't).** Four tags (`[F]` Functional, `[S]` Structural, `[B]` Behavioral, `[E]` Edge) were pure description: a competent reader infers category from the criterion text in well under a second. Removing them costs nothing and saves visual noise on every ISA {{PRINCIPAL_NAME}} ever reads again. Two tags (`[N]` Negative, `[A]` Antecedent) carried doctrinal weight as gates (≥1 anti-criterion always; ≥1 antecedent when goal is experiential) — but the *gates*, not the *labels*, are load-bearing. The gates survive. Anti-criteria already use `ISC-A-N` numbering and an `Anti:` prose prefix; the `[N]` tag was triple-redundant. Antecedent ISCs now use an `Antecedent:` prose prefix in the criterion description.

**Surface format before / after:**

```
v5.2.0:  - [ ] ISC-1 [F]: Haiku exists and JSON schema validates
         - [ ] ISC-A-1 [N]: Anti: bun build does not error

v5.3.0:  - [ ] ISC-1: Haiku exists and JSON schema validates
         - [ ] ISC-A-1: Anti: bun build does not error
         - [ ] ISC-7: Antecedent: novel juxtaposition of metric + sketch    (when experiential)
```

**What did NOT change:** every other v5.2.0 doctrine. Seven phases, Hard-to-Vary Doctrine preamble, ISA as system of record, the variation test, ISA-Level HVA (Coverage/Tightness/Uniqueness), per-ISC HVA with cluster-bearing rule, Verification Doctrine (Rules 1/2/2a/3 + P1-P5 hardening), `[DEFERRED-VERIFY]` ISC status, Inline Verification mandate, Reproduce-First blocking gate, Intent Echo, Reverse Engineering block, Preflight Gates A-D, Feedback Memory Auto-Consult, Deliverable Manifest, Parallelism Opportunity Scan, Re-Read Check, Fluff Sweep, Euphoric Surprise Prediction, Knowledge Capture, Documentation Sync, Forge/Anvil/Cato bindings, voice-curl format, frontmatter contract, fast-path trigger, the 7/7 SUMMARY block as terminator, the reflection JSONL schema, the per-tier ISC count floors at E2+ (16/32/128/256), and the CheckpointPerISC hook. The two doctrinal minimums also survive verbatim — only their *expression* moves from a bracket letter to a prose prefix.

**Migration / parser compatibility.** The parser (`hooks/lib/isa-utils.ts`) is **backward-compatible**: legacy ISAs with `[F]`/`[S]`/`[B]`/`[N]`/`[E]`/`[A]` still parse correctly and the `category` field is retained on `CriterionEntry` for them. New ISAs simply omit the bracket. Hooks (ISASync, CheckpointPerISC) require no changes — they consume `parseCriteriaList()` which now accepts both shapes. Historical ISAs in `MEMORY/WORK/` are not migrated (they are frozen records).

**Files updated:**
- `PAI/ALGORITHM/v5.3.0.md` (new doctrine file, copy of v5.2.0 with category section rewritten)
- `PAI/ALGORITHM/LATEST` → `v5.3.0`
- `PAI/DOCUMENTATION/IsaFormat.md` (Tags section + format examples + doctrinal-minimums language)
- `PAI/DOCUMENTATION/Algorithm/AlgorithmSystem.md` (outdated v3.26.0-era category table replaced with pointer to canonical doctrine)
- `hooks/lib/isa-template.ts` (ISA stub example uses bare `ISC-N:` format)
- `hooks/lib/isa-utils.ts` (regex made format-agnostic; comments updated; `VALID_CATEGORIES` retained for legacy parse, marked `@deprecated`)

**Migration command (rollback):** `echo v5.2.0 > LATEST && jq '.pai.algorithmVersion="5.2.0"' ~/.claude/settings.json | sponge ~/.claude/settings.json && sed -i '' 's|v5.3.0.md|v5.2.0.md|' ~/.claude/CLAUDE.md`. Hooks need no rollback — the parser still understands the old bracket format.

**Provenance:** Direct BPE audit by {{PRINCIPAL_NAME}} against v5.2.0 lines 85-97 + the `Anti-criteria` line 97. The Five Questions test surfaced (1) descriptive labels add zero information a competent reader can't infer, (2) the only doctrinal force was in `[N]`/`[A]` as gates, (3) `Anti:` prefix already encoded `[N]` — making `ISC-A-N` + `[N]` + `Anti:` triple-redundant. Conclusion: cut decoration, keep gate via prefix. Pattern reusable for at least three other doctrine spots that share the same shape.

### v5.1.0 → v5.2.0

v5.2.0 reintroduces **per-tier ISC count floors at E2+** as a soft minimum on the *count* axis only. v5.0.0's BPE compaction cut the v4.1.0 count floors (6/14/28/48/72) along with all category percentages and capability mixes. Field experience showed the granularity rule alone under-decomposes at the top tiers — a smart-enough model can pass the granularity gate with N atomic ISCs that nonetheless fail the ISA-Level HVA Coverage axis post-hoc. Floors close that gap before THINK, not after.

**The new floors:**

| Tier | ISC floor | vs v4.1.0 | vs v5.0/5.1 |
|------|-----------|-----------|--------------|
| Standard (E1) | none — preserves fast-path | -6 | unchanged |
| Extended (E2) | 16 | +2 | NEW soft floor |
| Advanced (E3) | 32 | +4 | NEW soft floor |
| Deep (E4) | 128 | +80 (2.7×) | NEW soft floor |
| Comprehensive (E5) | 256 | +184 (3.6×) | NEW soft floor |

**Soft, not strict.** The floor is a coverage anchor, not a blocking ceremony. If the task surface genuinely produces fewer atomic ISCs after the granularity rule has been applied honestly, document the under-decomposition and the reason in `## Decisions` and proceed. The ILA Coverage axis at E2+ remains the structural enforcer — the floor surfaces an under-decomposed ISA earlier, before THINK.

**Why these specific numbers.** E2/E3 are gentle bumps from v4.1.0 (16/32 vs 14/28). E4/E5 are aggressive (128/256 vs 48/72) because that's where decomposition pays the most — a 30-min E4 task that ships 30 ISCs has almost certainly compressed the spec to per-step bullets that hide real complexity; 128 forces real surface coverage. E5 at 256 averages ~28 sec per atomic check across the 120-min budget, which is the right order of magnitude for actually verifiable steps.

**What did NOT change from v5.1.0:** the CheckpointPerISC hook and EXECUTE Checkpoints subsection (preserved verbatim). What did NOT change from v5.0.0: every doctrine listed in the v5.0.0 "What did NOT change" paragraph below. **Category percentages stay cut** — no [S]≤40%, no [B]≥20%, no thinking/delegation splits. The floor is a count anchor only; the model still picks the category mix the task needs.

**Migration:** v5.2.0 lives alongside v5.1.0 and v5.0.0. To roll back: `echo v5.1.0 > LATEST && jq '.pai.algorithmVersion="5.1.0"' ~/.claude/settings.json | sponge ~/.claude/settings.json && sed -i '' 's|v5.2.0.md|v5.1.0.md|' ~/.claude/CLAUDE.md`. Hooks unchanged (parse only `effort` enum + ISC checkboxes + category tags). Floors are doctrine-level only — `isa-utils.ts` does not enforce them; the Algorithm prompt does.

### v5.0.0 → v5.1.0

v5.1.0 adds **per-step durability** — the one design move PAI hadn't yet committed to. The `CheckpointPerISC` hook (PostToolUse Edit/Write/MultiEdit on `MEMORY/WORK/{slug}/ISA.md`) auto-commits a git checkpoint in every opted-in repo on each `[ ]`→`[x]` ISC transition. Commits use `--no-verify --no-gpg-sign` to avoid husky/GPG hangs that would block the session. Sidecar state at `MEMORY/WORK/{slug}/.checkpoint-state.json` makes commits idempotent (no double-commit). Allowlist at `~/.claude/checkpoint-repos.txt` — defaults to `~/.claude` only; other repos require explicit {{PRINCIPAL_NAME}} opt-in (no surprise commits in WIP branches). Inspection + rollback via `bun ~/.claude/PAI/TOOLS/Checkpoint.ts {list|show|rollback} <slug> [<isc-id>]`. **Rollback is preview-only** — prints the suggested `git reset --hard <sha>` per repo and exits; never executes destructive ops without {{PRINCIPAL_NAME}} running them himself. Doctrine elsewhere is unchanged from v5.0.0; the only addition is the **Checkpoints subsection** in EXECUTE below. Provenance: R1 from session `20260426-230039_hankweave-pai-improvements-analysis` — Hankweave's per-codon git checkpoint absorbed as a PAI-native primitive without adopting Hankweave's runtime.

**Migration:** v5.1.0 lives alongside v5.0.0. To roll back: `echo v5.0.0 > LATEST && jq '.pai.algorithmVersion="5.0.0"' ~/.claude/settings.json | sponge ~/.claude/settings.json && sed -i '' 's|v5.1.0.md|v5.0.0.md|' ~/.claude/CLAUDE.md`. The hook can be left registered with no allowlist file (it no-ops); or remove its entries from `settings.json` PostToolUse arrays.

### v4.1.0 → v5.0.0

v5.0.0 is a **BPE compaction release** — Bitter Pill Engineering applied to the Algorithm itself. Doctrine is preserved verbatim where the wording is load-bearing; **prescriptive scaffolding (ISC count floors per tier, min-capability counts, category percentage caps and minimums, "≥1 thinking + ≥1 delegation" splits) is removed.** The model picks the right shape inside the only quantitative anchor that survives — the **tier time budget**.

Three structural moves:

1. **Counts and ratios out.** ISC floors (6/14/28/48/72), min-capability counts (0-1/2/4-5/6-10/10-14), category caps (`[S]` ≤40%, `[B]` ≥20%, `[E]` ≥10%, `[A]` ≤60%), `[N]` ≥2, "category diversity ≥3 tags", "max 2 ISCs may require human judgment", "≥1 thinking + ≥1 delegation" — all deleted. They were the model's judgment hard-coded as constants; a smarter model picks the right shape per task.

2. **Replaced by two operational rules.** **ISC granularity:** *"Split until each criterion is one binary tool probe."* If you cannot name the probe, the criterion is not yet atomic. **Capability selection:** *"Select what the task genuinely needs within the tier time budget."* Naming a capability is a binding commitment to invoke it — phantom capabilities = CRITICAL FAILURE. The granularity rule does the work the count floors used to do; the binding-commitment rule does the work the min-capability counts used to do.

3. **History moves out.** v3.21.0 → v4.1.0 CHANGES sections (~250 lines of historical churn) move to this file. Per-rule "Why this exists" boilerplate compacts to one-line provenance pointers. The full rationale lives here. Read this file once if you want the archaeology; the doctrine file stays focused on what to do this run.

**What did NOT change:** the seven phases, the Hard-to-Vary Doctrine preamble, the ISA as system of record, the six ISC categories ([F]/[S]/[B]/[N]/[E]/[A]), the variation test, the ISA-Level HVA (Coverage/Tightness/Uniqueness), the per-ISC HVA with cluster-bearing rule, the Verification Doctrine (Rules 1/2/2a/3 + P1-P5 hardening), `[DEFERRED-VERIFY]` ISC status, Inline Verification mandate, Reproduce-First blocking gate, Intent Echo, Reverse Engineering block, Preflight Gates A-D, Feedback Memory Auto-Consult, Deliverable Manifest (any tier with 2+ explicit sub-tasks), Parallelism Opportunity Scan, Re-Read Check (RR1), Fluff Sweep at VERIFY, Euphoric Surprise Prediction, Knowledge Capture rules, Documentation Sync, Forge/Anvil/Cato bindings, voice-curl format and identifier fields, frontmatter contract, fast-path trigger, the 7/7 SUMMARY block as terminator, the reflection JSONL schema. Two minimums survive on doctrinal grounds, not numerical ones: **`[N]` anti-criteria ≥1** (a goal with zero failure modes worth naming is under-specified) and **`[A]` antecedent ≥1 when the goal is experiential** (the doctrinal hook for aesthetic/resonant work).

**Migration:** v5.0.0 lives alongside v4.1.0. The `LATEST` pointer determines which version `CLAUDE.md` loads (currently a plain text file, not a symlink). Hooks (`isa-utils.ts`, ISASync) parse only the `effort` enum, ISC checkboxes, and category tags — none of which changed. State sync, work.json, Pulse rendering all carry forward unchanged. To roll back: `echo v4.1.0 > LATEST && jq '.pai.algorithmVersion="4.1.0"' settings.json | sponge settings.json`.

For v3.21.0 through v4.1.0 history: see individual version files in this directory; their `### CHANGES FROM` sections at the top are the source of truth for that era.

---

## Policy

When releasing a new Algorithm version:

1. Doctrine changes go into the new `vX.Y.Z.md` (no CHANGES section at top — start with `## The Algorithm X.Y.Z` then doctrine).
2. The CHANGES prose, migration recipe, and rollback recipe go **here**, as a new section under **Full History**, in reverse-chronological order (newest at top of Full History).
3. Add a one-line entry under **Index → Current**, demote the previous Current entry to **Prior**.
4. Update `LATEST` and `~/.claude/CLAUDE.md`'s algorithm reference to the new version.

The doctrine file is read every session. This file is read on demand. Keep them separate.
