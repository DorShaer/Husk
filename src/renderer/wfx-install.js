'use strict';

// The install sheet's driver: everything that happens between "somebody wants
// to run a stranger's workflow" and "a workflow record exists on this disk".
//
// The shell for all of it already ships in index.html, every pane of every
// state, so this file never creates a dialog. What it does is decide which
// pane is showing, fill the three panes whose content depends on the file that
// was read, and own the two irreversible moments: the fetch that pulls a
// stranger's repository onto this disk, and the install that writes a workflow
// record. Both are IPC calls that resolve rather than reject, so every call
// site here branches on .ok and none of them is wrapped in a try/catch that
// would turn a structured refusal into an unstyled crash.
//
// Three rules this file exists to hold, in the order they bite.
//
// A refusal has no Install control. Not a disabled one: absent. The shipped
// CSS hides the footer primary while data-state is "refused", so reaching that
// state is the whole implementation of the rule, and the code below therefore
// never re-shows #wfx-in-go without also leaving that state. A greyed commit
// button on a file that cannot be trusted reads as a lock to pick, and the
// next thing a reader does is go hunting for the override.
//
// An install that failed has to be visible from the footer. The body of this
// sheet is a scroller taller than the viewport and Install lives in the pinned
// footer, so a banner written at the top of the body is feedback the person
// who pressed the button is not looking at. Every failure path here writes the
// reason onto #wfx-in-foot as well and scrolls the banner into view, which is
// the pair the markup's own comment asks for.
//
// Every string that came out of the manifest reaches the DOM through el() from
// wfx-dom.js. That is not a style preference: this window runs with
// sandbox:false and its preload exposes workflows.create and workflows.run, so
// one interpolated manifest string in an innerHTML assignment is a workflow of
// the attacker's choosing being written and started. There is no innerHTML in
// this file at all, not even for the static glyphs: those are built through
// createElementNS from a frozen table of path data, because an exception for
// "just the icons" is an exception somebody later widens.
//
// One more invariant, stated because a later convenience patch is what would
// violate it: nothing derived from a manifest may reach the MCP add channels.
// The preflight's server rows describe what is here and what the author
// declared, and their only affordance opens the empty MCP form through a hook
// this file is given. Those channel names appear nowhere in this file, and a
// unit test greps for them.

