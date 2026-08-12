'use strict';

// The shim is a test dependency, and an untested test dependency is how a
// whole suite goes green for a reason the browser does not share.
//
// Everything below is a behaviour some assertion in wfx-dom-ambient.test.js,
// wfx-artifact-ui.test.js or wfx-artifact-ui-tiers.test.js leans on. The one
// that matters most is the first: wfx-dom.js verifies a foreign child with
// `value instanceof doc.defaultView.Node` and refuses an object that carries a
// nodeType and fails that check, so a shim whose nodes were plain objects
// would make every SVG glyph in the feature throw, and the failure would land
// in a renderer file rather than here.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createDocument, Node, textNodes } = require('../helpers/dom-shim');
const { loadRenderer } = require('../helpers/load-renderer');

test('dom-shim: a node built outside the builder is still a node the builder accepts', () => {
  const { dom, document } = loadRenderer({ scripts: ['dom'] });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'path'));

  assert.ok(svg instanceof Node);
  assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
  // The tag stays cased as asked in a namespace, which is what lets the
  // status glyphs keep their viewBox attribute name.
  assert.equal(svg.localName, 'svg');

  const wrapped = dom.el('span', { class: 'wfx-pf-i' }, svg);
  assert.equal(wrapped.childNodes.length, 1);
  assert.equal(wrapped.childNodes[0], svg);
});

test('dom-shim: appending a fragment moves its children rather than the fragment', () => {
  const document = createDocument();
  const frag = document.createDocumentFragment();
  frag.appendChild(document.createTextNode('one'));
  frag.appendChild(document.createElement('span'));

  const host = document.createElement('div');
  host.appendChild(frag);

  assert.equal(host.childNodes.length, 2);
  assert.equal(frag.childNodes.length, 0);
  assert.equal(host.textContent, 'one');
});

test('dom-shim: textContent reads every descendant and writing it empties the element', () => {
  const document = createDocument();
  const host = document.createElement('div');
  const inner = document.createElement('span');
  inner.appendChild(document.createTextNode('deep'));
  host.appendChild(document.createTextNode('top '));
  host.appendChild(inner);

  assert.equal(host.textContent, 'top deep');
  assert.equal(textNodes(host).map((n) => n.data).join('|'), 'top |deep');

  host.textContent = 'replaced';
  assert.equal(host.childNodes.length, 1);
  assert.equal(host.textContent, 'replaced');
  assert.equal(inner.parentNode, null);
});

test('dom-shim: splitText leaves both halves in the parent, in order', () => {
  const document = createDocument();
  const host = document.createElement('pre');
  const node = document.createTextNode('run {{previousOutput}} now');
  host.appendChild(node);

  const tail = node.splitText(4);
  assert.equal(node.data, 'run ');
  assert.equal(tail.data, '{{previousOutput}} now');
  assert.equal(host.childNodes.length, 2);
  assert.equal(host.childNodes[1], tail);
  assert.equal(host.textContent, 'run {{previousOutput}} now');
});

test('dom-shim: hidden, id and classList reflect the attributes a test reads back', () => {
  const document = createDocument();
  const node = document.createElement('div');

  node.hidden = true;
  assert.equal(node.getAttribute('hidden'), '');
  node.hidden = false;
  assert.equal(node.hasAttribute('hidden'), false);

  node.setAttribute('class', 'wfx-fig is-thin');
  assert.equal(node.classList.contains('is-thin'), true);
  node.classList.toggle('is-thin', false);
  assert.equal(node.getAttribute('class'), 'wfx-fig');

  node.setAttribute('id', 'wfxd-row');
  assert.equal(node.id, 'wfxd-row');
});

test('dom-shim: dataset reads the dashed attribute back under its camelCase key', () => {
  const { dom } = loadRenderer({ scripts: ['dom'] });
  const node = dom.el('button', { type: 'button', dataset: { wfxReceipt: 'wf-7' } });

  assert.equal(node.getAttribute('data-wfx-receipt'), 'wf-7');
  assert.equal(node.dataset.wfxReceipt, 'wf-7');
});

