'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const sv = require('../../src/lib/session-view');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// A fixed local noon, so day arithmetic never straddles a boundary by accident.
const NOW = new Date(2026, 7, 16, 12, 0, 0).getTime();

function mk(id, ago, extra = {}) {
  return {
    id,
    title: `session ${id}`,
    projectPath: '/code/husk',
    originalCwd: '/code/husk',
    path: `/projects/${id}.jsonl`,
    mtime: NOW - ago,
    startedMs: NOW - ago - HOUR,
    sizeBytes: 1024,
    named: false,
    firstMessage: '',
    prdSlug: '',
    prdPath: '',
    prdPhase: '',
    ...extra,
  };
}

const ctx = (over = {}) => ({
  now: NOW,
  currentCwd: '/code/husk',
  groupBy: 'project',
  chips: {},
  olderOpen: false,
  bySession: new Map(),
  byParent: new Map(),
  ...over,
});

// ─── Day arithmetic ─────────────────────────────────────────────────────────

test('dayDiff counts calendar days, not elapsed 24h blocks', () => {
  const lateYesterday = new Date(2026, 7, 15, 23, 30, 0).getTime();
  const earlyToday = new Date(2026, 7, 16, 0, 30, 0).getTime();
  // One hour apart, but different calendar days.
  assert.equal(sv.dayDiff(lateYesterday, NOW), 1);
  assert.equal(sv.dayDiff(earlyToday, NOW), 0);
});

test('isOlder keeps today plus the six previous days in the roster', () => {
  assert.equal(sv.isOlder(mk('a', 6 * DAY), NOW), false);
  assert.equal(sv.isOlder(mk('b', 7 * DAY), NOW), true);
});

test('isOlder keeps an undated session in the roster', () => {
  assert.equal(sv.isOlder(mk('a', 0, { mtime: 0 }), NOW), false);
});

// ─── Paths ──────────────────────────────────────────────────────────────────

test('sessionCwd prefers the recorded cwd over the decoded project path', () => {
  assert.equal(sv.sessionCwd({ originalCwd: '/real/path', projectPath: '/guess' }), '/real/path');
  assert.equal(sv.sessionCwd({ originalCwd: '', projectPath: '/guess' }), '/guess');
});

test('normPath strips trailing slashes so two spellings of one directory match', () => {
  assert.equal(sv.normPath('/code/husk/'), '/code/husk');
  assert.equal(sv.inCurrentProject(mk('a', 0), '/code/husk/'), true);
});

test('inCurrentProject is false when there is no current directory', () => {
  assert.equal(sv.inCurrentProject(mk('a', 0), ''), false);
});

// ─── Liveness ───────────────────────────────────────────────────────────────

function agentCtx(agents) {
  const bySession = new Map();
  const byParent = new Map();
  for (const a of agents) {
    bySession.set(a.sessionId, a);
    if (!a.parentSessionId) continue;
    if (!byParent.has(a.parentSessionId)) byParent.set(a.parentSessionId, []);
    byParent.get(a.parentSessionId).push(a);
  }
  return { bySession, byParent };
}

test('signal: a blocked child outranks a running one', () => {
  const c = agentCtx([
    { sessionId: 'k1', parentSessionId: 'p', running: true, state: 'working', detail: 'busy', hasTranscript: true },
    { sessionId: 'k2', parentSessionId: 'p', running: true, state: 'blocked', needs: 'Approve the push', detail: 'waiting', hasTranscript: true },
  ]);
  const sig = sv.signal(mk('p', MIN), c);
  assert.equal(sig.kind, 'blocked');
  assert.equal(sig.tok, '1 needs you');
  // The question it is stuck on beats the generic activity line.
  assert.equal(sig.cont, 'Approve the push');
});

test('signal: running children are counted without the blocked ones', () => {
  const c = agentCtx([
    { sessionId: 'k1', parentSessionId: 'p', running: true, state: 'working', detail: 'one', hasTranscript: true },
    { sessionId: 'k2', parentSessionId: 'p', running: true, state: 'working', detail: 'two', hasTranscript: true },
  ]);
  const sig = sv.signal(mk('p', MIN), c);
  assert.equal(sig.kind, 'running');
  assert.equal(sig.tok, '2 working');
});

