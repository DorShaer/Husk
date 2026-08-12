'use strict';

// DOM builder for workflow surfaces that render untrusted .husk.json data.
// It never parses markup: elements come from createElement, attributes are
// allowlisted, and strings become scrubbed text nodes. Programmer-shape errors
// throw; manifest content is rendered, truncated, dropped, or refused with a
// code.

// Allowlisted inert tags only.
const ALLOWED_TAGS = Object.freeze([
  'div', 'span', 'p', 'pre', 'code', 'strong', 'em', 'b', 'i', 'small',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'section', 'header', 'footer', 'article', 'aside', 'nav',
  'details', 'summary', 'figure', 'figcaption',
  'button', 'label', 'input', 'fieldset', 'legend', 'output',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'hr', 'br', 'time', 'abbr', 'kbd', 'samp', 'var', 'sup', 'sub',
]);
const TAGS = new Set(ALLOWED_TAGS);

// Inert attributes only.
const ALLOWED_ATTRS = Object.freeze([
  'id', 'class', 'title', 'role', 'lang', 'dir',
  'hidden', 'disabled', 'open', 'checked', 'readonly', 'multiple',
  'required', 'selected',
  'tabindex', 'type', 'name', 'value', 'placeholder', 'for',
  'colspan', 'rowspan', 'scope', 'headers', 'datetime',
  'maxlength', 'minlength', 'min', 'max', 'step', 'inputmode',
]);
const ATTRS = new Set(ALLOWED_ATTRS);

// Presence attrs accept only real booleans: hidden="false" is still hidden.
const BOOLEAN_ATTRS = new Set([
  'hidden', 'disabled', 'open', 'checked', 'readonly', 'multiple',
  'required', 'selected',
]);

// Allowed type values, per tag.
const INPUT_TYPES = new Set(['checkbox', 'radio', 'text', 'search', 'number', 'hidden']);
const BUTTON_TYPES = new Set(['button', 'submit', 'reset']);

// Lowercase only, no colon.
const ATTR_NAME_RE = /^[a-z][a-z0-9-]*$/;
const DATA_SUFFIX_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ARIA_SUFFIX_RE = /^[a-z]+$/;
const DATASET_KEY_RE = /^[a-z][A-Za-z0-9]*$/;
// Token shape for class values.
const CLASS_TOKEN_RE = /^[A-Za-z0-9_-]+$/;

// Builder-owned namespace for ids and id references.
const ID_REF_RE = /^wfxd-[A-Za-z0-9_-]{1,64}$/;
const NAME_TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Exact shell ids runtime content may reference for accessibility.
const SHELL_REF_IDS = new Set([
  'wfx-in-title',
]);

// Attributes that name one id or a space-separated id list.
const SINGLE_REF_ATTRS = new Set([
  'for', 'aria-activedescendant', 'aria-details', 'aria-errormessage',
]);
const REF_LIST_ATTRS = new Set([
  'headers', 'aria-controls', 'aria-describedby', 'aria-flowto',
  'aria-labelledby', 'aria-owns',
]);

const MAX_ATTR_NAME = 64;
const MAX_ATTR_VALUE = 4096;
const MAX_CLASS_TOKEN = 64;
// Bounds nested child/class arrays; cycles are tracked separately.
const MAX_CHILD_DEPTH = 16;

// Coded errors let callers/tests branch without matching text.
class WfxDomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WfxDomError';
    this.code = code;
  }
}

// Characters that take up no visual space, that reorder the ones after
// them, or that break a line. Tab, newline and carriage return are the
// three controls a prompt legitimately carries and are the only ones
// kept. The class is written as Unicode properties rather than as a
// hand-maintained range list, so the tables decide what counts:
// \p{Cf} is every format character, \p{Default_Ignorable_Code_Point}
// adds the ones that are not format characters, and \p{Zl} with \p{Zp}
// adds U+2028 and U+2029. The C0 and C1 controls stay spelled out
// because they are the only part of the class with an exception carved
// into it.
const INVISIBLE_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/gu;

