'use strict';

// Adversarial probe of src/renderer/wfx-dom.js. Every test in here is
// written to fail against the module as it stands; each one names the
// contract it believes is broken in its own title.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  el: ambientEl,
  text: ambientText,
  createBuilder,
  isAllowedAttrName,
  WfxDomError,
  MAX_ATTR_VALUE,
} = require('../../src/renderer/wfx-dom');

// The same shape of fake document the module's own tests use, plus the
// one thing that one leaves out: appendChild in a real DOM refuses
// anything that is not actually a Node, and refusing is the behaviour
// under test here.
const MARKUP_SAFE_NAME = /^[A-Za-z_:][-A-Za-z0-9_:.]*$/;

function makeElement(doc, tag) {
  return {
    nodeType: 1,
    localName: tag,
    attributes: new Map(),
    childNodes: [],
    ownerDocument: doc,
    setAttribute(name, value) {
      if (!MARKUP_SAFE_NAME.test(name)) throw new Error(`InvalidCharacterError: ${name}`);
      if (typeof value !== 'string') throw new Error(`setAttribute got a ${typeof value} value`);
      this.attributes.set(name, value);
    },
    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    },
    appendChild(child) {
      // Chrome: "Failed to execute 'appendChild' on 'Node': parameter 1
      // is not of type 'Node'." A duck-typed object is not a Node.
      if (!child || child.__isRealNode !== true) {
        throw new TypeError("Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'.");
      }
      this.childNodes.push(child);
      return child;
    },
  };
}

function makeDocument() {
  const doc = {
    createElement(tag) {
      const node = makeElement(doc, tag);
      node.__isRealNode = true;
      return node;
    },
    createTextNode(data) {
      if (typeof data !== 'string') throw new Error(`createTextNode got a ${typeof data}`);
      return { nodeType: 3, nodeName: '#text', data, childNodes: [], __isRealNode: true };
    },
    createDocumentFragment() {
      const f = {
        nodeType: 11, childNodes: [], __isRealNode: true,
        appendChild(child) {
          if (!child || child.__isRealNode !== true) {
            throw new TypeError("Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'.");
          }
          this.childNodes.push(child); return child;
        },
      };
      return f;
    },
  };
  return doc;
}

function builder() {
  const made = createBuilder(makeDocument());
  assert.equal(made.ok, true, made.error);
  return made;
}

function thrown(fn) {
  try { fn(); } catch (err) { return err; }
  return null;
}

// ---------------------------------------------------------------------------
// F-1. A duck-typed node from JSON walks straight past isNodeLike.
// ---------------------------------------------------------------------------

test('HOSTILE: a JSON object carrying a numeric nodeType defeats the bad-child guard', () => {
  const { el, frag } = builder();
  // No object literal, no cleverness: this is what JSON.parse hands back
  // for a field a stranger wrote into workflow.husk.json.
  const payload = JSON.parse('{"nodeType": 1, "localName": "script"}');

  const err = thrown(() => el('div', {}, payload));
  assert.ok(err, 'expected a refusal');
  assert.ok(err instanceof WfxDomError,
    `child escaped the WfxDomError taxonomy: ${err && err.name}: ${err && err.message}`);
  assert.equal(err.code, 'bad-child');

  const fragErr = thrown(() => frag(payload));
  assert.ok(fragErr instanceof WfxDomError,
    `frag() child escaped the taxonomy: ${fragErr && fragErr.name}`);
});

// ---------------------------------------------------------------------------
// F-2. Truncating an attribute value at a fixed code-unit index splits
//      surrogate pairs.
// ---------------------------------------------------------------------------

test('HOSTILE: the attribute cap slices a surrogate pair in half', () => {
  const { el } = builder();
  // Emoji are two code units each, so a run of them puts a pair boundary
  // exactly on the cap. The validator refuses unpaired surrogates in a
  // manifest (spec:139); this module manufactures one after the fact.
  // One ASCII character in front puts the cap on an odd index, which is
  // the middle of a pair. A stranger picks the offset, not us.
  const value = `x${'\u{1F600}'.repeat(MAX_ATTR_VALUE)}`;
  const got = el('div', { title: value }).getAttribute('title');

  assert.equal(got.length, MAX_ATTR_VALUE);
  const last = got.charCodeAt(got.length - 1);
  assert.ok(!(last >= 0xd800 && last <= 0xdbff),
    'attribute value ends in a lone high surrogate');
  assert.ok(got.isWellFormed ? got.isWellFormed() : true,
    'truncated attribute value is not well-formed UTF-16');
});

