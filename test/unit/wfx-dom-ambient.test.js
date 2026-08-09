'use strict';

// el() as the four renderer surfaces actually call it.
//
// The other wfx-dom files drive createBuilder(fakeDoc). This file drives the
// ambient el(), which resolves `document` per call and is the form every
// caller in src/renderer uses, against a document with a real prototype chain
// and a real defaultView. wfx-artifact-ui.js builds its status glyphs with
// createElementNS and hands them back to el() as children, which is the
// node-verification branch this file covers on both sides.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer } = require('../helpers/load-renderer');

const SVG_NS = 'http://www.w3.org/2000/svg';

function surface() {
  const loaded = loadRenderer({ scripts: ['dom'] });
  return { el: loaded.dom.el, text: loaded.dom.text, frag: loaded.dom.frag, api: loaded.dom, document: loaded.document };
}

// Returns the WfxDomError code a call refused with, or null if it did not
// refuse. The code is the stable half of the class; the message is not.
function codeOf(api, fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof api.WfxDomError, `expected a WfxDomError, got ${err && err.name}: ${err && err.message}`);
    return err.code;
  }
  return null;
}

function elementsIn(node, out = []) {
  if (node.nodeType === 1) out.push(node);
  for (const child of node.childNodes) elementsIn(child, out);
  return out;
}

test('ambient el: builds against the live document rather than a captured one', () => {
  const { el, document } = surface();
  const node = el('div', { class: 'wfx-rcp' }, 'ready');

  assert.equal(node.ownerDocument, document);
  assert.equal(node.tagName, 'DIV');
  // Appending it makes it findable through the document.
  document.body.appendChild(node);
  assert.equal(document.querySelector('.wfx-rcp'), node);
});

test('ambient el: an on-star attribute is refused before the element carries anything', () => {
  const { el, api } = surface();

  for (const name of ['onclick', 'onClick', 'ONCLICK', 'onerror', 'ontoggle', 'onbeforetoggle']) {
    assert.equal(codeOf(api, () => el('button', { type: 'button', [name]: 'alert(1)' })), 'event-attr', name);
  }
  // A name that merely starts with those two letters takes the same refusal.
  assert.equal(codeOf(api, () => el('div', { once: 'x' })), 'event-attr');

  const clean = el('button', { type: 'button' }, 'Run');
  assert.equal(clean.getAttribute('onclick'), null);
  assert.equal(clean.attributes.has('onclick'), false);
});

test('ambient el: only allowlisted attributes are written and the URL sinks are not among them', () => {
  const { el, api } = surface();

  for (const name of ['href', 'src', 'style', 'srcdoc', 'formaction', 'xlink:href', 'is']) {
    assert.equal(codeOf(api, () => el('div', { [name]: 'javascript:alert(1)' })), 'bad-attr-name', name);
  }
  const node = el('div', { title: 'a title', role: 'group', lang: 'en', tabindex: 0 });
  assert.equal(node.getAttribute('title'), 'a title');
  assert.equal(node.getAttribute('role'), 'group');
  // A number reaches setAttribute as its decimal string.
  assert.equal(node.getAttribute('tabindex'), '0');
});

test('ambient el: an imported string becomes text, and no second element is born', () => {
  const { el } = surface();
  const payloads = [
    '<img src=x onerror=alert(1)>',
    '</span><script>fetch("/steal")</script>',
    '"><button onclick=alert(1)>Run</button>',
    '<svg><animate onbegin=alert(1)>',
  ];

  for (const payload of payloads) {
    const node = el('p', { class: 'wfx-note-m' }, payload);
    assert.equal(elementsIn(node).length, 1, payload);
    assert.equal(node.childNodes.length, 1, payload);
    assert.equal(node.childNodes[0].nodeType, 3, payload);
    assert.equal(node.textContent, payload, payload);
  }
});

test('ambient el: numbers, bigints and conditional children coerce the way callers write them', () => {
  const { el, api } = surface();
  const node = el('span', null, 'runs: ', 31, ' ', 9007199254740993n, false && 'hidden', null, undefined);

  assert.equal(node.textContent, 'runs: 31 9007199254740993');
  // A non-finite number in a text slot refuses with a code.
  assert.equal(codeOf(api, () => el('span', null, NaN)), 'bad-child');
  assert.equal(codeOf(api, () => el('span', null, Infinity)), 'bad-child');
});

test('ambient el: nesting composes and arrays flatten in the order they were written', () => {
  const { el } = surface();
  const tile = el('span', { class: ['wfx-fig', 'is-thin'] },
    el('span', { class: 'wfx-fig-v' }, ['4m 48', el('span', { class: 'wfx-fig-u' }, 's')]),
    el('span', { class: 'wfx-fig-l' }, 'median run'));

  assert.equal(tile.getAttribute('class'), 'wfx-fig is-thin');
  assert.equal(tile.textContent, '4m 48smedian run');
  assert.equal(tile.children.length, 2);
  assert.equal(tile.children[0].children[0].getAttribute('class'), 'wfx-fig-u');
});