// Matches a surrogate that has no partner, including one the attribute
// cap below creates by cutting a pair in half.
const UNPAIRED_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// Scrubbed characters are replaced rather than deleted, so the text on
// screen shows where they were. U+FFFD is one code unit wide, so a
// capped value stays capped. The scrub reports on the string; nothing
// downstream reads what this module wrote.
const REPLACEMENT = '\uFFFD';

function scrub(value) {
  return value
    .replace(INVISIBLE_RE, REPLACEMENT)
    .replace(UNPAIRED_SURROGATE_RE, REPLACEMENT);
}

// Cuts to the cap first and scrubs second, so a pair the cut split is
// repaired by the same pass, and the result is at most MAX_ATTR_VALUE
// code units and well formed.
function capAttrValue(value) {
  const cut = value.length > MAX_ATTR_VALUE ? value.slice(0, MAX_ATTR_VALUE) : value;
  return scrub(cut);
}

// Asking a value what it is can fail: Array.isArray and Object.keys
// both answer a revoked Proxy with a TypeError outside this module's
// taxonomy. Every place that needs the answer goes through these two,
// which return null for "it refused to say" so the caller can decide
// whether that is a refusal to render or a value to drop.
function safeIsArray(value) {
  try {
    return Array.isArray(value);
  } catch (_) {
    return null;
  }
}

function safeOwnKeys(value) {
  try {
    return Object.keys(value);
  } catch (_) {
    return null;
  }
}

// Renders any value for an error message. It reads no property of the
// value at all: typeof and safeIsArray are the whole vocabulary, so
// nothing here runs code written outside this file. describe() runs
// inside the construction of every WfxDomError, which is why the try is
// here as well.
function describe(value) {
  let s;
  try {
    switch (typeof value) {
      case 'object': {
        if (value === null) { s = 'null'; break; }
        const arrayness = safeIsArray(value);
        // A value that will not say what it is gets described as
        // little as it told us.
        s = arrayness === null ? 'a value' : (arrayness ? 'an array' : 'an object');
        break;
      }
      case 'function': s = 'a function'; break;
      case 'symbol': s = 'a symbol'; break;
      case 'string': s = value; break;
      // number, bigint, boolean and undefined are primitives, so String()
      // runs nothing written outside this file.
      default: s = String(value); break;
    }
  } catch (_) {
    s = 'a value';
  }
  return scrub(s.length > 40 ? `${s.slice(0, 40)}...` : s);
}

function isAllowedTag(tag) {
  return typeof tag === 'string' && TAGS.has(tag);
}

// True for the fixed allowlist plus well-formed data-* and aria-*.
function isAllowedAttrName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_ATTR_NAME) return false;
  // The handler test runs first, ahead of the charset and the
  // allowlist lookup.
  if (name.startsWith('on')) return false;
  if (!ATTR_NAME_RE.test(name)) return false;
  if (name.startsWith('data-')) return DATA_SUFFIX_RE.test(name.slice(5));
  if (name.startsWith('aria-')) return ARIA_SUFFIX_RE.test(name.slice(5));
  return ATTRS.has(name);
}

// Returns the string to hand setAttribute, or null when the attribute
// should be left off entirely. null and undefined mean "absent" so a
// caller can write { title: maybeText } without branching.
function resolveValue(name, value) {
  if (value === null || value === undefined) return null;

  if (BOOLEAN_ATTRS.has(name)) {
    if (typeof value !== 'boolean') {
      throw new WfxDomError('bad-attr-value',
        `el(): "${name}" is presence-based, pass a boolean, got ${describe(value)}`);
    }
    return value ? '' : null;
  }

  const wantsWordBoolean = name.startsWith('aria-') || name.startsWith('data-');
  if (typeof value === 'boolean') {
    // ARIA states are the string "true" or "false"; an empty value is
    // invalid there, and dataset stringifies the same way, so both take
    // the word rather than the HTML presence convention.
    if (wantsWordBoolean) return value ? 'true' : 'false';
    throw new WfxDomError('bad-attr-value',
      `el(): "${name}" takes a string, got a boolean`);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new WfxDomError('bad-attr-value',
        `el(): "${name}" got ${describe(value)}, which is a computation bug, not a value`);
    }
    return String(value);
  }
  // A bigint goes through capAttrValue rather than String() on its own,
  // so the cap and the scrub stay one chokepoint every value passes.
  if (typeof value === 'bigint') return capAttrValue(String(value));

  if (typeof value !== 'string') {
    throw new WfxDomError('bad-attr-value',
      `el(): "${name}" takes a string, got ${describe(value)}`);
  }
  return capAttrValue(value);
}