test('signal: a held session with no live agent reads as held', () => {
  const c = agentCtx([{ sessionId: 'p', running: false, state: 'done', held: true, name: 'the agent', hasTranscript: true }]);
  const sig = sv.signal(mk('p', MIN), c);
  assert.equal(sig.kind, 'held');
});

test('signal: nothing running returns null', () => {
  assert.equal(sv.signal(mk('p', MIN), agentCtx([])), null);
});

// ─── Scent ──────────────────────────────────────────────────────────────────

test('scent: an unnamed session never repeats its title as an excerpt', () => {
  const s = mk('a', MIN, { named: false, title: 'fix the release', firstMessage: 'fix the release' });
  assert.equal(sv.scent(s, null), '');
});

test('scent: a named session surfaces the opening prompt', () => {
  const s = mk('a', MIN, { named: true, title: 'Release pipeline repair', firstMessage: 'the last three tags shipped empty' });
  assert.equal(sv.scent(s, null), 'the last three tags shipped empty');
});

test('scent: a named session whose prompt restates the title stays quiet', () => {
  const s = mk('a', MIN, { named: true, title: 'Release pipeline repair', firstMessage: 'Release  pipeline   REPAIR and then some' });
  assert.equal(sv.scent(s, null), '');
});

test('scent: a work item slug is not prose and earns no line', () => {
  // A finished session would otherwise be as tall as a live one to show a raw
  // identifier, which puts the density gradient on the wrong rows.
  const s = mk('a', MIN, { prdSlug: 'ship-it' });
  assert.equal(sv.scent(s, null), '');
});

test('scent: a live signal outranks every excerpt', () => {
  const s = mk('a', MIN, { named: true, firstMessage: 'an excerpt' });
  assert.equal(sv.scent(s, { kind: 'running', tok: 'working', cont: 'editing main.js' }), 'editing main.js');
});

// ─── Filtering ──────────────────────────────────────────────────────────────

test('filterSessions: the project chip scopes to the current directory', () => {
  const list = [mk('a', MIN), mk('b', MIN, { projectPath: '/code/other', originalCwd: '/code/other' })];
  const { rows } = sv.filterSessions(list, ctx({ chips: { project: true } }));
  assert.deepEqual(rows.map((s) => s.id), ['a']);
});

test('filterSessions: an agent is hidden while its parent is in view', () => {
  const c = agentCtx([{ sessionId: 'kid', parentSessionId: 'parent', running: true, state: 'working', hasTranscript: true }]);
  const list = [mk('parent', MIN), mk('kid', MIN)];
  const { rows } = sv.filterSessions(list, ctx(c));
  assert.deepEqual(rows.map((s) => s.id), ['parent']);
});

test('filterSessions: an agent stands alone once its parent is filtered out', () => {
  const c = agentCtx([{ sessionId: 'kid', parentSessionId: 'parent', running: true, state: 'working', hasTranscript: true }]);
  const list = [mk('parent', MIN, { projectPath: '/code/other', originalCwd: '/code/other' }), mk('kid', MIN)];
  const { rows } = sv.filterSessions(list, ctx({ ...c, chips: { project: true } }));
  assert.deepEqual(rows.map((s) => s.id), ['kid']);
});

test('filterSessions: search falls back to substring across the machine fields', () => {
  const list = [mk('a', MIN, { title: 'nothing alike', prdSlug: 'widget-run' })];
  const { rows, flat } = sv.filterSessions(list, ctx({ query: 'widget' }));
  assert.equal(flat, true);
  assert.deepEqual(rows.map((s) => s.id), ['a']);
});

