'use strict';

// Tests for the PAI toggle helpers + the install-from-repo copilot-
// instructions block writer. Each test gets a private tmpdir that stands
// in for ~/.claude/; we never touch the real home directory.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  HUSK_AGENTS_START,
  HUSK_AGENTS_END,
  PARKED_BASENAME,
  parkedPath,
  applyPaiState,
  buildHuskPrompt,
  renderHuskAgentsBlock,
  mergeHuskAgentsBlock,
} = require('../../src/lib/pai-state');

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-pai-')); });
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

const live = () => path.join(tmp, 'CLAUDE.md');
const parked = () => path.join(tmp, PARKED_BASENAME);

// ─── applyPaiState ────────────────────────────────────────────────────────

test('ISC-1: disabling parks an existing CLAUDE.md verbatim', () => {
  fs.writeFileSync(live(), 'PAI prose here.\nline 2\n');
  applyPaiState(tmp, false);
  assert.equal(fs.existsSync(live()), false, 'live file should be gone');
  assert.equal(fs.existsSync(parked()), true, 'parked file should exist');
  assert.equal(fs.readFileSync(parked(), 'utf8'), 'PAI prose here.\nline 2\n');
});

test('ISC-2: disabling when no CLAUDE.md exists is a quiet no-op', () => {
  assert.doesNotThrow(() => applyPaiState(tmp, false));
  assert.equal(fs.existsSync(live()), false);
  assert.equal(fs.existsSync(parked()), false);
});

test('ISC-3: enabling restores the parked file when live is absent', () => {
  fs.writeFileSync(parked(), 'PAI content\n');
  applyPaiState(tmp, true);
  assert.equal(fs.existsSync(live()), true);
  assert.equal(fs.existsSync(parked()), false);
  assert.equal(fs.readFileSync(live(), 'utf8'), 'PAI content\n');
});

test('ISC-4: enabling never clobbers a user-created live CLAUDE.md', () => {
  fs.writeFileSync(parked(), 'OLD PAI content\n');
  fs.writeFileSync(live(), 'USER content I wrote myself\n');
  applyPaiState(tmp, true);
  assert.equal(fs.readFileSync(live(), 'utf8'), 'USER content I wrote myself\n');
  assert.equal(fs.readFileSync(parked(), 'utf8'), 'OLD PAI content\n');
});

test('ISC-5: disabling when both files exist leaves both alone', () => {
  fs.writeFileSync(live(), 'live content\n');
  fs.writeFileSync(parked(), 'parked content\n');
  applyPaiState(tmp, false);
  assert.equal(fs.readFileSync(live(), 'utf8'), 'live content\n');
  assert.equal(fs.readFileSync(parked(), 'utf8'), 'parked content\n');
});

test('ISC-6: applyPaiState is idempotent; calling twice equals once', () => {
  fs.writeFileSync(live(), 'pai\n');
  applyPaiState(tmp, false);
  applyPaiState(tmp, false);
  assert.equal(fs.existsSync(live()), false);
  assert.equal(fs.existsSync(parked()), true);
  assert.equal(fs.readFileSync(parked(), 'utf8'), 'pai\n');
});

test('ISC-7: full disable → enable round-trip preserves byte-exact content', () => {
  const original = 'multi\nline\nPAI\nbody with unicode ── █ ─ ──\n';
  fs.writeFileSync(live(), original);
  applyPaiState(tmp, false);
  assert.equal(fs.existsSync(live()), false);
  applyPaiState(tmp, true);
  assert.equal(fs.existsSync(parked()), false);
  assert.equal(fs.readFileSync(live(), 'utf8'), original);
});

test('ISC-A1: applyPaiState never deletes; same total file count survives', () => {
  fs.writeFileSync(live(), 'a');
  fs.writeFileSync(path.join(tmp, 'unrelated.txt'), 'b');
  applyPaiState(tmp, false);
  applyPaiState(tmp, true);
  applyPaiState(tmp, false);
  applyPaiState(tmp, true);
  const survivors = fs.readdirSync(tmp).sort();
  assert.deepEqual(survivors, ['CLAUDE.md', 'unrelated.txt']);
});

test('ISC-A2: applyPaiState writes only inside the supplied claudeDir', () => {
  fs.writeFileSync(live(), 'pai\n');
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.includes('husk-pai-')).length;
  applyPaiState(tmp, false);
  applyPaiState(tmp, true);
  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.includes('husk-pai-')).length;
  assert.equal(after, before, 'no new sibling dirs created in tmpdir');
});