// An id this builder will write into a reference: one it minted
// itself, or one of the handful the shell owns. `id` itself is held to
// the builder namespace alone, in shapeReference.
function isReferableId(token) {
  return ID_REF_RE.test(token) || SHELL_REF_IDS.has(token);
}

// Runs before setAttribute for every attribute whose value names an
// element rather than describing one. A value outside the namespace is
// dropped and the element is written without it.
function shapeReference(name, value) {
  if (name === 'id') return ID_REF_RE.test(value) ? value : null;
  if (SINGLE_REF_ATTRS.has(name)) return isReferableId(value) ? value : null;
  if (REF_LIST_ATTRS.has(name)) {
    // An IDREFS value is space separated, so it is filtered token by
    // token: one bad reference does not cost the caller the good ones.
    const refs = value.split(/\s+/).filter(isReferableId);
    return refs.length ? refs.join(' ') : null;
  }
  if (name === 'name') return NAME_TOKEN_RE.test(value) ? value : null;
  return value;
}

// tag is passed through so `type` can be checked against the element it
// is landing on. It is null on the dataset and aria paths, where the
// name is prefixed and `type` cannot occur.
function applyOne(node, tag, name, value) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new WfxDomError('bad-attr-name', `el(): attribute name must be a non-empty string, got ${describe(name)}`);
  }
  if (name.toLowerCase().startsWith('on')) {
    throw new WfxDomError('event-attr',
      `el(): refusing attribute "${describe(name)}"; bind handlers with addEventListener, never from data`);
  }
  if (!isAllowedAttrName(name)) {
    throw new WfxDomError('bad-attr-name',
      `el(): attribute "${describe(name)}" is not allowlisted`);
  }

  if (name === 'type') {
    const allowed = tag === 'input' ? INPUT_TYPES : (tag === 'button' ? BUTTON_TYPES : null);
    if (!allowed) {
      throw new WfxDomError('bad-attr-name', `el(): "type" is not meaningful on <${describe(tag)}>`);
    }
    if (typeof value !== 'string' || !allowed.has(value)) {
      throw new WfxDomError('bad-attr-value', `el(): <${tag} type="${describe(value)}"> is not allowlisted`);
    }
  }

  const resolved = resolveValue(name, value);
  if (resolved === null) return;
  const shaped = shapeReference(name, resolved);
  if (shaped === null) return;
  node.setAttribute(name, shaped);
}

// Class tokens are content: a bad one is dropped and this attribute
// never throws. Accepts a string, a number, or arbitrarily nested
// arrays of them, so the common ['wfx-fig', isInline && 'is-inline']
// form works.
function collectClass(value, out, depth) {
  if (value === null || value === undefined || typeof value === 'boolean') return;
  // A value that will not say what it is holds no class tokens, so it
  // falls through the string test below and is dropped like any other
  // shape that is not one.
  if (safeIsArray(value) === true) {
    // A list that contains itself stops at the depth cap rather than
    // raising, and so does a merely deep one. By this point every token
    // a real caller wrote has already been collected.
    if (depth >= MAX_CHILD_DEPTH) return;
    for (const item of value) collectClass(item, out, depth + 1);
    return;
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) collectClass(String(value), out, depth);
    return;
  }
  if (typeof value !== 'string') return;
  for (const token of value.split(/\s+/)) {
    if (!token || token.length > MAX_CLASS_TOKEN) continue;
    if (!CLASS_TOKEN_RE.test(token)) continue;
    out.push(token);
  }
}

