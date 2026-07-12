'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// The rule main.js uses to decide which agent session a chat tab belongs to.
// Kept in step with the copilot branch of sessions:resolveLiveTitle.
//
// A tab launches the CLI, so its session cannot predate it, and the CLI can
// create several session directories for one chat while writing the conversation
// only into the last. A tab bound to one of the empty ones never earns a name.
function pickSession(candidates, startedAt) {
  const inWindow = candidates.filter((x) => !(isFinite(x.startedMs) && x.startedMs < startedAt - 60_000));
  if (!inWindow.length) return null;
  const earliest = (pool) => pool.reduce((a, b) => (!a || b.startedMs < a.startedMs ? b : a), null);
  const startedAfter = inWindow.filter((x) => !isFinite(x.startedMs) || x.startedMs >= startedAt);
  const pool = startedAfter.length ? startedAfter : inWindow;
  return earliest(pool.filter((x) => x.hasContent)) || earliest(pool);
}

const at = (iso) => Date.parse(iso);

// The sessions a single machine actually produced while one chat asked about the
// weather. Copilot made two empty directories before writing the conversation
// into a third, and two earlier chats sit just inside the lookback window.
const REAL_TIMELINE = [
  { id: 'greeting', startedMs: at('2026-07-12T12:49:25Z'), hasContent: true, name: 'Implement Greeting Feature' },
  { id: 'research', startedMs: at('2026-07-12T12:56:01Z'), hasContent: true, name: 'Research Israel Prime Minister' },
  { id: 'empty-1', startedMs: at('2026-07-12T12:56:56Z'), hasContent: false, name: '' },
  { id: 'empty-2', startedMs: at('2026-07-12T12:57:23Z'), hasContent: false, name: '' },
  { id: 'weather', startedMs: at('2026-07-12T12:57:43Z'), hasContent: true, name: 'Fetch Weather Data Tel Aviv' },
];
const TAB_STARTED = at('2026-07-12T12:56:50Z');

test('binds to the session holding the conversation, not an empty one the CLI left behind', () => {
  const picked = pickSession(REAL_TIMELINE, TAB_STARTED);
  assert.equal(picked.id, 'weather');
});

test('does not steal the session of a chat that started before this tab', () => {
  // 'research' began 49s before the tab: inside the lookback window, but it
  // belongs to an earlier chat and must not be claimed.
  const picked = pickSession(REAL_TIMELINE, TAB_STARTED);
  assert.notEqual(picked.id, 'research');
  assert.notEqual(picked.id, 'greeting');
});

test('takes the earliest session started after the tab when several carry content', () => {
  const first = { id: 'first', startedMs: TAB_STARTED + 5_000, hasContent: true, name: 'First' };
  const later = { id: 'later', startedMs: TAB_STARTED + 90_000, hasContent: true, name: 'Later' };
  assert.equal(pickSession([later, first], TAB_STARTED).id, 'first');
});

test('falls back to an empty session when nothing has content yet', () => {
  // Right after launch the tab's own session exists but is still empty. Binding
  // to it is correct; the caller marks the binding provisional and keeps probing.
  const fresh = { id: 'fresh', startedMs: TAB_STARTED + 3_000, hasContent: false, name: '' };
  assert.equal(pickSession([fresh], TAB_STARTED).id, 'fresh');
});

test('an empty session never outranks one with content, whatever the order', () => {
  const empty = { id: 'empty', startedMs: TAB_STARTED + 1_000, hasContent: false, name: '' };
  const real = { id: 'real', startedMs: TAB_STARTED + 60_000, hasContent: true, name: 'Real' };
  assert.equal(pickSession([empty, real], TAB_STARTED).id, 'real');
  assert.equal(pickSession([real, empty], TAB_STARTED).id, 'real');
});

test('sessions older than the lookback window are ignored entirely', () => {
  const ancient = { id: 'ancient', startedMs: TAB_STARTED - 600_000, hasContent: true, name: 'Yesterday' };
  assert.equal(pickSession([ancient], TAB_STARTED), null);
});

test('uses the pre-tab window only when nothing started after the tab', () => {
  // Clock skew: the session looks a few seconds older than the tab. With no other
  // candidate it is still the right answer.
  const skewed = { id: 'skewed', startedMs: TAB_STARTED - 5_000, hasContent: true, name: 'Skewed' };
  assert.equal(pickSession([skewed], TAB_STARTED).id, 'skewed');
});