test('filterSessions: a title match outranks a substring match', () => {
  const list = [
    mk('sub', 2 * MIN, { title: 'unrelated', firstMessage: 'mentions release somewhere' }),
    mk('title', MIN, { title: 'release the build' }),
  ];
  const fuzzyMatch = (q, t) => (String(t).toLowerCase().includes(String(q).toLowerCase()) ? { score: 50, positions: [0] } : null);
  const { rows, hits } = sv.filterSessions(list, ctx({ query: 'release', fuzzyMatch }));
  assert.equal(rows[0].id, 'title');
  assert.ok(hits.has('title'));
  assert.equal(hits.has('sub'), false);
});

test('filterSessions: an empty query keeps grouping on', () => {
  const { flat } = sv.filterSessions([mk('a', MIN)], ctx({ query: '   ' }));
  assert.equal(flat, false);
});

// ─── Threading ──────────────────────────────────────────────────────────────

test('collapseThreads: repeated runs of one task collapse to a counted head', () => {
  const list = [mk('a', MIN, { title: 'Same task' }), mk('b', 2 * MIN, { title: 'same TASK' }), mk('c', 3 * MIN, { title: 'Other' })];
  const entries = sv.collapseThreads(list, {});
  assert.equal(entries.length, 2);
  assert.equal(entries[0].runs, 2);
  assert.equal(entries[0].s.id, 'a');
  assert.deepEqual(entries[0].sibs.map((s) => s.id), ['b']);
});

test('collapseThreads: the same title in another project is a different thread', () => {
  const list = [
    mk('a', MIN, { title: 'Same task' }),
    mk('b', 2 * MIN, { title: 'Same task', projectPath: '/code/other', originalCwd: '/code/other' }),
  ];
  assert.equal(sv.collapseThreads(list, {}).length, 2);
});

test('collapseThreads: one title under two recorded directories stays two threads', () => {
  // Threading buckets on the same directory grouping does, so a head and its
  // siblings cannot end up in different groups.
  const a = mk('a', MIN, { title: 'ship it', projectPath: '/code/husk', originalCwd: '/code/husk' });
  const b = mk('b', 2 * MIN, { title: 'ship it', projectPath: '/code/husk', originalCwd: '/code/husk/site' });
  assert.equal(sv.collapseThreads([a, b], {}).length, 2);
});

test('threadKey: a path and title split cannot collide with another split', () => {
  const a = mk('a', MIN, { title: 'c d', projectPath: '/a/b', originalCwd: '/a/b' });
  const b = mk('b', MIN, { title: 'd', projectPath: '/a/b c', originalCwd: '/a/b c' });
  assert.notEqual(sv.threadKey(a), sv.threadKey(b));
});

test('collapseThreads: untitled sessions never thread together', () => {
  const list = [mk('a', MIN, { title: '(empty)' }), mk('b', 2 * MIN, { title: '(empty)' })];
  assert.equal(sv.collapseThreads(list, {}).length, 2);
});

test('collapseThreads: select mode gives every session its own row', () => {
  const list = [mk('a', MIN, { title: 'Same task' }), mk('b', 2 * MIN, { title: 'Same task' })];
  assert.equal(sv.collapseThreads(list, { picking: true }).length, 2);
});

// ─── Grouping ───────────────────────────────────────────────────────────────

test('groupSessions: the current project sorts first even when it is stale', () => {
  const list = [
    mk('fresh', MIN, { projectPath: '/code/other', originalCwd: '/code/other' }),
    mk('stale', 5 * HOUR),
  ];
  const { groups } = sv.buildView(list, ctx());
  assert.equal(groups[0].id, 'p:/code/husk');
  assert.equal(groups[0].note, 'this project');
  assert.equal(groups[1].id, 'p:/code/other');
});

test('groupSessions: an unknown project sorts last', () => {
  const list = [
    mk('unknown', MIN, { projectPath: '', originalCwd: '' }),
    mk('other', 5 * HOUR, { projectPath: '/code/other', originalCwd: '/code/other' }),
  ];
  const { groups } = sv.buildView(list, ctx({ currentCwd: '' }));
  assert.equal(groups[groups.length - 1].name, 'Unknown project');
});

