'use strict';

// The publish sheet: turning a workflow you have been running into one file
// somebody else can read.
//
// The premise of this surface is that publishing is a byproduct of finishing
// rather than a form to fill in. Everything the file needs is already on this
// machine: the graph is what you drew, the agents and model pins are what the
// steps say, the run history is what happened. So the sheet asks for exactly
// two decisions, a destination and whether the run log travels, and spends the
// rest of its space telling you what the bytes will say about you. Nothing
// here has a required field, and a reader who presses Publish without reading
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
// The byte disclosure is post-write and pre-commit, which is a deliberate
// departure from the body order in the spec, and the reason is a seam in the
// IPC contract rather than a preference. workflows:export has no dry run: it
// builds the artifact and writes it in one call, and the artifact it returns
// is the only object in this process that is the file. Rendering a preview
// before the write would mean reconstructing canonicalProjection, the graph
// hash and the requires block in the renderer, which is a second
// implementation of the canonicalizer that can disagree with the one that
// wrote the file, and a byte pane that disagrees with the bytes is worse than
// no byte pane at all. So Publish writes an untracked file onto your own disk,
// the done pane shows the exact bytes it wrote, and the git line that would
// make those bytes public sits directly under them. Nothing has been shared at
// the moment the disclosure is read, which is the property the disclosure
// exists to protect.
//
// Every string that came out of a file reaches the DOM through el() from
// wfx-dom.js. That matters here even though most of what this sheet renders is
// the user's own workflow, because republishing an imported workflow is a
// first-class path: the name, the description, the step names and the declared
// requirements in that case were written by whoever published the file this
// machine installed. The one exception is the graph thumbnail, and the
// exception is bounded by construction; see paintGraph.
//
// The git line is shell text a person pastes into a shell, so the workflow
// name inside it is quoted rather than interpolated. Same argument as above:
// on a republish that name is a stranger's string, and a commit message
// carrying $(...) inside double quotes is a command substitution that runs
// when the paste lands.

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
    'modal', 'card', 'ready', 'done', 'say', 'foot', 'go', 'goNoLog', 'doneBtn',
    'cancel', 'close', 'attach', 'destChange', 'copy',
    'refTitle', 'refMessage', 'refDetail',
    'graphHost', 'figsHost', 'recordHost', 'requiresHost', 'destPath',
    'raw', 'rawPre', 'rawName', 'rawMeta', 'rawPc',
    'doneNote', 'donePath', 'gitRow', 'gitPre',
  ];

  function resolve() {
    const modal = document.getElementById('wfx-publish-modal');
    if (!modal) return null;
    const ready = document.getElementById('wfx-pub-ready');
    const done = modal.querySelector('.wfx-pane-done');
    const pfs = ready ? ready.querySelectorAll('.wfx-pf') : [];
    const destChange = document.getElementById('wfx-pub-dest-change');
    const copy = document.getElementById('wfx-pub-copy');
    // Scoped to the modal rather than to the ready pane, because a write moves
    // the byte disclosure into the done pane and it stays there until the next
    // render puts it back. Looking for it where index.html declares it would
    // make every open after the first one report a missing sheet.
    const raw = modal.querySelector('details.wfx-step');
    const refs = {
      modal,
      card: modal.querySelector('.modal-card.wfx-sheet'),
      ready,
      done,
      say: document.getElementById('wfx-pub-say'),
      foot: document.getElementById('wfx-pub-foot'),
      go: document.getElementById('wfx-pub-go'),
      goNoLog: document.getElementById('wfx-pub-go-nolog'),
      doneBtn: document.getElementById('wfx-pub-done'),
      cancel: document.getElementById('wfx-pub-cancel'),
      close: document.getElementById('wfx-pub-x'),
      attach: document.getElementById('wfx-pub-attach'),
      destChange,
      copy,
      refTitle: document.getElementById('wfx-pub-ref-t'),
      refMessage: document.getElementById('wfx-pub-ref-m'),
      refDetail: document.getElementById('wfx-pub-ref-e'),
      graphHost: ready ? ready.querySelector('.wf-card-graph') : null,
      figsHost: ready ? ready.querySelector('.wfx-figs') : null,
      recordHost: pfs[0] || null,
      requiresHost: pfs[1] || null,
      destPath: destChange && destChange.parentElement
        ? destChange.parentElement.querySelector('.wfx-path')
        : null,
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
      console.error('wfx-publish: the publish sheet is missing', missing.join(', '));
      return null;
    }
    return refs;
  }

  // ─── module state ─────────────────────────────────────────────────────────
  // One sheet, one workflow at a time, so this is a small record rather than a
  // class. lastPublish is what makes the second publish of a session immediate:
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

  function paintPath(host, abs) {
    const parts = splitPath(abs);
    host.replaceChildren(
      el('span', { class: 'wfx-path-dir' }, parts.dir),
      el('span', { class: 'wfx-path-file' }, parts.file),
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
      if (!node.agentCommand) { unbound.push(String(node.name || 'Step').slice(0, 64)); continue; }
      const base = basename(node.agentCommand);
      if (base && AGENT_NAMES.includes(base) && !agents.includes(base)) agents.push(base);
      if (node.model) pins += 1;
    }
    agents.sort();
    return { nodes, edges, agents, pins, unbound };
  }

  // ─── panes ────────────────────────────────────────────────────────────────

  // The thumbnail is the one place in this file where a string reaches the DOM
  // through innerHTML, and it is safe for a structural reason rather than
  // because the data is trusted. wfMiniGraph is handed a projection built right
  // here that contains nothing but synthetic ids and numbers: no step name, no
  // prompt, no model, no agent. Its output is therefore a fixed set of SVG
  // elements whose only variable parts are coordinates, and there is no slot in
  // it for a manifest string to occupy. The alternative, building the SVG here,
  // would mean a second copy of the layout arithmetic drifting against the one
  // the workflow cards use.
  function paintGraph(host, graph) {
    if (typeof wfMiniGraph !== 'function') {
      host.replaceChildren(el('span', { class: 'wfx-empty-m' }, 'no preview available'));
      return;
    }
    const ids = new Map();
    const nodes = graph.nodes.map((node, i) => {
      const id = `s${i}`;
      ids.set(node.id, id);
      return { id, x: Number(node.x) || 0, y: Number(node.y) || 0 };
    });
    const edges = [];
    for (const edge of graph.edges) {
      const from = ids.get(edge.from);
      const to = ids.get(edge.to);
      if (from && to) edges.push({ from, to });
    }
    const markup = String(wfMiniGraph({ nodes, edges }, null));
    // The tripwire that turns the paragraph above from an argument about
    // another file into a check made in this one. The projection cannot carry a
    // string today, so this can only fire if wfMiniGraph grows a slot that
    // takes one, and the day it does the thumbnail should disappear rather than
    // become the feature's only unreviewed markup sink.
    if (/<\s*(script|foreignobject|use|image|iframe)\b|\son[a-z]+\s*=|javascript:|href|src\s*=/i.test(markup)) {
      console.error('wfx-publish: the thumbnail builder produced markup with a sink in it');
      host.replaceChildren(el('span', { class: 'wfx-empty-m' }, 'no preview available'));
      return;
    }
    // eslint-disable-next-line no-unsanitized/property -- numeric projection, checked above
    host.innerHTML = markup;
  }

  // What a reader of the file will see where the numbers go. Today that is
  // reliably nothing: a receipt has to name the graph it was earned on, and a
  // finished run in this build records no fingerprint, so no stored run can be
  // attached to any file. Rather than four dimmed tiles saying "none" four
  // times, the figures give way to the empty component, which names what is
  // true and what would change it. The tiles come back the moment a receipt
  // exists, which is why buildFigures below is written for both cases.
  function paintOutlook(host, history) {
    host.replaceChildren();
    host.hidden = true;
    let title;
    let message;
    if (history.unread) {
      title = 'Run history could not be read';
      message = 'The file will carry the graph and its requirements. Whether any run can be attached is decided when the file is built, and the next screen says what travelled.';
    } else if (history.total === 0) {
      title = 'No run history to attach';
      message = 'This workflow has not finished a run on this machine, so the file travels as a graph and a set of requirements. Run it and the next publish can carry what happened.';
    } else if (history.fingerprinted === 0) {
      title = `No receipts travel with this file, out of ${plural(history.total, 'stored run')}`;
      message = 'A receipt names the graph it was earned on, and a finished run in this version of Husk does not record that fingerprint. The file carries no numbers rather than numbers that might belong to a different version of these steps.';
    } else {
      title = `Up to ${plural(history.fingerprinted, 'run')} may be attached`;
      message = `${plural(history.total, 'run')} are stored for this workflow and ${history.fingerprinted} of them name this graph. The counts and the medians are computed when the file is built, and the next screen shows exactly what travelled.`;
    }
    const empty = injected(el('div', { class: 'wfx-empty' },
      el('p', { class: 'wfx-empty-t' }, title),
      el('p', { class: 'wfx-empty-m' }, message)));
    host.parentElement.insertBefore(empty, host);
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

  function paintRecord(host, graph, history) {
    const rows = [
      pfRow(
        `${plural(graph.nodes.length, 'step')} and ${plural(graph.edges.length, 'connection')}, with every prompt in full`,
        'A reader sees the prompt text before anything runs, which is the point. Layout travels as reading order only: coordinates are moved to the origin and rounded, so nudging a step on the canvas does not change what the file fingerprints.',
      ),
      pfRow(
        'A fingerprint of the steps and the routing',
        'Recomputed on their machine from the bytes they received. If it disagrees with what the file claims, their Husk refuses the file outright rather than showing them numbers that belong to some other graph.',
      ),
    ];
    if (history.unread) {
      rows.push(pfRow(
        'Run history could not be read',
        'The file is still publishable. Whatever the builder can attach, it attaches, and the next screen names it.',
      ));
    } else if (history.total === 0) {
      rows.push(pfRow(
        'No receipts, because there is nothing to count yet',
        'Receipts are earned by running the workflow here. Until then the file says so plainly, which is a different claim from a file that reports zero.',
      ));
    } else if (history.fingerprinted === 0) {
      rows.push(pfRow(
        `${plural(history.total, 'stored run')}, none of them attachable`,
        'This Husk does not yet record which graph a finished run executed, so no run in your history can be tied to this fingerprint. The file carries no receipts.',
      ));
    } else {
      rows.push(pfRow(
        `${plural(history.fingerprinted, 'run')} name this graph, out of ${history.total} stored`,
        'Only runs of these exact steps can be attached. A run from before you last edited the graph describes a program the reader will not be executing.',
      ));
    }
    rows.push(pfRow(
      'No pass rate, and no count of what the runs produced',
      'A step\'s status is its process exit code and nothing else, so a step that answers confidently wrong and exits zero counts as finished. The file carries the four raw outcome counts and the basis they were counted on, so no reader can print them as a percentage.',
    ));
    rows.push(pfRow(
      'No dollar figure, in any version of this file',
      'Four of the five agents Husk can run are priced at zero in its own rate table, so a cost would publish as free. Tokens travel instead, and whoever reads the file prices them with their own table and is told it is their estimate.',
    ));
    pfBlock(host, 'What gets written, and what it means', rows);
  }

  function paintRequires(host, graph, requires) {
    const rows = [];
    if (graph.agents.length) {
      rows.push(pfRow(
        [
          ...nameList(graph.agents, code),
          graph.pins ? `, with ${plural(graph.pins, 'model pin')}` : '',
        ],
        'Bare basenames, resolved on the reader\'s PATH and never from a directory inside the repo they cloned. Your own paths are not in the file.',
      ));
    } else {
      rows.push(pfRow(
        'No agent is named by any step',
        'Every step has to say which agent it runs before this can be published, because a step that does not resolves at run time to whatever the reader\'s own config says.',
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
      rows.push(pfRow(parts,
        'Names and content fingerprints only, so a reader can be told theirs is a different server rather than shown a green tick. No command, no arguments and no environment leaves this machine.'));
    } else {
      rows.push(pfRow(
        'No MCP server and no skill is declared',
        'Husk cannot derive these: which tool a step uses lives in prose inside its prompt, and guessing it would be a claim presented as a fact. A declaration edited into the file by hand is carried forward when you publish again.',
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
      rows.push(pfRow(parts,
        'You declared these; Husk cannot derive them. They travel labelled as your claim and are checked against the directory the reader binds before anything runs.'));
    } else {
      rows.push(pfRow(
        'No workspace requirement is declared',
        'Prompts embed the tooling of the repo they were written in: "run the full test suite" means one command in your tree and nothing at all in somebody else\'s. A marker file and a build command in the file are what carry that across.',
      ));
    }
    pfBlock(host, 'What the file will require of a reader', rows);
  }

  function paintDestination() {
    if (current.target) {
      paintPath(refs.destPath, current.target);
      return;
    }
    refs.destPath.replaceChildren(
      el('span', { class: 'wfx-path-file' }, 'Husk will ask, and offer this workflow\'s repo'),
    );
  }

  // Pre-write, the disclosure explains itself instead of standing empty. A
  // collapsed block with nothing in it reads as a feature that failed to load,
  // and the one sentence a reader needs at this point is when the bytes arrive
  // and what they will be able to do about them.
  function paintRawPending(graph) {
    refs.rawName.textContent = 'The exact bytes this writes';
    refs.rawMeta.textContent = `${plural(graph.nodes.length, 'step')} · ${plural(graph.edges.length, 'connection')} ·`;
    refs.rawPc.textContent = 'shown in full once written';
    refs.rawPre.textContent = 'Husk builds these bytes when you press Publish, and shows the whole file here before the line that would commit it. The file is written to your own disk and is not tracked by anything until you run that line, so reading it is the last step and not a leap of faith.';
  }

  // ─── the ready pane ───────────────────────────────────────────────────────

  function renderReady() {
    // The disclosure comes home before anything else touches the pane, so a
    // second publish in one sitting opens the same screen as the first. Home is
    // the end of the ready pane, which is where index.html declares it, and
    // saying so here rather than remembering where the element was found is
    // what keeps a re-resolve after a write from deciding that the done pane
    // is where it belongs.
    refs.ready.appendChild(refs.raw);
    refs.raw.open = false;
    clearInjected();

    const graph = current.graph;
    paintGraph(refs.graphHost, graph);
    paintOutlook(refs.figsHost, current.history);
    paintRecord(refs.recordHost, graph, current.history);
    paintRequires(refs.requiresHost, graph, current.requires);
    paintDestination();
    paintRawPending(graph);

    refs.attach.checked = false;
    refs.go.hidden = false;
    refs.doneBtn.hidden = true;
    refs.goNoLog.hidden = false;
    refs.go.textContent = 'Publish';
    applyBlockers();
    setState('ready');
  }

  // Two conditions this sheet can see for itself, both of which the builder
  // would refuse anyway. Predicting them is worth the duplication because the
  // refusal is one the reader can act on and neither fix lives in this sheet:
  // a step with no agent and a workflow with no steps are both repairs made on
  // the canvas, and hearing about them before the write saves a round trip
  // through a refusal pane. Everything else is left to the builder, which owns
  // the rules and states them in its own words.
  function applyBlockers() {
    const graph = current.graph;
    let blocker = null;
    if (!graph.nodes.length) {
      blocker = 'This workflow has no steps yet, so there is nothing to publish.';
    } else if (graph.unbound.length) {
      const first = graph.unbound[0];
      blocker = graph.unbound.length === 1
        ? `The step "${first}" does not say which agent it runs. Set one on the canvas and a reader will know what the file does.`
        : `${graph.unbound.length} steps, starting with "${first}", do not say which agent they run. Set one on each and a reader will know what the file does.`;
    }
    current.blocked = !!blocker;
    refs.foot.textContent = blocker
      || 'Nothing leaves this machine. Publishing writes one file where you point it.';
    if (blocker) {
      // aria-disabled rather than disabled, so the button keeps its place in
      // the tab order and the sentence naming what is blocking it can be
      // announced by the control it is about.
      refs.go.setAttribute('aria-disabled', 'true');
      refs.go.setAttribute('aria-describedby', 'wfx-pub-foot');
    } else {
      refs.go.removeAttribute('aria-disabled');
      refs.go.removeAttribute('aria-describedby');
    }
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
    busy = true;
    setState('working');
    refs.go.setAttribute('aria-disabled', 'true');
    refs.go.textContent = 'Publishing';
    say('Writing the file');

    let res = null;
    try {
      res = await window.husk.workflows.export(
        payloadFor(current.workflow.id, current.target, current.prior, attachLog),
      );
    } catch (_) { res = null; }

    busy = false;
    refs.go.textContent = 'Publish';
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
  function buildWarnings(res, text) {
    const rows = [];
    const warnings = Array.isArray(res.warnings) ? res.warnings : [];
    for (const warning of warnings) {
      if (!warning) continue;
      rows.push(pfRow(String(warning.code || 'note'), String(warning.message || '')));
    }
    const measured = byteLength(text);
    if (Number.isFinite(measured) && Number.isFinite(res.bytes) && measured !== res.bytes) {
      rows.push(pfRow(
        'The pane below is a re-serialization',
        `The writer reported ${res.bytes} bytes and the same object serializes to ${measured} here, so the text below is not byte for byte the file. Read the file itself before you commit it.`,
      ));
    }
    if (!rows.length) return null;
    return injected(el('div', { class: ['wfx-pf', 'is-plain'] },
      el('div', { class: 'wfx-pf-h' }, 'What Husk changed, or could not do'),
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
        message: 'The file that was written carries raw agent output, which a published workflow must never contain. Delete it rather than committing it.',
        detail: res.path,
      }, attachLog);
      return;
    }

    const noteTitle = refs.doneNote.querySelector('.wfx-note-t');
    const noteBody = refs.doneNote.querySelector('.wfx-note-m');
    if (noteTitle) noteTitle.textContent = 'Written.';
    if (noteBody) {
      noteBody.textContent = `${fmtBytes(res.bytes)}, ${receiptPhrase(artifact)}, ${attached ? 'run log attached' : 'no run log attached'}. It is not committed yet.`;
    }

    // The tiles appear only when receipts actually travelled, and they read
    // from the summary of the runs that went into them rather than from the
    // local history, so what the publisher sees here is what a reader will see
    // on the other side of the file. No run in this build records the graph it
    // executed, so nothing is publishable yet and this stays folded; it is
    // written now rather than later because the alternative is a surface that
    // silently keeps showing an empty state on the day receipts start working.
    clearInjected();
    const receiptsTravelled = Array.isArray(artifact.receipts) && artifact.receipts.length > 0;
    if (receiptsTravelled && res.receiptSummary) {
      const figs = injected(el('div', { class: 'wfx-figs' }, ...buildFigures(res.receiptSummary, attached)));
      refs.done.insertBefore(figs, refs.donePath);
    }

    const warnings = buildWarnings(res, text);
    if (warnings) refs.done.insertBefore(warnings, refs.donePath);

    paintPath(refs.donePath, res.path);

    // The disclosure moves under the git line rather than being rebuilt there,
    // so the summary, the chevron and the keyboard-reachable pre are the same
    // elements the ready pane offered and there is only one of them in the DOM.
    refs.rawName.textContent = 'The exact bytes that were written';
    refs.rawMeta.textContent = `${fmtBytes(res.bytes)} · ${receiptPhrase(artifact)} ·`;
    refs.rawPc.textContent = attached ? 'run log attached' : 'no log attached';
    refs.rawPre.textContent = text;
    refs.done.insertBefore(refs.raw, refs.gitRow);

    const command = gitCommandFor(res.path, artifact.name || current.workflow.name, artifact.revision || 1);
    refs.gitPre.textContent = command;
    current.command = command;
    refs.copy.textContent = 'Copy';

    refs.go.hidden = true;
    refs.goNoLog.hidden = true;
    refs.doneBtn.hidden = false;
    refs.foot.textContent = repoRelative(res.path)
      ? 'Nothing is shared yet. The file sits untracked in that repo until you run the line above.'
      : 'Nothing is shared yet. The file sits on your disk until you put it somewhere a reader can reach.';
    setState('done');
    say(`Written to ${res.path}`);
  }

  // ─── the refused pane ─────────────────────────────────────────────────────

  const REFUSAL_TITLES = {
    'evidence-too-large': 'The run log is larger than a workflow file may carry',
    'bad-agent': 'A step does not say which agent it runs',
    'name-collision': 'Two step names an AI router cannot tell apart',
    'regex-condition': 'This workflow routes on a regular expression',
    'too-many-nodes': 'This workflow is larger than a published file may carry',
    'bad-model': 'A model pin cannot be published as written',
    'bad-input': 'This workflow could not be published as written',
    'write-failed': 'That file could not be written',
    'not-found': 'That workflow is not in your list any more',
    'run-output-in-file': 'The file that was written carries raw agent output',
    'no-answer': 'Husk did not answer',
  };

  // The forward move exists for one refusal only. The footer declares two
  // primaries and the stylesheet swaps them on the refused state, which is
  // right for a size check on the author's own run log: routine, recoverable,
  // and fixed by publishing without it. Every other refusal here is about the
  // workflow itself, where there is no safe forward move and a button offering
  // one would be a lock to pick, so it is hidden and the body sentence carries
  // the fix in words.
  function renderRefused(res, attachLog) {
    const code = String(res.code || 'bad-input');
    refs.refTitle.textContent = REFUSAL_TITLES[code] || 'This workflow could not be published';
    refs.refMessage.textContent = String(res.message || 'Husk refused to write this file.');

    const rows = [
      el('dt', {}, 'code'), el('dd', {}, code),
      el('dt', {}, 'stage'), el('dd', {}, String(res.stage || 'export')),
    ];
    if (res.detail) { rows.push(el('dt', {}, 'detail'), el('dd', {}, String(res.detail))); }
    if (Array.isArray(res.steps) && res.steps.length) {
      rows.push(el('dt', {}, 'steps'),
        el('dd', {}, res.steps.map((s) => String((s && s.name) || '')).join(', ')));
    } else if (res.step && res.step.name) {
      rows.push(el('dt', {}, 'step'), el('dd', {}, String(res.step.name)));
    }
    refs.refDetail.replaceChildren(...rows);

    const logIsTheProblem = attachLog === true && (code === 'evidence-too-large' || code === 'chain-invalid');
    refs.goNoLog.hidden = !logIsTheProblem;
    if (logIsTheProblem) {
      refs.foot.textContent = 'Nothing was written. Publishing without the log writes the same file with the receipts labelled as your own account.';
    } else if (code === 'run-output-in-file') {
      // The one refusal that arrives after the write, so it is the one that
      // must not say nothing happened. The file exists, it is untracked, and
      // deleting it is the whole fix.
      refs.foot.textContent = 'The file was written and is untracked. Delete it; do not commit it.';
    } else {
      refs.foot.textContent = 'Nothing was written, and nothing about this workflow has changed.';
    }
    setState('refused');
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

  // The second publish of a session writes immediately and confirms with an
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
    const message = `Published revision ${revision}, ${receiptPhrase(res.artifact)} attached`;
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
      if (!current || refs.go.getAttribute('aria-disabled') === 'true') return;
      publish(refs.attach.checked === true);
    });
    refs.goNoLog.addEventListener('click', () => { if (current) publish(false); });

    // Change points the write at a file that already exists, which is the
    // overwrite path. Leaving it alone is the ordinary case: the save dialog
    // asks on Publish and offers the workflow's own repo, and that default
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
      say(`Publishing to ${picked}`);
    });

    // The toggle changes one line of copy and nothing else. Its own sentence,
    // the one that says an audit row carries the goal text and the workspace
    // path, is static markup and is never rewritten from here: a warning that
    // moves when you interact with it is a warning people learn to dismiss.
    refs.attach.addEventListener('change', () => {
      refs.rawPc.textContent = refs.attach.checked
        ? 'log requested, if there is one to attach'
        : 'shown in full once written';
    });

    refs.copy.addEventListener('click', async () => {
      if (!current || !current.command) return;
      try {
        await navigator.clipboard.writeText(current.command);
        refs.copy.textContent = 'Copied';
        setTimeout(() => { refs.copy.textContent = 'Copy'; }, 1600);
      } catch (_) { shout('That command could not be copied', 'error'); }
    });

    registerCloser();
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
      shout('The publish sheet could not load its renderer', 'error');
      console.error('wfx-publish: window.WfxDom is missing, so nothing can be built safely');
      return;
    }
    refs = resolve();
    if (!refs) { shout('The publish sheet is missing from this page', 'error'); return; }
    bindOnce();

    const workflow = await loadWorkflow(workflowOrId);
    if (!workflow || !workflow.id) { shout('That workflow is not in your list any more', 'error'); return; }

    const remembered = lastPublish.get(workflow.id) || null;
    const sidecar = await loadSidecar(workflow.id);
    const target = (typeof options.targetPath === 'string' && options.targetPath)
      || (remembered && remembered.path)
      || null;
    const prior = await loadPrior(workflow, sidecar, target, remembered);

    // A workflow published earlier in this session goes straight to the write.
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
    };

    restoreFocusTo = document.activeElement;
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
    // they should read.
    refs.card.setAttribute('tabindex', '-1');
    try { refs.card.focus({ preventScroll: true }); } catch (_) { refs.card.focus(); }
    say('Publish this workflow');
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
