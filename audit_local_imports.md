# Local import and transcript audit

Scope: the local sharing pipeline, private transcript persistence and its continuation entry points in this development change set.

## Findings fixed in this pass

| Severity | Component | Data flow and condition | Resolution and evidence |
| --- | --- | --- | --- |
| Medium | `src/lib/install-foundation.js`, `src/lib/market-bundle.js` | Selected bundle files and collected directory entries were statted before an unbounded path-based read. A concurrently replaced or growing input could invalidate those checks and exceed the intended read limit. | `readBoundedFile` checks a single open descriptor against identity and byte limits, rejects links and detects growth. Directory collection also limits depth and entry count. `bounded-file.test.js` exercises size, replacement, links and growth. |
| Medium | `src/lib/install-foundation.js` | Agent import copied files from staging after an external scanner and a user review. Changes during either interval could make the installed bytes differ from the reviewed manifest and file display. A scanner already has executable authority; this finding is an integrity failure, not an additional privilege claim. | Compare staged paths and hashes with the captured snapshot after scanning and again before installation. `install-foundation.test.js` mutates files in both intervals and verifies refusal, cleanup and zero installs. |
| Low | `src/lib/chat-transcript-store.js` | Handoff lookup could read a transcript leaf through a link; appending to an existing file did not restore its private mode. The condition requires local filesystem modification. | Bounded regular-file reads, checked append descriptors, private modes and atomic replacement for private rewrites. Transcript tests cover link reads, writes, directory links and permission restoration. |
| Low | `src/lib/install-foundation.js` | MCP requests were scanned as an application payload wrapper rather than the server map understood by the artifact reader. Canonicalizing through a map also needs to preserve duplicate input ids so one entry cannot replace another in the scanned representation. | Stage a canonical MCP server map with unique entry keys, retaining every input entry. A regression verifies both same-id entries appear in the review snapshot. |
| Low | `src/lib/install-foundation.js` | A page reload or window closure left a pending approval and its staging folder until timeout. | Navigation and destruction cancel the request, detach listeners and clean staging. The navigation regression verifies cancellation, no installation and removal of staged files. |

## Verified boundaries

Primary enforcement points are `src/lib/bounded-file.js:6`, `src/lib/install-foundation.js:53`, `src/lib/install-foundation.js:85`, `src/lib/chat-transcript-store.js:144` and `src/lib/chat-transcript-store.js:162`.

- Only the requesting web contents can answer its review id.
- Blocked scans remain blocked in main even if the renderer sends approval.
- Bundle validation checks paths, hashes, layouts, signatures and byte/file caps before installation.
- Scanner launch uses `execFile` without a shell. Unreadable, killed or timed-out scans require review.
- Automatic Brain capture does not create rules.
- Durable prompt recording runs only after runtime validation and excludes injected context.

## Coverage limits

This source audit and its regressions do not establish exhaustive vulnerability absence. A scanner is an explicitly selected local executable. Publisher declarations are not enforced OS permissions, and signature validity is not a safety verdict. Desktop components run with the current user's filesystem authority. Linux automated Electron runs use the repository's sandbox-disabled test harness; Windows/macOS behavior and active OS sandbox enforcement require their native validation environments.
