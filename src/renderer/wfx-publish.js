'use strict';

// The export sheet: turning a workflow you have been running into one file
// somebody else can read.
//
// The word is export and not publish, because this writes a file to a path you
// choose and nothing else. Nothing is uploaded, no index learns the workflow
// exists, and the file is untracked where it lands. Sharing it is a separate
// act the done pane hands you a git line for.
//
// The premise of this surface is that exporting is a byproduct of finishing
// rather than a form to fill in. Everything the file needs is already on this
// machine: the graph is what you drew, the agents and model pins are what the
// steps say, the run history is what happened. So the sheet asks for exactly
// two decisions, a destination and whether the run log travels, and spends the
// rest of its space telling you what the bytes will say about you. Nothing
// here has a required field, and a reader who presses Export without reading
// anything still ships a file that is honest about what it does and does not
// prove.
//
// Four things this file is careful about.
//
// The attach-the-log toggle defaults OFF, and that default is the whole
// argument. An audit row carries the goal text the author typed and the
// absolute path of the workspace the run happened in, which is a home
// directory layout and often a client's name. A reader has to opt into
// shipping those two things, not opt out of shipping them, because the cost of
// the wrong default is asymmetric: a log that did not travel costs a stranger
// one tier of confidence, and a log that travelled by accident cannot be
// recalled from a repo somebody has already cloned. The static markup states
// what a row contains in the label's own words, and this file never changes
// that sentence, only the state of the box under it.
//
// The byte disclosure lives in the done pane, and the reason is a seam in the
// IPC contract rather than a preference. workflows:export has no dry run: it
// builds the artifact and writes it in one call, and the artifact it returns
// is the only object in this process that is the file. Rendering a preview
// before the write would mean reconstructing canonicalProjection, the graph
// hash and the requires block in the renderer, which is a second
// implementation of the canonicalizer that can disagree with the one that
// wrote the file, and a byte pane that disagrees with the bytes is worse than
// no byte pane at all. So Export writes an untracked file onto your own disk,
// the done pane shows the exact bytes it wrote, and the git line that would
// make those bytes public sits directly under them. Nothing has been shared at
// the moment the disclosure is read, which is the property the disclosure
// exists to protect.
//
// The ready pane states what the file will contain and folds the argument for
// each claim behind one disclosure. The claims are the sheet's thesis and stay
// on the surface; the reasoning behind them is a thing to read once, not a
// thing to read before every export.
//
// A condition that stops the write is a gate at the top of the ready pane, not
// a sentence in the footer, and it carries the control that clears it. The one
// gate this sheet can raise, a step that does not name its agent, is repaired
// here because the canvas that would otherwise repair it is not open behind
// this sheet: exporting is reached from the workflow card's own menu.
//
// Every string that came out of a file reaches the DOM through el() from
// wfx-dom.js, with no exception left in this file. That matters here even
// though most of what this sheet renders is the user's own workflow, because
// re-exporting an imported workflow is a first-class path: the name, the
// description, the step names and the declared requirements in that case were
// written by whoever published the file this machine installed. The graph
// thumbnail goes through the same route; see paintGraph for why it carries its
// step names rather than a projection with the names stripped out.
//
// The git line is shell text a person pastes into a shell, so the workflow
// name inside it is quoted rather than interpolated. Same argument as above:
// on a republish that name is a stranger's string, and double quotes leave a
// shell free to expand what sits inside them, so the quoting is what keeps the
// pasted line a commit message and nothing more.

