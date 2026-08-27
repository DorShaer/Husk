'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { rank, scoreEntry, LABEL_WEIGHT, PREFIX_WEIGHT, SUB_WEIGHT } = require('../../src/lib/palette-search');

const OPTS = {
  sectionOrder: ['Sessions', 'Workflows', 'Projects', 'Agents', 'Prompts', 'Skills', 'Actions'],
  sectionMax: 5,
};

// Labels back out of the ranked positions, which is what the renderer does.
const labels = (entries, hits) => hits.map((h) => entries[h.index].label);

test('an empty query answers nothing, so the palette can show its own default', () => {
  const entries = [{ section: 'Actions', label: 'Switch to Chat', sub: '' }];
  assert.deepStrictEqual(rank('', entries, OPTS), []);
  assert.deepStrictEqual(rank('   ', entries, OPTS), []);
  assert.strictEqual(scoreEntry('', entries[0]), null);
});

test('a query that matches nothing returns no rows rather than every row', () => {
  const entries = [
    { section: 'Actions', label: 'Switch to Chat', sub: '' },
    { section: 'Sessions', label: 'auth refactor', sub: 'husk' },
  ];
  assert.deepStrictEqual(rank('zzzz', entries, OPTS), []);
});

test('a hit on the label outranks a hit on the line beneath it', () => {
  const entries = [
    { section: 'Sessions', label: 'nothing to see', sub: 'payments' },
    { section: 'Sessions', label: 'payments', sub: 'nothing to see' },
  ];
  assert.deepStrictEqual(labels(entries, rank('payments', entries, OPTS)), ['payments', 'nothing to see']);
});

test('a label the query spells from its first letter leads one it threads through', () => {
  const entries = [
    { section: 'Actions', label: 'Switch to Preferences', sub: '' },
    { section: 'Actions', label: 'Preferences', sub: '' },
  ];
  // "pref" is a subsequence of both, but only one of them starts with it.
  assert.deepStrictEqual(labels(entries, rank('pref', entries, OPTS)), ['Preferences', 'Switch to Preferences']);
});

test('the prefix bonus is worth more than any ordinary label hit', () => {
  const exact = scoreEntry('chat', { section: 'Actions', label: 'chat', sub: '' });
  const threaded = scoreEntry('chat', { section: 'Actions', label: 'Switch to Chat', sub: '' });
  assert.ok(exact > threaded);
  assert.ok(exact >= LABEL_WEIGHT + PREFIX_WEIGHT);
  assert.ok(threaded >= LABEL_WEIGHT);
  assert.ok(threaded < LABEL_WEIGHT + PREFIX_WEIGHT);
});

test('sections lead by their own best row, not by a fixed order', () => {
  const entries = [
    // Actions is last in sectionOrder, but it holds the only exact name here.
    { section: 'Sessions', label: 'a plugin conversation', sub: '' },
    { section: 'Actions', label: 'Plugins', sub: '' },
  ];
  const hits = rank('plugins', entries, OPTS);
  assert.strictEqual(hits[0].section, 'Actions');
});

test('sectionOrder breaks a tie between two equally good sections', () => {
  const entries = [
    { section: 'Actions', label: 'deploy', sub: '' },
    { section: 'Sessions', label: 'deploy', sub: '' },
  ];
  const hits = rank('deploy', entries, OPTS);
  assert.strictEqual(hits[0].score, hits[1].score);
  assert.deepStrictEqual(hits.map((h) => h.section), ['Sessions', 'Actions']);
});

test('a section nobody listed sorts after every section that was listed', () => {
  const entries = [
    { section: 'Wildcard', label: 'deploy', sub: '' },
    { section: 'Sessions', label: 'deploy', sub: '' },
  ];
  assert.deepStrictEqual(rank('deploy', entries, OPTS).map((h) => h.section), ['Sessions', 'Wildcard']);
});

test('each section is capped, so one crowded surface cannot bury the others', () => {
  const entries = [];
  for (let i = 0; i < 12; i++) entries.push({ section: 'Sessions', label: `deploy run ${i}`, sub: '' });
  entries.push({ section: 'Actions', label: 'deploy', sub: '' });

  const hits = rank('deploy', entries, { ...OPTS, sectionMax: 3 });
  const perSection = hits.reduce((acc, h) => ({ ...acc, [h.section]: (acc[h.section] || 0) + 1 }), {});
  assert.strictEqual(perSection.Sessions, 3);
  assert.strictEqual(perSection.Actions, 1);
});