test('applyPaiState swallows errors on rename of a directory in place of CLAUDE.md', () => {
  // Edge case: user accidentally created CLAUDE.md as a directory. Rename
  // would fail; we should NOT propagate the error.
  fs.mkdirSync(live());
  assert.doesNotThrow(() => applyPaiState(tmp, false));
});

test('applyPaiState throws on bogus claudeDir input', () => {
  assert.throws(() => applyPaiState('', true), /non-empty string/);
  assert.throws(() => applyPaiState(null, false), /non-empty string/);
});

test('parkedPath returns the .husk-disabled sibling under claudeDir', () => {
  const p = parkedPath('/some/claude');
  assert.equal(p, '/some/claude/' + PARKED_BASENAME);
});

// ─── buildHuskPrompt ──────────────────────────────────────────────────────

test('ISC-8: PAI-off prompt includes the explicit "do NOT emit" override', () => {
  const out = buildHuskPrompt({ agentName: 'Husk', paiEnabled: false, recap: true });
  assert.match(out, /do NOT emit PAI mode banners/);
  assert.match(out, /═══ PAI ═══/);
  assert.doesNotMatch(out, /follow your normal CLAUDE\.md, PAI\/Algorithm/);
});

test('ISC-9: PAI-on prompt names PAI/Algorithm and the TASK/CHANGE/VERIFY structure', () => {
  const out = buildHuskPrompt({ agentName: 'Husk', paiEnabled: true, recap: true });
  assert.match(out, /PAI\/Algorithm/);
  assert.match(out, /TASK\/CHANGE\/VERIFY/);
  assert.doesNotMatch(out, /do NOT emit PAI mode banners/);
});

test('ISC-10: recap=false appends the recap-suppression sentence regardless of PAI', () => {
  const off = buildHuskPrompt({ agentName: 'Husk', paiEnabled: false, recap: false });
  const on = buildHuskPrompt({ agentName: 'Husk', paiEnabled: true, recap: false });
  assert.match(off, /disabled recaps/);
  assert.match(on, /disabled recaps/);
});

test('ISC-10b: recap defaulted (undefined) does NOT append the recap-suppression sentence', () => {
  const out = buildHuskPrompt({ agentName: 'Husk', paiEnabled: true });
  assert.doesNotMatch(out, /disabled recaps/);
});

test('ISC-11: agentName is sanitized to [A-Za-z0-9 _-] and falls back to Husk', () => {
  const malicious = buildHuskPrompt({ agentName: 'Husk<script>alert(1)</script>;rm -rf', paiEnabled: true });
  // Sanitizer keeps letters/digits/space/underscore/hyphen; drops <, >, /, ;, (, ), !
  // The "rm -rf" tail is allowed verbatim because space and hyphen survive.
  assert.match(malicious, /named this agent Huskscriptalert1scriptrm -rf\./);
  assert.doesNotMatch(malicious, /<script>/);

  const empty = buildHuskPrompt({ agentName: '', paiEnabled: true });
  assert.match(empty, /named this agent Husk\./);

  const onlySymbols = buildHuskPrompt({ agentName: '!!!@@@###', paiEnabled: true });
  assert.match(onlySymbols, /named this agent Husk\./);

  const undef = buildHuskPrompt({ paiEnabled: true });
  assert.match(undef, /named this agent Husk\./);
});

test('agentName is capped at 40 characters', () => {
  const long = 'a'.repeat(80);
  const out = buildHuskPrompt({ agentName: long, paiEnabled: true });
  // The cap is 40; the sentence ends with "." not whitespace, so anchor on \.
  assert.match(out, /named this agent a{40}\./);
  assert.doesNotMatch(out, /a{41}/);
});

// ─── renderHuskAgentsBlock ────────────────────────────────────────────────

