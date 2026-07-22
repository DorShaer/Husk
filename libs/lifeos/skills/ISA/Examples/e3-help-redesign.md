<!-- Fictitious example. "duck" is a teaching placeholder for an existing CLI tool whose --help output we are redesigning. -->

---
task: "Redesign the duck CLI's --help output for first-encounter clarity"
slug: 20260411-191500_duck-help-redesign
project: DuckHelpRedesign
effort: advanced
effort_source: explicit
phase: execute
progress: 16/36
mode: interactive
started: 2026-04-11T02:15:00Z
updated: 2026-04-15T18:00:00Z
---

## Problem

The `duck` CLI's `--help` output is 187 lines, formatted as one block per flag in declaration order, with usage examples buried at line 142. New users land on it, scan for 4 seconds, hit Ctrl-C, and `man duck` instead. We track help-to-first-command time at 95 seconds (median for new installs) and the dominant time-sink in those 95 seconds is "scrolling through --help and giving up." The reference content is fine; the layout is not.

## Vision

A `duck --help` that a first-time user can read top-to-bottom in 30 seconds and walk away knowing: (a) what duck does in one sentence, (b) the two most-common invocations, (c) where to find more — and only after that, the full flag reference. Euphoric surprise: a new user lands on the redesigned help, types one of the example invocations within 15 seconds, and it works. They never visit the man page on their first session.

## Out of Scope

- **No new flags or behavior.** Reference content stays identical; only layout, ordering, and density change.
- **No man-page redesign.** `man duck` is the deep reference; this work is the front door, not the library.
- **No interactive help (`duck help`).** Stays a one-shot stdout dump like every other Unix CLI.
- **No color support added or removed.** Existing color behavior stays; this is content-and-layout work.
- **No localization.** English only, same as the rest of duck.

## Principles

- The first 30 seconds are the entire user experience for 80% of new users. The output is optimized for them, not for power users (who use `man` or `--help <flag>`).
- A help screen is a teaching surface, not a reference dump. Reference belongs in `man`.
- Whitespace is a feature. Density alone is not friendliness.
- Examples teach faster than prose. The first concrete invocation goes above the first flag definition.
- Progressive disclosure: highest-information-per-pixel content first, full flag table last.

## Constraints

