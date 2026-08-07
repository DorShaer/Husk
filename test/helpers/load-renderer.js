'use strict';

// Loads the workflow-artifact renderer scripts the way index.html does.
//
// These four files are classic scripts, not modules. wfx-dom.js exports itself
// twice (module.exports for the tests, window.WfxDom for the page) but the
// other three only ever assign to window, and each is a single IIFE that reads
// `document` and `window` as ambient globals. So there is nothing to require,
// and requiring wfx-dom.js alone does not exercise the code path the app runs:
// window.WfxArtifactUi is built against whatever window.WfxDom holds, and el()
// resolves the ambient document per call.
//
// Each script is compiled with new Function and handed window, document and
// console as parameters, which shadow the globals of the same name for the
// whole body. That gives every file its own top-level scope, a fresh window
// and a fresh document per load, and no writes to the process global at all,
// which matters because these are unit tests sharing a process with sixty
// other files that have no business inheriting a document.
//
// Two alternatives were tried and are worth naming, because both look better
// than this until you use them.
//
// Setting globalThis.document and requiring the files works exactly once per
// process. require caches, so a second load returns the first load's exports
// against the first load's document, and wfx-dom.js keeps a WeakSet of every
// node it built, so a shared load lets one test file's nodes pass another test
// file's node check.
//
// node:vm gives real isolation and is the closer model of a page: one context
// per load, all four scripts sharing its top-level lexical scope the way they
// share index.html's. It was written that way first. The cost is that a vm
// context is a separate realm, so every array and object that comes back out
// has a different Array.prototype and fails assert/strict deepEqual against a
// host-realm literal. Paying for that in every assertion in three test files,
// to model a lexical scope no assertion here reads, was the wrong trade.
//
// What this therefore does not model: the page's single shared script scope,
// where a top-level const in wfx-dom.js and one of the same name in another
// file would be a redeclaration that stops the page loading. That is a real
// hazard the module headers call out, and it belongs to whoever adds a script
// tag to index.html rather than to a unit test.

const fs = require('node:fs');
const path = require('node:path');

const { createDocument, Node } = require('./dom-shim');

const RENDERER_DIR = path.join(__dirname, '..', '..', 'src', 'renderer');

// Load order is index.html's, and it is not arbitrary: wfx-artifact-ui.js
// defines nothing at all when window.WfxDom is absent and says so on the
// console. A test that loaded them the other way round would get an undefined
// export and a confusing failure a long way from the cause.
const KNOWN = Object.freeze({
  dom: 'wfx-dom.js',
  ui: 'wfx-artifact-ui.js',
  install: 'wfx-install.js',
  publish: 'wfx-publish.js',
});

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

const compiled = new Map();

// Compiled once per file and reused across loads, because compilation is the
// slow half and the resulting function closes over nothing: every load calls
// it with its own window and document.
//
// The one thing that is interpolated into the compiled body is the file's own
// path, and it comes from path.join on this directory plus a filename out of
// the frozen KNOWN table above. No caller can name a file, no caller can reach
// the body, and the body itself is a first-party source file out of this
// repository. A helper that took either from an argument would be a different
// function with a different comment on it.
function compile(file) {
  if (!compiled.has(file)) {
    const full = path.join(RENDERER_DIR, file);
    const source = fs.readFileSync(full, 'utf8');
    // sourceURL so a stack from inside a renderer file names the renderer
    // file rather than "anonymous", which is the difference between a
    // readable failure and a guess.
    compiled.set(file, { full, source: `${source}\n//# sourceURL=${full}\n` });
  }
  return compiled.get(file);
}

// The console the scripts get. Silent and recording, because
// wfx-artifact-ui.js reports a missing builder to console.error and nothing
// else, so that one line is the only signal a test has that the load order was
// wrong. Swallowing it without keeping it would turn a wiring bug into an
// empty export object.
function recordingConsole() {
  const lines = [];
  const capture = (level) => (...args) => { lines.push({ level, args }); };
  return {
    lines,
    console: {
      log: capture('log'),
      info: capture('info'),
      warn: capture('warn'),
      error: capture('error'),
      debug: capture('debug'),
    },
  };
}

// opts:
//   scripts     which of KNOWN to load, in order. Default ['dom', 'ui'].
//   readyState  the document's readyState at load. 'loading' by default,
//               which is what defers wfx-install.js's own wiring until a test
//               dispatches DOMContentLoaded, so loading the file does not bind
//               listeners to a page that does not exist yet.
//   globals     extra names the scripts may read, for the shell surfaces the
//               four files reach for (api, navigator, toast). Each is passed
//               as a parameter and also set on window, so both `api.x` and
//               `window.api.x` resolve.
//
// Returns the window itself plus named shortcuts, so a test can reach both the
// exports and the document they were built against.
function loadRenderer(opts) {
  const o = opts || {};
  const wanted = Array.isArray(o.scripts) ? o.scripts : ['dom', 'ui'];
  const document = createDocument();
  if (typeof o.readyState === 'string') document.readyState = o.readyState;

  const recorder = recordingConsole();
  const window = {};
  const extras = o.globals || {};
  const extraNames = Object.keys(extras).filter((name) => IDENTIFIER_RE.test(name));
  for (const name of Object.keys(extras)) window[name] = extras[name];

  // wfx-dom.js verifies a child it did not build with
  // `value instanceof doc.defaultView.Node`, which is the only reason the SVG
  // glyphs built by createElementNS in wfx-artifact-ui.js are adopted rather
  // than refused. defaultView has to be the same object the scripts see as
  // window, or that check falls through to a globalThis with no DOM on it.
  window.window = window;
  window.Node = Node;
  document.defaultView = window;

  const params = ['window', 'document', 'console', ...extraNames];
  const args = [window, document, recorder.console, ...extraNames.map((name) => extras[name])];

  for (const key of wanted) {
    const file = KNOWN[key];
    if (!file) throw new Error(`load-renderer: unknown script "${key}"`);
    const { source } = compile(file);
    // eslint-disable-next-line no-new-func -- loading a classic script is the point of this helper
    const run = new Function(...params, source);
    run(...args);
  }

  return {
    window,
    document,
    consoleLines: recorder.lines,
    dom: window.WfxDom || null,
    ui: window.WfxArtifactUi || null,
    install: window.WfxInstall || null,
    publish: window.WfxPublish || null,
  };
}

module.exports = { loadRenderer, RENDERER_DIR, KNOWN };
