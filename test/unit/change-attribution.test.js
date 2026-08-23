'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { attribute } = require('../../src/lib/change-attribution');

const ROOT = '/home/dev/projects/husk';
const NOW = 1787498655000;
const MINUTE = 60 * 1000;

const run = (over) => ({
  runId: 'ap-lq3x9',
  goal: 'make the prefs rows match the pattern',
  endedAt: new Date(NOW - 14 * MINUTE).toISOString(),
  changes: [{ path: 'src/renderer/styles.css', status: 'modified' }],
  ...over,
});

const session = (over) => ({
  sessionId: 's1',
  cwd: ROOT,
  startedAt: NOW - 30 * MINUTE,
  ...over,
});

test('a path a retained run recorded is attributed to that run', () => {
  const claims = attribute({
    entries: [{ rel: 'src/renderer/styles.css', mtimeMs: NOW - MINUTE }],
    runs: [run()],
    sessions: [],
    root: ROOT,
    now: NOW,
  });
  const claim = claims.get('src/renderer/styles.css');
  assert.strictEqual(claim.tier, 'run');
  assert.strictEqual(claim.runId, 'ap-lq3x9');
  assert.strictEqual(claim.goal, 'make the prefs rows match the pattern');
  assert.strictEqual(claim.ambiguous, false);
});

test('a run record is read whether it lists changes, files or plain paths', () => {
  const entries = [{ rel: 'a.js', mtimeMs: NOW }];
  const shapes = [
    run({ changes: [{ path: 'a.js' }] }),
    run({ changes: undefined, files: ['a.js'] }),
    run({ changes: undefined, paths: [{ path: 'a.js' }] }),
  ];
  for (const record of shapes) {
    const claim = attribute({ entries, runs: [record], sessions: [], root: ROOT, now: NOW }).get('a.js');
    assert.strictEqual(claim.tier, 'run', JSON.stringify(Object.keys(record)));
  }
});

test('a path no run named and no session reaches is attributed to nobody', () => {
  const claims = attribute({
    entries: [{ rel: 'src/main.js', mtimeMs: NOW - MINUTE }],
    runs: [run()],
    sessions: [],
    root: ROOT,
    now: NOW,
  });
  assert.deepStrictEqual(claims.get('src/main.js'), {
    tier: 'none',
    runId: null,
    goal: null,
    since: null,
    ambiguous: false,
  });
});

test('a file written after a live session started is attributed to the window, not to an author', () => {
  const claims = attribute({
    entries: [{ rel: 'src/main.js', mtimeMs: NOW - 5 * MINUTE }],
    runs: [],
    sessions: [session()],
    root: ROOT,
    now: NOW,
  });
  const claim = claims.get('src/main.js');
  assert.strictEqual(claim.tier, 'window');
  assert.strictEqual(claim.since, NOW - 30 * MINUTE);
  assert.strictEqual(claim.runId, null);
  assert.strictEqual(claim.goal, null);
  assert.strictEqual(claim.ambiguous, false);
});

test('a file whose mtime predates every session start is attributed to nobody', () => {
  const claims = attribute({
    entries: [{ rel: 'src/main.js', mtimeMs: NOW - 90 * MINUTE }],
    runs: [],
    sessions: [session()],
    root: ROOT,
    now: NOW,
  });
  assert.strictEqual(claims.get('src/main.js').tier, 'none');
});

test('a file written at the very moment a session started is inside the window', () => {
  const claims = attribute({
    entries: [{ rel: 'src/main.js', mtimeMs: NOW - 30 * MINUTE }],
    runs: [],
    sessions: [session()],
    root: ROOT,
    now: NOW,
  });
  assert.strictEqual(claims.get('src/main.js').tier, 'window');
});

test('two overlapping sessions make the window ambiguous and keep the widest one', () => {
  const claims = attribute({
    entries: [{ rel: 'src/main.js', mtimeMs: NOW - MINUTE }],
    runs: [],
    sessions: [session(), session({ sessionId: 's2', startedAt: NOW - 10 * MINUTE })],
    root: ROOT,
    now: NOW,
  });
  const claim = claims.get('src/main.js');
  assert.strictEqual(claim.tier, 'window');
  assert.strictEqual(claim.ambiguous, true);
  assert.strictEqual(claim.since, NOW - 30 * MINUTE);
});