test('ISC-12: block is bracketed by HUSK-AGENTS markers and lists each picked agent', () => {
  const block = renderHuskAgentsBlock([
    { name: 'example-agent', body: 'You are a senior security engineer.' },
    { name: 'example-auth-agent', body: 'You are an auth specialist.' },
  ]);
  assert.match(block, /^<!-- HUSK-AGENTS:START -->/);
  assert.match(block, /<!-- HUSK-AGENTS:END -->$/);
  assert.match(block, /# Agent: example-agent/);
  assert.match(block, /# Agent: example-auth-agent/);
  assert.match(block, /You are a senior security engineer\./);
});

test('renderHuskAgentsBlock with empty pick list still emits both markers', () => {
  const block = renderHuskAgentsBlock([]);
  assert.match(block, /^<!-- HUSK-AGENTS:START -->/);
  assert.match(block, /<!-- HUSK-AGENTS:END -->$/);
});

test('renderHuskAgentsBlock handles a picked agent with missing body', () => {
  const block = renderHuskAgentsBlock([{ name: 'orphan', body: undefined }]);
  assert.match(block, /# Agent: orphan/);
  // The body section becomes empty rather than printing "undefined".
  assert.doesNotMatch(block, /undefined/);
});

// ─── mergeHuskAgentsBlock ─────────────────────────────────────────────────

test('ISC-13: pre-existing content ABOVE an existing block is preserved', () => {
  const before = '# Project rules\n\nBe nice to AI.\n\n';
  const stale = `${before}${HUSK_AGENTS_START}\n# Agent: stale\n${HUSK_AGENTS_END}\n`;
  const merged = mergeHuskAgentsBlock(stale, [{ name: 'fresh', body: 'fresh body' }]);
  assert.match(merged, /# Project rules/);
  assert.match(merged, /Be nice to AI\./);
  assert.match(merged, /# Agent: fresh/);
  assert.doesNotMatch(merged, /# Agent: stale/);
});

test('ISC-14: pre-existing content BELOW an existing block is preserved', () => {
  const after = '## Footnotes\n\nSome user notes here.\n';
  const stale = `${HUSK_AGENTS_START}\n# Agent: stale\n${HUSK_AGENTS_END}\n\n${after}`;
  const merged = mergeHuskAgentsBlock(stale, [{ name: 'fresh', body: 'fresh body' }]);
  assert.match(merged, /## Footnotes/);
  assert.match(merged, /Some user notes here\./);
});

test('ISC-15: re-installing replaces the block in place, no duplication', () => {
  const once = mergeHuskAgentsBlock('', [{ name: 'a', body: 'first' }]);
  const twice = mergeHuskAgentsBlock(once, [{ name: 'a', body: 'second' }]);
  const startCount = (twice.match(/HUSK-AGENTS:START/g) || []).length;
  const endCount = (twice.match(/HUSK-AGENTS:END/g) || []).length;
  assert.equal(startCount, 1, 'exactly one START marker after re-install');
  assert.equal(endCount, 1, 'exactly one END marker after re-install');
  assert.match(twice, /second/);
  assert.doesNotMatch(twice, /first/);
});

test('ISC-16: merging into a file without markers appends a fresh block', () => {
  const user = '# My copilot rules\n\nPrefer terse answers.\n';
  const merged = mergeHuskAgentsBlock(user, [{ name: 'a', body: 'body' }]);
  assert.match(merged, /# My copilot rules/);
  assert.match(merged, /Prefer terse answers\./);
  assert.match(merged, /HUSK-AGENTS:START/);
  assert.match(merged, /HUSK-AGENTS:END/);
  // The user content must come before the new block, never after.
  const userIdx = merged.indexOf('Prefer terse answers');
  const blockIdx = merged.indexOf('HUSK-AGENTS:START');
  assert.ok(userIdx < blockIdx, 'user content stays above the appended block');
});

test('merge into an empty / missing file produces only the block, ending with a newline', () => {
  const merged = mergeHuskAgentsBlock('', [{ name: 'a', body: 'b' }]);
  assert.match(merged, /^<!-- HUSK-AGENTS:START -->/);
  assert.equal(merged.endsWith('\n'), true);
});

test('merge with malformed markers (END before START) falls back to append', () => {
  // Defensive: someone hand-edited the file and broke marker order.
  const broken = `before\n${HUSK_AGENTS_END}\nmiddle\n${HUSK_AGENTS_START}\nafter\n`;
  const merged = mergeHuskAgentsBlock(broken, [{ name: 'a', body: 'b' }]);
  // Original content is preserved (broken markers and all), block is appended.
  assert.match(merged, /before/);
  assert.match(merged, /middle/);
  assert.match(merged, /after/);
  // The new properly-ordered START+END markers still appear at the bottom.
  const lastStart = merged.lastIndexOf(HUSK_AGENTS_START);
  const lastEnd = merged.lastIndexOf(HUSK_AGENTS_END);
  assert.ok(lastEnd > lastStart, 'new block has START before END at the bottom');
});
