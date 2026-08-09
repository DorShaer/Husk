'use strict';

// Loads the workflow-artifact renderer scripts the way index.html does.
//
// The four files are classic scripts, not modules: each is a single IIFE that
// reads `document` and `window` as ambient globals and assigns its export to
// window, so there is nothing to require.
//
// Each script is compiled with new Function and handed window, document and
// console as parameters, which shadow the globals of the same name for the
// whole body. Every file gets its own top-level scope, a fresh window and a
// fresh document per load, and the process global is left alone.

const fs = require('node:fs');
const path = require('node:path');

const { createDocument, Node } = require('./dom-shim');

const RENDERER_DIR = path.join(__dirname, '..', '..', 'src', 'renderer');

// Load order is index.html's: wfx-artifact-ui.js builds against window.WfxDom,
// so the dom file loads first.
const KNOWN = Object.freeze({
  dom: 'wfx-dom.js',
  ui: 'wfx-artifact-ui.js',
  install: 'wfx-install.js',
  publish: 'wfx-publish.js',
});

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

const compiled = new Map();

// Compiled once per file and reused across loads: the compiled function closes
// over nothing, and every load calls it with its own window and document.
function compile(file) {
  if (!compiled.has(file)) {
    const full = path.join(RENDERER_DIR, file);
    const source = fs.readFileSync(full, 'utf8');
    // sourceURL so a stack from inside a renderer file names that file rather
    // than "anonymous".
    compiled.set(file, { full, source: `${source}\n//# sourceURL=${full}\n` });
  }
  return compiled.get(file);
}

// The console the scripts get: silent and recording, so a test can read back
// what a script reported.
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
//   readyState  the document's readyState at load. 'loading' by default, which
//               defers wfx-install.js's wiring until a test dispatches
//               DOMContentLoaded.
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

  // wfx-dom.js checks a child it did not build with
  // `value instanceof doc.defaultView.Node`, so defaultView is the same object
  // the scripts see as window.
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
