'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { detect, isMechanical, applyMechanical, createStreamFilter, normalizeCheck, describe } = require('../../src/lib/rule-lint');

const DASH = '\u2014';
const EM = [{ check: { builtin: 'no-em-dash' } }];
const EMOJI = [{ check: { builtin: 'no-emoji' } }];
const term = (params) => [{ check: { builtin: 'replace-term', params: Object.assign({ term: 'utilize', replacement: 'use' }, params) } }];

// Streams the chunks through one filter and returns what reached the screen.
function stream(chunks, rules) {
  const f = createStreamFilter();
  return chunks.map((c) => f.push(c, rules)).join('') + f.push('', rules, true);
}

test('detect only suggests; enforcement needs an explicit check', () => {
  assert.deepEqual(detect('no em dashes anywhere'), { builtin: 'no-em-dash', params: {} });
  assert.deepEqual(detect(`strip ${DASH} from output`), { builtin: 'no-em-dash', params: {} });
  assert.deepEqual(detect('never use emoji'), { builtin: 'no-emoji', params: {} });
  assert.deepEqual(detect('say "use" instead of "utilize"'), { builtin: 'replace-term', params: { term: 'utilize', replacement: 'use', caseSensitive: false, inCode: false } });
  assert.equal(detect('use tabs instead of spaces'), null);
  assert.equal(detect('sound like Vercel settings'), null);
  assert.equal(isMechanical({ text: 'no em dashes' }), false);
  assert.ok(isMechanical({ text: 'anything', check: { builtin: 'no-em-dash' } }));
  assert.equal(isMechanical({ text: 'x', check: { builtin: 'nope' } }), false);
});

test('normalizeCheck validates the fields of each builtin', () => {
  assert.equal(normalizeCheck({ builtin: 'replace-term', params: { term: '  ' } }).ok, false);
  assert.equal(normalizeCheck({ builtin: 'replace-term', params: { term: 'x'.repeat(81) } }).ok, false);
  assert.deepEqual(normalizeCheck({ builtin: 'no-emoji', params: { junk: 1 } }), { ok: true, check: { builtin: 'no-emoji', params: {} } });
  assert.match(describe(normalizeCheck({ builtin: 'replace-term', params: { term: 'a', replacement: 'b', inCode: true } }).check), /also inside code/);
});

test('no-em-dash replaces with a hyphen everywhere, code included', () => {
  assert.equal(applyMechanical(`distribution ${DASH} the bottleneck`, EM), 'distribution - the bottleneck');
  assert.equal(applyMechanical(`\`a${DASH}b\`\n\`\`\`\nx ${DASH} y\n\`\`\``, EM), '`a-b`\n```\nx - y\n```');
  assert.equal(applyMechanical('already clean', EM), 'already clean');
  assert.equal(applyMechanical(`keep the ${DASH} here`, [{ text: 'be concise' }]), `keep the ${DASH} here`);
});

test('replace-term is whole word and case-insensitive by default', () => {
  assert.equal(applyMechanical('We Utilize it; utilized stays; reutilize stays.', term()), 'We use it; utilized stays; reutilize stays.');
  assert.equal(applyMechanical('Utilize utilize', term({ caseSensitive: true })), 'Utilize use');
  assert.equal(applyMechanical('a $& b', term({ term: 'b', replacement: '$&$&' })), 'a $& $&$&');
});

test('replace-term skips fenced and inline code unless asked to reach it', () => {
  const text = 'utilize `utilize()` and\n```js\nutilize(x)\n```\nutilize';
  assert.equal(applyMechanical(text, term()), 'use `utilize()` and\n```js\nutilize(x)\n```\nuse');
  assert.equal(applyMechanical(text, term({ inCode: true })), 'use `use()` and\n```js\nuse(x)\n```\nuse');
});

test('no-emoji strips emoji from prose and leaves code alone', () => {
  assert.equal(applyMechanical('Done \u2705', EMOJI), 'Done');
  assert.equal(applyMechanical('\u{1F680} Launch', EMOJI), 'Launch');
  assert.equal(applyMechanical('ship \u{1F680} it \u26A0\uFE0F now', EMOJI), 'ship it now');
  assert.equal(applyMechanical('team \u{1F469}\u200D\u{1F4BB}\u{1F3FD} rocks', EMOJI), 'team rocks');
  assert.equal(applyMechanical('copyright \u00A9 stays', EMOJI), 'copyright \u00A9 stays');
  assert.equal(applyMechanical('`\u2705` stays', EMOJI), '`\u2705` stays');
});

test('a term split across two and three chunks is still replaced', () => {
  assert.equal(stream(['we uti', 'lize it'], term()), 'we use it');
  assert.equal(stream(['we u', 'til', 'ize it'], term()), 'we use it');
  assert.equal(stream(['we utilize', 'd it'], term()), 'we utilized it');
  assert.equal(stream(['utilize'], term()), 'use');
});

test('fence state survives chunk boundaries', () => {
  const chunks = ['utilize\n`', '``\nutil', 'ize()\n`', '``\nutilize'];
  assert.equal(stream(chunks, term()), 'use\n```\nutilize()\n```\nuse');
  assert.equal(stream(['a `util', 'ize` b utilize'], term()), 'a `utilize` b use');
});

test('emoji sequences split across chunks are stripped whole', () => {
  assert.equal(stream(['ok \u26A0', '\uFE0F go'], EMOJI), 'ok go');
  assert.equal(stream(['hi \u{1F469}\u200D', '\u{1F4BB} there'], EMOJI), 'hi there');
});

test('em dash alone holds nothing back', () => {
  const f = createStreamFilter();
  assert.equal(f.push(`a${DASH}`, EM), 'a-');
  assert.equal(f.push('b`', EM), 'b`');
});

test('a stream with no rules passes through untouched', () => {
  assert.equal(stream(['a ', DASH, ' \u2705'], []), `a ${DASH} \u2705`);
});

test('any chunking of a reply gives the same result as the whole reply', () => {
  const rules = EM.concat(EMOJI, term());
  const text = `Utilize this \u2705 ${DASH} then \`utilize\` it:\n\`\`\`\nutilize(\u{1F680})\n\`\`\`\nDone \u{1F469}\u200D\u{1F4BB}, utilize!`;
  const whole = applyMechanical(text, rules);
  for (let i = 1; i < text.length; i += 1) {
    for (let j = i; j < text.length; j += 3) {
      assert.equal(stream([text.slice(0, i), text.slice(i, j), text.slice(j)], rules), whole, `cut at ${i},${j}`);
    }
  }
});