test('groupSessions: the current project renders empty rather than vanishing', () => {
  const list = [mk('other', MIN, { projectPath: '/code/other', originalCwd: '/code/other' })];
  const { groups } = sv.buildView(list, ctx());
  assert.equal(groups[0].id, 'p:/code/husk');
  assert.equal(groups[0].rows.length, 0);
  assert.equal(groups[0].ghost, true);
});

test('groupSessions: cold sessions leave the roster and are counted', () => {
  const list = [mk('hot', MIN), mk('cold', 9 * DAY)];
  const { groups, olderCount } = sv.buildView(list, ctx());
  assert.equal(olderCount, 1);
  assert.equal(groups.reduce((n, g) => n + g.rows.length, 0), 1);
});

test('groupSessions: opening the drawer appends the cold groups', () => {
  const list = [mk('hot', MIN), mk('cold', 9 * DAY)];
  const { groups } = sv.buildView(list, ctx({ olderOpen: true }));
  const older = groups.filter((g) => g.older);
  assert.equal(older.length, 1);
  assert.equal(older[0].rows.length, 1);
});

test('olderCount counts sessions, not rows, so it can be subtracted from the total', () => {
  // A cold thread of three runs is one row standing for three sessions. Counting
  // rows here would make the roster claim to show sessions it has parked.
  const list = [
    mk('hot', MIN, { title: 'Hot task' }),
    mk('c1', 9 * DAY, { title: 'Repeated task' }),
    mk('c2', 10 * DAY, { title: 'Repeated task' }),
    mk('c3', 11 * DAY, { title: 'Repeated task' }),
  ];
  const view = sv.buildView(list, ctx());
  assert.equal(view.total, 4);
  assert.equal(view.shown, 4);
  assert.equal(view.olderCount, 3);
  // What the count line prints, and what is actually on screen.
  const visibleRows = view.groups.reduce((n, g) => n + g.rows.length, 0);
  assert.equal(view.shown - view.olderCount, 1);
  assert.equal(visibleRows, 1);
});

test('groupSessions: an archive group repeating a live project says so', () => {
  // Both halves of one project would otherwise render the same header twice.
  const list = [mk('hot', MIN), mk('cold', 9 * DAY)];
  const { groups } = sv.buildView(list, ctx({ olderOpen: true }));
  const hot = groups.find((g) => !g.older);
  const older = groups.find((g) => g.older);
  assert.equal(hot.name, older.name);
  assert.equal(older.note, 'older');
  assert.notEqual(hot.id, older.id);
});

test('groupSessions: day grouping labels today and yesterday by name', () => {
  const list = [mk('a', MIN), mk('b', DAY), mk('c', 3 * DAY)];
  const { groups } = sv.buildView(list, ctx({ groupBy: 'day' }));
  assert.equal(groups[0].name, 'Today');
  assert.equal(groups[1].name, 'Yesterday');
  assert.notEqual(groups[2].name, 'Yesterday');
});

test('groupSessions: searching collapses grouping into one results band', () => {
  const list = [mk('a', MIN), mk('b', MIN, { projectPath: '/code/other', originalCwd: '/code/other' })];
  const { groups, flat } = sv.buildView(list, ctx({ query: 'session' }));
  assert.equal(flat, true);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, 'results');
});

test('groupSessions: row order inside a group is total and deterministic', () => {
  const same = NOW - MIN;
  const list = [
    { ...mk('b', MIN), mtime: same, sizeBytes: 10 },
    { ...mk('a', MIN), mtime: same, sizeBytes: 10 },
    { ...mk('c', MIN), mtime: same, sizeBytes: 99 },
  ];
  const { groups } = sv.buildView(list, ctx());
  // Size breaks the mtime tie, then id breaks the size tie.
  assert.deepEqual(groups[0].rows.map((e) => e.s.id), ['c', 'a', 'b']);
});

// ─── Labels ─────────────────────────────────────────────────────────────────

test('formatWhen floors rather than rounding', () => {
  assert.equal(sv.formatWhen(NOW - 59 * MIN, NOW).label, '59m');
  // 90 minutes ago is still today, so it reads as a clock time, never "2h".
  assert.notEqual(sv.formatWhen(NOW - 90 * MIN, NOW).label, '2h');
});