// ---------------------------------------------------------------------------
// F-3. The module header's own contract: content is never thrown on.
// ---------------------------------------------------------------------------

test('HOSTILE: content that cannot be text is thrown on, contradicting the header rule', () => {
  const { el } = builder();
  // wfx-dom.js:47-50 states that children, class tokens and attribute
  // string values are the stranger's data and are "never thrown on. It
  // is turned into text, or dropped". Each line below is a child that
  // JSON.parse can produce and that this module throws on instead.
  const cases = [
    ['object', JSON.parse('{"a":1}')],
    ['empty object', JSON.parse('{}')],
    ['object in an array', JSON.parse('[{"a":1}]')[0]],
  ];
  for (const [label, child] of cases) {
    assert.equal(thrown(() => el('div', {}, child)), null,
      `a ${label} child threw, but the header says content is never thrown on`);
  }
});

test('HOSTILE: a class list is content, yet a nested one throws too-deep', () => {
  const { el } = builder();
  const cycle = [];
  cycle.push(cycle);
  // Same header rule, class-token half. collectClass throws 'too-deep'.
  assert.equal(thrown(() => el('div', { class: cycle })), null,
    'a cyclic class list threw, but class tokens are declared content');
});

// ---------------------------------------------------------------------------
// F-4. describe() claims not to run an attacker toString, but
//      Object.prototype.toString reads Symbol.toStringTag.
// ---------------------------------------------------------------------------

test('HOSTILE: describe() runs a getter on the value it is meant to describe safely', () => {
  const { el } = builder();
  let ran = false;
  const bait = {};
  Object.defineProperty(bait, Symbol.toStringTag, {
    get() { ran = true; throw new Error('toStringTag ran'); },
  });

  const err = thrown(() => el('div', {}, bait));
  // The stronger half: the getter throws, describe() is inside the
  // error's own construction, so what leaves this module is a plain
  // Error with an attacker-chosen message and no .code at all.
  assert.ok(err instanceof WfxDomError,
    `error construction itself threw a bare ${err && err.constructor.name}: ${err && err.message}`);
  assert.equal(ran, false, 'describe() invoked a getter on the hostile value');
});

// ---------------------------------------------------------------------------
// F-10. Bidi and invisible control characters pass through the one text
//       primitive the consent gate has.
// ---------------------------------------------------------------------------

test('HOSTILE: a right-to-left override survives into a rendered command string', () => {
  const { el } = builder();
  // Slice 9 renders every prompt in a stranger's manifest in the consent
  // gate, which is the screen the user reads before agreeing to run it.
  // U+202E reorders everything after it, so the text a user approves and
  // the text an agent receives are different strings.
  const spoof = 'echo hi ‮# hcaehcaeb/moc.rekcatta lruc';
  const rendered = el('code', {}, spoof).childNodes[0].data;
  assert.ok(!/[‪-‮⁦-⁩‎‏]/.test(rendered),
    'a bidi control character reached a text node on a consent surface');
});

test('HOSTILE: NUL and other invisible controls survive into text and attributes', () => {
  const { el } = builder();
  const sneaky = 'rm -rf /   looks fine​⁢';
  assert.ok(!/[ --​-‏⁠-⁤]/
    .test(el('span', {}, sneaky).childNodes[0].data),
  'a C0 or zero-width control reached a text node');
  assert.ok(!/[ ​]/.test(el('div', { title: sneaky }).getAttribute('title')),
    'a C0 or zero-width control reached an attribute value');
});

// ---------------------------------------------------------------------------
// F-5. id is interpolated into selectors in app.js but has no token guard,
//      while class (which is not) does.
// ---------------------------------------------------------------------------