test('ambient el: a class token that is not a token is dropped and the element survives', () => {
  const { el } = surface();
  // A receipt-derived status that is not a token becomes nothing at all, and
  // the tokens beside it are written.
  const node = el('div', { class: ['wfx-rcp', 'x" onload=alert(1)', 'is-none'] });

  assert.equal(node.getAttribute('class'), 'wfx-rcp is-none');
  assert.equal(node.attributes.size, 1);
});

// ─── Namespaces ──────────────────────────────────────────────────────────────

test('ambient el: data-star and aria-star are namespaces, not an escape from the allowlist', () => {
  const { el, api } = surface();
  const node = el('button', { type: 'button', dataset: { wfxReceipt: 'wf-7' }, aria: { label: 'Open the record', hidden: false } });

  assert.equal(node.getAttribute('data-wfx-receipt'), 'wf-7');
  assert.equal(node.getAttribute('aria-label'), 'Open the record');
  // ARIA states take the word rather than the presence convention, because an
  // empty aria-hidden reads as true to a screen reader.
  assert.equal(node.getAttribute('aria-hidden'), 'false');

  // A dataset key is camelCase, as DOMStringMap says, and an ARIA suffix is
  // one lowercase word, as the WAI-ARIA spec says.
  assert.equal(codeOf(api, () => el('div', { dataset: { 'wfx-receipt': 'x' } })), 'bad-attr-name');
  assert.equal(codeOf(api, () => el('div', { aria: { 'labelled-by': 'x' } })), 'bad-attr-name');

  // data-onclick lands in the data namespace, with no handler attribute
  // beside it.
  const dashed = el('div', { 'data-onclick': 'alert(1)' });
  assert.equal(dashed.getAttribute('data-onclick'), 'alert(1)');
  assert.equal(dashed.getAttribute('onclick'), null);
});

test('ambient el: the id namespace stops a built element answering a lookup for a shell control', () => {
  const { el, document } = surface();
  const shell = document.createElement('button');
  shell.setAttribute('id', 'wfx-in-go');
  document.body.appendChild(shell);

  // An imported id is dropped rather than written.
  const imposter = el('div', { id: 'wfx-in-go' }, 'imported');
  document.body.appendChild(imposter);
  assert.equal(imposter.hasAttribute('id'), false);
  assert.equal(document.getElementById('wfx-in-go'), shell);

  // Inside the builder's own namespace an id is written and is findable.
  const mine = el('div', { id: 'wfxd-row-1' });
  document.body.appendChild(mine);
  assert.equal(document.getElementById('wfxd-row-1'), mine);

  // A reference follows the same rule token by token: a listed shell id
  // survives and the rest are dropped.
  const labelled = el('div', { aria: { labelledby: 'wfxd-row-1 wfx-in-title wfx-in-go' } });
  assert.equal(labelled.getAttribute('aria-labelledby'), 'wfxd-row-1 wfx-in-title');
});

test('ambient el: there is no SVG namespace in the builder, and a namespaced node is still adoptable', () => {
  const { el, api, document } = surface();

  // The tag allowlist carries no svg and no fetching or executing tag, so the
  // glyphs are built by hand.
  for (const tag of ['svg', 'path', 'a', 'img', 'script', 'iframe', 'link', 'style', 'math', 'use']) {
    assert.equal(codeOf(api, () => el(tag, null)), 'bad-tag', tag);
  }

  // The status glyph, built as wfx-artifact-ui.js builds it: a namespaced
  // element created outside the builder and handed back as a child, adopted
  // because it is a real node.
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M8 12.2l2.8 2.8L16 9.8');
  svg.appendChild(path);

  const row = el('span', { class: 'wfx-pf-i' }, svg);
  assert.equal(row.childNodes[0], svg);
  assert.equal(row.childNodes[0].namespaceURI, SVG_NS);
  assert.equal(row.childNodes[0].getAttribute('viewBox'), '0 0 24 24');
});

test('ambient el: an object that claims to be a node without being one is refused, not adopted', () => {
  const { el, api } = surface();

  // Under a real prototype chain a genuine namespaced element goes in and a
  // JSON object carrying a nodeType does not.
  assert.equal(codeOf(api, () => el('span', null, { nodeType: 1, tagName: 'SCRIPT' })), 'bad-child');
  assert.equal(codeOf(api, () => el('span', null, JSON.parse('{"nodeType":3,"data":"x"}'))), 'bad-child');

  // An imported field in a text slot is content of the wrong shape: dropped,
  // with the tree rendering on.
  const node = el('span', null, 'before', { name: 'step one' }, 'after');
  assert.equal(node.textContent, 'beforeafter');
});

test('ambient text and frag: the same rules, and a fragment carries no element of its own', () => {
  const { el, text, frag, document } = surface();
  const piece = frag('the file says ', el('code', null, 'codex'), ' is required');

  assert.equal(piece.nodeType, 11);
  assert.equal(piece.textContent, 'the file says codex is required');

  const host = el('p', { class: 'wfx-pf-note' }, piece);
  assert.equal(host.children.length, 1);
  assert.equal(host.children[0].tagName, 'CODE');

  const node = text('<b>not bold</b>');
  assert.equal(node.nodeType, 3);
  assert.equal(node.data, '<b>not bold</b>');
  assert.equal(document.body.contains(node), false);
});