// The band reads this timestamp out as the earliest session the change could
// belong to, so the module owes it the earliest qualifying start and never a
// later one that would drop a candidate session out of the window.
test('an ambiguous window reports the earliest session it could belong to', () => {
  const claims = attribute({
    entries: [{ rel: 'src/main.js', mtimeMs: NOW - MINUTE }],
    runs: [],
    sessions: [
      session({ sessionId: 's1', startedAt: NOW - 6 * 60 * MINUTE }),
      session({ sessionId: 's2', startedAt: NOW - 60 * MINUTE }),
      session({ sessionId: 's3', startedAt: NOW - 2 * MINUTE }),
      session({ sessionId: 's4', startedAt: NOW - 20 * 60 * MINUTE, cwd: '/home/dev/projects/other' }),
    ],
    root: ROOT,
    now: NOW,
  });
  const claim = claims.get('src/main.js');
  assert.strictEqual(claim.ambiguous, true);
  assert.strictEqual(claim.since, NOW - 6 * 60 * MINUTE);
  assert.strictEqual(claim.runId, null);
  assert.strictEqual(claim.goal, null);
});

// A session that started after the file was written could not have written it,
// so it counts neither toward the ambiguity nor toward the start that is shown.
test('only the sessions a change could belong to shape the window', () => {
  const claims = attribute({
    entries: [{ rel: 'src/main.js', mtimeMs: NOW - 30 * MINUTE }],
    runs: [],
    sessions: [
      session({ sessionId: 's1', startedAt: NOW - 5 * 60 * MINUTE }),
      session({ sessionId: 's2', startedAt: NOW - 10 * MINUTE }),
    ],
    root: ROOT,
    now: NOW,
  });
  const claim = claims.get('src/main.js');
  assert.strictEqual(claim.tier, 'window');
  assert.strictEqual(claim.ambiguous, false);
  assert.strictEqual(claim.since, NOW - 5 * 60 * MINUTE);
});

test('two runs naming one path make the run claim ambiguous', () => {
  const claims = attribute({
    entries: [{ rel: 'a.js', mtimeMs: NOW }],
    runs: [run({ changes: [{ path: 'a.js' }] }), run({ runId: 'ap-m02ka', changes: [{ path: 'a.js' }] })],
    sessions: [],
    root: ROOT,
    now: NOW,
  });
  assert.strictEqual(claims.get('a.js').ambiguous, true);
});

test('a session working outside the repository contributes nothing', () => {
  const outside = [
    session({ cwd: '/home/dev/projects/other' }),
    session({ cwd: '/home/dev/projects/husk-notes' }),
    session({ cwd: ROOT + '/src' }),
    session({ cwd: null }),
    session({ cwd: '' }),
  ];
  for (const s of outside) {
    const claims = attribute({
      entries: [{ rel: 'src/main.js', mtimeMs: NOW }],
      runs: [],
      sessions: [s],
      root: ROOT,
      now: NOW,
    });
    assert.strictEqual(claims.get('src/main.js').tier, 'none', String(s.cwd));
  }
});

test('a session whose directory holds the repository does reach it', () => {
  for (const cwd of [ROOT, ROOT + '/', '/home/dev/projects', '/home/dev']) {
    const claims = attribute({
      entries: [{ rel: 'src/main.js', mtimeMs: NOW }],
      runs: [],
      sessions: [session({ cwd })],
      root: ROOT,
      now: NOW,
    });
    assert.strictEqual(claims.get('src/main.js').tier, 'window', cwd);
  }
});

test('a deleted path with no readable mtime is attributed to nobody', () => {
  for (const mtimeMs of [null, undefined, NaN, Infinity, '1787498655000', {}]) {
    const claims = attribute({
      entries: [{ rel: 'src/gone.js', mtimeMs }],
      runs: [],
      sessions: [session()],
      root: ROOT,
      now: NOW,
    });
    assert.strictEqual(claims.get('src/gone.js').tier, 'none', String(mtimeMs));
  }
});

test('without a repository root no session can be shown to reach the files', () => {
  const claims = attribute({
    entries: [{ rel: 'src/main.js', mtimeMs: NOW }],
    runs: [],
    sessions: [session()],
    now: NOW,
  });
  assert.strictEqual(claims.get('src/main.js').tier, 'none');
});