(function () {
  // ── The shell ──────────────────────────────────────────────────────────────
  // Looked up per call rather than cached at load. This file is a classic
  // script and its position relative to the markup is index.html's business,
  // not ours; a cached null taken at parse time would be a sheet that silently
  // never opens if somebody moves the tag.
  const $ = (sel) => document.querySelector(sel);
  const byId = (id) => document.getElementById(id);

  // el() is resolved through window each time for the same reason, and the
  // failure is loud: a missing builder is a load-order bug in index.html, and
  // rendering a manifest without it is exactly the thing this feature exists
  // to prevent. Falling back to textContent here would be the quiet version of
  // the same mistake, because the fallback would then be the code path nobody
  // reviews.
  function kit() {
    const dom = window.WfxDom;
    if (!dom || typeof dom.el !== 'function') {
      throw new Error('wfx-install: wfx-dom.js must load before this file');
    }
    return dom;
  }
  const el = (tag, attrs, ...children) => kit().el(tag, attrs, ...children);

  // ── Static glyphs ──────────────────────────────────────────────────────────
  // SVG is not in el()'s tag allowlist, deliberately: it is a namespace with
  // its own script-bearing elements and none of these surfaces needs a caller
  // to be able to ask for one. The four marks below are ours, fixed, and carry
  // no data at all, so they are built element by element from this table.
  // Nothing here is parsed, which is the property that matters; a path string
  // set through setAttribute is inert whatever it contains.
  //
  // One stroke weight and one idiom across the three severities, matching the
  // shipped markup exactly: an enclosed circle for ok and for block, a
  // triangle for caution, all at stroke-width 2. A naked checkmark beside two
  // enclosed shapes is not a set, and the sheet's own CSS comments spend a
  // paragraph on that.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const GLYPHS = Object.freeze({
    ok: [
      ['circle', { cx: '12', cy: '12', r: '9' }],
      ['path', { d: 'M8 12.2l2.8 2.8L16 9.8' }],
    ],
    caution: [
      ['path', { d: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z' }],
      ['path', { d: 'M12 9v4M12 17h.01' }],
    ],
    block: [
      ['circle', { cx: '12', cy: '12', r: '9' }],
      ['path', { d: 'M15 9l-6 6M9 9l6 6' }],
    ],
    chevron: [
      ['path', { d: 'M9 6l6 6-6 6' }],
    ],
  });

  function glyph(kind, className) {
    const parts = GLYPHS[kind] || GLYPHS.block;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    if (className) svg.setAttribute('class', className);
    for (const [tag, attrs] of parts) {
      const node = document.createElementNS(SVG_NS, tag);
      for (const name of Object.keys(attrs)) node.setAttribute(name, attrs[name]);
      svg.appendChild(node);
    }
    return svg;
  }

  // ── Refusal copy ───────────────────────────────────────────────────────────
  // Keyed by stage first, because 'too-large' means two different things: the
  // source stage refuses a file whose size was checked before it was opened,
  // and the validate stage refuses one whose parsed contents exceed a budget.
  // A flat table would have silently collapsed them.
  //
  // Every entry names what was not done as well as what went wrong. A refusal
  // that only says "failed" leaves the reader wondering whether a clone is
  // still sitting somewhere or a half-written workflow is in their list, and
  // the answer on every path here is that nothing was kept.
  const REFUSAL_COPY = Object.freeze({
    source: {
      'no-url': {
        title: 'Nothing to fetch yet',
        message: 'Type the https URL of a repository that holds a workflow file, then press Fetch. Husk clones it into a scratch directory, reads it there, and copies nothing else out.',
      },
      'no-path': {
        title: 'Nothing to read yet',
        message: 'Choose a .husk.json on this disk, or type its absolute path, then press Fetch.',
      },
      'clone-failed': {
        title: 'Husk could not clone that repository',
        message: 'The clone did not finish, so nothing was read and nothing was kept. A private repository, a typo in the URL and no network all land here. The URL above is still filled in, so correcting it and pressing Fetch again costs nothing.',
      },
      'no-artifact-found': {
        title: 'No workflow file in that repository',
        message: 'The clone worked and there is no .husk.json anywhere inside it. A published workflow is a single file, usually workflow.husk.json at the root or under .husk/workflows. The scratch clone has been dropped.',
      },
      'unsafe-path': {
        title: 'That file is reached through a symbolic link',
        message: 'Somewhere between the repository root and the file, a directory or the file itself is a link pointing out of the tree. Following it would read whatever the author of the repository chose rather than what they published, so Husk stopped before opening anything.',
      },
      'not-a-file': {
        title: 'That path is not a file',
        message: 'The path resolved to a directory or to something that is neither. Point at the .husk.json itself.',
      },
      'too-large': {
        title: 'That file is too large to be a workflow',
        message: 'A workflow file is capped at one mebibyte. Husk checks the size on disk before it opens anything, so none of this file was read into memory.',
      },
      unreadable: {
        title: 'Husk could not read that file',
        message: 'The file is there and the read failed, which is usually a permission. Nothing was written and the sheet is still where you left it.',
      },
    },

    // The validator's own closed enum, passed through by the main process
    // verbatim. Each of these means the bytes are not a workflow this machine
    // will run, so all of them land on the refused pane where there is no
    // Install control to press.
    validate: {
      'too-large': {
        title: 'That file is too large to be a workflow',
        message: 'The contents exceed what a workflow file is allowed to carry. Nothing further was parsed.',
      },
      'not-json': {
        title: 'That file is not JSON',
        message: 'The bytes did not parse. Either it is not a workflow file at all, or it was truncated on its way here.',
      },
      'not-artifact': {
        title: 'That file is not a workflow',
        message: 'It parsed as JSON and it does not declare itself a husk.workflow. Husk identifies a workflow file by what is inside it rather than by its name, so a .husk.json that is something else stops here.',
      },
      'schema-too-new': {
        title: 'That file was written by a newer Husk',
        message: 'Its format version is above the highest this build reads. Husk will not read part of it and guess at the rest, because the parts it would drop are exactly the requirements and the receipts. Update Husk and open it again.',
      },
      'too-many-nodes': {
        title: 'That graph is larger than a workflow may be',
        message: 'The step or edge count is over the cap. The count is checked before anything is walked, so nothing in the file was processed.',
      },
      'bad-id': {
        title: 'That file has malformed step identifiers',
        message: 'A step or edge id is not in the canonical form Husk writes, which means the graph cannot be reassembled with any confidence about what connects to what.',
      },
      'bad-agent': {
        title: 'A step names an agent Husk will not run',
        message: 'Every step in a published workflow has to name one of the allowlisted agent commands as a bare name. A path, or a command outside the list, is refused here rather than being resolved against this machine.',
      },
      'regex-condition': {
        title: 'That file routes on a regular expression',
        message: 'Published workflows carry plain text conditions only. A pattern from a stranger is compiled here and run against agent output, and the same file would supply both the pattern and, through the previous step, the text it runs against.',
      },
      'bad-model': {
        title: 'A step pins a model name Husk will not pass on',
        message: 'A model pin is handed to a third-party command line, so its characters are constrained. This one is outside what Husk will forward.',
      },
      'edges-dropped': {
        title: 'That graph loses connections when it is read',
        message: 'At least one edge does not survive the read, which means the workflow that would be installed is not the workflow the file describes. Husk refuses rather than installing a graph missing a branch.',
      },
      'hash-mismatch': {
        title: 'These receipts do not belong to this workflow',
        message: 'The fingerprint written into this file is not the one Husk computed from the graph inside the same file. Either the graph was edited after the receipts were attached, or the receipts were taken from a different workflow. Nothing here can be trusted to describe what would run, so nothing is offered to install.',
      },
      'receipt-invalid': {
        title: 'A receipt in this file contradicts itself',
        message: 'The figures do not add up against their own declared totals. A receipt disproved by its own contents is worse than no receipt, so the file is refused rather than being shown with the numbers annotated.',
      },
      'chain-invalid': {
        title: 'The shipped log does not check out',
        message: 'This file attaches a run log and the log is not internally consistent, so the numbers it is meant to support cannot be recomputed from it here.',
      },
    },
  });

  const GENERIC_REFUSAL = Object.freeze({
    title: 'Husk stopped before installing anything',
    message: 'The file was not usable and nothing was written.',
  });

  // Install-stage refusals do not reach the refused pane. They are the sheet's
  // one recoverable failure: the file is fine, the destination is not, and
  // everything the reader assembled is still on screen. So these are single
  // sentences sized for the footer note, not pane copy.
  const INSTALL_TROUBLE = Object.freeze({
    'cwd-required': 'Nothing was written. This workflow needs a directory to run in before it can be installed.',
    'cwd-is-home': 'Nothing was written. Your home directory is not a working directory for an imported workflow; pick the project it is meant to touch.',
    'cwd-not-a-directory': 'Nothing was written. That path is no longer a directory. Pick it again.',
    'cwd-not-a-work-tree': 'Nothing was written. This workflow declares it needs a git work tree and that directory is not inside one.',
    'name-collision': 'Nothing was written. A workflow of that name is already here.',
    'write-failed': 'Nothing was written. Husk could not write the workflow record.',
  });

  // ── State ──────────────────────────────────────────────────────────────────
  // One object rather than a scatter of module-level lets, so close() empties
  // it in one statement and a stale field cannot survive into the next open.
  //
  // `seq` is the staleness token. Every async round trip captures it and drops
  // its own result if it changed, which is what stops a slow clone from
  // painting over a second, faster one the reader started after it, and what
  // makes Escape during a fetch mean something even though the clone in the
  // main process keeps going to its own end.
  const S = {
    seq: 0,
    source: 'repo',
    read: null,        // the whole ok payload from artifactRead
    artifact: null,
    cwd: null,
    preflight: null,
    installing: false,
    installed: null,   // { workflow, sidecar }
    restoreFocus: null,
    adopted: null,     // the two shell controls we re-parent instead of rebuilding
  };

  // Hooks the surrounding app fills in. Every one of them is optional and
  // every default is inert, because this sheet has to be reviewable and
  // testable without app.js having wired anything yet. They exist as hooks
  // rather than as direct calls for one hard reason and one soft one: the hard
  // one is that no value from a manifest may reach the MCP channels, so this
  // file must not be able to name them; the soft one is that app.js owns the
  // workflow grid and the consent gate, and reaching into either from here
  // would be two files repainting one list.
  const hooks = {
    onInstalled: null,     // (workflow, sidecar) => void, refresh the grid
    openConsent: null,     // (workflowId, workflow, cwd) => void, the first-run gate
    openMcpForm: null,     // () => void, the EMPTY form, never prefilled
    openSkills: null,      // () => void
    openAgents: null,      // (basename) => void, where Husk looks for agents
    getBilling: null,      // () => billingMode object | null, for the local estimate
  };

  // The ready pane's contents belong to the artifact inspector in
  // wfx-artifact-ui.js: it owns the record, the tiers and the dollar estimate,
  // and it is where the tier rules are enforced in one place rather than in
  // each surface that draws a number. This file owns the flow around it, so
  // when the inspector is present the whole pane is handed to it, and the
  // builders further down are the fallback that keeps this sheet complete on
  // its own. Two renderers for one pane would be two places for the tier rules
  // to drift, which is why this is a handoff rather than a merge.
  let inspector = null;

  function resolveInspector() {
    if (inspector) return inspector;
    const ui = window.WfxArtifactUi;
    if (ui && typeof ui.renderInspector === 'function') return ui.renderInspector;
    return null;
  }

  // ── Small shell helpers ────────────────────────────────────────────────────
  const modal = () => byId('wfx-install-modal');
  const sheet = () => {
    const m = modal();
    return m ? m.querySelector('.modal-card.wfx-sheet') : null;
  };

  function setState(name) {
    const card = sheet();
    if (card) card.setAttribute('data-state', name);
    paintFooter(name);
  }

  function stateNow() {
    const card = sheet();
    return card ? card.getAttribute('data-state') : null;
  }

  // One sentence per state change, in the sheet's own live region. The ready
  // pane is several hundred words and carries no aria-live of its own for
  // exactly that reason, so this is the only channel that tells a screen
  // reader what just happened and why.
  function say(sentence) {
    const node = byId('wfx-in-say');
    if (node) node.textContent = sentence;
  }

  // The footer note doubles as #wfx-in-go's aria-describedby target, so
  // writing a blocker here is also what announces it on the control that is
  // withheld. is-error is the failure treatment; it is always cleared on the
  // way in so a recovered state does not keep yesterday's red.
  function setFoot(sentence, isError) {
    const node = byId('wfx-in-foot');
    if (!node) return;
    node.classList.toggle('is-error', !!isError);
    node.textContent = sentence;
  }

  // The info banner above the panes. It carries the target of a fetch while
  // one is in flight, and nothing at all the rest of the time.
  function setStatus(children) {
    const node = byId('wfx-in-status');
    if (!node) return;
    if (!children) {
      node.hidden = true;
      node.replaceChildren();
      return;
    }
    node.hidden = false;
    node.replaceChildren(children);
  }

  // The error banner, and the other half of the rule it exists for. The
  // markup's own comment is explicit: this block sits at the top of a scroller
  // whose tail is where a reader stands when they press Install, so on its own
  // it is feedback nobody sees. Writing the footer note and scrolling the
  // banner into view is what makes the failure reachable from where the press
  // happened.
  //
  // The static icon span is kept rather than rebuilt, so the one glyph idiom
  // this surface uses stays owned by the markup.
  function setError(sentence) {
    const node = byId('wfx-in-err');
    if (!node) return;
    if (!sentence) {
      node.hidden = true;
      return;
    }
    const icon = node.querySelector('.ra-status-icon');
    node.replaceChildren(...(icon ? [icon] : []), el('span', {}, sentence));
    node.hidden = false;
    try {
      node.scrollIntoView({ block: 'nearest' });
    } catch (_) {
      // An old layout engine without the options object still scrolls; the
      // reachability of the message matters more than where exactly it lands.
      try { node.scrollIntoView(); } catch (__) { /* nothing to do */ }
    }
  }

  // Footer composition per state, in one place. Every earlier version of this
  // grew a hidden-attribute assignment at each call site and ended up with two
  // primaries visible at once on the path nobody clicks twice.
  function paintFooter(state) {
    const go = byId('wfx-in-go');
    const done = byId('wfx-in-done');
    const run = byId('wfx-in-run');
    const cancel = byId('wfx-in-cancel');
    const isReady = state === 'ready' || state === 'working';
    const isDone = state === 'done';
    if (go) go.hidden = !isReady;
    if (done) done.hidden = !isDone;
    if (run) run.hidden = !isDone;
    // Cancel is the way out of every state that is still assembling something.
    // After the write there is nothing to cancel, and Done is the way out.
    if (cancel) cancel.hidden = isDone;
  }

  // ── Path rendering ─────────────────────────────────────────────────────────
  // Two spans, never one string. The directory truncates and the filename does
  // not, which is the whole reason .wfx-path is built the way it is: a single
  // ellipsised element eats the tail, and the tail is the part that says where
  // this actually lands.
  function splitPath(abs) {
    const s = String(abs == null ? '' : abs);
    const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    if (cut < 0) return { dir: '', file: s };
    return { dir: s.slice(0, cut + 1), file: s.slice(cut + 1) };
  }

  function buildPath(abs) {
    const parts = splitPath(abs);
    return el('span', { class: 'wfx-path' },
      el('span', { class: 'wfx-path-dir' }, parts.dir),
      el('span', { class: 'wfx-path-file' }, parts.file));
  }

  // The done pane's path lives in static markup with placeholder copy in it,
  // so it is written through rather than rebuilt: the two spans are addressed
  // by class and only their text changes.
  function writeDonePath(abs) {
    const m = modal();
    if (!m) return;
    const host = m.querySelector('.wfx-pane-done .wfx-path');
    if (!host) return;
    const parts = splitPath(abs);
    const dir = host.querySelector('.wfx-path-dir');
    const file = host.querySelector('.wfx-path-file');
    if (dir) dir.textContent = parts.dir;
    if (file) file.textContent = parts.file;
  }

  // ── The graph preview ──────────────────────────────────────────────────────
  // wfMiniGraph in app.js returns a string of markup, which is the one thing
  // this sheet may not accept: assigning it would put an imported graph's
  // numbers through innerHTML, and the app-side function also spreads its
  // coordinate arrays into Math.min, which throws outright on a large graph.
  // Drawing it here from the same geometry keeps both problems away from a
  // surface whose input is a stranger's file, and costs about thirty lines.
  //
  // Nothing but numbers this function computed itself is ever written into an
  // attribute. Coordinates arrive as validated integers and are re-coerced
  // anyway, because a preview is not the right place to find out the validator
  // let something through.
  const MINI_NODE_CAP = 512;

  function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function buildMiniGraph(graph) {
    const nodes = (graph && Array.isArray(graph.nodes)) ? graph.nodes : [];
    const edges = (graph && Array.isArray(graph.edges)) ? graph.edges : [];
    if (!nodes.length) {
      return el('div', { class: ['wf-mini', 'is-empty'] }, el('span', {}, 'no steps'));
    }
    if (nodes.length > MINI_NODE_CAP) {
      return el('div', { class: ['wf-mini', 'is-empty'] }, el('span', {}, 'graph too large to preview'));
    }

    const W = 250; const H = 74; const PAD = 12; const NW = 26; const NH = 13;
    // reduce rather than a spread, for the reason the app-side copy needs the
    // same change: an argument list is bounded by the engine's stack, and a
    // graph is the one input here whose length came from a file.
    const bounds = nodes.reduce((acc, n) => {
      const x = num(n && n.x); const y = num(n && n.y);
      return {
        minX: Math.min(acc.minX, x), maxX: Math.max(acc.maxX, x),
        minY: Math.min(acc.minY, y), maxY: Math.max(acc.maxY, y),
      };
    }, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });

    const flatX = (bounds.maxX - bounds.minX) < 1;
    const flatY = (bounds.maxY - bounds.minY) < 1;
    const spanX = flatX ? 1 : (bounds.maxX - bounds.minX);
    const spanY = flatY ? 1 : (bounds.maxY - bounds.minY);
    const pos = new Map();
    nodes.forEach((n) => {
      const id = n && typeof n.id === 'string' ? n.id : null;
      if (id === null) return;
      const x = PAD + ((num(n.x) - bounds.minX) / spanX) * (W - PAD * 2 - NW);
      const y = flatY
        ? (H - NH) / 2
        : PAD + ((num(n.y) - bounds.minY) / spanY) * (H - PAD * 2 - NH);
      pos.set(id, { x, y });
    });

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'wf-mini');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('aria-hidden', 'true');

    // Edges first so the boxes sit over them, which is the order the app-side
    // preview draws in and the order the shipped example markup shows.
    edges.forEach((e) => {
      const a = pos.get(e && e.from);
      const b = pos.get(e && e.to);
      if (!a || !b) return;
      const x1 = a.x + NW; const y1 = a.y + NH / 2;
      const x2 = b.x; const y2 = b.y + NH / 2;
      const mx = (x1 + x2) / 2;
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', `M${x1.toFixed(1)} ${y1.toFixed(1)} C ${mx.toFixed(1)} ${y1.toFixed(1)}, ${mx.toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`);
      path.setAttribute('class', 'wf-mini-edge');
      svg.appendChild(path);
    });

    nodes.forEach((n) => {
      const p = pos.get(n && n.id);
      if (!p) return;
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', p.x.toFixed(1));
      rect.setAttribute('y', p.y.toFixed(1));
      rect.setAttribute('width', String(NW));
      rect.setAttribute('height', String(NH));
      rect.setAttribute('rx', '4');
      // One literal class and no state. The install preview has no local run
      // history to colour by, and a status folded in from a receipt is how a
      // manifest string would reach a class attribute.
      rect.setAttribute('class', 'wf-mini-node');
      svg.appendChild(rect);
    });

    return svg;
  }

  // ── Figures ────────────────────────────────────────────────────────────────
  // The chip is a sibling of the number inside the same tile, so there is no
  // arrangement of this builder that emits a figure without emitting where it
  // came from.
  function claim(tier, label) {
    return el('span', {},
      el('span', { class: ['wfx-claim', tier] },
        el('i', { class: 'wfx-claim-m', aria: { hidden: true } }),
        label));
  }

  // "author states" is the floor for everything a receipt asserts, and it is
  // also the ceiling until this machine has recomputed the numbers from a
  // shipped log. That recomputation is the main process's job and this read
  // does not carry its verdict, so claiming anything stronger here would be
  // the renderer inventing a tier. The word "verified" appears nowhere.
  const SAID = 'is-said';
  const COMPUTED = 'is-computed';

  function figure(value, unit, label, tier, tierLabel, isNull) {
    const v = el('span', { class: 'wfx-fig-v' }, value);
    if (unit) v.appendChild(el('span', { class: 'wfx-fig-u' }, unit));
    return el('div', { class: isNull ? ['wfx-fig', 'is-null'] : 'wfx-fig' },
      v,
      el('span', { class: 'wfx-fig-l' }, label),
      claim(tier, tierLabel));
  }

  function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return null;
    const secs = Math.round(ms / 1000);
    if (secs < 60) return { value: String(secs), unit: 's' };
    const mins = Math.floor(secs / 60);
    const rest = secs % 60;
    if (mins < 60) {
      return rest
        ? { value: `${mins}m ${String(rest).padStart(2, '0')}`, unit: 's' }
        : { value: String(mins), unit: 'm' };
    }
    const hours = Math.floor(mins / 60);
    return { value: `${hours}h ${String(mins % 60).padStart(2, '0')}`, unit: 'm' };
  }

  // Four tiles or none. The grid is an explicit four tracks, so three figures
  // leave a bare track with a border around it; when a datum has no honest
  // value its tile keeps its slot and loses its weight instead, which is what
  // .is-null is for. Zero receipts is a different fact from a missing figure,
  // and it gets prose rather than a grid of blanks.
  function buildFigures(artifact) {
    const receipts = Array.isArray(artifact.receipts) ? artifact.receipts : [];
    const r = receipts[0];
    if (!r) return null;

    const runs = Number(r.runs);
    const tiles = [];
    tiles.push(Number.isFinite(runs)
      ? figure(String(runs), null, 'runs', SAID, 'author states')
      : figure('no figure', null, 'runs', SAID, 'author states', true));

    const dur = fmtDuration(Number(r.medianDurationMs));
    tiles.push(dur
      ? figure(dur.value, dur.unit, 'median run', SAID, 'author states')
      : figure('no figure', null, 'median run', SAID, 'author states', true));

    const outcomes = (r.outcomes && typeof r.outcomes === 'object') ? r.outcomes : {};
    const completed = Number(outcomes.completed);
    tiles.push(Number.isFinite(completed) && Number.isFinite(runs)
      ? figure(String(completed), `/${runs}`, 'zero exit', SAID, 'author states')
      : figure('no figure', null, 'zero exit', SAID, 'author states', true));

    // The fourth tile is what the file shipped to back the other three, and
    // never a dollar figure. There are no dollars in the file at all, by
    // design, because four of the five agents are priced at zero in the local
    // rate table and a workflow costing real money would publish as free. A
    // local estimate from local rates is a real figure and it belongs to the
    // inspector, which owns the rate table and the tier that goes with it.
    const inline = r.evidence === 'inline';
    tiles.push(figure(inline ? 'log attached' : 'no log', null, 'evidence', SAID, 'author states', !inline));

    return el('div', { class: 'wfx-figs' }, ...tiles);
  }

  // ── The ready pane, when nothing better is registered ──────────────────────
  // Everything from here to paintReady is the fallback renderer: what this
  // sheet draws with no artifact inspector loaded. It is deliberately complete
  // rather than a placeholder, because a surface whose degraded mode is a blank
  // pane is a surface that ships blank the first time a load order changes.
  //
  // It is built into a fragment and committed in one assignment. A builder that
  // appends as it goes leaves a half-drawn sheet on screen when el() refuses
  // something, and a half-drawn sheet is the state a reader is most likely to
  // misread as the whole file.
  function buildEvidence(read) {
    const artifact = read.artifact;
    const out = [];

    // The fingerprint, whole. This is where a reader is asked to compare
    // against the repository they got the file from, and an eight character
    // prefix match is not a verdict. The chip says the string was recomputed
    // here rather than read out of the file, which is the only claim on this
    // pane this machine is entitled to make on its own.
    const copyBtn = adopt('wfx-in-fp-copy', () => el('button', { type: 'button', class: 'ghost-btn' }, 'Copy'));
    out.push(el('div', { class: ['ra-status', 'ra-status-info'] },
      el('div', { class: 'wfx-fp-h' },
        el('span', {}, claim(COMPUTED, 'computed here')),
        copyBtn),
      el('code', {}, String(artifact.graphHash || '')),
      el('span', {}, 'Recomputed from the bytes of this file, not read out of them.')));

    const publisher = (artifact.publisher && typeof artifact.publisher === 'object') ? artifact.publisher : null;
    const heading = publisher && publisher.name
      ? `${artifact.name} · ${publisher.name}`
      : String(artifact.name || '');
    out.push(el('div', { class: 'wfx-note' },
      el('p', { class: 'wfx-note-t' }, heading),
      el('p', { class: 'wfx-note-m' }, String(artifact.description || 'This file carries no description.'))));

    out.push(el('div', { class: 'wf-card-graph' }, buildMiniGraph(artifact.graph)));

    const figs = buildFigures(artifact);
    if (figs) out.push(figs);

    return kit().frag(...out);
  }

  // The closing argument of the pane: what the numbers above are worth. It is
  // assembled from the receipt rather than written once, because the honest
  // sentence is different for a file with no history, a file with a censored
  // median, and a file that shipped a log.
  function buildWorth(artifact) {
    const receipts = Array.isArray(artifact.receipts) ? artifact.receipts : [];
    const r = receipts[0];
    const steps = ((artifact.graph && artifact.graph.nodes) || []).length;
    if (!r) {
      return el('div', { class: 'wfx-note' },
        el('p', { class: 'wfx-note-t' }, 'What this file proves'),
        el('p', { class: 'wfx-note-m' },
          `Nothing about how it ran. It carries no run history at all, so what you have above is the graph, its ${steps} prompts and what the author says it needs. Everything Husk knows about this file it computed here. Installing writes a file and runs nothing.`));
    }

    const parts = [];
    const runs = Number(r.runs);
    const outcomes = (r.outcomes && typeof r.outcomes === 'object') ? r.outcomes : {};
    const completed = Number(outcomes.completed);
    if (r.evidence === 'inline') {
      parts.push('This file ships a run log, and the figures above are still what the author states until Husk has recomputed them from it.');
    } else {
      parts.push('This file ships no run log, so every figure above is what the author states and nothing on this machine checked it.');
    }
    if (Number.isFinite(completed) && Number.isFinite(runs)) {
      parts.push(`"${completed} of ${runs}" means ${completed} runs ended with a zero exit code and nothing more; an agent that answers confidently wrong and exits cleanly counts here.`);
    }
    const censored = Number(r.durationCensored);
    if (Number.isFinite(censored) && censored > 0) {
      parts.push(`${censored} of those runs had a step killed at the per-step time limit, so the median is cut off at the top.`);
    }
    if (r.runsWindowed === true) {
      parts.push('The run history behind these numbers was already truncated when they were counted, so the window is not the whole record.');
    }
    parts.push('Installing writes a file and runs nothing.');

    return el('div', { class: 'wfx-note' },
      el('p', { class: 'wfx-note-t' }, 'What the numbers above are worth'),
      el('p', { class: 'wfx-note-m' }, parts.join(' ')));
  }

  // The bound directory row. The Change button is the shell's, adopted rather
  // than rebuilt, because it carries an id the sheet's own contract names and
  // el() will not mint a shell id.
  function buildCwdRow() {
    const change = adopt('wfx-in-cwd-change', () => el('button', { type: 'button', class: 'ghost-btn' }, 'Change directory'));
    const path = S.cwd
      ? buildPath(S.cwd)
      : el('span', { class: 'wfx-path' },
        el('span', { class: 'wfx-path-file' }, 'no directory chosen yet'));
    return el('div', { class: 'ra-pathrow' }, path, change);
  }

  // A control that ships in index.html with an id this file is contracted to
  // wire keeps that identity by being moved into the rebuilt pane rather than
  // recreated. el() refuses to mint an id outside its own namespace, which is
  // the rule that stops a manifest naming the Install button, and adopting is
  // how a shell control survives it. The fallback exists so a markup change
  // downstream degrades to a working sheet with an anonymous button rather
  // than to a pane with a hole in it.
  function adopt(id, make) {
    if (!S.adopted) S.adopted = {};
    if (!S.adopted[id]) {
      const found = byId(id);
      S.adopted[id] = found || make();
    }
    return S.adopted[id];
  }

  // ── Preflight ──────────────────────────────────────────────────────────────
  const SEVERITY = Object.freeze({ block: 0, caution: 1, ok: 2 });
  const ROW_CLASS = Object.freeze({ block: 'is-block', caution: 'is-caution', ok: 'is-ok' });
  const ROW_GLYPH = Object.freeze({ block: 'block', caution: 'caution', ok: 'ok' });

  // Rows arrive from the main process in reading order and are shown in
  // severity order. A blocker under a green tick is a blocker the footer names
  // and the reader then has to scroll past two passes to find, which is the
  // situation the rose bar on the row exists to compensate for; putting the
  // row first is the fix the bar was standing in for. Sort is stable, so
  // within a severity the reading order the main process chose survives.
  function sortChecks(checks) {
    return checks
      .map((c, i) => ({ c, i }))
      .sort((a, b) => {
        const sa = SEVERITY[a.c.status] === undefined ? 3 : SEVERITY[a.c.status];
        const sb = SEVERITY[b.c.status] === undefined ? 3 : SEVERITY[b.c.status];
        return sa === sb ? a.i - b.i : sa - sb;
      })
      .map((x) => x.c);
  }

  // A row can carry two different affordances and they are not alternatives.
  // fix is somewhere to go; detail is something to read. Folding the second
  // into the first is how a button labelled "Add a server" ends up revealing
  // two hashes, so each gets its own control and a row that has both shows
  // both.
  // The one place a preflight fix is acted on, shared by the rows this file
  // builds and by the inspector's onFix callback, so a fix behaves the same
  // whichever renderer drew the row.
  //
  // Every destination is a hook rather than a call. The MCP row's affordance in
  // particular opens the EMPTY server form and nothing else: no name, no
  // command, no argv from the manifest reaches it, because a manifest value
  // arriving at the add channels is a stranger's JSON becoming a persistent
  // local process. Routing through a hook is what keeps those channel names out
  // of this file entirely.
  function dispatchFix(fix) {
    if (!fix || typeof fix !== 'object') return;
    if (fix.kind === 'pick-cwd') { pickCwd(); return; }
    if (fix.kind === 'open-mcp-form' && typeof hooks.openMcpForm === 'function') { hooks.openMcpForm(); return; }
    if (fix.kind === 'open-skills' && typeof hooks.openSkills === 'function') { hooks.openSkills(); return; }
    if (fix.kind === 'install-agent' && typeof hooks.openAgents === 'function') {
      hooks.openAgents(typeof fix.value === 'string' ? fix.value : null);
      return;
    }
    // Nothing wired for this fix yet. Saying so in the live region is more
    // useful than a control that swallows the press, and it keeps the row
    // honest: Husk is not about to substitute anything on the reader's behalf,
    // which is the whole point of naming the missing requirement.
    say('Husk has nothing to open for that here. The row above names what is missing.');
  }

  function buildFixControl(check) {
    const out = [];
    const fix = check.fix;
    if (fix && typeof fix === 'object') {
      const label = String(fix.label || 'What to do about this');
      const btn = el('button', { type: 'button', class: ['ghost-link', 'wfx-pf-fix'] }, label);
      btn.addEventListener('click', () => dispatchFix(fix));
      out.push(btn);
    }

    // The fingerprint pair, in full, on the one row where a reader is asked to
    // decide whether the server or skill they have is the one the prompts were
    // written against. 64 characters each, never a prefix: an eight character
    // match is not a verdict, and this is the surface the rule was written for.
    const detail = check.detail;
    if (detail && typeof detail === 'object' && (detail.declared || detail.local)) {
      const dl = el('dl', { class: 'wfx-refuse-e', hidden: true },
        el('dt', {}, 'declared'), el('dd', {}, String(detail.declared || '')),
        el('dt', {}, 'yours'), el('dd', {}, String(detail.local || '')));
      const show = el('button', { type: 'button', class: ['ghost-link', 'wfx-pf-fix'] }, 'Show both fingerprints');
      show.addEventListener('click', () => {
        dl.hidden = !dl.hidden;
        show.textContent = dl.hidden ? 'Show both fingerprints' : 'Hide the fingerprints';
        say(dl.hidden ? 'Fingerprints hidden.' : 'Both fingerprints are now shown in full.');
      });
      out.push(show, dl);
    }

    return out.length ? out : null;
  }

  function buildCheckRow(check) {
    const status = ROW_CLASS[check.status] ? check.status : 'caution';
    const kids = [
      el('span', { class: 'wfx-pf-i' }, glyph(ROW_GLYPH[status])),
      el('span', { class: 'wfx-pf-n' }, String(check.title || check.name || '')),
    ];
    if (check.note) kids.push(el('span', { class: 'wfx-pf-note' }, String(check.note)));
    const fix = buildFixControl(check);
    if (fix) kids.push(...fix);
    return el('div', { class: ['wfx-pf-row', ROW_CLASS[status]] }, ...kids);
  }

  // While the probes are running the card holds skeleton rows rather than
  // nothing, because the rows below it are already laid out and a card that
  // appears late moves the prompt list under the reader's cursor. There is no
  // stagger: staggering a checklist delays reading it for decoration.
  function buildPreflightSkeleton() {
    const rows = [0, 1, 2].map(() => el('div', { class: 'wfx-pf-row' },
      el('i', { class: 'wfx-sk' }), el('i', { class: 'wfx-sk' })));
    return el('div', { class: 'wfx-pf' },
      el('div', { class: 'wfx-pf-h' }, 'Against this machine'),
      ...rows);
  }

  function buildPreflight(result) {
    if (!result || !Array.isArray(result.checks)) return buildPreflightSkeleton();
    const rows = sortChecks(result.checks).map(buildCheckRow);
    return el('div', { class: 'wfx-pf' },
      el('div', { class: 'wfx-pf-h' }, 'Against this machine'),
      ...rows);
  }

  // ── Steps ──────────────────────────────────────────────────────────────────
  const PASS_CONTEXT = Object.freeze({
    full: 'carries the whole transcript',
    last50: 'carries the last 50 lines',
    none: 'carries nothing forward',
  });

  // The prompt is the actual risk surface: up to 8192 characters per step
  // handed to an agent CLI. It renders as one text node inside a <pre>, with
  // no token highlighting, because highlighting means splitting text nodes and
  // el() owns the scrub that turns an invisible character into a visible
  // replacement. A surface that split the string itself would be re-inserting
  // the fragments outside that guarantee, which is precisely how a hidden
  // second command gets back onto the screen it was supposed to be exposed on.
  function buildSteps(graph) {
    const nodes = (graph && Array.isArray(graph.nodes)) ? graph.nodes : [];
    const items = nodes.map((n, i) => {
      const meta = [n.agentCommand, n.model].filter((s) => typeof s === 'string' && s).join(' · ');
      const pass = PASS_CONTEXT[n.passContext] || 'carries nothing forward';
      return el('details', { class: 'wfx-step' },
        el('summary', {},
          el('span', { class: 'wfx-step-n' }, String(i + 1).padStart(2, '0')),
          el('span', { class: 'wfx-step-b' },
            el('span', { class: 'wfx-step-name' }, String(n.name || '')),
            el('span', { class: 'wfx-step-sub' },
              el('span', { class: 'wfx-step-meta' }, meta ? `${meta} ·` : ''),
              ' ',
              el('span', { class: 'wfx-step-pc' }, pass))),
          glyph('chevron', 'wfx-step-c')),
        el('pre', { class: 'wfx-prompt', tabindex: '0' }, String(n.prompt || '')));
    });
    return el('div', { class: 'wfx-steps' }, ...items);
  }

  // ── Painting the ready pane ────────────────────────────────────────────────
  function paintReady() {
    const host = byId('wfx-in-ready');
    if (!host || !S.read) return;

    const render = resolveInspector();
    if (render) {
      // The inspector takes its two shell controls out of the host before it
      // empties it, and this sheet empties the host between opens, so they go
      // back in first. Handing them over rather than letting it recreate them
      // is what keeps the Copy and Change listeners bound at startup working
      // across every repaint.
      host.replaceChildren(S.adopted['wfx-in-fp-copy'], S.adopted['wfx-in-cwd-change']);
      let res;
      try {
        res = render({
          host,
          artifact: S.read.artifact,
          preflight: S.preflight,
          cwd: S.cwd,
          billing: (typeof hooks.getBilling === 'function') ? hooks.getBilling() : null,
          chainCheck: null,
          miniGraph: buildMiniGraph(S.read.artifact.graph),
          onFix: (fix) => dispatchFix(fix),
        });
      } catch (_) {
        res = null;
      }
      // A pane that could not be drawn is a file that cannot be judged, so it
      // goes to the refused state where there is no Install control at all.
      // The inspector has already written its own refusal into the host; what
      // it cannot do from in there is take the commit button away.
      if (!res || res.ok !== true) {
        refuse({
          stage: 'validate',
          code: (res && res.code) || 'render-failed',
          message: 'Husk read the file and then could not draw what it found.',
          detail: null,
        });
      }
      return;
    }

    let content;
    try {
      content = kit().frag(
        buildEvidence(S.read),
        buildCwdRow(),
        S.preflight ? buildPreflight(S.preflight) : buildPreflightSkeleton(),
        buildSteps(S.read.artifact.graph),
        buildWorth(S.read.artifact));
    } catch (err) {
      // A refusal from el() means the file contains something the builder will
      // not put on screen. That is a property of the file, so it is reported
      // the way every other property of the file is: on the refused pane,
      // where there is no Install control at all.
      refuse({
        stage: 'validate',
        code: (err && err.code) || 'render-failed',
        message: 'Husk would not render part of this file.',
        detail: (err && err.message) || null,
      });
      return;
    }
    host.replaceChildren(content);
  }

  // ── Refusals ───────────────────────────────────────────────────────────────
  // A full fingerprint pair is the one detail a reader is asked to compare, so
  // when the detail string carries exactly two of them they get their own rows
  // rather than being buried in a sentence. Anything else is rendered as it
  // came, because inventing structure for a string we did not write is how a
  // refusal ends up hiding the part that mattered.
  const HASH_RE = /husk-wfg-1:sha256:[0-9a-f]{64}/g;

  function refusalRows(res) {
    const rows = [];
    rows.push(['code', String(res.code || 'unknown')]);
    const where = res.relPath || (S.read && S.read.source && S.read.source.relPath) || null;
    if (where) rows.push(['file', String(where)]);
    const detail = typeof res.detail === 'string' ? res.detail : null;
    if (detail) {
      const hashes = detail.match(HASH_RE);
      if (hashes && hashes.length === 2) {
        rows.push(['declared', hashes[0]]);
        rows.push(['recomputed', hashes[1]]);
      } else {
        rows.push(['detail', detail]);
      }
    }
    return rows;
  }

  function refuse(res) {
    const stage = REFUSAL_COPY[res.stage] ? res.stage : 'validate';
    const copy = (REFUSAL_COPY[stage] && REFUSAL_COPY[stage][res.code]) || GENERIC_REFUSAL;
    const title = byId('wfx-in-ref-t');
    const message = byId('wfx-in-ref-m');
    const detail = byId('wfx-in-ref-e');
    if (title) title.textContent = copy.title;
    // The refusal's own sentence first, then whatever the main process said,
    // because the second one names the specific thing and the first one says
    // what it means. Neither is dropped in favour of the other.
    if (message) {
      const extra = (typeof res.message === 'string' && res.message && res.message !== copy.message)
        ? ` ${res.message}`
        : '';
      message.textContent = `${copy.message}${extra}`;
    }
    if (detail) {
      const kids = [];
      for (const [dt, dd] of refusalRows(res)) {
        kids.push(el('dt', {}, dt), el('dd', {}, dd));
      }
      detail.replaceChildren(...kids);
    }
    // Everything staged is dropped. A refused file has no install, so keeping
    // the artifact around would leave the Install path one state transition
    // away from a file this sheet just said it would not run.
    S.read = null;
    S.artifact = null;
    S.preflight = null;
    setStatus(null);
    setError(null);
    setFoot('Nothing was installed and nothing was written.', false);
    setState('refused');
    say(`${copy.title}. Nothing was installed.`);
  }

  // ── Source selection ───────────────────────────────────────────────────────
  // The typed URL is never cleared by a source switch. Somebody who pastes a
  // URL, clicks the file card to check something and clicks back has not asked
  // to lose what they typed.
  function setSource(kind) {
    S.source = kind === 'file' ? 'file' : 'repo';
    const repoCard = byId('wfx-in-src-repo');
    const fileCard = byId('wfx-in-src-file');
    const repoRow = byId('wfx-in-row-repo');
    const fileRow = byId('wfx-in-row-file');
    const isRepo = S.source === 'repo';
    if (repoCard) {
      repoCard.classList.toggle('selected', isRepo);
      repoCard.setAttribute('aria-pressed', isRepo ? 'true' : 'false');
    }
    if (fileCard) {
      fileCard.classList.toggle('selected', !isRepo);
      fileCard.setAttribute('aria-pressed', isRepo ? 'false' : 'true');
    }
    if (repoRow) repoRow.hidden = !isRepo;
    if (fileRow) fileRow.hidden = isRepo;
  }

  // ── Fetch ──────────────────────────────────────────────────────────────────
  function fetchBusy(on) {
    const btn = byId('wfx-in-fetch');
    if (!btn) return;
    btn.disabled = !!on;
    btn.textContent = on ? 'Fetching' : 'Fetch';
  }

  async function doFetch() {
    if (S.installing) return;
    const isRepo = S.source === 'repo';
    const field = byId(isRepo ? 'wfx-in-url' : 'wfx-in-path');
    const raw = field ? String(field.value || '').trim() : '';
    if (!raw) {
      refuse({ stage: 'source', code: isRepo ? 'no-url' : 'no-path', message: '', detail: null });
      if (field) field.focus();
      return;
    }
    // A pasted "github.com/dev/flows" is unambiguously a URL and the scheme is
    // the one thing the reader gains nothing by typing. The main process still
    // decides what it will clone; this only fills in what was obviously meant.
    const value = (isRepo && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) ? `https://${raw}` : raw;
    if (isRepo && field) field.value = value;

    const seq = ++S.seq;
    S.read = null;
    S.artifact = null;
    S.preflight = null;
    setError(null);
    setState('busy');
    fetchBusy(true);
    if (isRepo) {
      setStatus(el('span', {},
        'Cloning ', el('code', {}, value),
        ' into a scratch directory. Husk reads it there and copies nothing else out.'));
    } else {
      setStatus(el('span', {}, 'Reading ', el('code', {}, value), ' from this disk.'));
    }
    say(isRepo ? 'Cloning the repository and looking for a workflow file.' : 'Reading the file.');

    const res = await window.husk.workflows.artifactRead(
      isRepo ? { source: 'repo', url: value } : { source: 'file', path: value });

    // A result from a fetch the reader has already replaced or abandoned is
    // discarded whole. Painting it would mean the sheet shows a file nobody
    // asked for any more, with an Install button under it.
    if (seq !== S.seq) return;
    fetchBusy(false);

    if (!res || !res.ok) {
      refuse(res || { stage: 'source', code: 'unreadable', message: '', detail: null });
      return;
    }

    S.read = res;
    S.artifact = res.artifact;
    S.preflight = null;
    setStatus(null);
    setState('ready');
    paintReady();
    applyGate();
    const steps = ((res.artifact.graph && res.artifact.graph.nodes) || []).length;
    say(`Read ${res.artifact.name}: ${steps} steps. Husk recomputed the fingerprint here. Nothing has been installed.`);
    runPreflight();
  }

  // ── Preflight and the commit gate ──────────────────────────────────────────
  async function runPreflight() {
    if (!S.artifact) return;
    const seq = S.seq;
    const res = await window.husk.workflows.preflight({ artifact: S.artifact, cwd: S.cwd });
    if (seq !== S.seq) return;
    if (!res || !res.ok) {
      // The artifact is revalidated inside preflight, so a refusal here is a
      // statement about the file and belongs on the refused pane like any
      // other. A sheet that offered Install after its own checks refused to
      // run would be offering the one thing it just said it could not judge.
      refuse(res || { stage: 'validate', code: 'render-failed', message: '', detail: null });
      return;
    }
    S.preflight = res;
    // res.cwd is deliberately not adopted as the binding. Preflight resolves a
    // directory so its marker-file and work-tree rows have something to report
    // on, and if the main process ever answers with a default, taking it here
    // would bind an imported workflow to a directory nobody chose: the exact
    // shape of the bug where a stranger's four-step agent workflow edits
    // whichever repo you last had open. The binding is what the reader picked
    // and nothing else, so an unpicked directory keeps the commit withheld.
    paintReady();
    applyGate();
    const blocking = Number(res.blocking) || 0;
    say(blocking
      ? `${blocking} requirement${blocking === 1 ? '' : 's'} on this machine ${blocking === 1 ? 'stops' : 'stop'} this from running here. Install is withheld.`
      : 'Nothing on this machine blocks this workflow.');
  }

  function firstBlocker() {
    const checks = (S.preflight && Array.isArray(S.preflight.checks)) ? S.preflight.checks : [];
    return checks.find((c) => c && c.status === 'block') || null;
  }

  // The single place that decides whether the commit is offered, and the
  // single place that writes the sentence saying why it is not. aria-disabled
  // rather than disabled: `disabled` takes the button out of the tab order, so
  // the one control a keyboard user would land on to find out what is blocking
  // them is the one they can never reach.
  function applyGate() {
    const go = byId('wfx-in-go');
    if (!go) return;
    if (stateNow() !== 'ready') return;

    if (!S.cwd) {
      go.setAttribute('aria-disabled', 'true');
      setFoot('Pick the directory this workflow will run in. Install stays withheld until it has one.', false);
      return;
    }
    const blocker = firstBlocker();
    if (blocker) {
      go.setAttribute('aria-disabled', 'true');
      setFoot(`${blocker.title || blocker.name}. Install stays withheld while that is true.`, false);
      return;
    }
    go.setAttribute('aria-disabled', 'false');
    setFoot('Installing writes a file. It does not run anything.', false);
  }

  // ── Binding a directory ────────────────────────────────────────────────────
  async function pickCwd() {
    if (S.installing) return;
    const picked = await window.husk.dialog2.pickDir();
    if (!picked) return;
    S.cwd = picked;
    paintReady();
    applyGate();
    say(`This workflow will run in ${picked}.`);
    // Every directory probe belongs to the main process and every one of them
    // is re-run at the moment of the press anyway, so the point of re-running
    // preflight here is the reader: the marker-file and work-tree rows are
    // about this directory and they are stale the instant it changes.
    runPreflight();
  }

  // ── Install ────────────────────────────────────────────────────────────────
  async function doInstall() {
    const go = byId('wfx-in-go');
    if (!go || S.installing) return;
    // An aria-disabled button is still clickable; this listener is the entire
    // guard. Re-announcing the blocker is the useful thing to do with a press
    // that cannot be honoured, because the reader has just told us they are
    // looking for the way forward.
    if (go.getAttribute('aria-disabled') === 'true') {
      const note = byId('wfx-in-foot');
      say(note ? note.textContent : 'Install is not available yet.');
      return;
    }
    if (!S.artifact || !S.cwd) return;

    const seq = S.seq;
    S.installing = true;
    const label = go.textContent;
    go.textContent = 'Installing';
    go.setAttribute('aria-disabled', 'true');
    setError(null);
    setFoot('Writing the workflow record.', false);
    setState('working');
    say('Writing the workflow record.');

    const res = await window.husk.workflows.install({ artifact: S.artifact, cwd: S.cwd });
    if (seq !== S.seq) return;
    S.installing = false;

    if (!res || !res.ok) {
      // The file is fine and the destination is not, so nothing the reader
      // assembled is discarded: the sheet goes back to ready with everything
      // in place, and the reason reaches both the banner at the top of the
      // scroller and the footer note beside the button that was pressed.
      const code = (res && res.code) || 'write-failed';
      const sentence = INSTALL_TROUBLE[code]
        || (res && res.message ? `Nothing was written. ${res.message}` : 'Nothing was written. The install did not complete.');
      go.textContent = label;
      setState('ready');
      applyGate();
      setFoot(sentence, true);
      setError(`${sentence} The staged install is still here, so fixing this and pressing Install again costs nothing.`);
      say(sentence);
      return;
    }

    S.installed = { workflow: res.workflow, sidecar: res.sidecar };
    go.textContent = label;
    paintDone(res.workflow);
    if (typeof hooks.onInstalled === 'function') {
      try {
        hooks.onInstalled(res.workflow, res.sidecar);
      } catch (err) {
        if (window.console && console.warn) console.warn('wfx-install: onInstalled hook threw', err);
      }
    }
    if (typeof window.toast === 'function') window.toast('Installed. Ready to run.', 'success');
  }

  function paintDone(workflow) {
    const steps = ((workflow && workflow.graph && workflow.graph.nodes) || []).length;
    const msg = byId('wfx-in-done-m');
    if (msg) {
      msg.textContent = `${(workflow && workflow.name) || 'The workflow'} is saved and has not run. Run it opens all ${steps} prompt${steps === 1 ? '' : 's'} once more and waits for you to say yes before anything spawns.`;
    }
    writeDonePath(S.cwd || '');
    setFoot('Nothing has run. Run it asks once more first.', false);
    setState('done');
    say('Installed. Nothing has run.');
    const done = byId('wfx-in-done');
    if (done) {
      try { done.focus(); } catch (_) { /* focus is a courtesy, not a contract */ }
    }
  }

  // The forward move from the done pane. The gate it opens is the same one the
  // card would have opened on first Run, which is deliberate: consent belongs
  // to the moment a stranger's prompts reach a CLI, not to the moment a file
  // is written, so there is exactly one place it can be given.
  function runIt() {
    const installed = S.installed || null;
    const workflow = installed ? installed.workflow : null;
    const id = workflow ? workflow.id : null;
    const cwd = (installed && installed.sidecar && installed.sidecar.boundCwd) || S.cwd || null;
    close();
    if (!id) return;
    if (typeof hooks.openConsent === 'function') { hooks.openConsent(id, workflow, cwd); return; }
    // runWorkflow is the one call that starts a workflow, not a convenience
    // wrapper: it reads the sidecar, opens the gate when the row says consent
    // is owed, writes consentedAt only after the reader agrees, and only then
    // starts the run. Calling workflows.run from here instead would be the
    // path that skips the gate, which is the entire thing the gate exists for.
    const ui = window.WfxArtifactUi;
    if (ui && typeof ui.runWorkflow === 'function') { ui.runWorkflow(id, { cwd, workflow }); return; }
    if (typeof window.toast === 'function') {
      window.toast('Installed. Press Run on its card to review the prompts.', 'success');
    }
  }

  // ── Open and close ─────────────────────────────────────────────────────────
  function reset() {
    S.seq += 1;
    S.read = null;
    S.artifact = null;
    S.cwd = null;
    S.preflight = null;
    S.installing = false;
    S.installed = null;
    const ready = byId('wfx-in-ready');
    if (ready) ready.replaceChildren();
    setStatus(null);
    setError(null);
    setFoot('Installing writes a file. It does not run anything.', false);
    const go = byId('wfx-in-go');
    if (go) {
      go.textContent = 'Install';
      go.setAttribute('aria-disabled', 'true');
    }
    fetchBusy(false);
    say('');
    setState('idle');
  }

  function open() {
    const m = modal();
    if (!m) return;
    S.restoreFocus = document.activeElement;
    reset();
    setSource(S.source);
    m.hidden = false;
    const field = byId(S.source === 'file' ? 'wfx-in-path' : 'wfx-in-url');
    if (field) {
      try { field.focus(); } catch (_) { /* focus is a courtesy, not a contract */ }
    }
  }

  // The closer MODAL_CLOSERS points at, which is why it does more than hide a
  // card. Bumping the sequence is what makes Escape during a clone mean
  // something: the clone in the main process runs to its own end, and its
  // result lands on a sheet that has already discarded it rather than
  // repainting a dialog the reader closed.
  function close() {
    const m = modal();
    if (m) m.hidden = true;
    reset();
    const back = S.restoreFocus;
    S.restoreFocus = null;
    if (back && typeof back.focus === 'function') {
      try { back.focus(); } catch (_) { /* the element may be gone; nothing to do */ }
    }
  }

  function isOpen() {
    const m = modal();
    return !!(m && !m.hidden);
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────
  // The two adopted controls are bound once, here, rather than on each repaint.
  // They are re-parented into the rebuilt ready pane, not recreated, so a
  // listener attached now survives every repaint of that pane.
  function wire() {
    const on = (id, event, fn) => {
      const node = byId(id);
      if (node) node.addEventListener(event, fn);
    };

    // Both adoptions happen here, before anything empties the ready pane. The
    // pane ships with a worked example in it and the first open replaces the
    // lot, so a control claimed later would be claimed from a pane that no
    // longer has it and the sheet would quietly grow a second, id-less Copy
    // button that nothing is bound to.
    adopt('wfx-in-fp-copy', () => el('button', { type: 'button', class: 'ghost-btn' }, 'Copy'));
    adopt('wfx-in-cwd-change', () => el('button', { type: 'button', class: 'ghost-btn' }, 'Change directory'));

    on('wfx-in-x', 'click', close);
    on('wfx-in-cancel', 'click', close);
    on('wfx-in-done', 'click', close);
    on('wfx-in-run', 'click', runIt);
    on('wfx-in-go', 'click', doInstall);

    on('wfx-in-src-repo', 'click', () => {
      setSource('repo');
      const field = byId('wfx-in-url');
      if (field) { try { field.focus(); } catch (_) { /* nothing to do */ } }
    });
    on('wfx-in-src-file', 'click', () => {
      setSource('file');
      pickArtifactFile();
    });
    on('wfx-in-browse', 'click', pickArtifactFile);
    on('wfx-in-fetch', 'click', doFetch);

    // Enter in either path field fetches, which is the shortcut the sheet's
    // keyboard path promises and the one people type without thinking.
    const enterFetches = (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      doFetch();
    };
    on('wfx-in-url', 'keydown', enterFetches);
    on('wfx-in-path', 'keydown', enterFetches);

    // Bound on the adopted nodes rather than by id, so the fallback buttons
    // built above are wired too and so the binding survives every repaint of
    // the ready pane: those two elements are moved into the rebuilt tree, not
    // recreated, which is the whole reason they are adopted.
    S.adopted['wfx-in-cwd-change'].addEventListener('click', pickCwd);
    S.adopted['wfx-in-fp-copy'].addEventListener('click', copyFingerprint);

    // A click on the scrim closes, matching every other dialog in this window.
    const m = modal();
    if (m) {
      m.addEventListener('click', (e) => { if (e.target === m) close(); });
    }
  }

  async function pickArtifactFile() {
    const picked = await window.husk.workflows.pickArtifactFile();
    if (!picked) return;
    const field = byId('wfx-in-path');
    if (field) field.value = picked;
    setSource('file');
    doFetch();
  }

  // 78 monospace characters a reader is explicitly invited to compare against
  // the repository they got the file from. Without this the only way to get it
  // out of the window was a mouse drag across the whole string.
  async function copyFingerprint() {
    const hash = S.artifact ? String(S.artifact.graphHash || '') : '';
    if (!hash) return;
    try {
      await navigator.clipboard.writeText(hash);
      say('The fingerprint is on the clipboard.');
      if (typeof window.toast === 'function') window.toast('Fingerprint copied', 'success');
    } catch (_) {
      say('Husk could not reach the clipboard. The fingerprint is selectable in the block above.');
    }
  }

  // ── The one global ─────────────────────────────────────────────────────────
  // A single namespaced object rather than a handful of loose functions,
  // because app.js needs exactly four things from this file: a way to open the
  // sheet from the page head, a closer to register in MODAL_CLOSERS so global
  // Escape drops a staged install rather than hiding a card over a running
  // clone, the hooks that let it keep owning the grid and the MCP and skills
  // surfaces, and an override for the ready pane's renderer.
  //
  //   WfxInstall.open()
  //   WfxInstall.close()                     MODAL_CLOSERS['wfx-install-modal']
  //   WfxInstall.isOpen()
  //   WfxInstall.configure({ onInstalled, openConsent, openMcpForm,
  //                          openSkills, openAgents, getBilling })
  //   WfxInstall.setInspector(fn)            same shape as
  //                                          WfxArtifactUi.renderInspector,
  //                                          which is picked up automatically
  //                                          and needs no registration
  window.WfxInstall = {
    open,
    close,
    isOpen,
    configure(next) {
      if (!next || typeof next !== 'object') return;
      for (const key of Object.keys(hooks)) {
        if (typeof next[key] === 'function') hooks[key] = next[key];
      }
    },
    setInspector(fn) {
      inspector = typeof fn === 'function' ? fn : null;
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire, { once: true });
  } else {
    wire();
  }
})();
