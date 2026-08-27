'use strict';

// Install-sheet driver for importing portable workflows.
//
// Invariants: refused artifacts have no Install control; install failures are
// visible from the pinned footer; manifest strings render only through WfxDom;
// manifest data never reaches MCP add channels.

(function () {
  // ── The shell ──────────────────────────────────────────────────────────────
  // Looked up per call, so a markup change is reported rather than cached.
  const byId = (id) => document.getElementById(id);

  // The builder is required: a manifest renders through it or not at all.
  function kit() {
    const dom = window.WfxDom;
    if (!dom || typeof dom.el !== 'function') {
      throw new Error('wfx-install: wfx-dom.js must load before this file');
    }
    return dom;
  }
  const el = (tag, attrs, ...children) => kit().el(tag, attrs, ...children);

  // Step names render as one visible line, whatever the file put in them.
  const NAME_CONTROL_RE = /[\u0000-\u001F\u007F]/g;
  const oneLine = (value) => String(value == null ? '' : value).replace(NAME_CONTROL_RE, '\uFFFD');

  // ── Static glyphs ──────────────────────────────────────────────────────────
  // Fixed SVG glyphs; manifest data never reaches these path strings.
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
  // Stage-scoped keys keep similarly named refusals distinct.
  const REFUSAL_COPY = Object.freeze({
    source: {
      'no-url': {
        title: 'Nothing to fetch yet',
        message: 'Type the https URL of a repository that holds a workflow file, then press Fetch. Husk clones it into a directory under its own data folder, reads it there, and copies nothing else out.',
      },
      'no-path': {
        title: 'Nothing to read yet',
        message: 'Choose a .husk.json on this disk, or type its absolute path, then press Fetch.',
      },
      // Detect local paths before git can misreport them as network failures.
      'local-path': {
        title: 'That is a path on this disk, not a repository URL',
        message: 'The repository field takes an https URL and Husk would have handed this to git as a remote. Husk moved it into the file field and switched the source to From a file, so pressing Fetch now reads it off this disk. Nothing was cloned and nothing was written.',
      },
      'clone-failed': {
        title: 'Husk could not clone that repository',
        message: 'The clone did not finish, so nothing was read and nothing was kept. A private repository, a typo in the URL and no network all land here. The URL above is still filled in, so correcting it and pressing Fetch again costs nothing.',
      },
      'no-artifact-found': {
        title: 'No workflow file in that repository',
        message: 'The clone worked and there is no .husk.json anywhere inside it. A published workflow is a single file, usually workflow.husk.json at the root or under .husk/workflows. The checkout stays in Husk\'s own data folder and is reused, and fast-forwarded, the next time you fetch that URL; nothing was read out of it and nothing was written to your workflows.',
      },
      // A catalog named a file on a different host than the catalog itself.
      // Subscribing to a registry is a decision about one host, so a pointer
      // that leaves it is refused rather than followed and disclosed.
      'cross-origin-artifact': {
        title: 'That catalog points at a different host than itself',
        message: 'A registry may only name workflow files served from the same host it is served from, so that subscribing to it is a decision about one host rather than about wherever it later chooses to point. Nothing was fetched from the other host.',
      },
      // The bytes are not the bytes the catalog listed. Refused rather than
      // shown with a warning: contradicted evidence is worse than none.
      'digest-mismatch': {
        title: 'That file is not the file this catalog lists',
        message: 'The catalog states a digest for this workflow and the bytes that arrived hash to something else. That means the file changed after the catalog was written, or that what answered is not what the catalog meant. Husk stopped before reading it as a workflow, so nothing was parsed and nothing was written.',
      },
      'digest-malformed': {
        title: 'That catalog states a digest Husk cannot read',
        message: 'The entry carries a digest that is not a sha256, so there is nothing to check the bytes against. Husk stopped rather than fetching a file it could not have compared.',
      },
      'bad-registry-url': {
        title: 'That is not a registry URL',
        message: 'A registry is one https URL to one JSON index, with no credentials in it. Nothing was fetched.',
      },
      'bad-artifact-url': {
        title: 'That entry does not say where its file is',
        message: 'The catalog lists this workflow without a usable https pointer to the file itself, so there is nothing to fetch.',
      },
      'fetch-failed': {
        title: 'Husk could not read that catalog',
        message: 'The request did not finish. No network, a host that answered with something other than a catalog, and too many redirects all land here. Nothing was read and nothing was written.',
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

    // Closed validator enum; all entries land on the no-Install refused pane.
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
  //
  // `owned` says whether this module is the thing currently using the dialog.
  // The sheet is shared: app.js opens the same card over the same ready pane to
  // show the record a card's receipts chip points at, and does it by showing
  // the modal itself. Everything that stages an install hangs off this flag, so
  // the source picker and both path rows are hidden whenever it is false. See
  // setSource.
  const S = {
    seq: 0,
    owned: false,
    source: 'repo',
    read: null,        // the whole ok payload from artifactRead
    artifact: null,
    cwd: null,
    preflight: null,
    nameClash: 0,      // how many workflows already carry this file's name
    installing: false,
    installed: null,   // { workflow, sidecar }
    restoreFocus: null,
    adopted: null,     // the two shell controls we re-parent instead of rebuilding
  };

  // Hooks the surrounding app fills in. Every one of them is optional and every
  // default is inert, so this sheet is reviewable and testable without app.js
  // having wired anything yet. They are hooks rather than direct calls so this
  // file never names the MCP channels, and so app.js keeps owning the workflow
  // grid and the consent gate.
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
  // so the tier rules live in one place rather than in each surface that draws
  // a number. This file owns the flow around it, so when the inspector is
  // present the whole pane is handed to it, and the builders further down are
  // the fallback that keeps this sheet complete on its own.
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

  // The error banner. It sits at the top of a scroller and the reader stands at
  // the tail when they press Install, so it is scrolled into view and the
  // footer note carries the same sentence.
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

  // Footer composition per state, in one place, so exactly one primary shows.
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
  // Delegated to wfMiniGraph in app.js, which is the only implementation. It
  // builds elements rather than a string of markup, and it bounds both the node
  // count and the way it measures its own extents.
  //
  // A second local copy of the drawing would drift out of step with it, and the
  // preview a person reads before running a stranger's workflow is the one that
  // has to carry the step names.
  //
  // The fallback shows a placeholder in a window where app.js failed to
  // evaluate, rather than throwing inside a dialog.
  function buildMiniGraph(graph) {
    if (typeof wfMiniGraph !== 'function') {
      return el('div', { class: ['wf-mini', 'is-empty'] }, el('span', {}, 'no preview available'));
    }
    // The panel surface is the sheet's own column width. Passing it rather than
    // taking the card default is what gives the labels room to be read at the
    // size this dialog actually renders.
    return wfMiniGraph(graph, null, 'panel');
  }

  // ── Figures ────────────────────────────────────────────────────────────────
  // The chip is a sibling of the number inside the same tile, so a figure
  // always renders with where it came from.
  function claim(tier, label) {
    return el('span', {},
      el('span', { class: ['wfx-claim', tier] },
        el('i', { class: 'wfx-claim-m', aria: { hidden: true } }),
        label));
  }

  // "author states" is the floor for everything a receipt asserts, and also the
  // ceiling until this machine has recomputed the numbers from a shipped log.
  // That recomputation is the main process's job and this read does not carry
  // its verdict. The word "verified" appears nowhere.
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
    // never a dollar figure: a workflow file carries no dollars. A local
    // estimate from local rates belongs to the inspector, which owns the rate
    // table and the tier that goes with it.
    const inline = r.evidence === 'inline';
    tiles.push(figure(inline ? 'log attached' : 'no log', null, 'evidence', SAID, 'author states', !inline));

    return el('div', { class: 'wfx-figs' }, ...tiles);
  }

  // ── The ready pane, when nothing better is registered ──────────────────────
  // Everything from here to paintReady is the fallback renderer: what this
  // sheet draws with no artifact inspector loaded. It is complete rather than a
  // placeholder, so a load-order change still gets a full pane.
  //
  // It is built into a fragment and committed in one assignment, so a refusal
  // from el() leaves the previous pane rather than a half-drawn one.
  function buildEvidence(read) {
    const artifact = read.artifact;
    const out = [];

    // The fingerprint, whole rather than as a prefix, because this is where a
    // reader compares it against the repository they got the file from. The
    // chip says the string was recomputed here rather than read out of the
    // file.
    const copyBtn = adopt('wfx-in-fp-copy', () => el('button', { type: 'button', class: 'ghost-btn' }, 'Copy'));
    out.push(el('div', { class: ['ra-status', 'ra-status-info'] },
      el('div', { class: 'wfx-fp-h' },
        el('span', {}, claim(COMPUTED, 'computed here')),
        copyBtn),
      el('code', {}, String(artifact.graphHash || '')),
      el('span', {}, 'Recomputed from the bytes of this file, not read out of them.')));

    const publisher = (artifact.publisher && typeof artifact.publisher === 'object') ? artifact.publisher : null;
    const heading = publisher && publisher.name
      ? `${oneLine(artifact.name)} · ${oneLine(publisher.name)}`
      : oneLine(artifact.name);
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
  // recreated: el() mints ids only inside its own namespace. The fallback keeps
  // a markup change downstream to a working sheet with an anonymous button.
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
  // severity order, so the rows the footer names are the first ones on screen.
  // The sort is stable, so within a severity the main process's order survives.
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

  // A row can carry two affordances and they are not alternatives: fix is
  // somewhere to go, detail is something to read, and a row with both shows
  // both.
  //
  // The one place a preflight fix is acted on, shared by the rows this file
  // builds and by the inspector's onFix callback, so a fix behaves the same
  // whichever renderer drew the row.
  //
  // Every destination is a hook rather than a call. The MCP row's affordance
  // opens the EMPTY server form: no name, no command, no argv from the manifest
  // reaches it, and the channel names stay out of this file entirely.
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
    // useful than a control that swallows the press, and the row above still
    // names what is missing.
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

    // The fingerprint pair, in full and never as a prefix, on the row where a
    // reader decides whether the server or skill they have is the one the
    // prompts were written against.
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

  // Each prompt renders as one text node inside a <pre>, with no token
  // highlighting: el() owns the scrub, and every character on screen is one it
  // wrote.
  function buildSteps(graph) {
    const nodes = (graph && Array.isArray(graph.nodes)) ? graph.nodes : [];
    const items = nodes.map((n, i) => {
      const meta = [n.agentCommand, n.model].filter((s) => typeof s === 'string' && s).join(' · ');
      const pass = PASS_CONTEXT[n.passContext] || 'carries nothing forward';
      return el('details', { class: 'wfx-step' },
        el('summary', {},
          el('span', { class: 'wfx-step-n' }, String(i + 1).padStart(2, '0')),
          el('span', { class: 'wfx-step-b' },
            el('span', { class: 'wfx-step-name' }, oneLine(n.name)),
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
      // keeps the Copy and Change listeners bound at startup across repaints.
      host.replaceChildren(S.adopted['wfx-in-fp-copy'], S.adopted['wfx-in-cwd-change']);
      let res;
      try {
        res = render({
          host,
          artifact: S.read.artifact,
          preflight: S.preflight,
          cwd: S.cwd,
          billing: (typeof hooks.getBilling === 'function') ? hooks.getBilling() : null,
          // The main process re-derives the shipped log's figures during
          // artifactRead and compares them to the declared ones, so that answer
          // is handed on. It is what makes the middle tier reachable.
          chainCheck: (S.read && S.read.chainCheck) || null,
          // Framed, because the busy pane's skeleton reserves a framed graph and
          // the real thing lands in the space it held. The inspector appends
          // what it is given and does not know what surface it is on, so the
          // frame belongs to the caller.
          //
          // app.js owns the labelled preview and the record pane behind a card
          // already uses it, so calling it here keeps the two drawings in step
          // and gives this sheet the step names. Null for the run, as the record
          // pane passes. buildMiniGraph is the fallback for a window where
          // app.js has not finished evaluating.
          miniGraph: el('div', { class: 'wf-card-graph' },
            typeof window.wfMiniGraph === 'function'
              ? window.wfMiniGraph(S.read.artifact.graph, null, 'panel')
              : buildMiniGraph(S.read.artifact.graph)),
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

  // The main process writes its messages as clause fragments, because most of
  // them are composed into a sentence somewhere ("Husk could not install this:
  // that path is not a directory"). This pane is the one place they are set
  // down whole, after a full stop, so they are given the two marks that make
  // them a sentence. Nothing is reworded: a message that already arrived
  // punctuated keeps exactly what it arrived with.
  function asSentence(value) {
    const s = String(value).trim();
    if (!s) return '';
    const head = s.charAt(0).toUpperCase() + s.slice(1);
    return /[.!?]$/.test(head) ? head : `${head}.`;
  }

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
        ? ` ${asSentence(res.message)}`
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
    // Everything staged is dropped, so a refused file leaves nothing behind
    // for the Install path to reach.
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
  //
  // The whole picker, both path rows and both buttons are gated on S.owned.
  // These controls live in the sheet's body above the panes rather than inside
  // one, so no data-state hides them, and app.js borrows this card to show the
  // record behind a workflow's receipts chip. A control that belongs to a flow
  // nobody started is not an affordance, so it is not on screen.
  function setSource(kind) {
    S.source = kind === 'file' ? 'file' : 'repo';
    const m = modal();
    const picker = m ? m.querySelector('.ra-sources') : null;
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
    if (picker) picker.hidden = !S.owned;
    if (repoRow) repoRow.hidden = !S.owned || !isRepo;
    if (fileRow) fileRow.hidden = !S.owned || isRepo;
  }

  // ── Fetch ──────────────────────────────────────────────────────────────────
  // The file row's markup carries a picker, and this button re-reads a path
  // already in the field, which is the loop a workflow is written in: edit the
  // file, read it here, look at the prompts, edit again. The sheet's refusal
  // copy names the control ("type its absolute path, then press Fetch"). It is
  // built here rather than in index.html because this module owns what Fetch
  // does in either source; the repo row's button keeps its shipped id and this
  // one is held by reference.
  let fileFetchBtn = null;

  function mountFileFetch() {
    if (fileFetchBtn) return fileFetchBtn;
    const row = byId('wfx-in-row-file');
    if (!row) return null;
    fileFetchBtn = el('button', { type: 'button', class: 'ghost-btn' }, 'Fetch');
    fileFetchBtn.addEventListener('click', doFetch);
    row.appendChild(fileFetchBtn);
    return fileFetchBtn;
  }

  // Both buttons, because either one can be the press that started the read and
  // a picker still live during a clone is a second read nobody asked for.
  function fetchBusy(on) {
    for (const btn of [byId('wfx-in-fetch'), fileFetchBtn]) {
      if (!btn) continue;
      btn.disabled = !!on;
      btn.textContent = on ? 'Fetching' : 'Fetch';
    }
    const browse = byId('wfx-in-browse');
    if (browse) browse.disabled = !!on;
  }

  // The banner that says these bytes did not come off the network. Unlike the
  // fetch-in-flight banner it survives into the ready pane, which otherwise
  // reads as the current contents of the URL in the field.
  //
  // The reason comes from git by way of friendlyCloneError, so it goes through
  // el() like every other string this sheet did not write.
  function staleNote(source) {
    if (!source || source.stale !== true) return null;
    let when = '';
    const t = source.fetchedAt ? new Date(source.fetchedAt) : null;
    if (t && !Number.isNaN(t.getTime())) {
      try { when = ` on ${t.toLocaleString()}`; } catch (_) { when = ` on ${t.toISOString()}`; }
    }
    const reason = (typeof source.staleReason === 'string' && source.staleReason) ? ` ${source.staleReason}` : '';
    // "last updated" rather than "cloned": the stamp is the last time this
    // checkout agreed with the remote, which is the clone only until the first
    // successful pull.
    return el('span', {},
      `Read from the copy Husk already had on disk${when ? `, last updated${when}` : ''}, not from the repository. The repository could not be reached just now, so this may not be what is at that URL today.${reason}`);
  }

  // How many sibling files this sentence will name before it gives up on
  // listing them. The main process collects at most 32 candidates, so a list
  // that fits under this number is provably the whole set and the sentence can
  // say so; past it the wording drops the total rather than asserting a count
  // that a truncated scan may not support.
  const NAMED_CANDIDATES = 6;

  // Which file in the repository these bytes are. A clone can hold several
  // .husk.json and the main process reads exactly one of them: shallowest
  // first, workflow.husk.json preferred, ties broken alphabetically so the
  // choice is the same on every machine. The sentence states that choice, so a
  // repository with a workflow file per environment does not read as one.
  //
  // The others are named and are not offered as controls: the repo source in
  // the main process decides which path in a clone is read.
  function sourceNote(source) {
    // A file a catalog named. Two facts belong in this line and no more: the
    // host it came from, and whether the catalog stated a digest that the
    // bytes then matched. A mismatch never reaches here, because the read
    // refuses it, so "listed without one" is the only other thing it can say.
    if (source && source.kind === 'registry') {
      let host = '';
      try { host = new URL(String(source.url)).host; } catch (_) { host = ''; }
      const parts = ['Read from ', el('code', {}, host || 'that registry'), '.'];
      parts.push(source.attested
        ? ' The catalog stated a digest for this file and the bytes match it, which is not a signature: it says the catalog and the file agree, not who wrote either.'
        : ' The catalog stated no digest for this file, so nothing here attests to which bytes were meant.');
      return el('span', {}, ...parts);
    }
    if (!source || source.kind !== 'repo') return null;
    const rel = (typeof source.relPath === 'string' && source.relPath) ? source.relPath : null;
    if (!rel) return null;
    const others = Array.isArray(source.candidates)
      ? source.candidates.filter((c) => typeof c === 'string' && c && c !== rel)
      : [];
    const parts = ['Read ', el('code', {}, rel), ' from that repository.'];
    if (others.length && others.length <= NAMED_CANDIDATES) {
      parts.push(' It also holds ');
      others.forEach((name, i) => {
        if (i > 0) parts.push(i === others.length - 1 ? ' and ' : ', ');
        parts.push(el('code', {}, name));
      });
      parts.push(others.length === 1 ? ', which was not read.' : ', none of which was read.');
    } else if (others.length) {
      parts.push(' It holds more workflow files than this sentence will list, and none of the others was read.');
    }
    return el('span', {}, ...parts);
  }

  // Two facts about one fetch, and neither implies the other: which file was
  // read, and whether the repository answered at all. .ra-status is a flex
  // column, so they stack as two spans rather than running together into a
  // paragraph where the second qualifies the first.
  function fetchNote(source) {
    const pieces = [sourceNote(source), staleNote(source)].filter(Boolean);
    if (!pieces.length) return null;
    return kit().frag(...pieces);
  }

  // A value the reader typed into the repository field that is plainly a path
  // on this disk. git would treat it as a remote and answer with a network
  // error, so it is answered here instead. Everything this recognises is
  // unambiguous: a leading separator, a home shorthand, an explicit relative
  // prefix, a Windows drive or UNC path, or the file scheme. A bare
  // "github.com/dev/flows" is none of those and gets the https prefix.
  const LOCAL_PATH_RE = /^(?:~|\/|\.{1,2}[/\\]|[A-Za-z]:[/\\]|\\\\|file:\/\/)/;

  async function doFetch() {
    // Nothing here runs while another surface has the card, so a fetch always
    // repaints the pane the flow that started it owns.
    if (S.installing || !S.owned) return;
    const isRepo = S.source === 'repo';
    const field = byId(isRepo ? 'wfx-in-url' : 'wfx-in-path');
    const raw = field ? String(field.value || '').trim() : '';
    if (!raw) {
      refuse({ stage: 'source', code: isRepo ? 'no-url' : 'no-path', message: '', detail: null });
      if (field) field.focus();
      return;
    }
    // A path in the URL field is answered here rather than by git. The value is
    // carried over into the file field and the source switched, because the
    // reader typed the right thing into the wrong box and retyping it is work
    // this sheet can do for them.
    if (isRepo && LOCAL_PATH_RE.test(raw)) {
      const pathField = byId('wfx-in-path');
      if (pathField) pathField.value = raw;
      refuse({ stage: 'source', code: 'local-path', message: '', detail: raw });
      setSource('file');
      if (pathField) { try { pathField.focus(); } catch (_) { /* focus is a courtesy */ } }
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
    S.nameClash = 0;
    setError(null);
    setState('busy');
    fetchBusy(true);
    if (isRepo) {
      setStatus(el('span', {},
        'Cloning ', el('code', {}, value),
        ' into a directory under Husk\'s own data folder. Husk reads it there and copies nothing else out.'));
    } else {
      setStatus(el('span', {}, 'Reading ', el('code', {}, value), ' from this disk.'));
    }
    say(isRepo ? 'Cloning the repository and looking for a workflow file.' : 'Reading the file.');

    const res = await window.husk.workflows.artifactRead(
      isRepo ? { source: 'repo', url: value } : { source: 'file', path: value });

    // A result from a fetch the reader has already replaced or abandoned is
    // discarded whole, so the pane describes the file that was last asked for.
    if (seq !== S.seq) return;
    fetchBusy(false);

    if (!res || !res.ok) {
      refuse(res || { stage: 'source', code: 'unreadable', message: '', detail: null });
      return;
    }

    S.read = res;
    S.artifact = res.artifact;
    S.preflight = null;
    const source = res.source || null;
    const stale = !!(source && source.stale === true);
    setStatus(fetchNote(source));
    setState('ready');
    paintReady();
    applyGate();
    const steps = ((res.artifact.graph && res.artifact.graph.nodes) || []).length;
    say(`Read ${oneLine(res.artifact.name)}: ${steps} steps.${stale ? ' It came from a copy already on disk; the repository could not be reached.' : ''} Husk recomputed the fingerprint here. Nothing has been installed.`);
    runPreflight();
    runNameCheck();
  }

  // ── The name this file would land under ────────────────────────────────────
  // Installing terminates in workflows:create, which does not care that a
  // workflow of the same name is already in the list: it mints a new id and the
  // grid grows a second card that is identical to the first from the outside.
  // Somebody importing a revision of a workflow they already have, which is the
  // common case for a file that lives in a repository, ends up with two cards,
  // so the count is stated before the press rather than discovered after it.
  //
  // The list is asked for rather than kept, because this sheet does not own the
  // grid and a cached copy would be stale the moment a card is renamed behind
  // it. Nothing here blocks: a second copy under one name is a legitimate thing
  // to want and this is a fact the reader is owed, not a rule.
  async function runNameCheck() {
    if (!S.artifact) return;
    const seq = S.seq;
    const wanted = String(S.artifact.name || '').trim().toLowerCase();
    if (!wanted) return;
    let list = null;
    try {
      list = await window.husk.workflows.list();
    } catch (_) {
      // No list is not a collision and must not be reported as one. The sheet
      // says nothing extra and the install is unaffected.
      return;
    }
    if (seq !== S.seq || !Array.isArray(list)) return;
    S.nameClash = list.filter((w) => w && String(w.name || '').trim().toLowerCase() === wanted).length;
    if (!S.nameClash) return;
    const node = byId('wfx-in-status');
    const already = S.nameClash === 1
      ? el('span', {}, 'A workflow called ', el('code', {}, oneLine(S.artifact.name)),
        ' is already in your list. Installing this file adds a second card under that name rather than replacing the first.')
      : el('span', {}, String(S.nameClash), ' workflows called ', el('code', {}, oneLine(S.artifact.name)),
        ' are already in your list. Installing this file adds another card under that name.');
    if (node) {
      node.hidden = false;
      node.appendChild(already);
    }
    applyGate();
    say('A workflow of this name is already here. Installing adds a second one.');
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
    // res.cwd is not adopted as the binding. Preflight resolves a directory so
    // its marker-file and work-tree rows have something to report on. The
    // binding is what the reader picked and nothing else, so an unpicked
    // directory keeps the commit withheld.
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

  // The single place that decides whether the commit is offered, and the single
  // place that writes the sentence saying why it is not. aria-disabled rather
  // than disabled, so the button keeps its place in the tab order and can carry
  // that sentence to a keyboard user.
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
    // The collision rides on the footer as well as in the banner at the top of
    // the scroller, because the banner is not where the reader is standing when
    // they press Install. The name itself is not repeated here: this string is
    // written straight to textContent, and the banner above is the copy that
    // carries the name, through el().
    setFoot(S.nameClash
      ? 'Installing writes a file. It does not run anything. A workflow of this name is already here, so this adds a second card.'
      : 'Installing writes a file. It does not run anything.', false);
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
    // The listener holds the state. Re-announcing the blocker is the useful
    // thing to do with a press that cannot be honoured, because the reader has
    // just told us they are looking for the way forward.
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
      msg.textContent = `${oneLine(workflow && workflow.name) || 'The workflow'} is saved and has not run. Run it opens all ${steps} prompt${steps === 1 ? '' : 's'} once more and waits for you to say yes before anything spawns.`;
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
    // runWorkflow is the one call that starts a workflow: it reads the sidecar,
    // opens the gate when the row says consent is owed, writes consentedAt only
    // after the reader agrees, and only then starts the run.
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
    S.nameClash = 0;
    S.installing = false;
    S.installed = null;
    // Dropping ownership here rather than in close() is what makes the resting
    // state of these controls "hidden". reset() runs at startup, on every open
    // before the flag is taken back, and on every close, so a card shown by
    // anything other than open() finds the source picker already put away.
    S.owned = false;
    setSource(S.source);
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
    S.owned = true;
    setSource(S.source);
    m.hidden = false;
    const field = byId(S.source === 'file' ? 'wfx-in-path' : 'wfx-in-url');
    if (field) {
      try { field.focus(); } catch (_) { /* focus is a courtesy, not a contract */ }
    }
  }

  // The marketplace's way in. The catalog has already decided which file this
  // is, so the source picker never appears: reset() leaves S.owned false, which
  // is what keeps those controls put away, and the sheet opens straight onto
  // the read.
  //
  // Everything after the bytes arrive is the block doFetch() runs, because it
  // is the same read: one validator, one preflight, one gate, one refusal
  // table. A catalog changes where the file was found and nothing else about
  // what happens to it.
  async function openFromRegistry(registryUrl, entry) {
    const m = modal();
    if (!m) return;
    S.restoreFocus = document.activeElement;
    reset();
    m.hidden = false;

    const seq = ++S.seq;
    setState('busy');
    const name = oneLine((entry && entry.claims && entry.claims.name) || 'that workflow');
    setStatus(el('span', {}, 'Reading ', el('code', {}, name), ' from the catalog that lists it.'));
    say('Reading the workflow file this catalog names. Nothing has been installed.');

    let res;
    try {
      res = await window.husk.workflows.artifactRead({ source: 'registry', registryUrl, entry });
    } catch (err) {
      res = { stage: 'source', code: 'fetch-failed', message: (err && err.message) || '', detail: null };
    }
    // A result the reader has already moved on from is discarded whole.
    if (seq !== S.seq) return;

    if (!res || !res.ok) {
      refuse(res || { stage: 'source', code: 'unreadable', message: '', detail: null });
      return;
    }

    S.read = res;
    S.artifact = res.artifact;
    S.preflight = null;
    setStatus(fetchNote(res.source || null));
    setState('ready');
    paintReady();
    applyGate();
    const steps = ((res.artifact.graph && res.artifact.graph.nodes) || []).length;
    say(`Read ${oneLine(res.artifact.name)}: ${steps} steps. Husk recomputed the fingerprint here. Nothing has been installed.`);
    runPreflight();
    runNameCheck();
  }

  // The closer MODAL_CLOSERS points at, which is why it does more than hide a
  // card. Bumping the sequence is what makes Escape during a clone mean
  // something: the clone in the main process runs to its own end and its result
  // lands on a sheet that has already discarded it.
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
    // lot, so the two shell controls are claimed while they are still there.
    adopt('wfx-in-fp-copy', () => el('button', { type: 'button', class: 'ghost-btn' }, 'Copy'));
    adopt('wfx-in-cwd-change', () => el('button', { type: 'button', class: 'ghost-btn' }, 'Change directory'));
    // The file row's Fetch, added once, before anything can hide the row.
    mountFileFetch();
    // And the resting state for the source controls: hidden until open() takes
    // the card. The sheet is closed at this point, so nothing moves on screen.
    setSource(S.source);

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
  // the repository they got the file from. Without this control the only way to
  // get it out of the window is a mouse drag across the whole string.
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
  // because app.js needs four things from this file: a way to open the sheet
  // from the page head, a closer to register in MODAL_CLOSERS so global Escape
  // drops a staged install, the hooks that let it keep owning the grid and the
  // MCP and skills surfaces, and an override for the ready pane's renderer.
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
    openFromRegistry,
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