function applyClass(node, value) {
  const tokens = [];
  collectClass(value, tokens, 0);
  const seen = new Set();
  const kept = [];
  let width = 0;
  for (const token of tokens) {
    if (seen.has(token)) continue;
    // The joined value obeys the same ceiling every other attribute
    // obeys. Stopping at the token that would cross the line, rather
    // than slicing the joined string, keeps every token written whole.
    const next = width === 0 ? token.length : width + 1 + token.length;
    if (next > MAX_ATTR_VALUE) break;
    seen.add(token);
    kept.push(token);
    width = next;
  }
  if (kept.length) node.setAttribute('class', kept.join(' '));
}

function applyDataset(node, value) {
  if (value === null || value === undefined) return;
  const keys = (typeof value === 'object' && safeIsArray(value) === false)
    ? safeOwnKeys(value)
    : null;
  // One refusal for both failures: a dataset that is not an object and
  // a dataset that will not be enumerated are equally unusable.
  if (keys === null) {
    throw new WfxDomError('bad-attr-value', `el(): dataset takes an object, got ${describe(value)}`);
  }
  for (const key of keys) {
    if (!DATASET_KEY_RE.test(key)) {
      throw new WfxDomError('bad-attr-name',
        `el(): dataset key "${describe(key)}" must be camelCase, as DOMStringMap requires`);
    }
    const name = `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    applyOne(node, null, name, value[key]);
  }
}

function applyAria(node, value) {
  if (value === null || value === undefined) return;
  const keys = (typeof value === 'object' && safeIsArray(value) === false)
    ? safeOwnKeys(value)
    : null;
  if (keys === null) {
    throw new WfxDomError('bad-attr-value', `el(): aria takes an object, got ${describe(value)}`);
  }
  for (const key of keys) {
    if (!ARIA_SUFFIX_RE.test(key)) {
      throw new WfxDomError('bad-attr-name', `el(): aria key "${describe(key)}" is not an ARIA attribute name`);
    }
    applyOne(node, null, `aria-${key}`, value[key]);
  }
}

function applyAttrs(node, tag, attrs) {
  if (attrs === null || attrs === undefined) return;
  // Object.keys reads own string keys only, and every one of them goes
  // through the name charset below. It is called through safeOwnKeys
  // because enumeration is a trappable operation.
  const keys = (typeof attrs === 'object' && safeIsArray(attrs) === false)
    ? safeOwnKeys(attrs)
    : null;
  if (keys === null) {
    throw new WfxDomError('bad-attrs', `el(): attrs must be a plain object, got ${describe(attrs)}`);
  }
  for (const key of keys) {
    const value = attrs[key];
    if (key === 'class') applyClass(node, value);
    else if (key === 'dataset') applyDataset(node, value);
    else if (key === 'aria') applyAria(node, value);
    else applyOne(node, tag, key, value);
  }
}

// Every node this module hands back is remembered here, which is how a
// child is confirmed to be a node rather than believed when it says it
// is one. A WeakSet keeps nothing alive, so a torn-down sheet costs
// nothing.
const BUILT = new WeakSet();

function remember(node) {
  if (node && (typeof node === 'object' || typeof node === 'function')) BUILT.add(node);
  return node;
}

// In the renderer the document has a defaultView and the real Node
// constructor is the authority, which is what lets a caller pass an
// element it built with document.createElement itself. Under the fake
// document the unit tests use there is no constructor to ask, and the
// WeakSet is the only answer.
function nodeConstructorFor(doc) {
  try {
    const view = doc.defaultView;
    if (view && typeof view.Node === 'function') return view.Node;
  } catch (_) { /* a document that throws on defaultView is not one to ask */ }
  return (typeof globalThis !== 'undefined' && typeof globalThis.Node === 'function')
    ? globalThis.Node
    : null;
}

function isRealNode(doc, value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
  if (BUILT.has(value)) return true;
  const Ctor = nodeConstructorFor(doc);
  if (!Ctor) return false;
  try {
    // instanceof consults Symbol.hasInstance on the constructor, never
    // on the value. It reads the prototype chain through
    // GetPrototypeOf, which a revoked proxy will not do, and a value
    // that cannot be asked whether it is a node is not one.
    return value instanceof Ctor;
  } catch (_) {
    return false;
  }
}

// Separates a plain manifest field, which is dropped, from an object
// presenting itself as a node, which is refused out loud. A nodeType is
// the claim itself; own symbol keys and an own toString or valueOf
// change what a value answers when something coerces it. None of the
// three is read in a way that runs code: getOwnPropertySymbols and
// hasOwnProperty do not invoke getters, and the nodeType read is
// guarded, with a throwing getter counting as a claim.
function claimsToBeMoreThanData(value) {
  try {
    if (value.nodeType !== undefined) return true;
  } catch (_) {
    return true;
  }
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) return true;
    if (Object.prototype.hasOwnProperty.call(value, 'toString')) return true;
    if (Object.prototype.hasOwnProperty.call(value, 'valueOf')) return true;
  } catch (_) {
    return true;
  }
  return false;
}

// appendChild is the one call in here that can fail for a reason this
// module did not choose, so a foreign error from it is converted to a
// coded refusal like everything else. The message carries nothing from
// the error.
function attach(parent, node) {
  try {
    parent.appendChild(node);
  } catch (_) {
    throw new WfxDomError('bad-child', 'el(): the document refused a child');
  }
}

// Text goes through createTextNode rather than textContent because it is
// the same guarantee (the string is data, never parsed) and it composes
// with mixed children, which a textContent assignment would clobber.
function textNode(doc, data) {
  return remember(doc.createTextNode(data));
}

// `open` holds the arrays on the path from the top of this walk down to
// here, which is what separates a cycle from a merely deep list; a
// depth counter alone cannot tell them apart.
function appendAll(doc, parent, children, depth, open) {
  // Past the cap the walk stops and the surrounding tree renders,
  // exactly as collectClass stops a nested class list. Content is
  // dropped rather than thrown on, so the sheet still renders.
  if (depth > MAX_CHILD_DEPTH) return;
  for (const child of children) {
    // false and null are how a caller writes a conditional child, so
    // they are skipped rather than rendered as the word "false".
    if (child === null || child === undefined || typeof child === 'boolean') continue;
    if (typeof child === 'string') {
      attach(parent, textNode(doc, scrub(child)));
      continue;
    }
    if (typeof child === 'number') {
      if (!Number.isFinite(child)) {
        throw new WfxDomError('bad-child', `el(): child is ${describe(child)}, which is a computation bug, not text`);
      }
      attach(parent, textNode(doc, String(child)));
      continue;
    }
    if (typeof child === 'bigint') {
      attach(parent, textNode(doc, String(child)));
      continue;
    }
    const arrayness = safeIsArray(child);
    if (arrayness === null) {
      // Nothing JSON.parse produces refuses to say whether it is an
      // array; a revoked proxy does, and it is refused by code here
      // rather than left to raise a bare TypeError from IsArray.
      throw new WfxDomError('bad-child',
        'el(): a child refused to say what it is, which no value out of a manifest does');
    }
    if (arrayness) {
      // The loud case is a cycle, not depth. An array that contains
      // itself has no rendering at all and cannot come from JSON, so it
      // is our bug and says so; a merely deep one is content and was
      // handled by the cap at the top. Checking the path rather than a
      // counter keeps the same array used twice as a sibling out of it.
      if (open.has(child)) {
        throw new WfxDomError('too-deep', 'el(): a child array contains itself');
      }
      open.add(child);
      appendAll(doc, parent, child, depth + 1, open);
      open.delete(child);
      continue;
    }
    // A function or a symbol cannot come out of JSON.parse, so one in a
    // content slot came from our own source and is a programmer error.
    if (typeof child === 'function' || typeof child === 'symbol') {
      throw new WfxDomError('bad-child',
        `el(): child must be a string, number, node or array, got ${describe(child)}`);
    }
    if (isRealNode(doc, child)) {
      attach(parent, child);
      continue;
    }
    if (claimsToBeMoreThanData(child)) {
      throw new WfxDomError('bad-child',
        `el(): child presents itself as a node and is not one, got ${describe(child)}`);
    }
    // Everything left is an ordinary object in a slot the caller
    // expected to be text. It is content of the wrong shape, so it is
    // dropped and the tree renders on, and it is not stringified,
    // which would run its toString.
  }
}

function build(doc, tag, attrs, children) {
  if (!isAllowedTag(tag)) {
    throw new WfxDomError('bad-tag', `el(): tag "${describe(tag)}" is not allowlisted`);
  }
  const node = remember(doc.createElement(tag));
  applyAttrs(node, tag, attrs);
  // A fresh path set per element, because the cycle question is about
  // one walk. Sharing one across sibling elements would call a list
  // rendered twice in the same sheet a cycle.
  appendAll(doc, node, children, 0, new Set());
  return node;
}

// text() answers exactly what the same value would have rendered as a
// bare child. A value a child slot skips (null, undefined, a boolean)
// is an empty text node here, and so is one a child slot drops.
function buildText(doc, value) {
  if (value === null || value === undefined || typeof value === 'boolean') {
    return textNode(doc, '');
  }
  if (typeof value === 'string') return textNode(doc, scrub(value));
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new WfxDomError('bad-child', `text(): got ${describe(value)}, which is a computation bug, not text`);
    }
    return textNode(doc, String(value));
  }
  if (typeof value === 'bigint') return textNode(doc, String(value));
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new WfxDomError('bad-child', `text(): takes a string or number, got ${describe(value)}`);
  }
  // A node reaching text() is a caller mistake worth hearing about,
  // since the node cannot survive the conversion and would vanish.
  if (isRealNode(doc, value) || claimsToBeMoreThanData(value)) {
    throw new WfxDomError('bad-child', `text(): takes a string or number, got ${describe(value)}`);
  }
  return textNode(doc, '');
}

function buildFrag(doc, children) {
  const frag = remember(doc.createDocumentFragment());
  appendAll(doc, frag, children, 0, new Set());
  return frag;
}

const DOC_METHODS = ['createElement', 'createTextNode', 'createDocumentFragment'];

// The { ok, error } entry point. Binds the three builders to one
// document so nothing in this module reads a global, which is what lets
// the unit tests run under plain node against a fake document.
function createBuilder(doc) {
  if (!doc || (typeof doc !== 'object' && typeof doc !== 'function')) {
    return { ok: false, code: 'no-document', error: `createBuilder: expected a document, got ${describe(doc)}` };
  }
  for (const method of DOC_METHODS) {
    if (typeof doc[method] !== 'function') {
      return { ok: false, code: 'no-document', error: `createBuilder: document is missing ${method}()` };
    }
  }
  return {
    ok: true,
    el: (tag, attrs, ...children) => build(doc, tag, attrs, children),
    text: (value) => buildText(doc, value),
    frag: (...children) => buildFrag(doc, children),
  };
}

// Resolved per call rather than at load time: this file is a classic
// script in index.html and its load order relative to anything that
// swaps the document is not worth depending on.
function ambientDocument() {
  const doc = (typeof document !== 'undefined') ? document : null;
  if (!doc || typeof doc.createElement !== 'function') {
    throw new WfxDomError('no-document', 'el(): no document in this context, use createBuilder(doc)');
  }
  return doc;
}

// The ambient forms the renderer surfaces use. They delegate to exactly
// the builders the tests drive, so there is no second code path that
// only runs in Electron.
function el(tag, attrs, ...children) {
  return build(ambientDocument(), tag, attrs, children);
}

function text(value) {
  return buildText(ambientDocument(), value);
}

function frag(...children) {
  return buildFrag(ambientDocument(), children);
}

const api = {
  el,
  text,
  frag,
  createBuilder,
  isAllowedTag,
  isAllowedAttrName,
  WfxDomError,
  ALLOWED_TAGS,
  ALLOWED_ATTRS,
  MAX_ATTR_VALUE,
  MAX_CHILD_DEPTH,
};

// Dual surface on purpose. The renderer has no module system
// (contextIsolation true, nodeIntegration false, so index.html loads
// this as a plain script), while the unit tests require it directly.
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.WfxDom = api;