- Output stays plain text suitable for piping to `less`, `grep`, etc. — no terminal-control escapes for the layout itself.
- Total length ≤ 100 lines (current: 187 lines).
- Renders correctly at 80-column width (no wrapped lines that break alignment).
- Must include every flag the current help includes — no flag omissions.
- Build process: `duck --help` reads from a single template file at compile time; the redesign updates that template, not the runtime renderer.
- Backwards-compat: `duck --help | rg <flag-name>` continues to find each flag (so existing scripts that grep --help don't break).

## Goal

Ship a redesigned `duck --help` template (≤ 100 lines, 80-col safe) that opens with a one-sentence project summary, shows the two most-common usages as concrete examples, lists the flag reference grouped by category (not declaration order), and ends with a "see also" footer pointing at man + docs URL — all reference content preserved, all flags still grep-able, first-time-user help-to-first-command time drops from 95s median to ≤ 30s median.

## Criteria

### Length and layout

- [x] ISC-1: `duck --help | wc -l` returns ≤ 100 lines (current baseline 187).
- [x] ISC-2: Every line in `duck --help` is ≤ 80 columns (probe: `awk 'length>80' < (duck --help) | wc -l` returns 0).
- [ ] ISC-3: Output has exactly three top-level sections: Summary+Examples block, Flag Reference, See Also (probe: count of section header rules `═` or `─`).

### Top-section content

- [x] ISC-4: First non-blank line is a one-sentence description ≤ 80 chars (probe: line 1 length, sentence-end period).
- [ ] ISC-5: Examples block contains exactly 2 invocations, each annotated with a one-line "what this does" gloss.
- [ ] ISC-6: Each example invocation is a real, currently-supported command (probe: copy-paste each example, run it, assert exit 0 against test fixtures).

### Flag reference

- [ ] ISC-7: Flags are grouped into ≤ 4 categories with clear headers (e.g., `Common`, `Output Control`, `Filtering`, `Diagnostics`).
- [ ] ISC-8: Each flag's entry is exactly 2 lines: `--flag, -f <ARG>` on line 1 (left-aligned, fixed-width), description on line 2 indented 4 spaces.
- [ ] ISC-9: Within each category, flags are alphabetized.
- [ ] ISC-10: Every flag from the current 187-line help is present in the new layout (probe: `diff <(rg "^  --" old-help.txt | sort -u) <(rg "^  --" new-help.txt | sort -u)` returns empty).

### See-also footer

- [ ] ISC-11: Footer contains exactly: man page reference, docs URL, version + build short-sha.
- [ ] ISC-12: Footer URL is on a single line and ≤ 80 chars.

### Backwards-compat

- [x] ISC-13: `duck --help | rg "\-\-each-flag-name"` returns ≥ 1 line for every flag (verified across all flags).
- [x] ISC-14: `duck --help` exit code stays 0 (probe: `duck --help; echo $?`).
- [ ] ISC-15: Pre-existing `man duck` still references "see `--help` for usage" — and the reference still resolves to a useful Examples block.

### Performance

- [ ] ISC-16: First-time-user help-to-first-command time drops from 95s median to ≤ 30s (probe: 5 new-user usability sessions, time from `duck --help` to first non-help command).
- [ ] ISC-17: Help-screen render time stays < 50ms (template is compiled-in, not parsed at runtime).

### Antecedent ISCs (experiential preconditions)

- [ ] ISC-18: **Antecedent:** the one-sentence description (line 1) is hard-to-vary — replacing any verb or noun with a synonym makes the description either inaccurate or weaker (probe: 3 paraphrase attempts reviewed, all detectably worse).
- [ ] ISC-19: **Antecedent:** the two examples in the Examples block are the two highest-frequency invocations from the last 30 days of telemetry (probe: cross-reference invocation-frequency log).
- [ ] ISC-20: **Antecedent:** the flag categories are intuitive — given only the four category names, a new user can guess which category contains a randomly-chosen flag with ≥ 70% accuracy (probe: 5 users, 10 random flags each, ≥ 70% category-guess accuracy).

### Voice and tone

- [ ] ISC-21: Each flag description is ≤ 80 chars and reads as imperative (e.g., "Print version and exit", not "This flag prints the version").
- [ ] ISC-22: Zero "Note:" preambles (probe: `rg "^    Note:" new-help.txt` returns 0).
- [ ] ISC-23: Zero "Please" appearances (probe: `rg -wi "please" new-help.txt` returns 0).

### Anti-criteria

- [ ] ISC-24: Anti: out of scope — no new flag was introduced (probe: flag count is unchanged from baseline).
- [ ] ISC-25: Anti: regression — `duck --help -h` and `duck -h` and `duck help` all still produce the same output (probe: `diff <(duck --help) <(duck -h) <(duck help)` returns identical).
- [ ] ISC-26: Anti: footer drift — version + build sha line is automatically generated, not hand-edited (probe: source template uses `{{VERSION}}` `{{SHA}}` placeholders, build pipeline injects).
- [ ] ISC-27: Anti: density creep — no flag description is split across two description lines (probe: every description is exactly 1 line of ≤ 80 chars).

### Migration discipline

- [ ] ISC-28: A diff between old and new template is captured in `docs/help-redesign-diff.md`.
- [ ] ISC-29: A blog post or release note draft (≤ 300 words) explaining the redesign exists at `docs/release-notes/help-redesign.md`.
- [ ] ISC-30: The 5 user-test session recordings (anonymized) are saved at `research/user-tests/help-redesign-2026-04/`.

### Bitter Pill discipline

- [ ] ISC-31: No section of the new help is shorter than 4 lines or longer than 70 lines (probe: per-section line count).
- [ ] ISC-32: Examples block does NOT include a "useful flag combinations" appendix (probe: human review — the discipline is two examples, not five).

### Publishing

- [ ] ISC-33: New template is committed to `templates/help.txt` with a commit message linking the redesign decision in Decisions.
- [ ] ISC-34: The change ships behind a build flag for one release before becoming default (probe: build flag exists, default-on commit lands one release after introduction).
- [ ] ISC-35: Pre-existing CI test `test/help-grep.sh` (which greps for each flag) passes against the new template.

### Long-tail observation

- [ ] ISC-36: 30 days post-ship, help-to-first-command median time has dropped to the ISC-16 threshold and stays there (probe: telemetry comparison day-30 vs day-0).

## Test Strategy

```yaml
- isc: ISC-1
  type: line-count
  check: --help line count
  threshold: ≤ 100
  tool: duck --help | wc -l

- isc: ISC-6
  type: integration
  check: each example actually runs
  threshold: exit 0 on all
  tool: bash test/help-examples.sh

- isc: ISC-10
  type: completeness
  check: every old flag is in new help
  threshold: empty diff
  tool: diff <(rg "^\s*--" old-help.txt | sort -u) <(rg "^\s*--" new-help.txt | sort -u)

- isc: ISC-16
  type: usability-test
  check: median help-to-first-command time
  threshold: ≤ 30s median across 5 users
  tool: 5 user-test sessions, time-stamped recordings

- isc: ISC-18
  type: antecedent
  check: one-sentence description is hard-to-vary
  threshold: 3 paraphrase attempts all detectably worse
  tool: human review by 3 unfamiliar reviewers

- isc: ISC-20
  type: antecedent
  check: category names are intuitive
  threshold: ≥ 70% guess accuracy across 5 users × 10 flags
  tool: structured user test

- isc: ISC-25
  type: backwards-compat
  check: --help -h and help all match
  threshold: identical output
  tool: diff <(duck --help) <(duck -h) <(duck help)
```

## Features

```yaml
- name: TopSection
  description: One-sentence summary + 2 example invocations with annotations
  satisfies: [ISC-4, ISC-5, ISC-6, ISC-18, ISC-19]
  depends_on: []
  parallelizable: false  # the opener gates everything

- name: FlagReference
  description: Reorder flags into ≤ 4 categories, alphabetize within, 2-line entries
  satisfies: [ISC-7, ISC-8, ISC-9, ISC-10, ISC-20, ISC-21]
  depends_on: [TopSection]
  parallelizable: false

- name: SeeAlsoFooter
  description: Man-page ref + docs URL + version/sha
  satisfies: [ISC-11, ISC-12, ISC-26]
  depends_on: [FlagReference]
  parallelizable: true

- name: BackwardsCompat
  description: --help -h and help all produce same output; flag-grep still works
  satisfies: [ISC-13, ISC-14, ISC-15, ISC-25, ISC-35]
  depends_on: [FlagReference, SeeAlsoFooter]
  parallelizable: true

- name: UsabilityValidation
  description: 5 user-test sessions for help-to-first-command + category intuition
  satisfies: [ISC-16, ISC-20, ISC-30]
  depends_on: [TopSection, FlagReference, SeeAlsoFooter]
  parallelizable: true
```

## Decisions

- 2026-04-11 02:15: Three top-level sections — Summary+Examples / Flag Reference / See Also — locked. Resists the "one more category" temptation that ate the last help redesign attempt.
- 2026-04-12 14:00: ❌ DEAD END: Tried 5 categories instead of 4. Users in pilot test split 60/40 on which category three flags belonged to. Reverted to 4 categories with clearer names. Don't retry.
- 2026-04-13 09:00: refined: ISC-19 sharpened from "examples reflect common usage" to "examples are the two highest-frequency invocations from 30-day telemetry" — the first phrasing let me cherry-pick aspirational examples; the second forced honesty.
- 2026-04-13 22:00: refined: ISC-8 sharpened from "flags formatted clearly" to "exactly 2 lines per flag, line 1 fixed-width, line 2 indented 4 spaces" — vague aesthetic claims are how help screens drift back to inconsistent layout over time.
- 2026-04-14 11:30: ❌ DEAD END: Tried inline color highlighting for flag names. Broke piping to `grep` and `less` for users without color-aware pagers. Reverted to plain text. Don't retry.
- 2026-04-15 16:00: refined: ISC-16 added a 30-day post-ship probe (ISC-30) — without it, the redesign passes its launch test but could regress in 90 days as new flags are added without category discipline.

<!--
E3 design ISA. Required sections: Problem, Vision, Out of Scope, Constraints, Goal, Criteria, Features, Test Strategy.
Optional Principles included — the design has experiential goals (first 30 seconds, recognition, intuition) and principles do real work in the design pass.
ISC count of 36 exceeds the E3 floor of 32. Three Antecedent ISCs (ISC-18, 19, 20) carry the experiential contract: hard-to-vary one-sentence summary, telemetry-grounded examples, and intuitive categories. Anti-criteria (ISC-24, 25, 26, 27) cover scope, regression, drift, and density. The Decisions section shows two ❌ DEAD ENDs and three refinements — typical for a redesign where every aesthetic temptation needs to be tested against actual users.
-->