test('dom-shim: setAttribute refuses a name markup could not carry and a value that is not a string', () => {
  const document = createDocument();
  const node = document.createElement('div');

  assert.throws(() => node.setAttribute('has space', 'x'), /InvalidCharacterError/);
  assert.throws(() => node.setAttribute('title', 5), TypeError);
  // viewBox is the reason the charset allows uppercase: the SVG glyphs are
  // built outside el() and their attribute names are camelCase.
  node.setAttribute('viewBox', '0 0 24 24');
  assert.equal(node.getAttribute('viewBox'), '0 0 24 24');
});

test('dom-shim: the selector subset covers every shape the four renderer files use', () => {
  const document = createDocument();
  const modal = document.createElement('div');
  modal.setAttribute('class', 'modal-card wfx-sheet');
  const details = document.createElement('details');
  details.setAttribute('class', 'wfx-step');
  const summary = document.createElement('summary');
  const pre = document.createElement('pre');
  const named = document.createElement('button');
  named.setAttribute('id', 'wfx-in-fp-copy');
  const marked = document.createElement('div');
  marked.setAttribute('data-wfx-injected', 'block');

  document.body.appendChild(modal);
  modal.appendChild(details);
  details.appendChild(summary);
  details.appendChild(pre);
  details.appendChild(named);
  modal.appendChild(marked);

  assert.equal(document.querySelector('.modal-card.wfx-sheet'), modal);
  assert.equal(document.querySelector('details.wfx-step'), details);
  assert.equal(document.querySelector('.wfx-step > summary'), summary);
  assert.equal(document.querySelector('[id="wfx-in-fp-copy"]'), named);
  assert.equal(document.getElementById('wfx-in-fp-copy'), named);
  assert.equal(modal.querySelector('pre'), pre);
  assert.deepEqual(modal.querySelectorAll('[data-wfx-injected="block"]'), [marked]);
  assert.equal(summary.closest('.wfx-step'), details);
  // A descendant combinator crosses a generation, a child combinator does not.
  assert.equal(document.querySelector('.modal-card pre'), pre);
  assert.equal(document.querySelector('.modal-card > pre'), null);
});

test('dom-shim: a click bubbles to the ancestor unless a handler stops it', () => {
  const document = createDocument();
  const card = document.createElement('div');
  const chip = document.createElement('button');
  card.appendChild(chip);

  const seen = [];
  card.addEventListener('click', () => { seen.push('card'); });
  chip.addEventListener('click', () => { seen.push('chip'); });
  chip.click();
  assert.deepEqual(seen, ['chip', 'card']);

  const stopped = [];
  const other = document.createElement('div');
  const inner = document.createElement('button');
  other.appendChild(inner);
  other.addEventListener('click', () => { stopped.push('card'); });
  inner.addEventListener('click', (e) => { e.stopPropagation(); stopped.push('chip'); });
  inner.click();
  assert.deepEqual(stopped, ['chip']);
});

test('dom-shim: each load gets its own document, so one test cannot see another test tree', () => {
  const first = loadRenderer({ scripts: ['dom'] });
  const second = loadRenderer({ scripts: ['dom'] });
  first.document.body.appendChild(first.dom.el('div', { id: 'wfxd-only-here' }));

  assert.ok(first.document.getElementById('wfxd-only-here'));
  assert.equal(second.document.getElementById('wfxd-only-here'), null);
  assert.notEqual(first.dom, second.dom);
});

test('dom-shim: all four renderer surfaces load in index.html order without complaint', () => {
  const loaded = loadRenderer({ scripts: ['dom', 'ui', 'install', 'publish'] });

  assert.equal(typeof loaded.dom.el, 'function');
  assert.equal(typeof loaded.ui.renderFigures, 'function');
  assert.equal(typeof loaded.install.open, 'function');
  assert.equal(typeof loaded.publish.open, 'function');
  // wfx-artifact-ui.js reports a missing builder on the console and defines
  // nothing at all, so a silent console is the only evidence that the load
  // order in this helper still matches the one in index.html.
  assert.deepEqual(loaded.consoleLines, []);
});

test('dom-shim: a file that wires itself on DOMContentLoaded stays unwired until the page says so', () => {
  const loaded = loadRenderer({ scripts: ['dom', 'ui', 'install'] });

  // readyState defaults to 'loading', so wfx-install.js has registered a
  // listener rather than run its wiring against a document with no markup in
  // it. Nothing to assert on the listener itself; what matters is that the
  // load did not throw and the export is present either way.
  assert.equal(loaded.document.readyState, 'loading');
  assert.equal(typeof loaded.install.configure, 'function');
});
