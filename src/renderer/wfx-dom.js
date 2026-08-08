'use strict';

// The only DOM construction primitive the workflow artifact surfaces are
// allowed to use.
//
// The install sheet, the publish sheet, the consent gate and the card
// receipts strip all render strings that arrived inside a
// workflow.husk.json this machine did not write. This window runs with
// sandbox:false and its preload exposes workflows.create and
// workflows.run, so one interpolated string reaching innerHTML is not a
// cosmetic defect, it is script execution, and what that reaches covers
// writing a workflow with a pinned agentCommand and starting it. The
// house pattern everywhere else
// in app.js is a template literal assigned to .innerHTML; these surfaces
// do not get to use it, and this file is what they use instead.
//
// el() is the whole mitigation, and it is deliberately boring: every
// element comes from createElement, every attribute goes through
// setAttribute against an allowlist, and every value that is not already
// a node becomes a text node. Nothing in this file parses markup, so a
// string shaped like a tag has nothing here to be parsed by: it is
// content, and it stays content no matter which slot it lands in.
//
// Three deliberate omissions, each of which someone will eventually ask
// for:
//
//   - No href, src or style attribute. Each turns a string into a
//     navigation or a fetch (javascript: URLs, url() fetches) and none
//     of the four surfaces needs one: they are class-driven, and their
//     only navigation is a button with a listener bound in code.
//   - No innerHTML escape hatch, not even a commented one. An exception
//     granted to one call site reopens the whole hole.
//   - No event-handler attributes. A handler belongs on the element
//     via addEventListener, in our source, where a reader can see what
//     it closes over.
//
// Beyond markup, three things this module owns because nothing
// downstream of it can:
//
//   - Invisible and bidi characters are replaced with U+FFFD in every
//     text node and every string attribute value. The consent gate is
//     the screen a user reads before agreeing to let a stranger's
//     commands run against a bound directory, so a string that displays
//     differently from the way it executes is the failure this module
//     exists to catch, not a cosmetic problem. The class of characters
//     is defined by the Unicode tables rather than by a list somebody
//     remembered to extend; see INVISIBLE_RE.
//   - Every string attribute is capped and left well formed: the cut
//     never splits a surrogate pair, the class attribute obeys the same
//     ceiling as every other one rather than growing with the manifest,
//     and a bigint goes through the same cap its decimal expansion
//     would otherwise walk straight past.
//   - id, for, headers, name and the aria attributes that name an
//     element rather than describe one are namespaced, not free text.
//     They point either inside the namespace this builder mints or at
//     one of the handful of shell ids listed by hand in SHELL_REF_IDS.
//     See ID_REF_RE for why.
//
// On throwing. The rest of src/lib returns { ok, error } and never
// throws, because those modules validate input this machine did not
// write and a validator that throws has crashed the app. This module
// splits that line on purpose, and the split is drawn at what a
// stranger's JSON can actually produce:
//
//   - Structure is written as a literal by us, in our source: the tag
//     name, an attribute name, and the *type* of an attribute value. A
//     wrong one is a programmer error a manifest can never reach, and
//     it throws loudly so it dies in a unit test rather than shipping
//     an element that silently carries a handler. Passing an object
//     where the caller wrote { title: ... } is that kind of error: the
//     slot has a type, and the type came from us.
//   - Content is the stranger's data: children, class tokens and the
//     characters inside a string value. Content is turned into text,
//     truncated, or dropped, and it is not thrown on, because a file
//     this machine did not write has to produce a rendered refusal
//     rather than a blank pane. A child that is a plain object is
//     dropped, a class token that is not a token is dropped, an id
//     outside our namespace is dropped, and the surrounding tree still
//     renders.
//   - Two shapes stay loud even though they arrive in a content slot.
//     A child that is a function, a symbol, a non-finite number or an
//     array that contains itself is something JSON.parse cannot
//     produce, so it can only have come from our own source. Note the
//     wording: a *cycle*, not depth. A twenty-deep array is one line of
//     JSON and is therefore content, and it is handled the way a
//     twenty-deep class list is, by stopping at the cap and rendering
//     what is above it. A child that *claims* to be a node (it carries
//     a nodeType, its own symbol keys, or its own toString) and cannot
//     be verified as one is refused rather than dropped, because
//     dropping it would erase the only evidence that a value arrived
//     carrying a node's markings without being one.
//
// Everything that leaves this module carries a code. setAttribute
// cannot fail here, because every name it is handed has already passed
// a charset stricter than the one the DOM itself enforces, but three
// calls can fail for a reason this module did not choose: appendChild
// answers anything that is not a Node with a TypeError, and
// Array.isArray, Object.keys and instanceof all invoke an internal
// method that a revoked Proxy refuses outright. Each of those goes
// through a wrapper here, so a foreign error cannot escape mid-tree and
// leave a half-built sheet on screen.
//
// createBuilder(doc) is the { ok, error } entry point and is what the
// unit tests drive. This module touches no global of its own, so the
// tests exercise it against a small fake document with no jsdom and no
// new dependency.