test('formatWhen always carries the absolute timestamp as a title', () => {
  const { title } = sv.formatWhen(NOW - MIN, NOW);
  assert.equal(title, new Date(NOW - MIN).toLocaleString());
});

test('formatWhen inside the week names the weekday without a clock', () => {
  // The clock would be the widest label the time column ever holds, and a label
  // wider than its track overflows into the title beside it.
  const label = sv.formatWhen(NOW - 3 * DAY, NOW).label;
  assert.match(label, /^[^\d]+$/);
  assert.ok(label.length <= 4, `weekday label was "${label}"`);
});

test('formatWhen stays inside the width the time column reserves', () => {
  // Every branch of the formatter, measured in characters. 10 is what a 64px
  // track holds at the row's mono size.
  const cases = [30 * 1000, 5 * MIN, 3 * HOUR, 3 * DAY, 20 * DAY, 400 * DAY];
  for (const ago of cases) {
    const { label } = sv.formatWhen(NOW - ago, NOW);
    assert.ok(label.length <= 10, `"${label}" is too wide for the time column`);
  }
});

test('formatWhen never renders a blank or NaN for a missing date', () => {
  assert.equal(sv.formatWhen(0, NOW).label, 'no date');
});

test('formatDuration floors and refuses impossible spans', () => {
  assert.equal(sv.formatDuration(NOW - 90 * MIN, NOW), '1h 30m');
  assert.equal(sv.formatDuration(NOW - 30 * 1000, NOW), 'under a minute');
  assert.equal(sv.formatDuration(NOW, NOW - MIN), '');
  assert.equal(sv.formatDuration(0, NOW), '');
});

test('formatSize matches the units the page has always used', () => {
  assert.equal(sv.formatSize(512), '512 B');
  assert.equal(sv.formatSize(2048), '2 KB');
  assert.equal(sv.formatSize(2 * 1024 * 1024), '2.0 MB');
});

test('isDeletable only accepts the transcripts the main process will remove', () => {
  assert.equal(sv.isDeletable({ path: '/projects/a.jsonl' }), true);
  assert.equal(sv.isDeletable({ path: '/state/a.json' }), false);
  assert.equal(sv.isDeletable({}), false);
});

// ─── Whole pipeline ─────────────────────────────────────────────────────────

test('buildView reports how many sessions exist and how many survived the filter', () => {
  const list = [mk('a', MIN), mk('b', MIN, { projectPath: '/code/other', originalCwd: '/code/other' })];
  const view = sv.buildView(list, ctx({ chips: { project: true } }));
  assert.equal(view.total, 2);
  assert.equal(view.shown, 1);
});

test('buildView survives an empty list without inventing groups', () => {
  const view = sv.buildView([], ctx({ currentCwd: '' }));
  assert.deepEqual(view.groups, []);
  assert.equal(view.olderCount, 0);
});

test('a short query must appear in the title, not merely be a subsequence', () => {
  // "Tidy up chores" has a t before an h and no "th" in it, so a bare
  // subsequence test at this length would match it along with everything else.
  const list = [
    mk('has', MIN, { title: 'The release pipeline' }),
    mk('sub', MIN, { title: 'Tidy up chores' }),
  ];
  const { fuzzyMatch } = require('../../src/lib/fuzzy');
  assert.notEqual(fuzzyMatch('th', 'Tidy up chores'), null, 'fixture must be a subsequence match');
  const { rows } = sv.filterSessions(list, ctx({ query: 'th', fuzzyMatch }));
  assert.deepEqual(rows.map((r) => r.id), ['has']);
});

test('a long query keeps full subsequence matching', () => {
  const list = [mk('a', MIN, { title: 'Rebuild the sessions page' })];
  const fuzzyMatch = require('../../src/lib/fuzzy').fuzzyMatch;
  // Not a substring, but a subsequence: r-e-b-s-e-s.
  const { rows } = sv.filterSessions(list, ctx({ query: 'rebses', fuzzyMatch }));
  assert.equal(rows.length, 1);
});
