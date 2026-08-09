'use strict';

// A hand-written DOM, sized to exactly four files.
//
// src/renderer/wfx-dom.js, wfx-artifact-ui.js, wfx-install.js and
// wfx-publish.js are classic scripts loaded by index.html rather than
// modules, so there is nothing to require, and the repo carries no
// jsdom. The document is written here by hand, and it implements the
// subset those four files touch and nothing else: every method below
// exists because a grep over them found a call site for it.
//
// Three fidelity decisions are worth stating up front:
//
//   - Every node is a real instance of the Node class exported from
//     this file, and document.defaultView.Node points at that class.
//     wfx-dom.js checks a child it did not build itself with
//     `child instanceof doc.defaultView.Node`, and the SVG glyphs in
//     wfx-artifact-ui.js are built with createElementNS outside the
//     builder and handed back to el() as children, so the class
//     hierarchy is what makes the four files loadable at all.
//   - setAttribute is stricter than the real one, on purpose: it
//     refuses a name that could not be written in markup and refuses a
//     non-string value.
//   - `value` and `checked` are plain properties, not attribute
//     reflections, which is what the real DOM does once a control has
//     been interacted with. The four files only ever read them back
//     after writing them.
//
// The selector engine understands type, #id, .class, [attr] and
// [attr="value"] compounds joined by descendant and child combinators,
// which covers every selector string in the four files. Its descendant
// match is greedy rather than backtracking, and no selector here is
// more than two compounds long.

// Names the HTML parser can produce. A name outside this charset gets
// InvalidCharacterError, as in the real DOM.
const MARKUP_SAFE_NAME = /^[A-Za-z_:][-A-Za-z0-9_:.]*$/;

