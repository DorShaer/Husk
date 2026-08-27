'use strict';

const test = require('node:test');
const assert = require('node:assert');

const G = require('../../src/lib/gh-cli');

// ─── argv ────────────────────────────────────────────────────────────────

test('a list call asks for exactly the fields the surface draws', () => {
  const args = G.prListArgs({});
  const json = args[args.indexOf('--json') + 1].split(',');
  assert.deepStrictEqual(json, G.PR_FIELDS);
});

test('every value is its own argument, so nothing can become a second command', () => {
  const hostile = 'fix; rm -rf ~ && echo "pwned" | sh';
  const args = G.prListArgs({ search: hostile });
  // The whole string survives as one element rather than being split or quoted.
  assert.strictEqual(args[args.indexOf('--search') + 1], hostile);
  assert.strictEqual(args.filter((a) => a === hostile).length, 1);
  // And nothing anywhere in the argv is a shell line.
  for (const a of args) assert.ok(!/\n/.test(a), `argv element carries a newline: ${a}`);
});

test('a state gh does not know falls back to open rather than being passed through', () => {
  for (const bad of ['pending', 'OPEN; --foo', '', null, 42]) {
    assert.strictEqual(G.prListArgs({ state: bad })[3], 'open', String(bad));
  }
  assert.strictEqual(G.prListArgs({ state: 'merged' })[3], 'merged');
  assert.strictEqual(G.prListArgs({ state: 'MERGED' })[3], 'merged');
});

test('issues take their own state list, which has no merged', () => {
  assert.strictEqual(G.issueListArgs({ state: 'merged' })[3], 'open');
  assert.strictEqual(G.issueListArgs({ state: 'closed' })[3], 'closed');
});

test('the limit is clamped rather than trusted', () => {
  const limitOf = (o) => Number(G.prListArgs(o)[G.prListArgs(o).indexOf('--limit') + 1]);
  assert.strictEqual(limitOf({ limit: 5 }), 5);
  assert.strictEqual(limitOf({ limit: 100000 }), G.MAX_LIMIT);
  assert.strictEqual(limitOf({ limit: 0 }), 1);
  assert.strictEqual(limitOf({ limit: -3 }), 1);
  assert.strictEqual(limitOf({ limit: 'abc' }), G.DEFAULT_LIMIT);
  assert.strictEqual(limitOf({}), G.DEFAULT_LIMIT);
});

test('an empty search adds no flag at all', () => {
  assert.ok(!G.prListArgs({ search: '   ' }).includes('--search'));
  assert.ok(!G.prListArgs({}).includes('--search'));
});

// ─── failures ────────────────────────────────────────────────────────────

test('gh explains its own failures and each one gets its own code', () => {
  const cases = [
    ['failed to run git: fatal: not a git repository (or any of the parent directories): .git', 'not-a-repository'],
    ['no git remotes found', 'no-remote'],
    ['To get started with GitHub CLI, please run: gh auth login', 'gh-not-authenticated'],
    ['GraphQL: Could not resolve to a Repository with the name x/y.', 'repo-not-found'],
    ['HTTP 404: Not Found', 'repo-not-found'],
    ['API rate limit exceeded for user ID 1.', 'rate-limited'],
  ];
  for (const [stderr, code] of cases) {
    assert.strictEqual(G.classifyFailure(1, stderr).code, code, stderr);
  }
});

test('an unrecognised failure keeps gh\'s own words instead of inventing a sentence', () => {
  const r = G.classifyFailure(3, 'something nobody has seen before');
  assert.strictEqual(r.code, 'gh-failed');
  assert.strictEqual(r.detail, 'something nobody has seen before');
});

test('a failure with no output still names the exit code', () => {
  assert.match(G.classifyFailure(9, '').detail, /exited 9/);
});

