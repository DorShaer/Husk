'use strict';

// Tests for the derived-state helpers behind the Projects board. Pure
// functions in, groups out; no fs, no git binary, no Electron.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ACTIVE_WINDOW_MS,
  parseGitStatus,
  groupBoard,
} = require('../../src/lib/workspace-state');

// ─── parseGitStatus ───────────────────────────────────────────────────────

test('clean repo with upstream: branch, ahead and behind, zero dirty', () => {
  const s = parseGitStatus('## main...origin/main [ahead 2, behind 1]\n');
  assert.deepEqual(s, { branch: 'main', ahead: 2, behind: 1, dirty: 0, conflicts: 0 });
});

test('branch without upstream parses bare', () => {
  const s = parseGitStatus('## feat/workspaces\n M src/main.js\n');
  assert.equal(s.branch, 'feat/workspaces');
  assert.equal(s.ahead, 0);
  assert.equal(s.dirty, 1);
});

test('upstream gone reads as zero ahead and behind', () => {
  const s = parseGitStatus('## old-branch...origin/old-branch [gone]\n');
  assert.equal(s.branch, 'old-branch');
  assert.equal(s.ahead, 0);
  assert.equal(s.behind, 0);
});

test('fresh repo with no commits yet still names the branch', () => {
  const s = parseGitStatus('## No commits yet on main\n?? a.txt\n');
  assert.equal(s.branch, 'main');
  assert.equal(s.dirty, 1);
});

test('detached HEAD is labeled, not mistaken for a branch name', () => {
  const s = parseGitStatus('## HEAD (no branch)\n');
  assert.equal(s.branch, 'detached');
});

test('dirty counts changed, added, untracked; ignored is excluded', () => {
  const s = parseGitStatus('## main\n M a.js\nA  b.js\n?? c.js\n!! d.log\n');
  assert.equal(s.dirty, 3);
  assert.equal(s.conflicts, 0);
});

test('merge conflicts are counted separately and included in dirty', () => {
  const s = parseGitStatus('## main\nUU merge.js\n M other.js\n');
  assert.equal(s.dirty, 2);
  assert.equal(s.conflicts, 1);
});

test('empty and garbage input degrade to a null state', () => {
  assert.deepEqual(parseGitStatus(''), { branch: null, ahead: 0, behind: 0, dirty: 0, conflicts: 0 });
  assert.deepEqual(parseGitStatus(null), { branch: null, ahead: 0, behind: 0, dirty: 0, conflicts: 0 });
});

// ─── groupBoard ───────────────────────────────────────────────────────────

const NOW = 1_800_000_000_000;
const proj = (id, over = {}) => ({ id, name: id, path: '/tmp/' + id, ...over });
const avail = (over = {}) => ({ available: true, dirty: 0, conflicts: 0, live: false, retainedCount: 0, lastSessionMs: null, ...over });

test('retained autopilot runs put a project in Needs you', () => {
  const g = groupBoard([proj('a')], { a: avail({ retainedCount: 2 }) }, NOW);
  assert.deepEqual(g.needsYou, ['a']);
});

test('merge conflicts put a project in Needs you', () => {
  const g = groupBoard([proj('a')], { a: avail({ dirty: 3, conflicts: 1 }) }, NOW);
  assert.deepEqual(g.needsYou, ['a']);
  assert.deepEqual(g.active, []);
});

test('a live agent, a dirty tree, or a recent session all mean Active', () => {
  const projects = [proj('live'), proj('dirty'), proj('recent')];
  const states = {
    live: avail({ live: true }),
    dirty: avail({ dirty: 1 }),
    recent: avail({ lastSessionMs: NOW - 60_000 }),
  };
  const g = groupBoard(projects, states, NOW);
  assert.deepEqual([...g.active].sort(), ['dirty', 'live', 'recent']);
});

test('clean and stale drops to Quiet once outside the activity window', () => {
  const g = groupBoard(
    [proj('old')],
    { old: avail({ lastSessionMs: NOW - ACTIVE_WINDOW_MS - 1 }) },
    NOW,
  );
  assert.deepEqual(g.quiet, ['old']);
});

test('a project whose folder is gone lands in Quiet, never in Needs you', () => {
  const g = groupBoard(
    [proj('gone')],
    { gone: { available: false, retainedCount: 5 } },
    NOW,
  );
  assert.deepEqual(g.quiet, ['gone']);
  assert.deepEqual(g.needsYou, []);
});

test('within a group, live sorts first, then recency, then name', () => {
  const projects = [
    proj('b', { lastUsedAt: new Date(NOW - 3_600_000).toISOString() }),
    proj('a', { lastUsedAt: new Date(NOW - 3_600_000).toISOString() }),
    proj('newest', { lastUsedAt: new Date(NOW - 60_000).toISOString() }),
    proj('alive'),
  ];
  const states = {
    a: avail(), b: avail(), newest: avail(), alive: avail({ live: true }),
  };
  const g = groupBoard(projects, states, NOW);
  assert.deepEqual(g.active, ['alive', 'newest', 'a', 'b']);
});

test('lastUsedAt counts as activity even with no session on disk', () => {
  const g = groupBoard(
    [proj('used', { lastUsedAt: new Date(NOW - 1000).toISOString() })],
    { used: avail() },
    NOW,
  );
  assert.deepEqual(g.active, ['used']);
});

test('a project with no state entry at all is Quiet, not a crash', () => {
  const g = groupBoard([proj('x')], {}, NOW);
  assert.deepEqual(g.quiet, ['x']);
});