// One compound selector: an optional type, plus any number of #id,
// .class and [attr] clauses in any order.
const COMPOUND_RE = /([#.][A-Za-z_-][\w-]*)|(\[\s*([A-Za-z_:][-\w:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*)?\])/g;

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const DOCUMENT_NODE = 9;
const FRAGMENT_NODE = 11;

// ─── Nodes ───────────────────────────────────────────────────────────────────

// The base every other node extends, and the reason it is a class rather
// than a factory: see the module header on instanceof.
class Node {
  constructor(ownerDocument, nodeType) {
    this.ownerDocument = ownerDocument || null;
    this.nodeType = nodeType;
    this.childNodes = [];
    this.parentNode = null;
    this._listeners = new Map();
  }

  get parentElement() {
    return (this.parentNode && this.parentNode.nodeType === ELEMENT_NODE) ? this.parentNode : null;
  }

  get firstChild() {
    return this.childNodes.length ? this.childNodes[0] : null;
  }

  get lastChild() {
    return this.childNodes.length ? this.childNodes[this.childNodes.length - 1] : null;
  }

  get nextSibling() {
    return siblingAt(this, 1);
  }

  get previousSibling() {
    return siblingAt(this, -1);
  }

  get children() {
    return this.childNodes.filter((n) => n.nodeType === ELEMENT_NODE);
  }

  // Fragments are spread rather than inserted, matching the render paths
  // that return a fragment for the caller to append into a host.
  appendChild(child) {
    return this.insertBefore(child, null);
  }

  insertBefore(child, ref) {
    if (!(child instanceof Node)) {
      throw new TypeError('insertBefore: argument is not a Node');
    }
    if (child.nodeType === FRAGMENT_NODE) {
      for (const grand of child.childNodes.slice()) this.insertBefore(grand, ref);
      child.childNodes.length = 0;
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    if (ref && at < 0) throw new Error('insertBefore: reference node is not a child');
    if (at < 0) this.childNodes.push(child);
    else this.childNodes.splice(at, 0, child);
    child.parentNode = this;
    return child;
  }

  removeChild(child) {
    const at = this.childNodes.indexOf(child);
    if (at < 0) throw new Error('removeChild: node is not a child');
    this.childNodes.splice(at, 1);
    child.parentNode = null;
    return child;
  }

  replaceChild(next, prev) {
    const at = this.childNodes.indexOf(prev);
    if (at < 0) throw new Error('replaceChild: node is not a child');
    this.insertBefore(next, prev);
    return this.removeChild(prev);
  }

  // The renderer surfaces build a block and swap it in one call, and a string
  // among the arguments becomes a text node. Detaches first rather than
  // iterating the live list, because insertBefore reparents.
  replaceChildren(...next) {
    for (const child of this.childNodes.splice(0)) child.parentNode = null;
    const doc = this.ownerDocument || this;
    for (const child of next) {
      // (Node or DOMString), so a non-Node stringifies, null included.
      this.appendChild(child instanceof Node ? child : doc.createTextNode(String(child)));
    }
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  contains(other) {
    let cursor = other;
    while (cursor) {
      if (cursor === this) return true;
      cursor = cursor.parentNode;
    }
    return false;
  }

  get textContent() {
    if (this.nodeType === TEXT_NODE) return this.data;
    let out = '';
    for (const child of this.childNodes) out += child.textContent;
    return out;
  }

  set textContent(value) {
    if (this.nodeType === TEXT_NODE) { this.data = String(value); return; }
    for (const child of this.childNodes.slice()) this.removeChild(child);
    const s = (value === null || value === undefined) ? '' : String(value);
    if (s) this.appendChild(this.ownerDocument.createTextNode(s));
  }

  addEventListener(type, fn, opts) {
    if (typeof fn !== 'function') return;
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push({ fn, once: !!(opts && opts.once) });
  }

  removeEventListener(type, fn) {
    const bound = this._listeners.get(type);
    if (!bound) return;
    const at = bound.findIndex((entry) => entry.fn === fn);
    if (at >= 0) bound.splice(at, 1);
  }

  // Bubbling is modelled because the receipts strip depends on it: the
  // chip's click handler calls stopPropagation to keep the press off the
  // card behind it.
  dispatchEvent(event) {
    const type = event && event.type;
    if (!type) return true;
    const path = [];
    for (let cursor = this; cursor; cursor = cursor.parentNode) path.push(cursor);
    let stopped = false;
    event.target = this;
    event.stopPropagation = () => { stopped = true; };
    for (const node of path) {
      const bound = node._listeners.get(type);
      if (bound) {
        event.currentTarget = node;
        for (const entry of bound.slice()) {
          if (entry.once) node.removeEventListener(type, entry.fn);
          entry.fn.call(node, event);
        }
      }
      if (stopped) break;
    }
    return true;
  }

  querySelector(selector) {
    return firstMatch(this, parseSelector(selector));
  }

  querySelectorAll(selector) {
    const steps = parseSelector(selector);
    const out = [];
    walkElements(this, (node) => { if (matchesSteps(node, steps)) out.push(node); });
    return out;
  }
}

function siblingAt(node, delta) {
  const parent = node.parentNode;
  if (!parent) return null;
  const at = parent.childNodes.indexOf(node);
  const want = at + delta;
  return (want >= 0 && want < parent.childNodes.length) ? parent.childNodes[want] : null;
}

class Text extends Node {
  constructor(ownerDocument, data) {
    super(ownerDocument, TEXT_NODE);
    if (typeof data !== 'string') throw new TypeError(`createTextNode got a ${typeof data}`);
    this.data = data;
    this.nodeName = '#text';
  }

  get length() {
    return this.data.length;
  }

  get nodeValue() {
    return this.data;
  }

  // The prompt renderer's {{previousOutput}} highlight splits a text node
  // el() already wrote, rather than replacing a string into markup.
  splitText(offset) {
    const tail = new Text(this.ownerDocument, this.data.slice(offset));
    this.data = this.data.slice(0, offset);
    if (this.parentNode) this.parentNode.insertBefore(tail, this.nextSibling);
    return tail;
  }
}

class Element extends Node {
  constructor(ownerDocument, localName, namespaceURI) {
    super(ownerDocument, ELEMENT_NODE);
    this.localName = localName;
    this.tagName = namespaceURI ? localName : localName.toUpperCase();
    this.namespaceURI = namespaceURI || null;
    this.attributes = new Map();
    // Plain properties rather than attribute reflections; see the module
    // header.
    this.value = '';
    this.checked = false;
  }

  setAttribute(name, value) {
    if (typeof name !== 'string' || !MARKUP_SAFE_NAME.test(name)) {
      throw new Error(`InvalidCharacterError: ${String(name)}`);
    }
    if (typeof value !== 'string') {
      throw new TypeError(`setAttribute got a ${typeof value} value for "${name}"`);
    }
    this.attributes.set(name, value);
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  get id() {
    return this.getAttribute('id') || '';
  }

  set id(value) {
    this.setAttribute('id', String(value));
  }

  get className() {
    return this.getAttribute('class') || '';
  }

  // hidden and disabled are presence attributes in markup and booleans as
  // properties, reflected both ways.
  get hidden() {
    return this.hasAttribute('hidden');
  }

  set hidden(value) {
    if (value) this.setAttribute('hidden', '');
    else this.removeAttribute('hidden');
  }

  get disabled() {
    return this.hasAttribute('disabled');
  }

  set disabled(value) {
    if (value) this.setAttribute('disabled', '');
    else this.removeAttribute('disabled');
  }

  // Reads through to the class attribute on every call rather than caching,
  // because el() writes the attribute directly.
  get classList() {
    const owner = this;
    const read = () => (owner.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    const write = (tokens) => {
      if (tokens.length) owner.setAttribute('class', tokens.join(' '));
      else owner.removeAttribute('class');
    };
    return {
      contains: (token) => read().includes(token),
      add: (...tokens) => {
        const kept = read();
        for (const token of tokens) if (!kept.includes(token)) kept.push(token);
        write(kept);
      },
      remove: (...tokens) => write(read().filter((t) => !tokens.includes(t))),
      toggle: (token, force) => {
        const on = (force === undefined) ? !read().includes(token) : !!force;
        if (on) this.classList.add(token);
        else this.classList.remove(token);
        return on;
      },
      get length() { return read().length; },
      toString: () => read().join(' '),
    };
  }

  // DOMStringMap, in the direction el() writes it: a camelCase key is the
  // dashed attribute and back again.
  get dataset() {
    const owner = this;
    const attrFor = (key) => `data-${String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    const map = {};
    for (const [name, value] of owner.attributes) {
      if (!name.startsWith('data-')) continue;
      const key = name.slice(5).replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
      map[key] = value;
    }
    return new Proxy(map, {
      get: (target, key) => (typeof key === 'string' ? target[key] : undefined),
      set: (target, key, value) => {
        target[key] = String(value);
        owner.setAttribute(attrFor(key), String(value));
        return true;
      },
      deleteProperty: (target, key) => {
        delete target[key];
        owner.removeAttribute(attrFor(key));
        return true;
      },
    });
  }

  closest(selector) {
    const steps = parseSelector(selector);
    for (let cursor = this; cursor; cursor = cursor.parentNode) {
      if (cursor.nodeType === ELEMENT_NODE && matchesSteps(cursor, steps)) return cursor;
    }
    return null;
  }

  matches(selector) {
    return matchesSteps(this, parseSelector(selector));
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  blur() {
    if (this.ownerDocument && this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = this.ownerDocument.documentElement;
    }
  }

  click() {
    this.dispatchEvent({ type: 'click' });
  }

  // A no-op with a signature: the call sites only ask a row to be
  // visible and never read anything back, and this shim has no layout.
  scrollIntoView() {}
}

class DocumentFragment extends Node {
  constructor(ownerDocument) {
    super(ownerDocument, FRAGMENT_NODE);
  }
}

class Document extends Node {
  constructor() {
    super(null, DOCUMENT_NODE);
    this.ownerDocument = this;
    // 'loading' by default so a file that wires itself on DOMContentLoaded
    // defers until a test says the page is ready.
    this.readyState = 'loading';
    this.defaultView = null;
    this.documentElement = new Element(this, 'html');
    this.body = new Element(this, 'body');
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }

  createElement(tag) {
    if (typeof tag !== 'string' || !tag) throw new TypeError('createElement: tag must be a non-empty string');
    return new Element(this, tag, null);
  }

  createElementNS(ns, tag) {
    if (typeof tag !== 'string' || !tag) throw new TypeError('createElementNS: tag must be a non-empty string');
    return new Element(this, tag, ns || null);
  }

  createTextNode(data) {
    return new Text(this, data);
  }

  createDocumentFragment() {
    return new DocumentFragment(this);
  }

  getElementById(id) {
    let found = null;
    walkElements(this, (node) => {
      if (!found && node.getAttribute('id') === id) found = node;
    });
    return found;
  }
}

// ─── Selectors ───────────────────────────────────────────────────────────────

function parseCompound(source) {
  const compound = { tag: null, ids: [], classes: [], attrs: [] };
  const typeMatch = /^([A-Za-z][\w-]*|\*)/.exec(source);
  let rest = source;
  if (typeMatch) {
    compound.tag = typeMatch[1] === '*' ? null : typeMatch[1].toLowerCase();
    rest = source.slice(typeMatch[0].length);
  }
  COMPOUND_RE.lastIndex = 0;
  let consumed = 0;
  let m = COMPOUND_RE.exec(rest);
  while (m) {
    if (m.index !== consumed) break;
    consumed = m.index + m[0].length;
    if (m[1]) {
      if (m[1][0] === '#') compound.ids.push(m[1].slice(1));
      else compound.classes.push(m[1].slice(1));
    } else {
      const value = m[4] !== undefined ? m[4] : (m[5] !== undefined ? m[5] : m[6]);
      compound.attrs.push({ name: m[3], value: value === undefined ? null : value });
    }
    m = COMPOUND_RE.exec(rest);
  }
  if (consumed !== rest.length) {
    throw new Error(`dom-shim: unsupported selector fragment "${source}"`);
  }
  return compound;
}

function parseSelector(selector) {
  if (typeof selector !== 'string' || !selector.trim()) {
    throw new Error(`dom-shim: unsupported selector ${JSON.stringify(selector)}`);
  }
  if (selector.includes(',')) {
    throw new Error('dom-shim: selector lists are not supported, and nothing under test uses one');
  }
  const steps = [];
  // Splitting on the child combinator first, then on whitespace, keeps the
  // two combinators the four files use apart without a real tokenizer.
  for (const chunk of selector.trim().split(/\s*>\s*/)) {
    const parts = chunk.trim().split(/\s+/).filter(Boolean);
    parts.forEach((part, i) => {
      const combinator = (steps.length === 0) ? null : ((i === 0) ? '>' : ' ');
      steps.push({ combinator, compound: parseCompound(part) });
    });
  }
  return steps;
}

function matchCompound(node, compound) {
  if (!node || node.nodeType !== ELEMENT_NODE) return false;
  if (compound.tag && node.localName.toLowerCase() !== compound.tag) return false;
  for (const id of compound.ids) if (node.getAttribute('id') !== id) return false;
  for (const cls of compound.classes) if (!node.classList.contains(cls)) return false;
  for (const attr of compound.attrs) {
    if (!node.hasAttribute(attr.name)) return false;
    if (attr.value !== null && node.getAttribute(attr.name) !== attr.value) return false;
  }
  return true;
}

function matchesSteps(node, steps) {
  let i = steps.length - 1;
  if (!matchCompound(node, steps[i].compound)) return false;
  let cursor = node;
  while (i > 0) {
    const combinator = steps[i].combinator;
    const want = steps[i - 1].compound;
    if (combinator === '>') {
      cursor = cursor.parentNode;
      if (!matchCompound(cursor, want)) return false;
    } else {
      let up = cursor.parentNode;
      while (up && !matchCompound(up, want)) up = up.parentNode;
      if (!up) return false;
      cursor = up;
    }
    i -= 1;
  }
  return true;
}

function walkElements(root, visit) {
  for (const child of root.childNodes) {
    if (child.nodeType === ELEMENT_NODE) visit(child);
    if (child.childNodes.length) walkElements(child, visit);
  }
}

function firstMatch(root, steps) {
  let found = null;
  walkElements(root, (node) => {
    if (!found && matchesSteps(node, steps)) found = node;
  });
  return found;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

function createDocument() {
  return new Document();
}

// Every text node under a subtree, in document order. Assertions about
// what a builder wrote are usually assertions about this list.
function textNodes(root) {
  const out = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === TEXT_NODE) out.push(child);
      else walk(child);
    }
  };
  walk(root);
  return out;
}

module.exports = {
  Node,
  Text,
  Element,
  DocumentFragment,
  Document,
  createDocument,
  textNodes,
  ELEMENT_NODE,
  TEXT_NODE,
  DOCUMENT_NODE,
  FRAGMENT_NODE,
};