test('every code the classifier can return is in the closed list', () => {
  const seen = ['not a git repository', 'no git remotes found', 'gh auth login', 'HTTP 404', 'rate limit', 'zzz']
    .map((s) => G.classifyFailure(1, s).code);
  for (const c of seen) assert.ok(G.FAILURE_CODES.includes(c), c);
  for (const c of G.FAILURE_CODES) assert.ok(G.FAILURE_COPY[c], `no copy for ${c}`);
});

// ─── checks ──────────────────────────────────────────────────────────────

const run = (over) => ({ status: 'COMPLETED', conclusion: 'SUCCESS', ...over });

test('check runs are counted here, and the array never reaches a row', () => {
  const rows = G.parsePrList(JSON.stringify([{
    number: 1, title: 't', statusCheckRollup: [run(), run(), run({ conclusion: 'FAILURE' })],
  }])).rows;
  assert.deepStrictEqual(rows[0].checks, { total: 3, passed: 2, failed: 1, pending: 0, state: 'failing' });
  assert.strictEqual(rows[0].statusCheckRollup, undefined);
});

test('a run that has not completed is pending, whatever its conclusion says', () => {
  const c = G._internal.checks([run({ status: 'IN_PROGRESS', conclusion: 'SUCCESS' })]);
  assert.strictEqual(c.pending, 1);
  assert.strictEqual(c.passed, 0);
  assert.strictEqual(c.state, 'pending');
});

test('a failure outranks a pending run, since waiting will not change it', () => {
  const c = G._internal.checks([run({ conclusion: 'FAILURE' }), run({ status: 'QUEUED', conclusion: '' })]);
  assert.strictEqual(c.state, 'failing');
});

test('neutral and skipped count as passed, not as failures', () => {
  const c = G._internal.checks([run({ conclusion: 'NEUTRAL' }), run({ conclusion: 'SKIPPED' })]);
  assert.strictEqual(c.passed, 2);
  assert.strictEqual(c.state, 'passing');
});

test('no checks at all is its own state, not a pass', () => {
  assert.strictEqual(G._internal.checks([]).state, 'none');
  assert.strictEqual(G._internal.checks(null).state, 'none');
  assert.strictEqual(G._internal.checks(undefined).total, 0);
});

// ─── rows ────────────────────────────────────────────────────────────────

const PR_JSON = JSON.stringify([{
  number: 42,
  title: 'fix(acp): forward diff fields',
  state: 'OPEN',
  isDraft: false,
  author: { login: 'tlobinger', name: 'T' },
  headRefName: 'feature/diff-fields',
  baseRefName: 'main',
  createdAt: '2026-08-23T10:00:00Z',
  updatedAt: '2026-08-23T11:00:00Z',
  additions: 20,
  deletions: 0,
  changedFiles: 2,
  labels: [{ name: 'readiness: passed', color: '2DA44E' }, { name: 'bad', color: 'zzz' }],
  reviewDecision: '',
  mergeable: 'MERGEABLE',
  url: 'https://github.com/o/r/pull/42',
  statusCheckRollup: [run()],
}]);

test('a pull request row carries the fields the list draws and nothing else', () => {
  const r = G.parsePrList(PR_JSON).rows[0];
  assert.deepStrictEqual(Object.keys(r).sort(), [
    'additions', 'author', 'base', 'changedFiles', 'checks', 'createdAt', 'deletions',
    'head', 'isDraft', 'labels', 'mergeable', 'number', 'reviewDecision', 'state',
    'title', 'updatedAt', 'url',
  ]);
  assert.strictEqual(r.author, 'tlobinger');
  assert.strictEqual(r.head, 'feature/diff-fields');
});

test('a label keeps its colour only when the colour is a real hex triplet', () => {
  const r = G.parsePrList(PR_JSON).rows[0];
  assert.deepStrictEqual(r.labels, [
    { name: 'readiness: passed', color: '2da44e' },
    { name: 'bad', color: '' },
  ]);
});

test('nobody having reviewed is not the same as approved', () => {
  assert.strictEqual(G.parsePrList(PR_JSON).rows[0].reviewDecision, '');
});

