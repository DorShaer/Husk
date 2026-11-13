'use strict';

const test = require('node:test');
const assert = require('node:assert');
const T = require('../../src/lib/turn-changes');
const E = require('../../src/lib/chat-events');
const G = require('../../src/lib/gh-cli');

const status = (mtimes, unstaged = [], staged = []) => ({ mtimes, numstat: { staged, unstaged } });
const entry = (path, s = 'modified', over = {}) => ({ path, status: s, staged: false, unstaged: true, ...over });

test('a file already dirty and untouched during the turn is not listed', () => {
  const before = T.snapshot(status({ 'a.js': 10 }, [{ path: 'a.js', adds: 2, dels: 1 }]), [entry('a.js')]);
  const after = T.snapshot(status({ 'a.js': 10 }, [{ path: 'a.js', adds: 2, dels: 1 }]), [entry('a.js')]);
  assert.deepStrictEqual(T.changedBetween(before, after), { files: [], adds: 0, dels: 0 });
});

test('a new path, and a dirty path written again, are both listed with their counts', () => {
  const before = T.snapshot(status({ 'a.js': 10 }, [{ path: 'a.js', adds: 2, dels: 1 }]), [entry('a.js')]);
  const after = T.snapshot(
    status({ 'a.js': 20, 'b.js': 20 }, [{ path: 'a.js', adds: 5, dels: 1 }]),
    [entry('a.js'), entry('b.js', 'untracked')],
  );
  const d = T.changedBetween(before, after);
  assert.deepStrictEqual(d.files.map((f) => f.path), ['a.js', 'b.js']);
  assert.strictEqual(d.adds, 5);
  assert.strictEqual(d.dels, 1);
  assert.strictEqual(d.files[1].status, 'untracked');
});

test('a path that left the dirty set is not listed, and staged plus unstaged counts sum', () => {
  const before = T.snapshot(status({ 'gone.js': 1 }), [entry('gone.js')]);
  const after = T.snapshot(
    status({ 'both.js': 2 }, [{ path: 'both.js', adds: 1, dels: 0 }], [{ path: 'both.js', adds: 3, dels: 2 }]),
    [entry('both.js', 'modified', { staged: true })],
  );
  const d = T.changedBetween(before, after);
  assert.deepStrictEqual(d.files, [{ path: 'both.js', status: 'modified', staged: true, unstaged: true, adds: 4, dels: 2 }]);
});

test('malformed input reads as nothing changed', () => {
  assert.deepStrictEqual(T.changedBetween(null, T.snapshot(null, null)), { files: [], adds: 0, dels: 0 });
});

test('a legal path named __proto__ stays an ordinary file row', () => {
  const before = T.snapshot(status({}), []);
  const mtimes = Object.create(null);
  mtimes['__proto__'] = 7;
  const after = T.snapshot(status(mtimes, [{ path: '__proto__', adds: 1, dels: 0 }]), [entry('__proto__', 'untracked')]);
  assert.deepStrictEqual(T.changedBetween(before, after), {
    files: [{ path: '__proto__', status: 'untracked', staged: false, unstaged: true, adds: 1, dels: 0 }],
    adds: 1,
    dels: 0,
  });
});

test('the thread takes a changes card only when files moved', () => {
  let s = E.emptyThread();
  s = E.reduceThread(s, { type: 'changes', files: [], adds: 0, dels: 0 });
  assert.strictEqual(s.items.length, 0);
  s = E.reduceThread(s, { type: 'changes', files: [{ path: 'a.js', status: 'modified', adds: 1, dels: 0 }], adds: 1, dels: 0 });
  assert.strictEqual(s.items.length, 1);
  assert.strictEqual(s.items[0].kind, 'changes');
});

test('a second read of the same pull request updates its card in place', () => {
  let s = E.emptyThread();
  s = E.reduceThread(s, { type: 'pr', number: 7, title: 't', url: 'u', checks: { total: 1, failed: 0, pending: 1, state: 'pending' } });
  s = E.reduceThread(s, { type: 'pr', number: 7, title: 't', url: 'u', checks: { total: 1, failed: 1, pending: 0, state: 'failing' } });
  s = E.reduceThread(s, { type: 'pr', number: 8, title: 'other', url: 'v', checks: null });
  const prs = s.items.filter((it) => it.kind === 'pr');
  assert.strictEqual(prs.length, 2);
  assert.strictEqual(prs[0].checks.state, 'failing');
});

test('each check keeps its own name, state and link', () => {
  const rows = G._internal.checkRuns([
    { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://x/1' },
    { name: 'unit', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://x/2' },
    { context: 'deploy/preview', state: 'PENDING', targetUrl: 'https://x/3' },
    { status: 'COMPLETED', conclusion: 'SUCCESS' },
    null,
  ]);
  assert.deepStrictEqual(rows, [
    { name: 'lint', workflow: '', state: 'passing', url: 'https://x/1' },
    { name: 'unit', workflow: 'CI', state: 'failing', url: 'https://x/2' },
    { name: 'deploy/preview', workflow: '', state: 'pending', url: 'https://x/3' },
  ]);
});