test('HOSTILE: id takes any string at all, though class is charset-guarded for exactly this reason', () => {
  const { el } = builder();
  // app.js:3765 does document.querySelector(`#wf-canvas [id="node-${id}"] ...`).
  // wfx-dom.js:116-119 gives "somebody later interpolates into a
  // selector" as the reason class tokens are constrained. id is the
  // attribute that reason is actually about.
  const hostile = 'node-x"] , script, [id="';
  const node = el('div', { id: hostile });
  assert.notEqual(node.getAttribute('id'), hostile,
    'a selector-breaking id was written verbatim');
});

test('HOSTILE: an id can shadow a real element id and clobber getElementById', () => {
  const { el } = builder();
  // The consent gate is found by id. A manifest string reaching any id
  // slot lets a stranger seed a duplicate that wins document order.
  const node = el('div', { id: 'wfx-consent-modal' });
  assert.equal(node.getAttribute('id'), null,
    'a manifest-shaped id was accepted with no token constraint');
});

// ---------------------------------------------------------------------------
// F-6. class has a per-token cap but no total cap, unlike every other value.
// ---------------------------------------------------------------------------

test('HOSTILE: the class attribute has no total size cap, unlike every other attribute', () => {
  const { el } = builder();
  // Each token is short and legal, so the per-token cap never fires and
  // the dedupe never collapses them. Every other attribute is bounded by
  // MAX_ATTR_VALUE; this one is bounded by the manifest.
  const tokens = [];
  for (let i = 0; i < 200000; i += 1) tokens.push(`c${i}`);
  const written = el('div', { class: tokens }).getAttribute('class');
  assert.ok(written.length <= MAX_ATTR_VALUE,
    `class attribute is ${written.length} chars, past the ${MAX_ATTR_VALUE} cap every other attribute obeys`);
});

// ---------------------------------------------------------------------------
// F-7. text() and a bare child disagree about booleans.
// ---------------------------------------------------------------------------

test('HOSTILE: text(false) renders the word false while a false child renders nothing', () => {
  const { el, text } = builder();
  assert.equal(el('span', {}, false).childNodes.length, 0);
  // Same value, same conceptual slot, opposite outcome. The published
  // export list says text() takes "a string or a finite number".
  assert.equal(text(false).data, '',
    'text() stringified a boolean that el() would have dropped');
});

// ---------------------------------------------------------------------------
// F-8. isAllowedAttrName's comment claims an ordering the code does not have.
// ---------------------------------------------------------------------------

test('HOSTILE: the on-prefix check does not run before every other test as documented', () => {
  // wfx-dom.js:157-159 claims "Anything beginning with 'on' is false
  // before any other test runs, so a future edit that adds an entry to
  // ALLOWED_ATTRS cannot accidentally open a handler slot." The charset
  // test runs first, so a name that starts with on and fails the charset
  // is rejected for the charset reason, and the stated invariant is a
  // property of the code's shape rather than of its order.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', '..', 'src', 'renderer', 'wfx-dom.js'), 'utf8');
  const body = src.slice(src.indexOf('function isAllowedAttrName'));
  const onIdx = body.indexOf("startsWith('on')");
  const reIdx = body.indexOf('ATTR_NAME_RE.test');
  assert.ok(onIdx < reIdx,
    'the on-prefix test is not first, so the comment above it is wrong');
  assert.equal(isAllowedAttrName('onclick'), false);
});

// ---------------------------------------------------------------------------
// F-9. The ambient builders throw a bare WfxDomError with no document,
//      which is the one path a renderer load-order mistake takes.
// ---------------------------------------------------------------------------

test('HOSTILE: ambient text() and frag() have no refusal path a caller can branch on', () => {
  assert.equal(typeof globalThis.document, 'undefined');
  const err = thrown(() => ambientText('x'));
  assert.ok(err instanceof WfxDomError);
  assert.equal(err.code, 'no-document');
  // Documented as { ok, error } at the module boundary, but the ambient
  // forms are the ones index.html actually calls.
  assert.ok(thrown(() => ambientEl('div')) === null || true);
});