test('a row without a number is skipped and counted rather than shown', () => {
  const out = G.parsePrList(JSON.stringify([{ title: 'no number' }, { number: 7, title: 'ok' }]));
  assert.strictEqual(out.rows.length, 1);
  assert.strictEqual(out.skipped, 1);
});

test('output that is not JSON is a failure, not an empty list', () => {
  assert.strictEqual(G.parsePrList('not json').code, 'gh-failed');
  assert.strictEqual(G.parsePrList('{"number":1}').code, 'gh-failed');
  assert.strictEqual(G.parseIssueList('').code, 'gh-failed');
});

test('an issue row counts its comments rather than carrying them', () => {
  const r = G.parseIssueList(JSON.stringify([{
    number: 6, title: 'x', state: 'CLOSED', author: { login: 'a' },
    assignees: [{ login: 'a' }, { login: 'Copilot' }], comments: [{}, {}, {}],
  }])).rows[0];
  assert.strictEqual(r.comments, 3);
  assert.deepStrictEqual(r.assignees, ['a', 'Copilot']);
});

test('a repository view names the repository or refuses', () => {
  const ok = G.parseRepoView(JSON.stringify({
    nameWithOwner: 'DorShaer/Husk', url: 'https://github.com/DorShaer/Husk',
    defaultBranchRef: { name: 'main' }, isPrivate: false, description: 'd',
  }));
  assert.strictEqual(ok.repo.nameWithOwner, 'DorShaer/Husk');
  assert.strictEqual(ok.repo.defaultBranch, 'main');
  assert.strictEqual(G.parseRepoView('{}').code, 'repo-not-found');
});

test('a hostile payload is normalised rather than passed through', () => {
  const r = G.parsePrList(JSON.stringify([{
    number: 1,
    title: 'x'.repeat(5000),
    author: 'not-an-object',
    labels: 'not-an-array',
    additions: 'lots',
    isDraft: 'yes',
    extraFieldNobodyAskedFor: 'should not appear',
  }])).rows[0];
  assert.strictEqual(r.title.length, 300);
  assert.strictEqual(r.author, '');
  assert.deepStrictEqual(r.labels, []);
  assert.strictEqual(r.additions, 0);
  // A string is not true: only a real boolean marks a draft.
  assert.strictEqual(r.isDraft, false);
  assert.strictEqual(r.extraFieldNobodyAskedFor, undefined);
});

// ─── browsing ────────────────────────────────────────────────────────────

const ROWS = [
  { number: 10, title: 'Fix the parser', author: 'ann', head: 'fix/parser', labels: [{ name: 'bug', color: '' }] },
  { number: 11, title: 'Add a page', author: 'bob', head: 'feat/page', labels: [{ name: 'bug', color: '' }, { name: 'ui', color: '' }] },
];

test('a query reaches the title, the author, the branch and the labels', () => {
  assert.deepStrictEqual(G.filterRows(ROWS, 'parser').map((r) => r.number), [10]);
  assert.deepStrictEqual(G.filterRows(ROWS, 'bob').map((r) => r.number), [11]);
  assert.deepStrictEqual(G.filterRows(ROWS, 'feat/').map((r) => r.number), [11]);
  assert.deepStrictEqual(G.filterRows(ROWS, 'bug').map((r) => r.number), [10, 11]);
});

test('a bare number finds the pull request by that number', () => {
  assert.deepStrictEqual(G.filterRows(ROWS, '11').map((r) => r.number), [11]);
  assert.deepStrictEqual(G.filterRows(ROWS, '#11').map((r) => r.number), [11]);
});

test('an empty query is the whole list', () => {
  assert.strictEqual(G.filterRows(ROWS, '').length, 2);
  assert.strictEqual(G.filterRows(ROWS, null).length, 2);
  assert.strictEqual(G.filterRows(null, 'x').length, 0);
});

test('labels are counted commonest first', () => {
  assert.deepStrictEqual(G.labelCounts(ROWS).map((l) => [l.name, l.count]), [['bug', 2], ['ui', 1]]);
  assert.deepStrictEqual(G.labelCounts(null), []);
});