// Tags these surfaces actually build. An allowlist rather than a
// denylist because the interesting tags (script, iframe, object, embed,
// link, base, meta, svg, math) are exactly the ones a denylist author
// forgets, and because a surface that needs a new tag should have to
// come here and think about it. Notably absent: <a> and <img>, which
// exist only to carry a URL, and this builder has no URL attribute.
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

// Attribute names that are not data-* or aria-*. Everything here is
// either inert or a well-understood UA behaviour. Anything that names a
// resource, a target or a script is absent, which is why the list is
// short enough to read in one pass.
const ALLOWED_ATTRS = Object.freeze([
  'id', 'class', 'title', 'role', 'lang', 'dir',
  'hidden', 'disabled', 'open', 'checked', 'readonly', 'multiple',
  'required', 'selected',
  'tabindex', 'type', 'name', 'value', 'placeholder', 'for',
  'colspan', 'rowspan', 'scope', 'headers', 'datetime',
  'maxlength', 'minlength', 'min', 'max', 'step', 'inputmode',
]);
const ATTRS = new Set(ALLOWED_ATTRS);

// Presence-based attributes: the HTML parser treats hidden="false" as
// hidden, which is the footgun this set exists to close. Only a real
// boolean is accepted for these, so a stringly-typed caller fails here
// instead of shipping an unclickable button.
const BOOLEAN_ATTRS = new Set([
  'hidden', 'disabled', 'open', 'checked', 'readonly', 'multiple',
  'required', 'selected',
]);

// `type` changes what an element *is*, so it is pinned per tag rather
// than accepted as free text. input type="image" and type="file" each
// bring behaviour (formaction, a file picker) that no surface here
// wants.
const INPUT_TYPES = new Set(['checkbox', 'radio', 'text', 'search', 'number', 'hidden']);
const BUTTON_TYPES = new Set(['button', 'submit', 'reset']);

// Lowercase only, and no colon, so a name can never be written in a form
// the HTML parser reads differently from the way we read it here.
const ATTR_NAME_RE = /^[a-z][a-z0-9-]*$/;
const DATA_SUFFIX_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
// Every ARIA attribute in the WAI-ARIA spec is a single lowercase word
// after the prefix (label, labelledby, describedby, pressed, modal).
const ARIA_SUFFIX_RE = /^[a-z]+$/;
// Mirrors DOMStringMap: dataset keys are camelCase and a dash in a key
// is an error rather than something to guess about.
const DATASET_KEY_RE = /^[a-z][A-Za-z0-9]*$/;
// A class token is inert once it goes through setAttribute, so this is
// not a security boundary; it is the token-shape guard. A
// receipt-derived status carrying a quote and a space has to become
// nothing at all, not a token somebody later interpolates into a
// selector or a template.
const CLASS_TOKEN_RE = /^[A-Za-z0-9_-]+$/;

// The selector argument above is really an argument about id, and about
// the two attributes that point at one. app.js calls getElementById 45
// times and interpolates an id straight into a selector
// (`#wf-canvas [id="node-${wfSelectedNodeId}"]`, app.js:3765), and the
// consent gate itself is found by id, so a manifest-derived id can both
// change what that selector matches and shadow a real element in
// document order.
// This builder therefore owns exactly one namespace and writes nothing
// outside it: an id it did not shape is dropped, the same way a class
// token that is not a token is dropped. Nothing static in index.html
// begins with "wfxd-", so an element built here can never answer a
// lookup meant for the shell.
const ID_REF_RE = /^wfxd-[A-Za-z0-9_-]{1,64}$/;
// `name` reaches no lookup in this window (these surfaces submit
// nothing), but it is still a string somebody can search on, so it is
// held to a plain token with no metacharacters in it.
const NAME_TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/;

