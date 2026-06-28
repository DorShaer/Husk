---
task: "Build a CLI tool that extracts arxiv paper metadata into JSONL"
slug: 20260201-100000_arxiv-extractor-cli
project: ArxivExtractor
effort: advanced
effort_source: explicit
phase: execute
progress: 5/14
mode: interactive
started: 2026-02-01T18:00:00Z
updated: 2026-02-12T03:00:00Z
---

## Problem

Researching across arxiv papers means reading abstracts in a browser one at a time. There is no quick "give me the title, authors, abstract, categories, and submission date for these 50 paper IDs as JSONL so I can grep them" tool. The arxiv API exists but its XML response shape is annoying enough that nobody uses it casually.

## Vision

A single bun TypeScript CLI: `bun arxiv.ts <id1> <id2> ... > papers.jsonl`. One paper per line, structured fields, no friction. Euphoric surprise: feeding 100 IDs and getting clean JSONL back in under three seconds.

## Out of Scope

- No PDF download. Metadata only.
- No citation graph traversal. Single-paper lookup, no following references.
- No web UI. CLI exclusively.
- No persistent cache. Stateless; every run hits the API.

## Constraints

- Bun runtime only. No Node dependency.
- Zero npm dependencies — use Bun's built-in `fetch` and a hand-rolled XML parse.
- Must respect arxiv's API rate limits (3 requests / second per their TOS).

## Goal

Ship a single-file `arxiv.ts` CLI that takes paper IDs as arguments, queries the arxiv Atom API, parses the response, and writes one JSONL row per paper to stdout with fields: `id`, `title`, `authors`, `abstract`, `categories`, `submitted`, `updated`.

## Criteria

- [x] ISC-1: `arxiv.ts` is a single file at the project root.
- [x] ISC-2: Zero entries in `package.json` `dependencies` (probe: `jq '.dependencies | length' package.json` returns 0).
- [ ] ISC-3: `bun arxiv.ts 2401.12345` returns exactly one JSONL row to stdout.
- [ ] ISC-4: The JSONL row has exactly seven fields: `id, title, authors, abstract, categories, submitted, updated`.
- [x] ISC-5: `authors` is an array of strings, never a single concatenated string.
- [ ] ISC-6: `categories` is an array of strings (e.g., `["cs.AI", "cs.LG"]`).
- [ ] ISC-7: A 100-ID batch completes in ≤ 3 seconds wall clock (rate-limit-aware throttling).
- [x] ISC-8: A bad ID (e.g., `9999.99999`) writes a JSONL row with `error` field instead of crashing.
- [ ] ISC-9: stderr stays empty on a successful 100-ID run (no logging clutter).
- [ ] ISC-10: `bun arxiv.ts --help` prints usage in ≤ 12 lines.
- [ ] ISC-11: Anti: out of scope — `arxiv.ts --download` is not a recognized flag (returns help + exits 2).
- [x] ISC-12: Anti: regression — never makes more than 3 concurrent requests against arxiv API.

## Test Strategy

```yaml
- isc: ISC-3
  type: cli-probe
  check: stdout has exactly one JSONL row
  threshold: 1 line
  tool: bun arxiv.ts 2401.12345 | wc -l

- isc: ISC-7
  type: performance
  check: wall-clock for 100 IDs
  threshold: ≤ 3000ms
  tool: time bun arxiv.ts $(cat 100-ids.txt)

- isc: ISC-8
  type: error-handling
  check: bad ID does not exit non-zero
  threshold: exit 0 + JSONL row with error field
  tool: bun arxiv.ts 9999.99999 | jq -e '.error'

- isc: ISC-12
  type: anti-probe
  check: max concurrent requests
  threshold: ≤ 3
  tool: instrument fetch with counter
```

## Features

```yaml
- name: AtomFetch
  description: Bun fetch + queue with 3-concurrency throttle
  satisfies: [ISC-7, ISC-12]
  depends_on: []
  parallelizable: false  # core IO layer

- name: AtomParse
  description: Hand-rolled XML → typed object
  satisfies: [ISC-4, ISC-5, ISC-6]
  depends_on: [AtomFetch]
  parallelizable: false

- name: CLIInterface
  description: Argument parsing, --help, error formatting
  satisfies: [ISC-3, ISC-8, ISC-9, ISC-10, ISC-11]
  depends_on: [AtomParse]
  parallelizable: false  # single-file CLI
```

## Decisions

- 2026-02-01 18:00: Hand-rolled XML parse over a library — Bun has no built-in XML, the response shape is bounded, and adding a dep would violate the zero-deps constraint.
- 2026-02-08 22:30: ❌ DEAD END: Tried Promise.all() with 100-IDs — arxiv rate-limited after request 12. Reverted to a 3-concurrency queue. Don't retry.
