'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { fuzzyMatch, fuzzyFilter, isBoundary } = require('../../src/lib/fuzzy');

test('fuzzyMatch: non-subsequence returns null', () => {
  assert.equal(fuzzyMatch('abc', 'acb'), null);
  assert.equal(fuzzyMatch('xyz', 'abc'), null);
  assert.equal(fuzzyMatch('longer', 'lon'), null);
});

test('fuzzyMatch: matching is case-insensitive', () => {
  const m = fuzzyMatch('AB', 'axb');
  assert.notEqual(m, null);
  assert.deepEqual(m.positions, [0, 2]);
});

test('fuzzyMatch: empty query matches with zero score', () => {
  assert.deepEqual(fuzzyMatch('', 'anything'), { score: 0, positions: [] });
});

test('fuzzyMatch: positions are the matched indices in target', () => {
  const m = fuzzyMatch('ac', 'abc');
  assert.deepEqual(m.positions, [0, 2]);
});

test('fuzzyMatch: consecutive match outscores gapped match', () => {
  const consecutive = fuzzyMatch('ab', 'abxx').score;
  const gapped = fuzzyMatch('ab', 'axxb').score;
  assert.ok(consecutive > gapped, `expected ${consecutive} > ${gapped}`);
});

test('fuzzyMatch: boundary match outscores mid-word match', () => {
  const boundary = fuzzyMatch('ab', 'a_b').score;
  const midword = fuzzyMatch('ab', 'axxb').score;
  assert.ok(boundary > midword, `expected ${boundary} > ${midword}`);
});

test('fuzzyMatch: earlier match outscores later match', () => {
  const early = fuzzyMatch('a', 'axxxx').score;
  const late = fuzzyMatch('a', 'xxxxa').score;
  assert.ok(early > late, `expected ${early} > ${late}`);
});

test('fuzzyMatch: camelCase hump counts as a boundary', () => {
  assert.equal(isBoundary('fooBar', 3), true);
  assert.equal(isBoundary('foobar', 3), false);
  const humped = fuzzyMatch('fb', 'fooBar').score;
  const flat = fuzzyMatch('fb', 'fooxbar').score;
  assert.ok(humped > flat, `expected ${humped} > ${flat}`);
});

test('fuzzyFilter: ranks boundary and consecutive above scattered', () => {
  const items = ['axxb', 'a_b', 'ab'];
  const ranked = fuzzyFilter('ab', items);
  assert.equal(ranked[ranked.length - 1], 'axxb');
  assert.ok(ranked.indexOf('a_b') < ranked.indexOf('axxb'));
  assert.ok(ranked.indexOf('ab') < ranked.indexOf('axxb'));
});

test('fuzzyFilter: drops non-matching items', () => {
  const items = ['apple', 'grape', 'plum'];
  const ranked = fuzzyFilter('ap', items);
  assert.deepEqual(ranked.sort(), ['apple', 'grape']);
});

test('fuzzyFilter: empty query returns all items in original order', () => {
  const items = ['c', 'a', 'b'];
  assert.deepEqual(fuzzyFilter('', items), ['c', 'a', 'b']);
});

test('fuzzyFilter: ties broken by shorter target then original index', () => {
  // All three match "ab" as a leading boundary+consecutive run, so scores
  // differ only by the leading-position penalty on identical prefixes.
  // Build a genuine tie: same score, different lengths and indices.
  const items = ['abcd', 'abc', 'abce'];
  const ranked = fuzzyFilter('ab', items);
  // Shorter 'abc' should come before the length-4 entries.
  assert.equal(ranked[0], 'abc');
  // The two length-4 entries keep original relative order (abcd before abce).
  assert.ok(ranked.indexOf('abcd') < ranked.indexOf('abce'));
});

test('fuzzyFilter: keyFn extracts the match target from objects', () => {
  const items = [
    { id: 1, name: 'readme' },
    { id: 2, name: 'main' },
    { id: 3, name: 'makefile' },
  ];
  const ranked = fuzzyFilter('ma', items, (it) => it.name);
  const names = ranked.map((it) => it.name);
  assert.ok(names.includes('main'));
  assert.ok(names.includes('makefile'));
  assert.ok(!names.includes('readme'));
});

test('fuzzyFilter: non-array items yields empty result', () => {
  assert.deepEqual(fuzzyFilter('a', null), []);
});