// The one thing the namespace above cannot express: a built subtree
// occasionally has to point at an element it did not build, because the
// shell owns it. The ready pane is filled at runtime and its accessible
// name is the sheet's static heading, so aria-labelledby has to reach
// across the boundary or the pane is unlabelled.
//
// That is a reference to a specific element in index.html, not to a
// shape, so it is spelled as a list of the exact ids rather than as a
// pattern. A pattern is what would sink this: every control in the
// shell is spelled "wfx-" too (wfx-in-go is the Install button), and a
// prefix rule would hand a manifest string the run button's id. Adding
// an entry here means opening index.html, finding the id, and deciding
// that runtime content has a reason to name it.
const SHELL_REF_IDS = new Set([
  'wfx-in-title',
]);

// Attributes whose value is one id, and attributes whose value is a
// space-separated list of them. These are the ARIA half of the same
// invariant `id`, `for` and `headers` carry: they name an element, and a
// name that came out of a manifest names whatever the manifest chose,
// including the shell's own controls. resolveValue alone does not settle
// that: it caps a value at four thousand characters and has no opinion
// about which element those characters point at, so these two lists are
// what hold the reference to the namespace.
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
// Bounds recursion through nested child and class arrays. Sixteen is
// far past any real markup nesting, and the cap is what keeps a
// hundred-thousand-deep array out of the stack. It is not what catches a
// list containing itself: a cycle is caught by the path set in
// appendAll, because a cycle and a deep list are different findings and
// only one of them is worth losing an element over.
const MAX_CHILD_DEPTH = 16;

// Carries a code so a caller or a test can branch on the reason without
// matching on message text, matching how the import validator reports
// its refusals.
class WfxDomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WfxDomError';
    this.code = code;
  }
}

// Characters that take up no visual space, or that reorder the ones
// after them. U+202E turns the rest of a line around, so the command a
// user approves on the consent gate and the command the agent receives
// are different strings; a zero-width space splits a word a reader
// would otherwise recognise; a NUL prints as nothing at all. Tab,
// newline and carriage return are the three controls a prompt
// legitimately carries and are the only ones kept.
//
// The class is written as Unicode properties rather than as a list of
// ranges, and the reason is the tag block. U+E0000 to U+E007F is a
// complete, entirely invisible copy of ASCII, one well formed surrogate
// pair per character, which makes it the channel that matters rather
// than a curiosity: the import validator refuses a manifest carrying an
// unpaired surrogate and nothing else about unicode, so a hidden second
// command reaches this module well formed and is scrubbed here or
// nowhere. A hand-written range list misses it, and misses
// U+206A-206F sitting between two ranges such a list does name, the
// variation selectors, the interlinear annotation marks, and the Hangul
// fillers, which render as blanks without being format characters at
// all. Any list maintained by hand is a list of the invisibles somebody
// has heard of, so the tables decide instead: \p{Cf} is every format
// character, including the tag block and any the tables assign later;
// \p{Default_Ignorable_Code_Point} adds the ones that are not
// format characters; and \p{Zl} with \p{Zp} adds U+2028 and U+2029,
// which are not invisible but are line breaks, and a line break inside
// the <pre> the prompt list uses can push the real command out of the
// visible box. The C0 and C1 controls stay spelled out because they are
// the only part of the class with an exception carved into it.
const INVISIBLE_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/gu;

// A surrogate without its partner is not a character at all. The import
// validator refuses a manifest carrying one, and the attribute cap
// below can manufacture one by cutting a pair in half, so the condition
// is closed here rather than assumed to be gone.
const UNPAIRED_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// U+FFFD is what a decoder writes when a character could not be
// represented, which is exactly the fact being reported, and it is one
// code unit wide so a capped value stays capped. Deleting the character
// is the more dangerous choice: it would let a destructive command with
// a zero-width space inside a path render as the harmless one it is
// pretending to be, which is the reordering problem again with the
// evidence removed.
//
// The tag block makes that argument sharper rather than weaker, which
// is worth stating because the instinct on reading about hidden text is
// to strip it. 'git status' followed by twenty-one tag characters
// spelling a second chained command renders, if the tag characters are
// deleted, as the two words 'git status': exactly the string the file's
// author wants the consent gate to show, and the user then
// approves a command whose other half is still in the file the runner
// reads. Replaced, the same prompt renders as 'git status' followed by
// twenty-one replacement glyphs, which is unmistakably not a command
// and is the only signal this surface can give that the bytes and the
// pixels disagree. The scrub does not sanitise the prompt (nothing
// downstream reads what this module wrote); it reports on it.
const REPLACEMENT = '\uFFFD';