// The table below is the module's whole reason for existing: whatever is fed
// in, an authorship claim may only come out of a run record that named the
// exact path.
const ADVERSARIAL = [
  ['nothing at all', {}],
  ['no entries', { entries: [], runs: [run()], sessions: [session()], root: ROOT, now: NOW }],
  ['an entry with no path', { entries: [{ mtimeMs: NOW }], runs: [run()], sessions: [session()], root: ROOT, now: NOW }],
  ['entries that are not objects', { entries: [null, 'a.js', 7, []], runs: [run()], sessions: [session()], root: ROOT, now: NOW }],
  ['a run with no id', { entries: [{ rel: 'a.js', mtimeMs: NOW }], runs: [run({ runId: null, changes: [{ path: 'a.js' }] })], sessions: [session()], root: ROOT, now: NOW }],
  ['a run naming another path', { entries: [{ rel: 'a.js', mtimeMs: NOW }], runs: [run({ changes: [{ path: 'b.js' }] })], sessions: [session()], root: ROOT, now: NOW }],
  ['a run naming a prefix of the path', { entries: [{ rel: 'src/a.js', mtimeMs: NOW }], runs: [run({ changes: [{ path: 'src' }] })], sessions: [session()], root: ROOT, now: NOW }],
  ['a run naming the path with a leading slash', { entries: [{ rel: 'a.js', mtimeMs: NOW }], runs: [run({ changes: [{ path: '/a.js' }] })], sessions: [session()], root: ROOT, now: NOW }],
  ['runs that are not objects', { entries: [{ rel: 'a.js', mtimeMs: NOW }], runs: [null, 'ap-1', 7], sessions: [session()], root: ROOT, now: NOW }],
  ['runs that are not a list', { entries: [{ rel: 'a.js', mtimeMs: NOW }], runs: 'ap-lq3x9', sessions: [session()], root: ROOT, now: NOW }],
  ['a session carrying a run id', { entries: [{ rel: 'a.js', mtimeMs: NOW }], runs: [], sessions: [session({ runId: 'ap-lq3x9', goal: 'do the thing' })], root: ROOT, now: NOW }],
  ['a session started in the future', { entries: [{ rel: 'a.js', mtimeMs: NOW }], runs: [], sessions: [session({ startedAt: NOW + MINUTE })], root: ROOT, now: NOW }],
  ['a session with no start time', { entries: [{ rel: 'a.js', mtimeMs: NOW }], runs: [], sessions: [session({ startedAt: null })], root: ROOT, now: NOW }],
  ['sessions that are not a list', { entries: [{ rel: 'a.js', mtimeMs: NOW }], runs: [], sessions: { cwd: ROOT, startedAt: 0 }, root: ROOT, now: NOW }],
  ['a root that is not a string', { entries: [{ rel: 'a.js', mtimeMs: NOW }], runs: [], sessions: [session()], root: 7, now: NOW }],
  ['a now that is nonsense', { entries: [{ rel: 'a.js', mtimeMs: NOW }], runs: [], sessions: [session()], root: ROOT, now: 'yesterday' }],
  ['an mtime in the far future', { entries: [{ rel: 'a.js', mtimeMs: NOW * 4 }], runs: [], sessions: [session()], root: ROOT, now: NOW }],
  ['a whole input that is a string', 'nonsense'],
  ['a whole input that is null', null],
];

test('no input produces an authorship claim outside tier run', () => {
  for (const [why, input] of ADVERSARIAL) {
    const claims = attribute(input);
    assert.ok(claims instanceof Map, why);
    for (const [rel, claim] of claims) {
      assert.ok(['run', 'window', 'none'].includes(claim.tier), why + ': ' + rel);
      assert.strictEqual(typeof claim.ambiguous, 'boolean', why + ': ' + rel);
      if (claim.tier === 'run') {
        // A run claim is only allowed when a run record named this exact path.
        const runs = (input && Array.isArray(input.runs)) ? input.runs : [];
        const named = runs.some((r) => Array.isArray(r && r.changes) && r.changes.some((c) => c && c.path === rel));
        assert.ok(named, why + ': ' + rel);
      } else {
        assert.strictEqual(claim.runId, null, why + ': ' + rel);
        assert.strictEqual(claim.goal, null, why + ': ' + rel);
      }
    }
  }
});

test('malformed input answers an empty map rather than throwing', () => {
  for (const value of [null, undefined, 0, 42, 'x', [], true]) {
    const claims = attribute(value);
    assert.ok(claims instanceof Map, String(typeof value));
    assert.strictEqual(claims.size, 0, String(typeof value));
  }
});