(function () {
  // ─── shell hooks ──────────────────────────────────────────────────────────
  // Resolved once per open rather than at load time, and by structure rather
  // than by id where index.html gives no id. That is a real dependency on
  // markup this file does not own, so a missing hook is reported by name and
  // the sheet refuses to open, instead of painting half a screen and leaving
  // the reader to guess which half is real. The static markup ships a worked
  // example in every data slot, so a slot this file failed to find would show
  // somebody else's workflow under this workflow's title.

  const REQUIRED = [
    'modal', 'card', 'body', 'ready', 'done', 'say', 'foot', 'go', 'goNoLog', 'doneBtn',
    'cancel', 'back', 'close', 'attach', 'destChange', 'copy', 'subject',
    'refTitle', 'refMessage', 'refDetail',
    'gate', 'gateTitle', 'gateMessage', 'gateFix', 'gateFixLabel', 'gateSel', 'gateGo', 'gateWho',
    'graphHost', 'recordHost', 'requiresHost', 'destPath',
    'what', 'whatName', 'whatMeta', 'whatPc',
    'raw', 'rawPre', 'rawName', 'rawMeta', 'rawPc',
    'doneNote', 'donePath', 'gitRow', 'gitPre',
  ];

  function resolve() {
    const modal = document.getElementById('wfx-publish-modal');
    if (!modal) return null;
    const ready = document.getElementById('wfx-pub-ready');
    const done = modal.querySelector('.wfx-pane-done');
    const destChange = document.getElementById('wfx-pub-dest-change');
    const copy = document.getElementById('wfx-pub-copy');
    // By id, both of them. Two details.wfx-step live in this modal, one per
    // pane, and a structural query would hand every write to whichever the
    // markup happens to declare first.
    const raw = document.getElementById('wfx-pub-raw');
    const what = document.getElementById('wfx-pub-what');
    const refs = {
      modal,
      card: modal.querySelector('.modal-card.wfx-sheet'),
      body: modal.querySelector('.modal-body'),
      ready,
      done,
      say: document.getElementById('wfx-pub-say'),
      subject: document.getElementById('wfx-pub-subject'),
      foot: document.getElementById('wfx-pub-foot'),
      go: document.getElementById('wfx-pub-go'),
      goNoLog: document.getElementById('wfx-pub-go-nolog'),
      doneBtn: document.getElementById('wfx-pub-done'),
      cancel: document.getElementById('wfx-pub-cancel'),
      back: document.getElementById('wfx-pub-back'),
      close: document.getElementById('wfx-pub-x'),
      attach: document.getElementById('wfx-pub-attach'),
      destChange,
      copy,
      refTitle: document.getElementById('wfx-pub-ref-t'),
      refMessage: document.getElementById('wfx-pub-ref-m'),
      refDetail: document.getElementById('wfx-pub-ref-e'),
      gate: document.getElementById('wfx-pub-gate'),
      gateTitle: document.getElementById('wfx-pub-gate-t'),
      gateMessage: document.getElementById('wfx-pub-gate-m'),
      gateFix: document.getElementById('wfx-pub-gate-fix'),
      gateFixLabel: document.getElementById('wfx-pub-fix-label'),
      gateSel: document.getElementById('wfx-pub-fix-agent'),
      gateGo: document.getElementById('wfx-pub-fix-go'),
      gateWho: document.getElementById('wfx-pub-gate-who'),
      graphHost: ready ? ready.querySelector('.wf-card-graph') : null,
      recordHost: document.getElementById('wfx-pub-record'),
      requiresHost: document.getElementById('wfx-pub-requires'),
      destPath: destChange && destChange.parentElement
        ? destChange.parentElement.querySelector('.wfx-path')
        : null,
      what,
      whatName: what ? what.querySelector('.wfx-step-name') : null,
      whatMeta: what ? what.querySelector('.wfx-step-meta') : null,
      whatPc: what ? what.querySelector('.wfx-step-pc') : null,
      raw,
      rawPre: raw ? raw.querySelector('pre') : null,
      rawName: raw ? raw.querySelector('.wfx-step-name') : null,
      rawMeta: raw ? raw.querySelector('.wfx-step-meta') : null,
      rawPc: raw ? raw.querySelector('.wfx-step-pc') : null,
      doneNote: done ? done.querySelector('.wfx-note') : null,
      donePath: done ? done.querySelector('.wfx-path') : null,
      gitRow: copy ? copy.parentElement : null,
      gitPre: copy && copy.parentElement ? copy.parentElement.querySelector('pre') : null,
    };
    const missing = REQUIRED.filter((key) => !refs[key]);
    if (missing.length) {
      console.error('wfx-publish: the export sheet is missing', missing.join(', '));
      return null;
    }
    return refs;
  }

  // ─── module state ─────────────────────────────────────────────────────────
  // One sheet, one workflow at a time, so this is a small record rather than a
  // class. lastPublish is what makes the second export of a session immediate:
  // it is the only thing in the app that ties a workflow to the path its file
  // was written to, because a sidecar row exists for imported workflows only
  // and carries no destination.

  const lastPublish = new Map();
  let refs = null;
  let bound = false;
  let busy = false;
  let openFor = null;
  let restoreFocusTo = null;
  let current = null;

  function el(tag, attrs, ...children) { return window.WfxDom.el(tag, attrs, ...children); }

  // Every string that came out of a file reaches the DOM through the kit,
  // including the ones that land in an element index.html already declared.
  // textContent is safe on its own; routing through one function is what makes
  // that checkable by reading this file rather than by auditing each caller.
  function setText(node, value) {
    if (node) node.replaceChildren(window.WfxDom.text(String(value)));
  }

  // A name somebody else chose, sitting inside a sentence written in the app's
  // language. dir=auto lets the chip take the direction of its own first strong
  // character, and the isolate in the stylesheet keeps that decision from
  // leaking into the words on either side.
  function nameChip(value) {
    return el('code', { dir: 'auto' }, String(value));
  }

  function hasKit() {
    const kit = window.WfxDom;
    return !!(kit && typeof kit.el === 'function');
  }

  function say(message) {
    if (refs && refs.say) refs.say.textContent = message;
  }

  function setState(state) {
    if (refs && refs.card) refs.card.setAttribute('data-state', state);
  }

  function shout(message, kind) {
    if (typeof toast === 'function') toast(message, kind || '');
    else console.warn('wfx-publish:', message);
  }

  // ─── formatting ───────────────────────────────────────────────────────────

  function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

  function fmtBytes(n) {
    if (!Number.isFinite(n) || n < 0) return 'an unknown size';
    if (n < 1024) return plural(n, 'byte');
    return `${(n / 1024).toFixed(1)} KB`;
  }

  // The figure component splits a unit off the value so the unit can drop a
  // rank, which means a duration arrives here as two strings rather than one.
  function durationParts(ms) {
    const s = Math.round((Number(ms) || 0) / 1000);
    if (s < 60) return { value: String(s), unit: 's' };
    return { value: `${Math.floor(s / 60)}m ${s % 60}`, unit: 's' };
  }

  function splitPath(abs) {
    const p = String(abs || '');
    const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    if (cut < 0) return { dir: '', file: p };
    return { dir: p.slice(0, cut + 1), file: p.slice(cut + 1) };
  }

  // dir=ltr on both halves. A path is a left-to-right structure whatever
  // language its segments are written in, and a directory named in a
  // right-to-left script otherwise swaps places with the one beside it, which
  // makes the row describe a location that does not exist.
  function paintPath(host, abs) {
    const parts = splitPath(abs);
    host.replaceChildren(
      el('span', { class: 'wfx-path-dir', dir: 'ltr' }, parts.dir),
      el('span', { class: 'wfx-path-file', dir: 'ltr' }, parts.file),
    );
  }

  // ─── the shell command ────────────────────────────────────────────────────
  // Single quotes rather than double, always, and not as a style choice. Inside
  // double quotes a shell still expands $(...), `...` and $VAR, and both of the
  // strings that go into this line can be somebody else's: the workflow name on
  // a republish came from a file this machine installed, and the destination
  // path can be anywhere the save dialog was pointed. Single quotes expand
  // nothing at all, and the one character they cannot carry is escaped by
  // closing the quote, backslash-escaping the apostrophe and reopening.

  const SHELL_BARE_RE = /^[A-Za-z0-9._/@%+=:,-]+$/;

  function shellQuote(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`;
  }

  function shellArg(value) {
    const s = String(value);
    return SHELL_BARE_RE.test(s) ? s : shellQuote(s);
  }

  // A path under a repo's own .husk/workflows is written relative, because that
  // is the form a person runs from the repo root and the form that reads back
  // as a repo file rather than as a machine's directory layout. Anything else
  // keeps its absolute form, which still works from anywhere inside the tree.
  function repoRelative(abs) {
    const p = String(abs || '').replace(/\\/g, '/');
    const marker = '/.husk/workflows/';
    const at = p.indexOf(marker);
    if (at < 0) return null;
    return p.slice(at + 1);
  }

  function gitCommandFor(abs, name, revision) {
    const rel = repoRelative(abs);
    const title = String(name || 'workflow')
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 64) || 'workflow';
    const message = `workflow: ${title} (revision ${revision})`;
    // The double dash is not decoration. A file name beginning with a dash is
    // an option to git no matter how it is quoted, and the save dialog will
    // accept one, so the separator is what keeps the pasted line a file
    // operation rather than a parse error or, worse, a flag that means
    // something.
    return `git add -- ${shellArg(rel || abs)} &&\ngit commit -m ${shellQuote(message)}`;
  }

  // ─── the bytes ────────────────────────────────────────────────────────────
  // The same two-space form with a trailing newline that main.js writes, so the
  // text in the disclosure pane is the text on disk rather than a rendering of
  // it. byteLength is measured separately and compared against the byte count
  // the writer reported: if they disagree, something between the writer and
  // this pane changed the object, and the pane says so rather than presenting
  // itself as the file.

  function serializeArtifact(artifact) {
    return `${JSON.stringify(artifact, null, 2)}\n`;
  }

  function byteLength(text) {
    try { return new TextEncoder().encode(text).length; } catch (_) { return NaN; }
  }

  // Run history rows carry `entries`, up to twelve thousand characters of raw
  // agent stdout per step, and the whole point of the receipt format is that
  // none of it travels. The export path strips it, and this is the check that
  // the claim held for the file that was actually written, run against the
  // serialized bytes rather than against the object so that a field nested
  // anywhere at any depth is caught. The key can only appear at the start of a
  // line: a prompt containing the word survives JSON.stringify with its quotes
  // escaped and its newlines written as \n, so it can never open one.
  const ENTRIES_KEY_RE = /^\s*"entries"\s*:/m;

  // ─── el() components ──────────────────────────────────────────────────────

  const CLAIM_WORDS = {
    computed: 'computed here',
    consistent: 'matches the shipped log',
    said: 'author states',
  };

  // The chip is a sibling of the figure's value, never a class on it, so there
  // is no arrangement of this code that renders a number without rendering
  // where the number came from. The three words are the only three; "verified"
  // does not appear in this feature and there is no branch here that could
  // produce it.
  function claimChip(tier) {
    return el('span', { class: ['wfx-claim', `is-${tier}`] },
      el('i', { class: 'wfx-claim-m', aria: { hidden: true } }),
      CLAIM_WORDS[tier] || CLAIM_WORDS.said);
  }

  function figure(spec) {
    const isNull = spec.value === null || spec.value === undefined;
    return el('div', { class: ['wfx-fig', isNull && 'is-null'] },
      el('span', { class: 'wfx-fig-v' },
        isNull ? (spec.placeholder || 'none') : spec.value,
        !isNull && spec.unit ? el('span', { class: 'wfx-fig-u' }, spec.unit) : null),
      el('span', { class: 'wfx-fig-l' }, spec.label),
      spec.tier ? el('span', {}, claimChip(spec.tier)) : null);
  }

  function pfRow(name, note) {
    return el('div', { class: 'wfx-pf-row' },
      el('span', { class: 'wfx-pf-n' }, name),
      note ? el('span', { class: 'wfx-pf-note' }, note) : null);
  }

  function pfBlock(host, title, rows) {
    host.replaceChildren(el('div', { class: 'wfx-pf-h' }, title), ...rows.filter(Boolean));
  }

  // Three blocks in this sheet have no host in index.html and are inserted
  // beside one: the outlook that stands in for the figures, the warnings after
  // a write, and the figures themselves once receipts travel. They are marked
  // in the DOM rather than remembered in a variable, because the variable dies
  // with the record it lives on and the element does not: closing and
  // reopening the sheet would otherwise stack a second copy of each on top of
  // the first, and the reader would be looking at last time's warnings.
  const INJECTED = 'data-wfx-pub';

  function injected(node) {
    node.setAttribute(INJECTED, 'block');
    return node;
  }

  function clearInjected() {
    for (const node of refs.modal.querySelectorAll(`[${INJECTED}="block"]`)) node.remove();
  }

  function code(value) { return el('code', {}, value); }

  // A list of names read as a sentence rather than as a comma-joined array,
  // because these rows are prose and "claude, codex" in the middle of one reads
  // as a fragment of a config file that leaked into a paragraph.
  function nameList(values, render) {
    const out = [];
    values.forEach((value, i) => {
      if (i > 0) out.push(i === values.length - 1 ? ' and ' : ', ');
      out.push(render ? render(value) : value);
    });
    return out;
  }

  // ─── reading the workflow ─────────────────────────────────────────────────

  const AGENT_NAMES = ['claude', 'copilot', 'codex', 'aider', 'gemini'];

  // The same reduction the import validator and the artifact builder apply, for
  // display only. A step whose command is a path is not something this sheet
  // can fix, but the file will carry the basename and the reader deserves to
  // see the string the file will actually contain rather than the one on the
  // canvas.
  function basename(value) {
    return String(value == null ? '' : value)
      .trim()
      .split(/\s+/)[0]
      .split(/[\\/]/)
      .pop()
      .toLowerCase()
      .replace(/\.(exe|cmd|bat|ps1)$/i, '');
  }

  function readGraph(workflow) {
    const graph = (workflow && workflow.graph) || {};
    const nodes = Array.isArray(graph.nodes) ? graph.nodes.filter(Boolean) : [];
    const edges = Array.isArray(graph.edges) ? graph.edges.filter(Boolean) : [];
    const agents = [];
    const unbound = [];
    let pins = 0;
    for (const node of nodes) {
      if (!node.agentCommand) {
        // The id travels with the name. The gate marks these steps in the
        // thumbnail and the repair writes to exactly these nodes, and both
        // need to say which node rather than which label: two steps are
        // allowed to share a name.
        unbound.push({
          id: String(node.id == null ? '' : node.id),
          name: Array.from(String(node.name || 'Step')).slice(0, 64).join(''),
        });
        continue;
      }
      const base = basename(node.agentCommand);
      if (base && AGENT_NAMES.includes(base) && !agents.includes(base)) agents.push(base);
      if (node.model) pins += 1;
    }
    agents.sort();
    return { nodes, edges, agents, pins, unbound };
  }

  // ─── panes ────────────────────────────────────────────────────────────────

  // The graph goes in whole, names and all. A publisher is being shown what a
  // reader of this file will see, and what a reader needs to see is which steps
  // are in it. A projection with every name stripped out of it, synthetic ids
  // and coordinates only, draws four unlabelled lozenges, and those are
  // indistinguishable from a preview that failed to load; on the install sheet
  // the same drawing is the picture somebody decides on.
  //
  // Carrying the names costs nothing here, because there is no string sink to
  // defend: wfMiniGraph returns elements rather than markup, and every step
  // name in it reaches the DOM through the same WfxDom.text() the prompt list
  // uses.
  function paintGraph(host, graph) {
    if (typeof wfMiniGraph !== 'function') {
      host.replaceChildren(el('span', { class: 'wfx-empty-m' }, 'no preview available'));
      return;
    }
    try {
      // Null for the run, because this sheet has no business colouring the
      // drawing by an outcome. The width is the host's own, measured rather
      // than assumed: the host is already in the document, the sheet's column
      // is a good deal wider than the floor the builder falls back to, and
      // every pixel of that difference is a pixel a step name can use. The
      // measurement is why setState runs before this does; a host inside a
      // pane the card is not currently showing measures zero.
      //
      // The marks are the steps the gate is about, so the picture and the gate
      // name one set between them and a reader can find in one what they read
      // in the other.
      host.replaceChildren(wfMiniGraph(
        { nodes: graph.nodes, edges: graph.edges }, null, 'panel', host.clientWidth,
        new Set(graph.unbound.map((step) => step.id)),
      ));
    } catch (err) {
      // A preview that cannot be drawn costs this sheet a picture and nothing
      // else. Everything under it, which is the part that says what the file
      // will contain, is still true and still exportable, so the failure is
      // reported where a developer will see it and named where the reader will.
      console.error('wfx-publish: the thumbnail could not be drawn', err);
      host.replaceChildren(el('span', { class: 'wfx-empty-m' }, 'no preview available'));
    }
  }

  // The tiles as a reader of the file will see them, which is why every one of
  // them carries the "author states" chip: with no chain attached, nothing in
  // the receipt is anything but the publisher's account of their own runs. A
  // median over one or two runs is not called a median, because it is not one.
  function buildFigures(summary, evidenceAttached) {
    const runs = Number(summary.runs) || 0;
    const durationLabel = summary.precision === 'single'
      ? 'that run'
      : (summary.precision === 'pair' ? 'range' : 'median run');
    const duration = Number.isFinite(summary.medianDurationMs)
      ? durationParts(summary.medianDurationMs)
      : null;
    const completed = summary.outcomes ? Number(summary.outcomes.completed) || 0 : 0;
    return [
      figure({ value: String(runs), label: 'runs', tier: 'said' }),
      duration
        ? figure({ value: duration.value, unit: duration.unit, label: durationLabel, tier: 'said' })
        : figure({ value: null, placeholder: 'not timed', label: durationLabel }),
      figure({ value: String(completed), unit: `/${runs}`, label: 'zero exit', tier: 'said' }),
      evidenceAttached
        ? figure({ value: 'log', label: 'evidence', tier: 'said' })
        : figure({ value: null, placeholder: 'no log', label: 'evidence' }),
    ];
  }

  // Each row states one thing the bytes will do. The argument for why the
  // format works that way is not here: it is a thing to understand once, and
  // repeating it above the Export button on every export is what makes this
  // pane an essay.
  function paintRecord(host, graph, history) {
    const rows = [
      pfRow(
        `${plural(graph.nodes.length, 'step')}, ${plural(graph.edges.length, 'connection')}, every prompt in full`,
        'A reader sees the prompt text before anything runs.',
      ),
      pfRow(
        'Graph fingerprint',
        'Rechecked on the reader\'s machine before anything is shown.',
      ),
    ];
    if (history.unread) {
      rows.push(pfRow('Run history unreadable', 'Exporting still works.'));
    } else if (history.total === 0) {
      rows.push(pfRow('No run receipts', 'Receipts are earned by running this here.'));
    } else if (history.fingerprinted === 0) {
      rows.push(pfRow(
        `${plural(history.total, 'stored run')}, none of them attachable`,
        'These runs predate the fingerprint, or ran a different version of these steps.',
      ));
    } else {
      rows.push(pfRow(
        `${plural(history.fingerprinted, 'run')} name this graph, out of ${history.total} stored`,
        'Runs from before your last graph edit are excluded.',
      ));
    }
    rows.push(pfRow(
      'Outcome counts, not a pass rate',
      'Status is the process exit code, so a wrong answer that exits zero counts as finished.',
    ));
    rows.push(pfRow('Tokens, not cost', 'The reader prices them with their own table.'));
    pfBlock(host, 'Contents', rows);
  }

  function paintRequires(host, graph, requires) {
    const rows = [];
    if (graph.agents.length) {
      rows.push(pfRow(
        [
          ...nameList(graph.agents, code),
          graph.pins ? `, with ${plural(graph.pins, 'model pin')}` : '',
        ],
        'Bare basenames, resolved on the reader\'s PATH. Your paths stay here.',
      ));
    } else {
      rows.push(pfRow(
        'No step names an agent',
        'Set one on each step to export.',
      ));
    }

    const mcp = (requires && Array.isArray(requires.mcpServers)) ? requires.mcpServers : [];
    const skills = (requires && Array.isArray(requires.skills)) ? requires.skills : [];
    if (mcp.length || skills.length) {
      const parts = [];
      if (mcp.length) {
        parts.push(mcp.length === 1 ? 'An MCP server named ' : 'MCP servers named ');
        parts.push(...nameList(mcp.map((m) => String(m && m.name)), code));
      }
      if (mcp.length && skills.length) parts.push(', and ');
      if (skills.length) {
        parts.push(skills.length === 1 ? 'the skill ' : 'the skills ');
        parts.push(...nameList(skills.map((s) => String(s && s.id)), code));
      }
      rows.push(pfRow(parts, 'Names and fingerprints only. No commands, no environment.'));
    } else {
      rows.push(pfRow(
        'No MCP server or skill declared',
        'Husk cannot derive these from a prompt.',
      ));
    }

    const workspace = (requires && requires.workspace) || null;
    const markers = (workspace && Array.isArray(workspace.markerFiles)) ? workspace.markerFiles : [];
    const commands = (workspace && Array.isArray(workspace.commands)) ? workspace.commands : [];
    if ((workspace && workspace.vcs === 'git') || markers.length || commands.length) {
      const parts = [];
      parts.push(workspace && workspace.vcs === 'git' ? 'A git work tree' : 'A working directory');
      if (markers.length) { parts.push(' with '); parts.push(...nameList(markers.map(String), code)); }
      if (commands.length) { parts.push(', running '); parts.push(...nameList(commands.map(String), code)); }
      rows.push(pfRow(parts, 'Your declaration, checked before anything runs.'));
    } else {
      rows.push(pfRow(
        'No workspace requirement declared',
        'A marker file and a build command are what carry a prompt\'s assumptions across.',
      ));
    }
    pfBlock(host, 'Requires', rows);
  }

  function paintDestination() {
    if (current.target) {
      paintPath(refs.destPath, current.target);
      return;
    }
    refs.destPath.replaceChildren(
      el('span', { class: 'wfx-path-file' }, 'Husk will ask where to save'),
    );
  }

  // Which workflow this sheet is about. The title names the operation, so
  // without this the only thing on screen identifying the subject is a drawing.
  //
  // The name is the only part of this line the user wrote, and it goes in
  // isolated rather than concatenated. A name whose first strong character is
  // right-to-left otherwise sets the direction of the whole line, which moves
  // the step count to the front and the name to the end: the row then reads as
  // a different sentence than the one this builds. The element itself stays
  // left-to-right because the separators and the counts are the app's.
  function paintSubject() {
    const meta = [plural(current.graph.nodes.length, 'step')];
    const revision = current.prior && Number.isSafeInteger(current.prior.revision)
      ? current.prior.revision + 1
      : null;
    if (revision) meta.push(`revision ${revision}`);
    // Set here rather than read off the markup, because the direction is part
    // of what this function composes: the line is the app's, the name inside it
    // is not, and losing that distinction changes what the row says.
    refs.subject.setAttribute('dir', 'ltr');
    refs.subject.replaceChildren(
      el('span', { dir: 'auto' }, String(current.workflow.name || 'Untitled workflow')),
      ` · ${meta.join(' · ')}`,
    );
  }

  // The summary line of the folded block, which has to say enough that opening
  // it is a choice rather than a search.
  function paintWhat(graph, history) {
    setText(refs.whatName, 'What travels in this file');
    const meta = [plural(graph.nodes.length, 'step'), plural(graph.edges.length, 'connection')];
    if (graph.agents.length) meta.push(graph.agents.join(', '));
    setText(refs.whatMeta, `${meta.join(' · ')} ·`);
    if (history.unread) setText(refs.whatPc, 'run history unreadable');
    else if (history.fingerprinted > 0) setText(refs.whatPc, `${plural(history.fingerprinted, 'attachable run')}`);
    else setText(refs.whatPc, 'no receipts');
  }

  // ─── the ready pane ───────────────────────────────────────────────────────

  function renderReady() {
    // First, before any paint. paintGraph measures its host to decide how much
    // room a step name has, and a host inside a pane the card is not showing
    // measures zero: reopening the sheet after a write would otherwise draw the
    // thumbnail at the builder's fallback width and drop the labels.
    setState('ready');
    clearInjected();
    refs.body.scrollTop = 0;

    const graph = current.graph;
    paintSubject();
    paintGraph(refs.graphHost, graph);
    paintRecord(refs.recordHost, graph, current.history);
    paintRequires(refs.requiresHost, graph, current.requires);
    paintWhat(graph, current.history);
    paintDestination();

    // A graph with no steps has nothing to describe, and the folded block would
    // otherwise report zero of everything under a heading promising contents.
    // The gate says the one true thing about that workflow.
    refs.what.hidden = !graph.nodes.length;
    refs.what.open = false;

    // The toggle is a decision, and coming back from a refusal is not a reason
    // to unmake it. open() is what starts it at off; this restores whatever the
    // reader last chose in this sitting.
    refs.attach.checked = current.attachLog === true;
    refs.go.hidden = false;
    refs.doneBtn.hidden = true;
    refs.goNoLog.hidden = false;
    refs.back.hidden = true;
    refs.go.textContent = 'Export';
    applyBlockers();
  }

  // ─── the gate ─────────────────────────────────────────────────────────────

  // Two conditions this sheet can see for itself, both of which the builder
  // would refuse anyway. Predicting them is worth the duplication because the
  // press that would discover them is the press this sheet exists to make
  // work, and because one of the two is repairable right here.
  //
  // The roster names four steps and then counts the rest. A list that grows
  // with the graph turns the one block a reader has to act on into the tallest
  // thing on the surface, and past four names the count is the information.
  const ROSTER_SHOWN = 4;

  function rosterOf(unbound, total) {
    // Naming every step of a workflow where none of them is bound is a list
    // that says nothing the count above it did not already say.
    if (unbound.length === total) return [`Every step in this workflow`];
    const shown = unbound.slice(0, ROSTER_SHOWN).map((step) => nameChip(step.name));
    const rest = unbound.length - shown.length;
    // A truncated list is a comma series, because "A, B, C and D" closes the
    // sentence and ", and 2 more" then reopens it.
    if (rest > 0) {
      const parts = [];
      shown.forEach((chip, i) => { if (i) parts.push(', '); parts.push(chip); });
      parts.push(`, and ${rest} more`);
      return parts;
    }
    return nameList(shown);
  }

  function paintGate(blocker) {
    if (!blocker) {
      refs.gate.hidden = true;
      refs.gateWho.replaceChildren();
      return;
    }
    setText(refs.gateTitle, blocker.title);
    setText(refs.gateMessage, blocker.message);
    refs.gateFix.hidden = !blocker.repairable;
    if (blocker.repairable) {
      setText(refs.gateGo, `Set on ${plural(blocker.count, 'step')}`);
      // Withheld until the choices land. fillAgentChoices clears it.
      if (!agentChoicesPainted) refs.gateGo.setAttribute('aria-disabled', 'true');
      refs.gateWho.replaceChildren(...rosterOf(current.graph.unbound, current.graph.nodes.length));
    } else {
      refs.gateWho.replaceChildren();
    }
    refs.gate.hidden = false;
  }

  function readBlocker(graph) {
    if (!graph.nodes.length) {
      return {
        title: 'This workflow has no steps',
        message: 'Add at least one step in the builder, then export.',
        footer: 'No steps to export',
        repairable: false,
        count: 0,
      };
    }
    if (!graph.unbound.length) return null;
    const count = graph.unbound.length;
    return {
      title: count === 1 ? 'One step does not name an agent' : `${count} steps do not name an agent`,
      message: 'An exported step names its agent, so a reader runs the same program you did. Set one on each and Export unlocks.',
      // The footer states the consequence rather than restating the title. Two
      // copies of one sentence at the top and bottom of a single screen read as
      // a rendering fault, and the footer's job is to say what the button is
      // doing, which is standing down.
      footer: 'Export stays withheld until every step names an agent.',
      repairable: true,
      count,
    };
  }

  function applyBlockers() {
    const blocker = readBlocker(current.graph);
    current.blocked = !!blocker;
    paintGate(blocker);

    setText(refs.foot, blocker
      ? blocker.footer
      : 'Nothing leaves this machine. Exporting writes one file where you point it.');
    refs.foot.classList.toggle('is-error', !!blocker);

    if (blocker) {
      // aria-disabled rather than disabled, so the button keeps its place in
      // the tab order and the sentence naming what is blocking it can be
      // announced by the control it is about.
      refs.go.setAttribute('aria-disabled', 'true');
      refs.go.setAttribute('aria-describedby', 'wfx-pub-foot');
      if (blocker.repairable) fillAgentChoices();
      say(blocker.title);
    } else {
      refs.go.removeAttribute('aria-disabled');
      refs.go.removeAttribute('aria-describedby');
    }
  }

  // The choices in the repair control, which never include an empty one: a
  // control whose job is to name an agent must not offer the value that leaves
  // it unnamed. Only what this machine reports as installed is offered, because
  // the repair writes a claim about what a reader will run and a name nothing
  // here can execute is a claim nobody checked.
  //
  // detect() answers with a record carrying an agents array. The bare array is
  // the older shape and is read too, which is the same pair app.js accepts.
  //
  // option is outside the kit's tag allowlist on purpose, so these two are
  // built directly. Nothing here is parsed: a text node and a value attribute
  // are inert whatever they contain.
  let agentChoices = null;
  let agentChoicesPainted = false;

  // An empty answer is not cached. A probe that found nothing is as likely to
  // be a probe that ran before anything was installed as a machine with
  // nothing on it, and the cost of asking again is one IPC call per open.
  async function loadAgentChoices() {
    if (agentChoices && agentChoices.length) return agentChoices;
    let rows = [];
    try {
      const answer = await window.husk.agents.detect();
      rows = Array.isArray(answer)
        ? answer
        : ((answer && Array.isArray(answer.agents)) ? answer.agents : []);
    } catch (_) { rows = []; }
    agentChoices = rows
      .filter((a) => a && a.available && a.command)
      .map((a) => ({ command: String(a.command), label: String(a.label || a.command) }));
    return agentChoices;
  }

  // The button is withheld until the control under it has something to say. The
  // list arrives over IPC and the gate paints synchronously, so a press in that
  // window would read an empty select and write nothing, which is exactly the
  // silence this whole surface exists to remove.
  async function fillAgentChoices() {
    if (agentChoicesPainted) return;
    const choices = await loadAgentChoices();
    if (!refs || !refs.gateSel) return;
    agentChoicesPainted = choices.length > 0;
    const options = choices.map((choice) => {
      const option = document.createElement('option');
      option.setAttribute('value', choice.command);
      option.appendChild(window.WfxDom.text(choice.label));
      return option;
    });
    refs.gateSel.replaceChildren(...options);
    if (choices.length) {
      refs.gateGo.removeAttribute('aria-disabled');
    } else {
      // Nothing installed. The gate keeps its title, which is still true, and
      // the row under it says why the repair cannot run rather than offering a
      // name this machine has no way to execute.
      setText(refs.gateGo, 'No agent to set');
      setText(refs.gateFixLabel, 'Install an agent, then set it on each step.');
      refs.gateSel.hidden = true;
    }
  }

  // The repair. One update call carrying the id and the graph, which merges
  // rather than replaces on the main side, so the workflow's name, description
  // and trigger are untouched and exactly one field moves on exactly the steps
  // that had none.
  //
  // Nothing is written anywhere until this runs. A workflow already on disk
  // with unbound steps stays that way until somebody presses this button,
  // because rebinding one on load would change what it runs at a moment with
  // no surface to say so.
  async function repairUnbound(command) {
    if (busy || !current || !command) return;
    const unbound = new Set(current.graph.unbound.map((step) => step.id));
    if (!unbound.size) return;

    busy = true;
    refs.gateGo.setAttribute('aria-disabled', 'true');
    say('Setting the agent on those steps');

    const source = (current.workflow.graph && current.workflow.graph.nodes) || [];
    const graph = {
      nodes: source.map((node) => (node && unbound.has(String(node.id == null ? '' : node.id)) && !node.agentCommand
        ? Object.assign({}, node, { agentCommand: command })
        : node)),
      edges: (current.workflow.graph && current.workflow.graph.edges) || [],
    };

    let res = null;
    try { res = await window.husk.workflows.update({ id: current.workflow.id, graph }); }
    catch (_) { res = null; }

    busy = false;
    refs.gateGo.removeAttribute('aria-disabled');

    if (!res || !res.ok) {
      shout('That change could not be saved', 'error');
      say('Those steps were not changed');
      return;
    }

    // The rest of the page holds its own copy of this workflow, and the builder
    // opens from that copy. Telling it to re-read is what stops a later Save
    // from writing the pre-repair graph back over this one.
    if (typeof current.onChanged === 'function') {
      try { await current.onChanged(); } catch (_) { /* the page will re-read on its own next paint */ }
    }

    // Re-read rather than patch in place. The workflow that comes back has been
    // through the same sanitizer every ordinary save runs, so what this sheet
    // describes from here is what is on disk. The history is re-read for the
    // same reason: agentCommand is inside the hashed body, so the fingerprint
    // has moved and the count of runs that name it is stale by construction.
    const fresh = await loadWorkflow(current.workflow.id);
    if (!fresh) {
      // The write reported success and the record cannot be read back, so this
      // sheet has no basis for saying what is on disk. Repainting the old
      // blocker here would report the repair as having failed, which is a
      // different claim and not one anything here can support.
      shout('That workflow could not be read back', 'error');
      say('The change was saved, but this workflow could not be read back');
      return;
    }
    current.workflow = fresh;
    current.graph = readGraph(current.workflow);
    current.history = await loadHistory(current.workflow.id);
    renderReady();
    say(current.blocked ? refs.foot.textContent : 'Every step names an agent now');
  }

  // ─── the write ────────────────────────────────────────────────────────────

  // Carried forward rather than regenerated, so a republish is a new revision
  // of one artifact instead of a new artifact that happens to share a name.
  // The prior comes from the file at the destination when there is one, because
  // the bytes on disk are the authority on what revision exists, and from the
  // sidecar or this session's memory otherwise.
  function payloadFor(workflowId, target, prior, attachLog) {
    const payload = { workflowId, attachLog: attachLog === true };
    if (target) payload.targetPath = target;
    if (prior) {
      if (typeof prior.artifactId === 'string') payload.artifactId = prior.artifactId;
      if (Number.isSafeInteger(prior.revision) && prior.revision >= 1 && prior.revision < 100000) {
        payload.revision = prior.revision + 1;
      }
      if (prior.requires && typeof prior.requires === 'object') payload.requires = prior.requires;
      if (typeof prior.notes === 'string') payload.notes = prior.notes;
      if (prior.publisher && typeof prior.publisher === 'object') payload.publisher = prior.publisher;
    }
    return payload;
  }

  async function publish(attachLog) {
    if (busy || current.blocked) return;
    current.attachLog = attachLog === true;
    busy = true;
    setState('working');
    refs.go.setAttribute('aria-disabled', 'true');
    refs.go.textContent = 'Exporting';
    say('Writing the file');

    let res = null;
    try {
      res = await window.husk.workflows.export(
        payloadFor(current.workflow.id, current.target, current.prior, attachLog),
      );
    } catch (_) { res = null; }

    busy = false;
    refs.go.textContent = 'Export';
    refs.go.removeAttribute('aria-disabled');

    if (!res || typeof res !== 'object') {
      renderRefused({
        stage: 'export',
        code: 'no-answer',
        message: 'Husk did not answer the request to write this file',
        detail: null,
      }, attachLog);
      return;
    }
    if (res.ok) { renderDone(res, attachLog); return; }
    if (res.cancelled) {
      setState('ready');
      applyBlockers();
      say('Nothing was written');
      return;
    }
    renderRefused(res, attachLog);
  }

  // ─── the done pane ────────────────────────────────────────────────────────

  function receiptPhrase(artifact) {
    const receipts = (artifact && Array.isArray(artifact.receipts)) ? artifact.receipts : [];
    if (!receipts.length) return 'no receipts';
    const runs = receipts.reduce((sum, r) => sum + (Number(r && r.runs) || 0), 0);
    return `${plural(receipts.length, 'receipt')} covering ${plural(runs, 'run')}`;
  }

  function evidenceAttached(artifact) {
    const receipts = (artifact && Array.isArray(artifact.receipts)) ? artifact.receipts : [];
    return receipts.some((r) => r && r.evidence === 'inline');
  }

  // Warnings are the difference between what the author asked for and what the
  // file says, and there is exactly one moment where that difference is
  // actionable: after the write and before the commit. A regex condition that
  // crossed as a substring match, a connection that was left out, a run log
  // that could not be attached. None of them stops the file being useful and
  // all of them change what it claims, so they are rendered as rows rather than
  // rolled into a toast that disappears.
  // The row's name slot is a heading in the sheet's own voice. A warning code
  // is a key the main process routes on, and printing it here puts a machine
  // identifier in the one line of the row a person reads first. The message
  // beside it is already prose and carries the specifics.
  const WARNING_TITLES = {
    'no-receipts': 'No run was attachable',
    'edges-dropped': 'A connection was left out',
    'regex-downgraded': 'A routing pattern was widened',
    'evidence-skipped': 'A run log was left out',
    'evidence-unavailable': 'A run log could not be read',
  };

  // Capped, because one row per unreadable run log is a list bounded by the run
  // history and every one of them renders above the git command this pane
  // exists to hand over.
  const WARNINGS_SHOWN = 4;

  function buildWarnings(res, text) {
    const rows = [];
    const warnings = (Array.isArray(res.warnings) ? res.warnings : []).filter(Boolean);
    for (const warning of warnings.slice(0, WARNINGS_SHOWN)) {
      const code = String(warning.code || 'note');
      rows.push(pfRow(WARNING_TITLES[code] || 'A note about this file', String(warning.message || '')));
    }
    if (warnings.length > WARNINGS_SHOWN) {
      rows.push(pfRow(
        `${warnings.length - WARNINGS_SHOWN} further notes`,
        'Read the file itself for the rest.',
      ));
    }
    const measured = byteLength(text);
    if (Number.isFinite(measured) && Number.isFinite(res.bytes) && measured !== res.bytes) {
      rows.push(pfRow(
        'The pane below is a re-serialization',
        `The writer reported ${res.bytes} bytes; this pane serializes to ${measured}. Read the file on disk.`,
      ));
    }
    if (!rows.length) return null;
    return injected(el('div', { class: ['wfx-pf', 'is-plain'] },
      el('div', { class: 'wfx-pf-h' }, 'Warnings'),
      ...rows));
  }

  function renderDone(res, attachLog) {
    const artifact = res.artifact || {};
    const text = serializeArtifact(artifact);
    const attached = evidenceAttached(artifact);

    lastPublish.set(current.workflow.id, { path: res.path, artifact });
    current.target = res.path;
    current.prior = artifact;

    // The one check that cannot be delegated. The whole receipt format exists
    // so that raw agent output does not travel, and this is the assertion that
    // it did not for the file that was actually written. It runs after the
    // write because that is when the bytes exist; a file that fails it is on
    // disk and untracked, which is exactly the state a person can still fix.
    if (ENTRIES_KEY_RE.test(text)) {
      renderRefused({
        stage: 'export',
        code: 'run-output-in-file',
        message: 'The file contains raw agent output and must not be committed. Delete it.',
        detail: res.path,
      }, attachLog);
      return;
    }

    const noteTitle = refs.doneNote.querySelector('.wfx-note-t');
    const noteBody = refs.doneNote.querySelector('.wfx-note-m');
    setText(noteTitle, 'Written.');
    setText(noteBody, `${fmtBytes(res.bytes)}, ${receiptPhrase(artifact)}, ${attached ? 'run log attached' : 'no run log'}. Untracked until you commit it.`);

    // The tiles appear only when receipts actually travelled, and they read
    // from the summary of the runs that went into them rather than from the
    // local history, so what the publisher sees here is what a reader will see
    // on the other side of the file.
    clearInjected();
    const receiptsTravelled = Array.isArray(artifact.receipts) && artifact.receipts.length > 0;
    if (receiptsTravelled && res.receiptSummary) {
      const figs = injected(el('div', { class: 'wfx-figs' }, ...buildFigures(res.receiptSummary, attached)));
      refs.done.insertBefore(figs, refs.donePath);
    }

    const warnings = buildWarnings(res, text);
    if (warnings) refs.done.insertBefore(warnings, refs.donePath);

    paintPath(refs.donePath, res.path);

    // The disclosure is declared in this pane, directly above the line that
    // would make these bytes public, and it opens folded every time: a reader
    // who wants the file asks for it, and a pane that unfolds four kilobytes of
    // JSON on arrival buries the one command it exists to hand over.
    setText(refs.rawName, 'The exact bytes that were written');
    setText(refs.rawMeta, `${fmtBytes(res.bytes)} · ${receiptPhrase(artifact)} ·`);
    setText(refs.rawPc, attached ? 'run log attached' : 'no log attached');
    setText(refs.rawPre, text);
    refs.raw.open = false;

    const command = gitCommandFor(res.path, artifact.name || current.workflow.name, artifact.revision || 1);
    setText(refs.gitPre, command);
    current.command = command;
    setText(refs.copy, 'Copy');

    refs.go.hidden = true;
    refs.goNoLog.hidden = true;
    refs.back.hidden = true;
    refs.doneBtn.hidden = false;
    refs.foot.classList.remove('is-error');
    setText(refs.foot, repoRelative(res.path)
      ? 'Not shared until you run this.'
      : 'Not shared. The file is on your disk.');
    setState('done');
    // Focus lands on the one control this pane still offers, because the button
    // that was focused a moment ago is hidden by the state it just entered and
    // a hidden focus owner drops the caret to the document.
    try { refs.doneBtn.focus({ preventScroll: true }); } catch (_) { /* the pane went away */ }
    say(`Written to ${res.path}`);
  }

  // ─── the refused pane ─────────────────────────────────────────────────────

  const REFUSAL_TITLES = {
    'evidence-too-large': 'The run log is larger than a workflow file may carry',
    'bad-agent': 'A step does not say which agent it runs',
    'name-collision': 'Two step names an AI router cannot tell apart',
    'regex-condition': 'This workflow routes on a regular expression',
    'too-many-nodes': 'This workflow is larger than an exported file may carry',
    'bad-model': 'A model pin cannot be exported as written',
    'bad-input': 'This workflow could not be exported as written',
    'write-failed': 'That file could not be written',
    'not-found': 'That workflow is not in your list any more',
    'run-output-in-file': 'The file that was written carries raw agent output',
    'no-answer': 'Husk did not answer',
    // The rest of what the export path can return. A code with no entry here
    // falls through to a heading that names no fact, which is the least useful
    // thing this pane can say at the moment it has the reader's attention.
    'evidence-unavailable': 'The run log could not be read',
    'chain-invalid': 'The run log does not verify against itself',
    'receipt-invalid': 'A receipt did not survive its own check',
    'not-artifact': 'Husk wrote a file it would refuse to read',
    'bad-id': 'Husk built an identifier it cannot read back',
    'edges-dropped': 'Husk dropped a connection while building the file',
    'hash-mismatch': 'The fingerprint does not match the file Husk just built',
    'schema-too-new': 'Husk built a file this version cannot read',
    'cancelled': 'Nothing was written',
  };

  // Two refusals are about the run log, and for those the forward move is to
  // export without it: the footer declares that primary and the stylesheet
  // swaps it in on the refused state. Every other refusal here is about the
  // workflow itself, where there is no safe forward move and a button offering
  // one would be a lock to pick.
  //
  // Back is the move that always exists. The destination the reader chose and
  // the toggle they set live in the ready pane, which this state hides, so
  // without it the only exit from a refusal is Cancel and Cancel throws both
  // decisions away.
  const LOG_REFUSALS = new Set([
    'evidence-too-large', 'chain-invalid', 'evidence-unavailable', 'receipt-invalid',
  ]);

  function renderRefused(res, attachLog) {
    const code = String(res.code || 'bad-input');
    setText(refs.refTitle, REFUSAL_TITLES[code] || 'This workflow could not be exported');
    setText(refs.refMessage, String(res.message || 'Husk refused to write this file.'));

    const rows = [
      el('dt', {}, 'code'), el('dd', {}, code),
      el('dt', {}, 'stage'), el('dd', {}, String(res.stage || 'export')),
    ];
    if (res.detail) { rows.push(el('dt', {}, 'detail'), el('dd', {}, String(res.detail))); }
    if (Array.isArray(res.steps) && res.steps.length) {
      // Chips through nameList rather than a joined string, for the reason the
      // roster uses them: a run of right-to-left names joined by commas reads
      // back to front, and the list is the part a reader acts on.
      rows.push(el('dt', {}, 'steps'),
        el('dd', {}, ...nameList(res.steps.map((s) => nameChip(String((s && s.name) || ''))))));
    } else if (res.step && res.step.name) {
      rows.push(el('dt', {}, 'step'), el('dd', {}, nameChip(String(res.step.name))));
    }
    refs.refDetail.replaceChildren(...rows);

    const logIsTheProblem = attachLog === true && LOG_REFUSALS.has(code);
    refs.goNoLog.hidden = !logIsTheProblem;
    refs.back.hidden = false;
    refs.foot.classList.remove('is-error');
    if (logIsTheProblem) {
      setText(refs.foot, 'Nothing was written. Without the log, receipts ship as your own account.');
    } else if (code === 'run-output-in-file') {
      // The one refusal that arrives after the write, so it is the one that
      // must not say nothing happened. The file exists, it is untracked, and
      // deleting it is the whole fix.
      setText(refs.foot, 'File written and untracked. Delete it, do not commit.');
    } else {
      setText(refs.foot, 'Nothing was written.');
    }
    setState('refused');
    // Before the caret can be orphaned: the state change hides whichever footer
    // primary had focus, and a hidden focus owner sends Tab back to the page
    // behind the sheet.
    const landing = logIsTheProblem ? refs.goNoLog : refs.back;
    try { landing.focus({ preventScroll: true }); } catch (_) { /* the footer went away */ }
    say(refs.refTitle.textContent);
  }

  // ─── opening ──────────────────────────────────────────────────────────────

  async function loadWorkflow(workflowOrId) {
    if (workflowOrId && typeof workflowOrId === 'object') return workflowOrId;
    const id = String(workflowOrId || '');
    if (!id) return null;
    try {
      const list = await window.husk.workflows.list();
      return (Array.isArray(list) ? list : []).find((w) => w && w.id === id) || null;
    } catch (_) { return null; }
  }

  async function loadSidecar(workflowId) {
    try {
      const res = await window.husk.workflows.sidecars();
      const rows = (res && res.ok && res.sidecars) ? res.sidecars : {};
      return rows[workflowId] || null;
    } catch (_) { return null; }
  }

  async function loadHistory(workflowId) {
    try {
      const res = await window.husk.workflows.runs();
      const rows = (res && res.ok && Array.isArray(res.runs)) ? res.runs : null;
      if (!rows) return { total: 0, fingerprinted: 0, unread: true };
      let total = 0;
      let fingerprinted = 0;
      for (const row of rows) {
        if (!row || row.workflowId !== workflowId) continue;
        total += 1;
        // The field slice 7 adds. Counted rather than assumed absent, so this
        // surface starts telling the truth about attachable runs on the day the
        // runner starts recording it, with no edit here.
        if (typeof row.graphHash === 'string' && row.graphHash) fingerprinted += 1;
      }
      return { total, fingerprinted, unread: false };
    } catch (_) {
      return { total: 0, fingerprinted: 0, unread: true };
    }
  }

  // The destination's own bytes are the authority on what revision exists
  // there, so a republish reads the file it is about to replace. The read is
  // only trusted as this workflow's prior when the artifact id matches the one
  // we wrote, because a person can point two workflows at one path and
  // inheriting a stranger's identity is how a file quietly becomes a revision
  // of something it is not.
  async function loadPrior(workflow, sidecar, target, remembered) {
    if (target && remembered && remembered.artifact) {
      try {
        const res = await window.husk.workflows.artifactRead({ source: 'file', path: target });
        if (res && res.ok && res.artifact && res.artifact.artifactId === remembered.artifact.artifactId) {
          return res.artifact;
        }
      } catch (_) { /* a destination that cannot be read is simply not a prior */ }
    }
    if (remembered && remembered.artifact) return remembered.artifact;
    if (sidecar && sidecar.artifact) return sidecar.artifact;
    return null;
  }

  // The second export of a session writes immediately and confirms with an
  // Undo, because by then every question this sheet asks has been answered once
  // and asking again turns a byproduct back into a form. The Undo is what makes
  // an unconfirmed write to a tracked file safe: it rewrites the destination at
  // the revision that was there before.
  async function republish(workflow, remembered, prior) {
    let res = null;
    try {
      res = await window.husk.workflows.export(
        payloadFor(workflow.id, remembered.path, prior, false),
      );
    } catch (_) { res = null; }
    if (!res || !res.ok) {
      // A silent republish that refuses reopens the sheet, where the refusal
      // has a pane with room to explain itself and a control that acts on it.
      return open(workflow, { sheet: true, refusal: res || null });
    }
    lastPublish.set(workflow.id, { path: res.path, artifact: res.artifact || {} });
    const revision = (res.artifact && res.artifact.revision) || 1;
    const message = `Exported revision ${revision}, ${receiptPhrase(res.artifact)} attached`;
    // Undo is offered only when there is a revision to go back to. Rewriting
    // the destination without one would not restore anything: it would write a
    // second new revision over the first, which is the opposite of the promise
    // the word makes. The restored file is the previous revision rebuilt, not
    // the previous bytes replayed, so its publishedAt is the moment of the
    // restore; there is no channel here that writes bytes it did not build.
    const restorable = !!(prior && Number.isSafeInteger(prior.revision) && prior.revision >= 1);
    const undo = () => {
      window.husk.workflows.export({
        workflowId: workflow.id,
        targetPath: res.path,
        artifactId: prior.artifactId,
        revision: prior.revision,
        requires: prior.requires,
        notes: typeof prior.notes === 'string' ? prior.notes : null,
        publisher: prior.publisher || null,
        attachLog: false,
      }).then((back) => {
        if (back && back.ok) {
          lastPublish.set(workflow.id, { path: back.path, artifact: back.artifact || {} });
          shout(`Restored revision ${prior.revision}`, 'success');
        } else {
          shout('That file could not be restored', 'error');
        }
      }).catch(() => shout('That file could not be restored', 'error'));
    };
    if (restorable && typeof toastAction === 'function') toastAction(message, 'Undo', undo, 'success');
    else shout(message, 'success');
    return undefined;
  }

  function bindOnce() {
    if (bound) return;
    bound = true;

    refs.close.addEventListener('click', close);
    refs.cancel.addEventListener('click', close);
    refs.doneBtn.addEventListener('click', close);
    refs.go.addEventListener('click', () => {
      if (!current) return;
      if (refs.go.getAttribute('aria-disabled') === 'true') {
        // A press that cannot write still has to answer. Re-announcing the
        // reason and putting the reader in front of the control that clears it
        // is the difference between a button that is withheld and a button
        // that is broken, which is the whole of the complaint this state
        // exists to answer.
        say(refs.foot.textContent);
        if (!refs.gate.hidden) {
          try { refs.gate.scrollIntoView({ block: 'nearest' }); } catch (_) { /* no layout here */ }
          if (!refs.gateFix.hidden) {
            try { refs.gateSel.focus({ preventScroll: true }); } catch (_) { /* the gate went away */ }
          }
        }
        return;
      }
      publish(refs.attach.checked === true);
    });
    // The toggle goes back to off with the decision it describes. Leaving it
    // ticked after publishing without the log would show a ready pane claiming
    // the next write carries a log the reader just declined.
    refs.goNoLog.addEventListener('click', () => {
      if (!current) return;
      refs.attach.checked = false;
      publish(false);
    });

    refs.back.addEventListener('click', () => {
      if (busy || !current) return;
      renderReady();
      try { refs.card.focus({ preventScroll: true }); } catch (_) { refs.card.focus(); }
      say(current.blocked ? refs.foot.textContent : 'Export this workflow');
    });

    refs.gateGo.addEventListener('click', () => {
      if (!current || refs.gateGo.getAttribute('aria-disabled') === 'true') return;
      repairUnbound(refs.gateSel.value);
    });

    // Change points the write at a file that already exists, which is the
    // overwrite path. Leaving it alone is the ordinary case: the save dialog
    // asks on Export and offers the workflow's own repo, and that default
    // lives in the main process where the work tree is visible.
    refs.destChange.addEventListener('click', async () => {
      if (busy || !current) return;
      let picked = null;
      try { picked = await window.husk.workflows.pickArtifactFile(); }
      catch (_) { picked = null; }
      if (!picked) return;
      current.target = picked;
      current.prior = await loadPrior(current.workflow, current.sidecar, picked, lastPublish.get(current.workflow.id));
      paintDestination();
      say(`Exporting to ${picked}`);
    });

    refs.copy.addEventListener('click', async () => {
      if (!current || !current.command) return;
      try {
        await navigator.clipboard.writeText(current.command);
        setText(refs.copy, 'Copied');
        setTimeout(() => { setText(refs.copy, 'Copy'); }, 1600);
      } catch (_) { shout('That command could not be copied', 'error'); }
    });

    trapFocus();
    registerCloser();
  }

  // Tab stays inside the card. Without this the sheet is a dialog only to a
  // reader who can see it: aria-modal keeps it out of the accessibility tree
  // below, and nothing keeps the caret out of the page behind it.
  //
  // Candidates are filtered by offsetParent, which is null for anything inside
  // a pane the current state hides and for the footer primaries the stylesheet
  // swaps out. That is one test instead of a second list to keep in step with
  // the CSS.
  const FOCUSABLE = 'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

  function trapFocus() {
    refs.card.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      const stops = Array.from(refs.card.querySelectorAll(FOCUSABLE))
        .filter((node) => !node.disabled && node.offsetParent !== null);
      if (!stops.length) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      const on = document.activeElement;
      if (event.shiftKey && (on === first || on === refs.card)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && on === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  // Escape has to reach this sheet through the same table every other dialog
  // uses, or it hides the card while a write is in flight and leaves the state
  // machine pointing at a screen nobody can see. MODAL_CLOSERS is a top-level
  // const in app.js, so it is reachable by name and only by name, and reading a
  // binding that may not have been evaluated yet is what the try is for.
  function registerCloser() {
    try {
      if (typeof MODAL_CLOSERS === 'object' && MODAL_CLOSERS && !MODAL_CLOSERS['wfx-publish-modal']) {
        MODAL_CLOSERS['wfx-publish-modal'] = close;
      }
    } catch (_) { /* app.js has not evaluated that binding yet */ }
  }

  async function open(workflowOrId, opts) {
    const options = opts || {};
    if (!hasKit()) {
      shout('The export sheet could not load its renderer', 'error');
      console.error('wfx-publish: window.WfxDom is missing, so nothing can be built safely');
      return;
    }
    refs = resolve();
    if (!refs) { shout('The export sheet is missing from this page', 'error'); return; }
    bindOnce();

    const workflow = await loadWorkflow(workflowOrId);
    if (!workflow || !workflow.id) { shout('That workflow is not in your list any more', 'error'); return; }

    const remembered = lastPublish.get(workflow.id) || null;
    const sidecar = await loadSidecar(workflow.id);
    const target = (typeof options.targetPath === 'string' && options.targetPath)
      || (remembered && remembered.path)
      || null;
    const prior = await loadPrior(workflow, sidecar, target, remembered);

    // A workflow exported earlier in this session goes straight to the write.
    if (remembered && !options.sheet) return republish(workflow, remembered, prior);

    current = {
      workflow,
      sidecar,
      target,
      prior,
      graph: readGraph(workflow),
      history: await loadHistory(workflow.id),
      requires: (prior && prior.requires) || null,
      command: null,
      blocked: false,
      // Off at the start of every sitting, and remembered across a refusal from
      // there. The default is the argument this sheet makes about the run log.
      attachLog: false,
      // How a workflow this sheet edits reaches the rest of the page.
      onChanged: typeof options.onChanged === 'function' ? options.onChanged : null,
    };

    // The caller's own trigger, when it passed one. The menu item that opens
    // this sheet closes its menu first, so by the time this runs the button
    // that was pressed is out of the document and document.activeElement is the
    // body. Guarded on isOpen so a re-entrant open cannot record this card as
    // the place focus came from.
    if (!isOpen()) {
      restoreFocusTo = (options.returnFocusTo && typeof options.returnFocusTo.focus === 'function')
        ? options.returnFocusTo
        : document.activeElement;
    }
    openFor = workflow.id;
    refs.modal.hidden = false;

    try {
      renderReady();
      if (options.refusal) renderRefused(options.refusal, false);
    } catch (err) {
      // wfx-dom throws on a structural mistake, which is ours and not the
      // file's. Landing in the refusal pane keeps the sheet in a state it can
      // describe instead of leaving half a screen on top of a live app.
      console.error('wfx-publish: the sheet could not be built', err);
      renderRefused({
        stage: 'export',
        code: 'bad-input',
        message: 'This sheet could not be drawn for that workflow.',
        detail: err && err.code ? String(err.code) : null,
      }, false);
    }

    // Focus lands on the card rather than on a control, so a keyboard reader
    // starts at the top of what the sheet says and tabs forward into the two
    // decisions, instead of starting on a button whose label is the last thing
    // they should read. A refusal moves it again; that is renderRefused's call.
    refs.card.setAttribute('tabindex', '-1');
    if (!options.refusal) {
      try { refs.card.focus({ preventScroll: true }); } catch (_) { refs.card.focus(); }
    }
    // The live region already carries whatever the render decided, and a title
    // announced over it would replace the one sentence that says why the sheet
    // cannot export with a sentence naming the sheet.
    if (!options.refusal && !current.blocked) say('Export this workflow');
    return undefined;
  }

  function close() {
    // A write is one file and is not abortable, so the sheet stays put until it
    // reaches done or a refusal on its own. Closing over a request in flight
    // would leave a person with no screen that says what happened to it.
    if (busy) return;
    if (!refs) return;
    refs.modal.hidden = true;
    openFor = null;
    const back = restoreFocusTo;
    restoreFocusTo = null;
    if (back && typeof back.focus === 'function' && document.contains(back)) {
      try { back.focus({ preventScroll: true }); } catch (_) { /* the element went away */ }
    }
  }

  function isOpen() {
    return !!(refs && !refs.modal.hidden && openFor);
  }

  // One object rather than four globals, because app.js is a 15000 line classic
  // script sharing one namespace and a name like `open` in it is a collision
  // waiting for a reviewer to miss it.
  window.WfxPublish = { open, close, isOpen };
}());