test('a missing or nonsense cap falls back to the default rather than dropping rows', () => {
  const entries = [];
  for (let i = 0; i < 9; i++) entries.push({ section: 'Sessions', label: `deploy ${i}`, sub: '' });
  assert.strictEqual(rank('deploy', entries, { sectionOrder: OPTS.sectionOrder }).length, 5);
  assert.strictEqual(rank('deploy', entries, { sectionMax: 0 }).length, 5);
  assert.strictEqual(rank('deploy', entries, { sectionMax: -3 }).length, 5);
  assert.strictEqual(rank('deploy', entries, {}).length, 5);
});

test('rows within a section are ordered by score, then by label', () => {
  const entries = [
    { section: 'Sessions', label: 'zebra deploy', sub: '' },
    { section: 'Sessions', label: 'alpha deploy', sub: '' },
    { section: 'Sessions', label: 'deploy', sub: '' },
  ];
  // "deploy" wins on the prefix bonus; the other two tie and fall back to name.
  assert.deepStrictEqual(
    labels(entries, rank('deploy', entries, OPTS)),
    ['deploy', 'alpha deploy', 'zebra deploy'],
  );
});

test('the ranker reports positions into the caller\'s own array', () => {
  const entries = [
    { section: 'Actions', label: 'nope', sub: '' },
    { section: 'Sessions', label: 'deploy', sub: '' },
  ];
  const hits = rank('deploy', entries, OPTS);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].index, 1);
  assert.strictEqual(entries[hits[0].index].label, 'deploy');
});

test('an entry is searchable by its sub line alone', () => {
  const entries = [{ section: 'Sessions', label: 'untitled', sub: 'husk/installer' }];
  assert.deepStrictEqual(rank('installer', entries, OPTS).map((h) => h.index), [0]);
});

test('the sub line matches a literal run only, so prose does not answer everything', () => {
  // A paragraph will contain almost any short query as a gapped subsequence.
  // "rel" threads through "Review ... a ... build" and must not count.
  const prose = { section: 'Skills', label: 'Xyz', sub: 'Review an agent transcript for a tagged build' };
  assert.strictEqual(scoreEntry('rel', prose), null);
  // The same words as a literal run do count.
  assert.notStrictEqual(scoreEntry('agent transcript', prose), null);
});

test('a label still matches loosely, letter by letter, because a name is short', () => {
  const entry = { section: 'Actions', label: 'Switch to Preferences', sub: '' };
  // "stp" is a gapped subsequence of the name, and names allow gaps.
  assert.notStrictEqual(scoreEntry('stp', entry), null);
});

test('an earlier run in the sub line outscores a later one', () => {
  const early = scoreEntry('build', { section: 'Skills', label: 'a', sub: 'build the thing' });
  const late = scoreEntry('build', { section: 'Skills', label: 'a', sub: 'a much longer preamble before the build' });
  assert.ok(early > late);
  assert.ok(early <= SUB_WEIGHT);
});

test('any label hit outranks any sub hit, however long the description', () => {
  const onLabel = scoreEntry('build', { section: 'Skills', label: 'rebuild everything', sub: '' });
  const onSub = scoreEntry('build', { section: 'Skills', label: 'unrelated', sub: 'build the thing' });
  assert.ok(onLabel > onSub);
  assert.ok(onLabel >= LABEL_WEIGHT);
  assert.ok(onSub <= SUB_WEIGHT);
  assert.ok(SUB_WEIGHT < LABEL_WEIGHT);
});

test('matching ignores case in both directions', () => {
  const entries = [{ section: 'Sessions', label: 'Auth Refactor', sub: '' }];
  assert.strictEqual(rank('AUTH', entries, OPTS).length, 1);
  assert.strictEqual(rank('auth', entries, OPTS).length, 1);
});

test('malformed input is ranked as empty rather than thrown over', () => {
  assert.deepStrictEqual(rank('x', null, OPTS), []);
  assert.deepStrictEqual(rank('x', undefined, OPTS), []);
  assert.deepStrictEqual(rank(null, [{ section: 'Actions', label: 'a', sub: '' }], OPTS), []);
  assert.strictEqual(scoreEntry('a', null), null);
  assert.strictEqual(scoreEntry('a', { section: 'Actions' }), null);
  // An entry with no section is still rankable; it lands in the unnamed group.
  assert.deepStrictEqual(rank('a', [{ label: 'a' }], OPTS).map((h) => h.section), ['']);
});
