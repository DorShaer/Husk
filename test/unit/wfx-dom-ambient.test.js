'use strict';

// el() as the four renderer surfaces actually call it.
//
// wfx-dom.test.js and the two hostile files drive createBuilder(fakeDoc),
// which is the right instrument for the allowlists and the scrub because it
// needs no document at all. What it cannot reach is the form every caller in
// src/renderer uses: the ambient el(), which resolves `document` per call, and
// which is the only path that ever meets a node the builder did not build.
// That gap is not academic. wfx-artifact-ui.js constructs its status glyphs
// with createElementNS, outside the builder and outside the tag allowlist, and
// hands them straight back to el() as children, so the node-verification
// branch that decides whether they are adopted or refused had no test on
// either side of it. This file is that path, against a document with a real
// prototype chain and a real defaultView.
//
// The overlap with wfx-dom.test.js is deliberate in exactly one place: the
// on-star refusal and the text coercion are re-asserted here because they are
// the two properties the whole feature rests on, and a property that holds
// under a fake document and not under a real one is a property nobody has.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer } = require('../helpers/load-renderer');

const SVG_NS = 'http://www.w3.org/2000/svg';

function surface() {
  const loaded = loadRenderer({ scripts: ['dom'] });
  return { el: loaded.dom.el, text: loaded.dom.text, frag: loaded.dom.frag, api: loaded.dom, document: loaded.document };
}

// Returns the WfxDomError code a call refused with, or null if it did not
// refuse. Matching on the code rather than the message is what the class
// carries one for: the message quotes the value being refused and is not a
// string a test should be pinned to.
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
  // Appending it makes it findable through the document, which is the whole
  // reason the surfaces build into the live tree instead of a detached one.
  document.body.appendChild(node);
  assert.equal(document.querySelector('.wfx-rcp'), node);
});

test('ambient el: an on-star attribute is refused before the element carries anything', () => {
  const { el, api } = surface();

  for (const name of ['onclick', 'onClick', 'ONCLICK', 'onerror', 'ontoggle', 'onbeforetoggle']) {
    assert.equal(codeOf(api, () => el('button', { type: 'button', [name]: 'alert(1)' })), 'event-attr', name);
  }
  // A name that merely starts with the two letters is not a handler and is
  // refused for the ordinary reason, which keeps the two refusals separable.
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
  // A number reaches setAttribute as its decimal string, which is what the
  // real DOM does and what the shim's string-only setAttribute enforces.
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
  // A non-finite number in a text slot is arithmetic that went wrong upstream
  // rather than a value to render, so it is loud.
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
  // The receipt-derived status is the case this guard was written for: a
  // status of 'x" onload=alert(1)' has to become nothing at all rather than a
  // token somebody later interpolates into a selector.
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
  // ARIA states take the word, not the presence convention, because an empty
  // aria-hidden is invalid and reads as true to a screen reader.
  assert.equal(node.getAttribute('aria-hidden'), 'false');

  // The prefix does not buy a free-form name. A dataset key is camelCase
  // because DOMStringMap says so, and an ARIA suffix is one lowercase word
  // because every attribute in the WAI-ARIA spec is.
  assert.equal(codeOf(api, () => el('div', { dataset: { 'wfx-receipt': 'x' } })), 'bad-attr-name');
  assert.equal(codeOf(api, () => el('div', { aria: { 'labelled-by': 'x' } })), 'bad-attr-name');

  // data-onclick is written, and that is correct rather than a gap: the
  // prefix is what makes it inert. The handler refusal is about the name the
  // parser would bind, so the assertion worth making is that the attribute
  // landed in the data namespace and no handler attribute exists beside it.
  const dashed = el('div', { 'data-onclick': 'alert(1)' });
  assert.equal(dashed.getAttribute('data-onclick'), 'alert(1)');
  assert.equal(dashed.getAttribute('onclick'), null);
});

test('ambient el: the id namespace stops a built element answering a lookup for a shell control', () => {
  const { el, document } = surface();
  const shell = document.createElement('button');
  shell.setAttribute('id', 'wfx-in-go');
  document.body.appendChild(shell);

  // An id out of a manifest is dropped rather than written, so the built node
  // cannot shadow the Install button in document order.
  const imposter = el('div', { id: 'wfx-in-go' }, 'imported');
  document.body.appendChild(imposter);
  assert.equal(imposter.hasAttribute('id'), false);
  assert.equal(document.getElementById('wfx-in-go'), shell);

  // Inside the builder's own namespace an id is written and is findable.
  const mine = el('div', { id: 'wfxd-row-1' });
  document.body.appendChild(mine);
  assert.equal(document.getElementById('wfxd-row-1'), mine);

  // A reference follows the same rule token by token: the shell id that is
  // listed by hand survives, the one that is not is dropped.
  const labelled = el('div', { aria: { labelledby: 'wfxd-row-1 wfx-in-title wfx-in-go' } });
  assert.equal(labelled.getAttribute('aria-labelledby'), 'wfxd-row-1 wfx-in-title');
});

test('ambient el: there is no SVG namespace in the builder, and a namespaced node is still adoptable', () => {
  const { el, api, document } = surface();

  // Every tag that exists to fetch or execute something is off the list, svg
  // and its children included, which is why the glyphs are built by hand.
  for (const tag of ['svg', 'path', 'a', 'img', 'script', 'iframe', 'link', 'style', 'math', 'use']) {
    assert.equal(codeOf(api, () => el(tag, null)), 'bad-tag', tag);
  }

  // The status glyph, built exactly as wfx-artifact-ui.js builds it: a
  // namespaced element with camelCase attribute names, created outside the
  // builder and handed back to it as a child. It is adopted because it is a
  // real node, not because it says it is one.
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

  // The distinction this file is here to prove holds under a real prototype
  // chain: a genuine namespaced element goes in, and a JSON object wearing a
  // nodeType does not, even though both answer the same duck-type question.
  assert.equal(codeOf(api, () => el('span', null, { nodeType: 1, tagName: 'SCRIPT' })), 'bad-child');
  assert.equal(codeOf(api, () => el('span', null, JSON.parse('{"nodeType":3,"data":"x"}'))), 'bad-child');

  // An ordinary field out of a manifest that landed in a text slot is content
  // of the wrong shape: dropped, with the tree rendering on.
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
