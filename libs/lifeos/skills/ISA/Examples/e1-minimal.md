<!-- Fictitious example. "ColorlessCLI" is a teaching project name; any resemblance to real products or organizations is coincidental. -->

---
task: "Add a --no-color flag to a CLI tool"
slug: 20260428-141500_no-color-flag
effort: standard
effort_source: auto
phase: execute
progress: 0/4
mode: interactive
started: 2026-04-28T21:15:00Z
updated: 2026-04-28T21:15:00Z
---

## Goal

Add a `--no-color` flag to the `dump.ts` CLI so output strips ANSI escape codes when the flag is present (or when `NO_COLOR` env is set, per the no-color.org convention).

## Criteria

- [ ] ISC-1: `dump.ts --no-color | cat | head -1` produces output containing zero ANSI escape sequences (probe: `dump.ts --no-color | rg -c $'\x1b\['` returns 0).
- [ ] ISC-2: `NO_COLOR=1 dump.ts | rg -c $'\x1b\['` returns 0 (env-var path also strips).
- [ ] ISC-3: Default `dump.ts` (no flag, no env) still emits color codes when stdout is a TTY (probe: `script -q /dev/null dump.ts | rg -c $'\x1b\['` returns ≥1).
- [ ] ISC-4: Anti: `dump.ts --no-color` does not emit any new warning to stderr (probe: `dump.ts --no-color 2>&1 >/dev/null | wc -c` returns 0).

<!--
E1 minimal ISA. Required sections at this tier: Goal + Criteria.
Problem / Vision / Out of Scope / Principles / Constraints / Test Strategy / Features / Decisions / Changelog / Verification all omitted — the task is small enough that the Goal sentence plus four binary probes carries the entire articulation. The Anti-criterion (ISC-4) is what keeps a sloppy implementation from passing — adding a "color disabled" log line would technically meet ISC-1 while breaking the silent-by-default expectation.
-->
