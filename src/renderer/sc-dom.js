'use strict';

// DOM builders for the source page. Every node that page paints is built here,
// so the painter stays out of the page module and out of app.js.
//
// The module is stateless. A builder takes its data plus a bag of callbacks and
// returns a detached node; it reads no page state and calls no IPC, which is
// what lets any one of them be exercised on its own.
//
// Elements come from createElement and every string lands through textContent.
// A path, a branch name, a commit subject, an author and a run goal all come
// out of a repository on disk, so they are text and never markup. The single
// exception is the syntax-highlight backdrop on a diff line, which
// highlightLines entity-escapes before it is written.

(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Past this width a line is painted plain. Tokenizing a minified bundle line
  // costs more than the color is worth on the hot path.
  const HL_MAX = 2000;

  // Icon paths, in the 24-unit stroked grammar the rest of the shell draws in.
  const ICONS = Object.freeze({
    check: ['M20 6L9 17l-5-5'],
    plus: ['M12 5v14', 'M5 12h14'],
    minus: ['M5 12h14'],
    discard: ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5'],
    run: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 8 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H2a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 3.6 8a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 8 3.6h.1A1.6 1.6 0 0 0 9.2 2.1V2a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1 1.6 1.6 0 0 0 1.8.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H22a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.1z'],
    clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
    branch: ['M6 3v12', 'M18 9v3a6 6 0 0 1-6 6h-1'],
    trash: ['M4 7h16', 'M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2', 'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12', 'M10 11v6', 'M14 11v6'],
  });

  // Circles a path cannot draw, keyed by the same icon name.
  const ICON_CIRCLES = Object.freeze({
    branch: [[6, 18, 3], [18, 6, 3]],
  });

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== null && text !== undefined && text !== '') node.textContent = String(text);
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.75');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of (ICONS[name] || [])) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    }
    for (const c of (ICON_CIRCLES[name] || [])) {
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', String(c[0]));
      circle.setAttribute('cy', String(c[1]));
      circle.setAttribute('r', String(c[2]));
      svg.appendChild(circle);
    }
    return svg;
  }

  function isFn(v) {
    return typeof v === 'function';
  }

  function str(v) {
    return typeof v === 'string' ? v : '';
  }

  function num(v) {
    return typeof v === 'number' && isFinite(v) ? v : 0;
  }

  function hasNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  // Thousands separators without an Intl formatter, which costs far more per
  // call than a diff of a few thousand rows can afford.
  function groupNum(n) {
    const s = String(Math.abs(Math.trunc(n)));
    let out = '';
    for (let i = 0; i < s.length; i++) {
      if (i > 0 && (s.length - i) % 3 === 0) out += ',';
      out += s[i];
    }
    return (n < 0 ? '-' : '') + out;
  }

  function plural(n, one, many) {
    return n === 1 ? one : many;
  }

  // Relative age in the long form the page copy is written in. Shared so a
  // stamp in a row and a stamp in the page sub read the same.
  function ago(ms) {
    const t = typeof ms === 'number' ? ms : Date.parse(ms);
    if (!isFinite(t)) return '';
    const delta = Date.now() - t;
    if (delta < 0) return 'just now';
    const m = Math.floor(delta / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' ' + plural(h, 'hour', 'hours') + ' ago';
    const d = Math.floor(h / 24);
    if (d < 30) return d + ' ' + plural(d, 'day', 'days') + ' ago';
    return new Date(t).toLocaleDateString();
  }

  // Wall clock, zero padded, for the provenance window claim.
  function clockAt(ms) {
    const t = typeof ms === 'number' ? ms : Date.parse(ms);
    if (!isFinite(t)) return '';
    const d = new Date(t);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return hh + ':' + mm;
  }

  // The git status colour scale the Files list already owns, so the two pages
  // speak one badge language. A status with no hue on that scale keeps the
  // letter and takes the row's own colour.
  const BADGE_LETTER = Object.freeze({
    modified: 'M',
    added: 'A',
    deleted: 'D',
    untracked: '?',
    renamed: 'R',
    copied: 'C',
    'type-changed': 'T',
    conflicted: 'U',
    ignored: '!',
  });
  const BADGE_HUE = Object.freeze({
    modified: 'fx-b-M',
    added: 'fx-b-A',
    deleted: 'fx-b-D',
    untracked: 'fx-b-question',
    renamed: 'fx-b-R',
    copied: 'fx-b-C',
    'type-changed': 'fx-b-T',
    conflicted: 'fx-b-U',
  });

  function badgeEl(status) {
    const key = str(status);
    const letter = BADGE_LETTER[key] || '?';
    const hue = BADGE_HUE[key];
    return el('span', hue ? 'sc-row-badge ' + hue : 'sc-row-badge', letter);
  }

  // A path reads as basename plus its folder, which is how a change list is
  // scanned: the file first, the place second.
  function pathEl(rel) {
    const p = str(rel);
    const cut = p.lastIndexOf('/');
    const frag = document.createDocumentFragment();
    frag.appendChild(el('span', 'sc-row-base', cut >= 0 ? p.slice(cut + 1) : p));
    frag.appendChild(el('span', 'sc-row-dir', cut > 0 ? p.slice(0, cut) : ''));
    return frag;
  }

  // A +N/-M tail. A side with nothing to report is left off rather than printed
  // as zero, so a deleted file reads as one number. Each side is its own node,
  // so the two counts take their own ink.
  function statParts(adds, dels, boxCls, partCls) {
    const box = el('span', boxCls);
    const a = num(adds);
    const d = num(dels);
    const addCls = partCls ? partCls + ' is-add' : 'is-add';
    const delCls = partCls ? partCls + ' is-del' : 'is-del';
    if (a > 0) box.appendChild(el('span', addCls, '+' + groupNum(a)));
    if (a > 0 && d > 0) box.appendChild(document.createTextNode(' '));
    if (d > 0) box.appendChild(el('span', delCls, '-' + groupNum(d)));
    return box;
  }

  // The same tail for the diff head. A file with no counts on either side is
  // binary, where a number would be a guess, so the head says so in a word.
  function statEl(adds, dels) {
    if (!hasNum(adds) && !hasNum(dels)) return el('span', 'sc-dhead-stat', 'binary');
    return statParts(adds, dels, 'sc-dhead-stat', 'sc-dstat-n');
  }

  function iconButton(cls, name, label, onClick) {
    const b = el('button', cls);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.appendChild(icon(name));
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
    return b;
  }

  function textButton(cls, label, onClick) {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
    return b;
  }

  const BAND_TITLE = Object.freeze({
    conflicts: 'Conflicts',
    staged: 'Staged',
    changed: 'Changed',
    untracked: 'Untracked',
    run: 'Run changes',
    history: 'History',
  });

  function bandTitle(kind) {
    return BAND_TITLE[str(kind)] || str(kind);
  }

  // One band of the change list. Rows are appended to the returned element by
  // the caller, which is what the collapsed rule selects on.
  function bandEl(kind, count, acts) {
    const bag = acts || {};
    const band = el('div', 'sc-band');
    band.dataset.band = str(kind);
    if (bag.open !== false) band.classList.add('is-open');

    const head = el('div', 'sc-band-head');
    // Sentence case, not the rail's uppercase eyebrow. Six identical 11px caps
    // across two unrelated hierarchies in one viewport separate nothing.
    head.appendChild(el('span', 'sc-band-title', bag.label || bandTitle(kind)));
    head.appendChild(el('span', 'sc-band-count', groupNum(num(count))));
    head.appendChild(el('span', 'sc-band-chevron', '›'));

    const actBox = el('div', 'sc-band-acts');
    if (isFn(bag.onStageAll)) actBox.appendChild(iconButton('', 'plus', 'Stage every file in this band', () => bag.onStageAll(kind)));
    if (isFn(bag.onUnstageAll)) actBox.appendChild(iconButton('', 'minus', 'Unstage every file in this band', () => bag.onUnstageAll(kind)));
    if (isFn(bag.onDiscardAll)) actBox.appendChild(iconButton('', 'discard', 'Discard every change in this band', () => bag.onDiscardAll(kind)));
    if (actBox.childNodes.length) head.appendChild(actBox);

    if (isFn(bag.onToggle)) {
      head.addEventListener('click', () => bag.onToggle(kind));
    }
    band.appendChild(head);
    return band;
  }

  // One changed file. Staged-ness is whatever the caller was told by the last
  // porcelain read, so the check reflects git and never a click.
  function fileRowEl(entry, opts) {
    const e = entry || {};
    const o = opts || {};
    const rel = str(e.path);
    const row = el('div', 'sc-row');
    row.dataset.path = rel;
    row.tabIndex = o.cursor ? 0 : -1;
    row.title = e.oldPath ? str(e.oldPath) + ' -> ' + rel : rel;
    if (o.selected) row.classList.add('is-selected');
    if (e.staged) row.classList.add('is-staged');
    if (e.status === 'conflicted') row.classList.add('is-conflict');

    if (isFn(o.onToggleStage)) {
      const label = e.staged ? 'Unstage ' + rel : 'Stage ' + rel;
      const check = iconButton('sc-row-check', 'check', label, () => o.onToggleStage(e));
      check.tabIndex = -1;
      row.appendChild(check);
    }

    row.appendChild(badgeEl(e.status));
    row.appendChild(pathEl(rel));
    row.appendChild(statParts(e.adds, e.dels, 'sc-row-stat', ''));

    const prov = e.prov;
    if (prov && prov.tier && prov.tier !== 'none') {
      const mark = el('span', 'sc-row-prov');
      mark.appendChild(icon(prov.tier === 'run' ? 'run' : 'clock'));
      mark.title = prov.tier === 'run' && prov.runId
        ? 'Autopilot run ' + str(prov.runId) + ' wrote this file'
        : 'Changed after this chat started';
      row.appendChild(mark);
    }

    if (isFn(o.onOpen)) row.addEventListener('click', () => o.onOpen(e));
    return row;
  }

  // One commit in the History list.
  function commitRowEl(commit, opts) {
    const c = commit || {};
    const o = opts || {};
    const row = el('div', 'sc-crow');
    row.dataset.sha = str(c.sha);
    row.tabIndex = o.cursor ? 0 : -1;
    if (o.selected) row.classList.add('is-selected');

    row.appendChild(el('span', 'sc-crow-sha', str(c.shortSha) || str(c.sha).slice(0, 12)));
    const subject = el('span', 'sc-crow-subject', str(c.subject));
    subject.title = str(c.subject);
    row.appendChild(subject);
    if (str(c.refs)) row.appendChild(el('span', 'sc-crow-refs', str(c.refs)));

    const meta = [str(c.author), ago(c.dateMs)].filter(Boolean).join(' · ');
    if (meta) row.appendChild(el('span', 'sc-crow-meta', meta));

    if (isFn(o.onOpen)) row.addEventListener('click', () => o.onOpen(c));
    return row;
  }

  // The sticky band above a hunk. It carries the range in the numbers a person
  // reads and git's own function context, plus the per-hunk actions.
  function hunkBandEl(hunk, opts) {
    const h = hunk || {};
    const o = opts || {};
    const band = el('div', 'sc-hunk');
    band.tabIndex = o.cursor ? 0 : -1;
    if (typeof o.index === 'number') band.dataset.hunk = String(o.index);

    const head = el('div', 'sc-hunk-head');
    const start = num(h.newLines) > 0 ? num(h.newStart) : num(h.oldStart);
    const span = num(h.newLines) > 0 ? num(h.newLines) : num(h.oldLines);
    const end = start + Math.max(span, 1) - 1;
    head.appendChild(el('span', 'sc-hunk-range', '@@ Lines ' + groupNum(start) + '-' + groupNum(end)));
    if (str(h.fn)) {
      const fn = el('span', 'sc-hunk-fn', 'in ' + str(h.fn));
      fn.title = str(h.fn);
      head.appendChild(fn);
    }
    band.appendChild(head);

    const actBox = el('div', 'sc-hunk-acts');
    if (isFn(o.onStage)) actBox.appendChild(textButton('', 'Stage hunk', () => o.onStage(o.index)));
    if (isFn(o.onUnstage)) actBox.appendChild(textButton('', 'Unstage hunk', () => o.onUnstage(o.index)));
    if (isFn(o.onDiscard)) actBox.appendChild(textButton('', 'Discard hunk', () => o.onDiscard(o.index)));
    if (actBox.childNodes.length) band.appendChild(actBox);

    return band;
  }

  // The one place markup is written. highlightLines returns one balanced,
  // entity-escaped string per source line, so the value is already text by the
  // time it lands.
  function setCode(node, text, lang) {
    if (!lang || text.length > HL_MAX) { node.textContent = text; return; }
    const api = (typeof window !== 'undefined' && window.husk) ? window.husk.text : null;
    const lines = (api && isFn(api.highlightLines)) ? api.highlightLines(text, lang) : null;
    if (!Array.isArray(lines) || lines.length !== 1) { node.textContent = text; return; }
    // eslint-disable-next-line no-unsanitized/property -- highlightLines/escapeHtml entity-escape all input.
    node.innerHTML = lines[0];
  }

  const LINE_CLASS = Object.freeze({ add: 'sc-dl is-add', del: 'sc-dl is-del', ctx: 'sc-dl is-ctx' });
  const LINE_SIGN = Object.freeze({ add: '+', del: '-', ctx: '' });

  // One diff row. A large diff is thousands of these, so it builds four nodes,
  // binds no listener, and reads nothing back out of the document.
  function lineEl(line, opts) {
    const l = line || {};
    const o = opts || {};
    const kind = str(l.kind) || 'ctx';
    if (kind === 'nonl') return el('div', 'sc-nonl', str(l.text) || 'No newline at end of file');

    const row = el('div', LINE_CLASS[kind] || LINE_CLASS.ctx);
    row.appendChild(el('span', 'sc-dl-no', l.oldNo === null || l.oldNo === undefined ? '' : String(l.oldNo)));
    row.appendChild(el('span', 'sc-dl-no', l.newNo === null || l.newNo === undefined ? '' : String(l.newNo)));
    row.appendChild(el('span', 'sc-dl-sign', LINE_SIGN[kind] || ''));
    const code = el('span', 'sc-dl-code');
    setCode(code, str(l.text), o.lang);
    row.appendChild(code);
    return row;
  }

  // The context opener between two hunks. The row expands a fixed number of
  // lines; the word beside it expands the whole gap, and passes n as null.
  function expandRowEl(dir, n, onExpand) {
    const count = num(n);
    if (count <= 0) return null;
    const up = dir !== 'down';
    const b = el('button', 'sc-expand');
    b.type = 'button';
    b.dataset.dir = up ? 'up' : 'down';
    b.title = 'Show more of this file';
    b.appendChild(el('span', '', up ? '⌃' : '⌄'));
    b.appendChild(el('span', '', 'expand ' + groupNum(count) + ' ' + plural(count, 'line', 'lines')));
    b.appendChild(el('span', '', '·'));
    const all = el('span', '', 'expand all');
    b.appendChild(all);
    if (isFn(onExpand)) {
      b.addEventListener('click', () => onExpand(b.dataset.dir, count));
      all.addEventListener('click', (e) => { e.stopPropagation(); onExpand(b.dataset.dir, null); });
    }
    return b;
  }

  // A file git reports as binary. There is no text to diff, so the pane says
  // that and names the controls that still apply to the file as a whole.
  function binaryEl() {
    const box = el('div', 'sc-binary');
    box.appendChild(el('div', '', 'This file is binary, so there is no text diff to show.'));
    box.appendChild(el('div', 'sc-note', 'Staging, discarding and opening the file work from the head above. Hunk controls do not, because a binary file has no hunks.'));
    return box;
  }

  // A diff past the ceiling the pane can paint. The count is git's own, and the
  // two actions are whatever the caller can still offer for the whole file.
  function tooBigEl(opts) {
    const o = opts || {};
    const n = num(o.lines);
    const box = el('div', 'sc-toobig');
    box.appendChild(el('div', '', 'This diff is ' + groupNum(n) + ' ' + plural(n, 'line', 'lines') + '. Painting it would lock the window, so Husk did not read it.'));

    const acts = el('div', 'sc-dacts');
    if (isFn(o.onStageAll)) acts.appendChild(textButton('sc-act', 'Stage the whole file', () => o.onStageAll()));
    if (isFn(o.onOpen)) acts.appendChild(textButton('sc-act', 'Open in Files', () => o.onOpen()));
    if (acts.childNodes.length) box.appendChild(acts);

    if (isFn(o.onStageAll)) box.appendChild(el('div', 'sc-note', 'Staging the whole file does not need the diff and is safe to do from here.'));
    return box;
  }

  // The marker above the diff of a file whose whole content is the addition.
  function newFileEl() {
    return el('div', 'sc-new', 'New file. Every line in it is an addition.');
  }

  // Provenance. Authorship is stated only for a run Husk recorded, because Husk
  // wrote that record. Everything else is stated as time and says plainly that
  // Husk does not know what wrote the file. Knowing neither renders nothing.
  function provBandEl(claim) {
    const c = claim || {};
    const tier = str(c.tier);
    if (tier !== 'run' && tier !== 'window') return null;

    const band = el('div', tier === 'run' ? 'sc-prov-band is-run' : 'sc-prov-band');
    band.appendChild(icon(tier === 'run' ? 'run' : 'clock'));
    const body = el('div', '');

    if (tier === 'run') {
      body.appendChild(el('span', '', 'Autopilot run ' + str(c.runId) + ' wrote this file.'));
      if (str(c.goal)) body.appendChild(el('span', 'sc-prov-goal', 'Goal: ' + str(c.goal)));
      body.appendChild(el('span', 'sc-prov-goal', 'Husk created this worktree and recorded the file list.'));
    } else {
      const at = clockAt(c.since);
      const when = c.ambiguous
        ? 'Changed after more than one session started, the earliest at ' + at + '.'
        : 'Changed after this chat started at ' + at + '.';
      body.appendChild(el('span', '', when));
      body.appendChild(el('span', 'sc-prov-goal', 'Husk does not know what wrote it.'));
    }

    band.appendChild(body);
    return band;
  }

  // A card on the overview. `act` is a node, a plain count string, or a
  // { label, onClick } button.
  function ovCardEl(title, rows, act) {
    const card = el('section', 'sc-ov-card');
    const head = el('div', 'sc-ov-card-head');
    head.appendChild(el('span', 'section-label', str(title)));
    if (act) {
      if (typeof act === 'string') head.appendChild(el('span', 'section-label-count', act));
      else if (isFn(act.onClick)) head.appendChild(textButton('ghost-btn', str(act.label), act.onClick));
      else if (act.nodeType) head.appendChild(act);
    }
    card.appendChild(head);

    const box = el('div', 'sc-ov-rows');
    for (const row of (Array.isArray(rows) ? rows : [])) {
      if (row && row.nodeType) box.appendChild(row);
    }
    card.appendChild(box);
    return card;
  }

  // A retained agent run waiting on review.
  function runRowEl(run, opts) {
    const r = run || {};
    const o = opts || {};
    const row = el('div', 'sc-run-row');
    row.dataset.run = str(r.id);

    row.appendChild(el('span', '', str(r.id)));
    const goal = el('span', 'sc-run-goal', str(r.goal));
    goal.title = str(r.goal);
    row.appendChild(goal);

    const files = num(r.files);
    if (files > 0) row.appendChild(el('span', '', groupNum(files) + ' ' + plural(files, 'file', 'files')));

    const when = ago(r.endedAt);
    if (when) row.appendChild(el('span', '', 'ended ' + when));

    if (isFn(o.onReview)) row.appendChild(textButton('ghost-btn', 'Review', () => o.onReview(r)));
    if (isFn(o.onDiscard)) row.appendChild(textButton('ghost-btn ghost-btn-danger', 'Discard', () => o.onDiscard(r)));
    return row;
  }

  // One branch in the popover. A branch another worktree holds cannot be
  // switched to, so it renders as a fact with its reason rather than as a dead
  // control, and it takes no focus.
  //
  // Fetch state is a property of the repository rather than of one branch, so
  // it arrives once per call in opts.hasFetched and opts.fetchedAtMs and the
  // whole list is stamped from the same read.
  function branchRowEl(branch, opts) {
    const b = branch || {};
    const o = opts || {};
    const held = !!str(b.worktreePath) && !b.isHead;
    const row = el(held ? 'div' : 'button', 'sc-pop-row');
    if (!held) row.type = 'button';
    row.dataset.branch = str(b.name);
    if (b.isHead) row.classList.add('is-active');
    if (held) row.classList.add('is-held');

    row.appendChild(el('span', '', str(b.name)));

    // Ahead, behind and a gone upstream are all counted against the copy of the
    // remote ref on this machine, so a row that prints one of them says when
    // that copy was taken. Behind waits for a fetch rather than reading as 0.
    const fetched = o.hasFetched === true && hasNum(o.fetchedAtMs);
    const track = [];
    let remote = false;
    if (b.gone) { track.push('upstream gone'); remote = true; }
    else {
      if (num(b.ahead) > 0) { track.push(groupNum(num(b.ahead)) + ' ahead'); remote = true; }
      if (fetched && num(b.behind) > 0) { track.push(groupNum(num(b.behind)) + ' behind'); remote = true; }
    }
    if (remote) track.push(fetched ? 'measured ' + ago(o.fetchedAtMs) : 'never fetched');
    const age = ago(b.dateMs);
    if (age) track.push(age);
    if (track.length) row.appendChild(el('span', 'sc-pop-track', track.join(' · ')));

    if (held) row.appendChild(el('span', 'sc-pop-lock', 'open in ' + str(b.worktreePath)));
    if (str(b.subject)) row.title = str(b.subject);

    // Delete is offered only where it can be carried out: the checked out
    // branch and a branch another worktree holds already say why they cannot.
    if (!held && !b.isHead && isFn(o.onDelete)) {
      const del = iconButton('sc-pop-del', 'trash', 'Delete branch ' + str(b.name), () => o.onDelete(b));
      del.tabIndex = -1;
      row.appendChild(del);
    }

    if (!held && isFn(o.onPick)) row.addEventListener('click', () => o.onPick(b));
    return row;
  }

  // The row that creates a branch from the current commit. The line under the
  // field is the caller's to fill: setMessage puts one there and marks the
  // field invalid, and an empty string takes both away.
  function branchNewRowEl(opts) {
    const o = opts || {};
    const row = el('div', 'sc-pop-new');

    const input = el('input', 'form-input');
    input.type = 'text';
    input.id = 'sc-branch-new';
    input.placeholder = 'New branch from here';
    input.setAttribute('aria-label', 'Name for a new branch from the current commit');
    input.setAttribute('autocomplete', 'off');
    input.spellcheck = false;

    const go = el('button', '', 'Create');
    go.type = 'button';
    go.id = 'sc-branch-new-go';

    const msg = el('span', 'sc-pop-msg');
    msg.id = 'sc-branch-new-msg';
    msg.setAttribute('role', 'status');
    msg.hidden = true;
    input.setAttribute('aria-describedby', msg.id);

    const fire = () => { if (isFn(o.onCreate)) o.onCreate(input.value); };
    go.addEventListener('click', (e) => { e.stopPropagation(); fire(); });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      fire();
    });

    row.appendChild(input);
    row.appendChild(go);
    row.appendChild(msg);

    row.setMessage = (text) => {
      const line = str(text);
      msg.textContent = line;
      msg.hidden = !line;
      if (line) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    };
    return row;
  }

  // An empty state. `msg` is one line or several. `cta` is one or more
  // { label, onClick, primary, danger } buttons, and opts.note is the quiet
  // line under them that says what a button will actually do.
  function emptyEl(iconName, msg, cta, opts) {
    const o = opts || {};
    const box = el('div', o.compact ? 'sc-empty' : 'empty-state');

    if (iconName) {
      const mark = el('span', o.compact ? '' : 'es-icon');
      mark.appendChild(icon(iconName));
      box.appendChild(mark);
    }

    const lines = Array.isArray(msg) ? msg : [msg];
    for (const line of lines) {
      if (!str(line)) continue;
      box.appendChild(el('div', o.compact ? '' : 'es-msg', str(line)));
    }

    const ctas = Array.isArray(cta) ? cta : (cta ? [cta] : []);
    for (const c of ctas) {
      if (!c || !isFn(c.onClick)) continue;
      const cls = c.primary ? 'btn-primary' : (c.danger ? 'ghost-btn ghost-btn-danger' : 'ghost-btn');
      box.appendChild(textButton(cls, str(c.label), c.onClick));
    }

    if (str(o.note)) box.appendChild(el('div', 'sc-note', str(o.note)));
    return box;
  }

  const api = {
    bandEl,
    fileRowEl,
    commitRowEl,
    hunkBandEl,
    lineEl,
    expandRowEl,
    binaryEl,
    tooBigEl,
    newFileEl,
    provBandEl,
    statEl,
    ovCardEl,
    runRowEl,
    branchRowEl,
    branchNewRowEl,
    emptyEl,
    badgeEl,
    pathEl,
    ago,
  };

  if (typeof window !== 'undefined') window.ScDom = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