function scrub(value) {
  return value
    .replace(INVISIBLE_RE, REPLACEMENT)
    .replace(UNPAIRED_SURROGATE_RE, REPLACEMENT);
}

// A manifest field that survived validation is short; anything past the
// cap is either a bug or a file trying to put a megabyte into the DOM.
// The cut happens first and the scrub second, so a pair the cut split
// is repaired by the same pass that removes the invisibles, and the
// result is both exactly MAX_ATTR_VALUE code units and well formed.
function capAttrValue(value) {
  const cut = value.length > MAX_ATTR_VALUE ? value.slice(0, MAX_ATTR_VALUE) : value;
  return scrub(cut);
}

// Asking a value what it is can fail. Array.isArray runs the IsArray
// internal method and Object.keys runs OwnPropertyKeys, and a Proxy
// whose handler has been revoked answers both with a TypeError that is
// nothing to do with this module's taxonomy. Every place that needs the
// answer goes through these two, which return null for "it refused to
// say" so the caller can decide whether that is a refusal to render
// (structure) or a value to drop (content). The alternative, a bare
// TypeError leaving from the middle of a tree walk, is the half-built
// sheet the module header promises cannot happen.
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

// Renders any value for an error message without becoming a second bug.
// A template literal throws on a symbol and runs a toString the value's
// own author wrote, and Object.prototype.toString is no better because
// it reads Symbol.toStringTag, which can be a throwing getter. Since
// describe() runs inside the construction of every WfxDomError, a throw
// here would replace a coded refusal with a bare Error carrying a
// message written outside this file, so nothing below reads a property
// of the value at all: typeof and safeIsArray are the whole vocabulary.
// The try is here even though safeIsArray owns the proxy case, because
// this function runs while an error is being reported and an error
// raised there is the one failure with nothing left to catch it.
function describe(value) {
  let s;
  try {
    switch (typeof value) {
      case 'object': {
        if (value === null) { s = 'null'; break; }
        const arrayness = safeIsArray(value);
        // A value that will not answer what it is gets described as
        // little as it told us, which is nothing.
        s = arrayness === null ? 'a value' : (arrayness ? 'an array' : 'an object');
        break;
      }
      case 'function': s = 'a function'; break;
      case 'symbol': s = 'a symbol'; break;
      case 'string': s = value; break;
      // number, bigint, boolean and undefined are primitives, so String()
      // runs nothing that anyone outside this file wrote.
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
  // The handler test is first, ahead of the charset and ahead of the
  // allowlist lookup, so that no later edit to either one can open a
  // handler slot behind it.
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
  // A bigint is the one value type whose decimal expansion has no upper
  // bound at all, so it is the last type that should be allowed to skip
  // the ceiling. It goes through capAttrValue rather than String() on
  // its own so that the cap and the scrub stay one chokepoint every
  // value passes, instead of a rule with one type standing outside it.
  if (typeof value === 'bigint') return capAttrValue(String(value));

  if (typeof value !== 'string') {
    throw new WfxDomError('bad-attr-value',
      `el(): "${name}" takes a string, got ${describe(value)}`);
  }
  return capAttrValue(value);
}

// An id this builder is willing to write into a reference: one it
// minted itself, or one of the handful the shell owns. `id` itself is
// deliberately not run through here, because minting a shell id is the
// shadowing itself rather than a reference to it.
function isReferableId(token) {
  return ID_REF_RE.test(token) || SHELL_REF_IDS.has(token);
}

// The last gate before setAttribute, for every attribute whose value
// names an element rather than describing one. A value outside the
// namespace is content that cannot be a valid token, so it is dropped
// and the element is written without it, which is what the rest of the
// tree does with a bad class token.
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

// Class tokens are content: a bad one is dropped, and this is the one
// attribute that never throws at all, because it is assembled from many
// independent pieces and losing the whole element over one of them is
// exactly the blank pane the content rule exists to prevent. Accepts a
// string, a number, or arbitrarily nested arrays of them, so the common
// ['wfx-fig', isInline && 'is-inline'] form works.
function collectClass(value, out, depth) {
  if (value === null || value === undefined || typeof value === 'boolean') return;
  // safeIsArray returns null for a value that refuses to answer, and a
  // value that will not say what it is holds no class tokens, so it
  // falls through the string test below and is dropped like any other
  // shape that is not one.
  if (safeIsArray(value) === true) {
    // A list that contains itself stops here rather than raising, and
    // so does a merely deep one: the depth cap is what makes the
    // recursion safe, and by this point every token a real caller wrote
    // has already been collected. The child path raises on a cycle
    // where this one does not, and the difference is what the two slots
    // are worth: an unrenderable child list is the element, while a
    // class list is one of many independent pieces and dropping the
    // element over it is the blank pane again.
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
    // obeys. Without this a field carrying many short distinct tokens
    // is a multi-megabyte attribute on one element, since the per-token
    // cap never fires and the dedupe never collapses anything. Stopping
    // at the token that would cross the line, rather than slicing the
    // joined string, keeps every token that is written a whole one.
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
  // a dataset that will not be enumerated are equally unusable, and the
  // slot's type came from our source either way.
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
  // Object.keys skips symbols and the prototype chain, so a
  // JSON.parse'd '{"__proto__": ...}' arrives as an ordinary own key and
  // is refused by the name charset like anything else. It is called
  // through safeOwnKeys because enumeration is a trappable operation and
  // this is the outermost call of the three that make it.
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
// child is verified as a node instead of believed when it says it is
// one. Duck-typing on nodeType alone is not a check at all: JSON.parse
// hands back {"nodeType": 1} for free, appendChild answers a non-Node
// with a TypeError, and that TypeError is outside this module's
// taxonomy and aborts the render half way down the tree. A WeakSet
// keeps nothing alive, so a torn-down sheet costs nothing.
const BUILT = new WeakSet();

function remember(node) {
  if (node && (typeof node === 'object' || typeof node === 'function')) BUILT.add(node);
  return node;
}

// In the renderer the document has a defaultView and the real Node
// constructor is the authority, which is what lets a caller pass an
// element it built with document.createElement itself. Under the fake
// document the unit tests use there is no constructor to ask, and the
// WeakSet is the only answer, which is the strict behaviour: an object
// this module did not create is not a node.
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
    // instanceof walks the value's prototype chain and consults
    // Symbol.hasInstance on the constructor, never on the value, so the
    // value itself gets no say in the answer. It does read the chain
    // through GetPrototypeOf, though, which is the one thing a revoked
    // proxy will not do, and a value that cannot be asked whether it is
    // a node is not one.
    return value instanceof Ctor;
  } catch (_) {
    return false;
  }
}

// Separates a plain manifest field, which is dropped, from an object
// that is claiming to be something it is not, which is refused out
// loud. A nodeType is the claim itself; own symbol keys and an own
// toString are the slots that exist to change what a value pretends to
// be when something coerces it. None of the three is read in a way that
// runs code: getOwnPropertySymbols and hasOwnProperty do not invoke
// getters, and the one read that can (nodeType) is guarded, with a
// throwing getter counting as a claim, since nothing honest defines
// one.
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
// module did not choose. A foreign error escaping from it is what
// leaves a half-built sheet on screen, so it is converted to a coded
// refusal like everything else. The message carries nothing from the
// error, because the error's own fields are not ours to trust.
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
// depth counter alone cannot tell them apart. See the comment on the
// array branch below.
function appendAll(doc, parent, children, depth, open) {
  // Past the cap the walk stops and the surrounding tree renders,
  // exactly as collectClass stops a nested class list. Twenty nested
  // arrays are one line of JSON, so a manifest can produce this shape
  // for free, and content is dropped rather than thrown on: a file this
  // machine did not write has to produce a rendered refusal, not a
  // blank pane.
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
      // array; a revoked proxy does, and unhandled it is the shape that
      // puts a bare TypeError from IsArray on the way out of here.
      throw new WfxDomError('bad-child',
        'el(): a child refused to say what it is, which no value out of a manifest does');
    }
    if (arrayness) {
      // The loud case is a cycle, not depth. An array that contains
      // itself has no rendering at all and cannot come from JSON, so it
      // is our bug and says so; a merely deep one is content and was
      // handled by the cap at the top. Checking the path rather than
      // inferring from a counter also means the same array used twice as
      // a sibling is what it looks like, not a false cycle.
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
    // Everything left is an ordinary object out of a stranger's file
    // landing in a slot the caller expected to be text. It is content
    // of the wrong shape, so it is dropped and the tree renders on. It
    // is deliberately not stringified: that would run its toString.
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
// bare child, because a caller who wraps a field in text() for clarity
// must not get different output from one who does not. A value a child
// slot skips (null, undefined, a boolean) is an empty text node here,
// and a value a child slot drops (a plain object) is one too.
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
