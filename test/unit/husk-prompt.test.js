'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  HUSK_AGENTS_START, HUSK_AGENTS_END, buildHuskPrompt, renderHuskAgentsBlock, mergeHuskAgentsBlock,
} = require('../../src/lib/husk-prompt');

// ─── buildHuskPrompt ──────────────────────────────────────────────────────

test('the prompt names the agent and points at no framework', () => {
  const out = buildHuskPrompt({ agentName: 'Atlas' });
  assert.match(out, /named this agent Atlas\./);
  assert.match(out, /respond as Atlas/);
  assert.doesNotMatch(out, /LifeOS|PAI|framework|banner|CHANGE\/VERIFY/i);
});

test('recap=false appends the recap-suppression sentence, including the speech-balloon line', () => {
  const out = buildHuskPrompt({ agentName: 'Husk', recap: false });
  assert.match(out, /disabled recaps/);
  assert.match(out, /"\u{1F5E3}\uFE0F Husk:" summary line/u);
});

test('recap left on, or not given, adds no suppression sentence', () => {
  assert.doesNotMatch(buildHuskPrompt({ agentName: 'Husk', recap: true }), /disabled recaps/);
  assert.doesNotMatch(buildHuskPrompt({ agentName: 'Husk' }), /disabled recaps/);
});

test('agentName is sanitized to [A-Za-z0-9 _-] and falls back to Husk', () => {
  const odd = buildHuskPrompt({ agentName: 'Husk<script>alert(1)</script>;rm -rf' });
  assert.match(odd, /named this agent Huskscriptalert1scriptrm -rf\./);
  assert.doesNotMatch(odd, /<script>/);
  for (const agentName of ['', '!!!@@@###', undefined]) assert.match(buildHuskPrompt({ agentName }), /named this agent Husk\./);
});

test('agentName is capped at 40 characters', () => {
  const out = buildHuskPrompt({ agentName: 'a'.repeat(80) });
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
