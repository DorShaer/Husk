// Husk chat pane: the native thread a chat-mode tab shows in place of its xterm.
//
// The thread state lives in the reducer from src/lib/chat-events.js, loaded
// in-page as window.HuskChatEvents (the window.husk.chat bridge is the
// fallback). This file only paints that state. Painting
// is incremental and keyed by each item's stable key: an item's node is built
// once and patched when its signature changes, so a streaming reply re-renders
// one block per frame and never the whole thread.
//
// Every agent string reaches the DOM through textContent or the markdown
// renderer, which builds nodes the same way. Icons are built with
// createElementNS from the static tables below.
(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const NEAR_BOTTOM_PX = 40;
  const OUTPUT_CAP = 200000;
  const DIFF_CELL_CAP = 250000;

  // [tag, attrs] lists, drawn on a 24px stroke grid like the rest of the app.
  const ICONS = {
    execute: [['path', { d: 'M4 17l6-5-6-5' }], ['path', { d: 'M12 19h8' }]],
    read: [['path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }], ['path', { d: 'M14 3v5h5' }], ['path', { d: 'M9 13h6M9 17h4' }]],
    edit: [['path', { d: 'M12 20h9' }], ['path', { d: 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z' }]],
    fetch: [['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'M3 12h18' }], ['path', { d: 'M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18' }]],
    think: [['path', { d: 'M9 18h6M10 21h4' }], ['path', { d: 'M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z' }]],
    other: [['path', { d: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z' }]],
    chevron: [['path', { d: 'M9 6l6 6-6 6' }]],
    send: [['path', { d: 'M12 19V5' }], ['path', { d: 'M5 12l7-7 7 7' }]],
    stop: [['rect', { x: '7', y: '7', width: '10', height: '10', rx: '1.5', fill: 'currentColor' }]],
    attach: [['path', { d: 'M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48' }]],
    shield: [['path', { d: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z' }], ['path', { d: 'M12 8v5' }], ['path', { d: 'M12 16h.01' }]],
    plan: [['path', { d: 'M9 6h11M9 12h11M9 18h11' }], ['path', { d: 'M4 6h.01M4 12h.01M4 18h.01' }]],
    check: [['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]],
    cross: [['path', { d: 'M7 7l10 10M17 7L7 17' }]],
    lock: [['rect', { x: '5', y: '11', width: '14', height: '9', rx: '2' }], ['path', { d: 'M8 11V8a4 4 0 0 1 8 0v3' }]],
    copy: [['rect', { x: '9', y: '9', width: '11', height: '11', rx: '2' }], ['path', { d: 'M5 15V6a2 2 0 0 1 2-2h8' }]],
    rerun: [['path', { d: 'M3 12a9 9 0 1 0 3-6.7L3 8' }], ['path', { d: 'M3 3v5h5' }]],
    terminal: [['rect', { x: '3', y: '4', width: '18', height: '16', rx: '2' }], ['path', { d: 'M7 9l3 3-3 3' }], ['path', { d: 'M12 15h5' }]],
    down: [['path', { d: 'M6 9l6 6 6-6' }]],
  };

  const TOOL_KINDS = new Set(['execute', 'read', 'edit', 'fetch', 'think', 'other']);

  function icon(name, cls) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.75');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    if (cls) svg.setAttribute('class', cls);
    for (const [tag, attrs] of ICONS[name] || ICONS.other) {
      const n = document.createElementNS(SVG_NS, tag);
      for (const k of Object.keys(attrs)) n.setAttribute(k, attrs[k]);
      svg.appendChild(n);
    }
    return svg;
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function str(v) { return v === null || v === undefined ? '' : String(v); }
  function basename(p) { return str(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || str(p); }

  function md(text) {
    if (window.HuskChatMd && typeof window.HuskChatMd.render === 'function') return window.HuskChatMd.render(text);
    return document.createTextNode(str(text));
  }

  function cap(s) {
    const t = str(s);
    return t.length > OUTPUT_CAP ? t.slice(0, OUTPUT_CAP) + '\n\n[output truncated]' : t;
  }

  function prettyInput(input) {
    if (input === undefined || input === null) return '';
    if (typeof input === 'string') return input;
    if (typeof input === 'object' && typeof input.command === 'string' && Object.keys(input).length <= 2) return input.command;
    try { return JSON.stringify(input, null, 2); } catch (_) { return str(input); }
  }

  function fmtDuration(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '';
    if (ms < 1000) return (ms / 1000).toFixed(1) + 's';
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    return m + 'm ' + (s % 60) + 's';
  }

  function fmtCost(usd) {
    if (typeof usd !== 'number' || !isFinite(usd)) return '';
    if (usd > 0 && usd < 0.01) return '$' + usd.toFixed(4);
    return '$' + usd.toFixed(2);
  }

  // ─── diff ──────────────────────────────────────────────────────────────────

  // Line diff of old against new: the shared head and tail are trimmed first,
  // then the middle runs through an LCS table when it is small enough. A huge
  // middle shows as a straight replacement, which is still correct, only less
  // granular.
  function lineDiff(oldText, newText) {
    // A final newline ends the last line rather than opening an empty one.
    const lines = (t) => { const v = str(t); return v === '' ? [] : v.replace(/\n$/, '').split('\n'); };
    const a = oldText === null || oldText === undefined ? [] : lines(oldText);
    const b = lines(newText);
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let q = 0;
    while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
    const ops = [];
    for (let k = 0; k < p; k++) ops.push([' ', a[k]]);
    const am = a.slice(p, a.length - q);
    const bm = b.slice(p, b.length - q);
    if (am.length * bm.length > 0 && am.length * bm.length <= DIFF_CELL_CAP) {
      const n = am.length, m = bm.length;
      const t = new Array(n + 1);
      for (let x = 0; x <= n; x++) t[x] = new Uint32Array(m + 1);
      for (let x = n - 1; x >= 0; x--) for (let y = m - 1; y >= 0; y--) {
        t[x][y] = am[x] === bm[y] ? t[x + 1][y + 1] + 1 : Math.max(t[x + 1][y], t[x][y + 1]);
      }
      let x = 0, y = 0;
      while (x < n && y < m) {
        if (am[x] === bm[y]) { ops.push([' ', am[x]]); x++; y++; }
        else if (t[x + 1][y] >= t[x][y + 1]) { ops.push(['-', am[x]]); x++; }
        else { ops.push(['+', bm[y]]); y++; }
      }
      while (x < n) ops.push(['-', am[x++]]);
      while (y < m) ops.push(['+', bm[y++]]);
    } else {
      for (const l of am) ops.push(['-', l]);
      for (const l of bm) ops.push(['+', l]);
    }
    for (let k = a.length - q; k < a.length; k++) ops.push([' ', a[k]]);
    return ops;
  }

  // Unchanged runs longer than two context windows fold to a marker, the way a
  // unified diff only shows the lines around each change.
  function foldContext(ops, ctx) {
    const out = [];
    let k = 0;
    while (k < ops.length) {
      if (ops[k][0] !== ' ') { out.push(ops[k]); k++; continue; }
      let e = k; while (e < ops.length && ops[e][0] === ' ') e++;
      const run = e - k;
      const lead = k === 0 ? 0 : ctx;
      const trail = e === ops.length ? 0 : ctx;
      if (run > lead + trail + 1) {
        for (let z = k; z < k + lead; z++) out.push(ops[z]);
        out.push(['@', (run - lead - trail) + ' unchanged lines']);
        for (let z = e - trail; z < e; z++) out.push(ops[z]);
      } else {
        for (let z = k; z < e; z++) out.push(ops[z]);
      }
      k = e;
    }
    return out;
  }

  function renderDiff(d) {
    const box = el('div', 'chat-diff');
    const ops = lineDiff(d.oldText, d.newText);
    let add = 0, del = 0;
    for (const o of ops) { if (o[0] === '+') add++; else if (o[0] === '-') del++; }
    const head = el('div', 'chat-diff-head');
    head.appendChild(el('span', 'chat-diff-path', d.path || 'file'));
    if (d.oldText === null || d.oldText === undefined) head.appendChild(el('span', 'chat-diff-tag', 'new'));
    const stats = el('span', 'chat-diff-stats');
    stats.appendChild(el('span', 'chat-diff-add', '+' + add));
    stats.appendChild(el('span', 'chat-diff-del', '-' + del));
    head.appendChild(stats);
    box.appendChild(head);
    const body = el('div', 'chat-diff-body');
    for (const [sign, text] of foldContext(ops, 3)) {
      const row = el('div', 'chat-diff-line' + (sign === '+' ? ' is-add' : sign === '-' ? ' is-del' : sign === '@' ? ' is-gap' : ''));
      row.appendChild(el('span', 'chat-diff-sign', sign === '@' ? '' : sign));
      row.appendChild(el('span', 'chat-diff-text', text));
      body.appendChild(row);
    }
    box.appendChild(body);
    return box;
  }

  // ─── item signatures ───────────────────────────────────────────────────────

  // Cheap fingerprint of what an item would paint. A node is patched only when
  // its fingerprint moves, so an idle thread costs one string per item a frame.
  function sigOf(it, pending, waiting) {
    switch (it.kind) {
      case 'user': return 'u';
      case 'text':
      case 'thought': return (it.open ? 'o' : 'c') + (it.final ? 'f' : '') + str(it.text).length + ':' + str(it.text).slice(-24);
      case 'tool': return [it.status, it.title, it.toolKind, it.detail, str(it.output).length,
        Array.isArray(it.diffs) ? it.diffs.length : 0, it.input === undefined ? 0 : 1,
        Array.isArray(it.locations) ? it.locations.length : 0, waiting && waiting.has(it.id) ? 'w' : ''].join('|');
      case 'permission': return str(it.decision) + '|' + (pending.indexOf(it.requestId) !== -1 ? 'p' : 'x');
      case 'plan': try { return JSON.stringify(it.entries || []); } catch (_) { return String(Date.now()); }
      default: return 'm';
    }
  }

  // "ctx 2%" for a { used, size } token count, or null when there is none.
  function usageLabel(usage) {
    const used = Number(usage && usage.used);
    const size = Number(usage && usage.size);
    if (!isFinite(used) || !isFinite(size) || size <= 0 || used < 0) return null;
    const pct = (used / size) * 100;
    const shown = used > 0 && pct < 1 ? '<1' : String(Math.min(100, Math.round(pct)));
    return { text: 'ctx ' + shown + '%', title: used.toLocaleString() + ' of ' + size.toLocaleString() + ' context tokens used' };
  }

  // "3.2K" for 3200 tokens: one decimal under a hundred units, none above,
  // and a trailing ".0" dropped so round numbers read as "10K".
  function fmtTokens(nArg) {
    const n = Number(nArg);
    if (!isFinite(n) || n < 0) return '';
    const unit = (v, suffix) => {
      const r = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
      return String(r).replace(/\.0$/, '') + suffix;
    };
    if (n < 1000) return String(Math.round(n));
    if (n < 1e6) return unit(n / 1000, 'K');
    return unit(n / 1e6, 'M');
  }

  // "3.2K / 128K" for the top bar's context counter, or null without usage.
  function contextLabel(usage) {
    const used = Number(usage && usage.used);
    const size = Number(usage && usage.size);
    if (!isFinite(used) || !isFinite(size) || size <= 0 || used < 0) return null;
    return { text: fmtTokens(used) + ' / ' + fmtTokens(size), title: used.toLocaleString() + ' of ' + size.toLocaleString() + ' context tokens used' };
  }

  function clock(d) {
    const p = (x) => (x < 10 ? '0' : '') + x;
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // ─── composer autocomplete (pure) ──────────────────────────────────────────

  // Commands list everything that matches (the popover scrolls); files are
  // capped since a repo can hold thousands.
  const AC_MAX = 8;
  const AC_MAX_COMMANDS = 500;
  const AC_MAX_FILES = 40;

  function clampCaret(value, caret) {
    const n = typeof caret === 'number' && isFinite(caret) ? caret : value.length;
    return Math.max(0, Math.min(value.length, n));
  }

  function tokenEnd(value, from) {
    let end = from;
    while (end < value.length && !/\s/.test(value[end])) end++;
    return end;
  }

  // A slash command is the leading token of a line: the caret sits in a run
  // that starts with "/" at the start of the input or right after a newline.
  // Returns { start, end, query } over that token, or null.
  function slashContext(valueArg, caretArg) {
    const value = str(valueArg);
    const caret = clampCaret(value, caretArg);
    const lineStart = value.lastIndexOf('\n', caret - 1) + 1;
    const head = value.slice(lineStart, caret);
    if (!/^\/\S*$/.test(head)) return null;
    return { start: lineStart, end: tokenEnd(value, caret), query: head.slice(1) };
  }

  // A file mention is the word under the caret when it starts with "@" after
  // whitespace or at the start of the input. Returns { start, end, query }.
  function mentionContext(valueArg, caretArg) {
    const value = str(valueArg);
    const caret = clampCaret(value, caretArg);
    const m = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
    if (!m) return null;
    const start = caret - m[2].length - 1;
    return { start, end: tokenEnd(value, caret), query: m[2] };
  }

  function commandName(c) { return str(c && c.name).replace(/^\/+/, '').trim(); }

  // Commands whose name starts with the query, case-insensitive, in the order
  // the agent advertised them, one row per name.
  function matchCommands(commands, queryArg, limitArg) {
    const limit = limitArg || AC_MAX;
    const q = str(queryArg).toLowerCase();
    const seen = new Set();
    const out = [];
    for (const c of Array.isArray(commands) ? commands : []) {
      const name = commandName(c);
      if (!name || seen.has(name) || !name.toLowerCase().startsWith(q)) continue;
      seen.add(name);
      out.push({ name, description: str(c && c.description) });
      if (out.length >= limit) break;
    }
    return out;
  }

  // Subsequence score of query in target, higher is better, null when the
  // query is not a subsequence. Rewards runs, word starts and a basename hit.
  function scorePath(queryArg, targetArg) {
    const q = str(queryArg).toLowerCase();
    const t = str(targetArg);
    const lower = t.toLowerCase();
    if (!q) return 0;
    let score = 0;
    let ti = 0;
    let prev = -2;
    for (let qi = 0; qi < q.length; qi++) {
      const at = lower.indexOf(q[qi], ti);
      if (at === -1) return null;
      score += 10;
      if (at === prev + 1) score += 15;
      if (at === 0 || /[\/._\- ]/.test(t[at - 1])) score += 10;
      score -= Math.min(at - ti, 20);
      prev = at;
      ti = at + 1;
    }
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    if (base.includes(q)) score += 25;
    return score - t.length / 100;
  }

  // Files ranked by the fuzzy helper when one is given (window.husk.text's,
  // which returns matches best first), else by scorePath.
  function matchFiles(files, queryArg, limitArg, fuzzy) {
    const limit = limitArg || AC_MAX;
    const list = Array.isArray(files) ? files : [];
    const q = str(queryArg);
    if (!q) return list.slice(0, limit);
    if (typeof fuzzy === 'function') {
      try {
        const res = fuzzy(q, list);
        if (Array.isArray(res)) return res.slice(0, limit).map(str);
      } catch (_) { /* fall through to the local scorer */ }
    }
    const scored = [];
    for (const f of list) {
      const s = scorePath(q, f);
      if (s !== null) scored.push([s, f]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, limit).map((x) => x[1]);
  }

  // Replaces the token at range with text and one trailing space, keeping the
  // rest of the input. Returns { value, caret }.
  function completeToken(valueArg, range, text) {
    const value = str(valueArg);
    const before = value.slice(0, range.start);
    const after = value.slice(range.end).replace(/^ /, '');
    const ins = str(text) + ' ';
    return { value: before + ins + after, caret: before.length + ins.length };
  }

  // ─── controller ────────────────────────────────────────────────────────────

  function mount(tab, opts) {
    const o = opts || {};
    const api = (window.husk && window.husk.chat) || {};
    // The in-renderer reducer folds events without cloning the whole thread
    // across the bridge on every call; the bridge copy is the fallback.
    const ev = window.HuskChatEvents;
    const reduce = ev && typeof ev.reduceThread === 'function' ? ev.reduceThread
      : (typeof api.reduce === 'function' ? api.reduce : (s) => s);
    const emptyThread = () => (ev && typeof ev.emptyThread === 'function' ? ev.emptyThread()
      : typeof api.emptyThread === 'function' ? api.emptyThread() : { items: [], pending: [], turnOpen: false, commands: [] });
    const tabId = tab.id;
    const host = o.host || document.getElementById('terminal');
    let state = emptyThread();
    let queue = [];
    let frame = null;
    let destroyed = false;
    let running = false;
    let starting = false;
    let exited = false;
    // Set by a send or a new permission card: the next paint scrolls to the
    // bottom even when the reader had scrolled up.
    let forceScroll = false;
    let turnStartedAt = 0;
    let agentName = str(o.agentName) || 'the agent';
    let cwd = str(o.cwd);
    const nodes = new Map();

    let infoTitle = str(o.title);
    const pane = el('div', 'chat-pane');
    pane.dataset.sessionId = tabId;
    const scroller = el('div', 'chat-thread');
    const list = el('div', 'chat-thread-inner');
    // Live row at the foot of the thread while the agent works and nothing is
    // streaming yet (claude's thinking deltas arrive empty, so without this
    // the pane sits silent between Enter and the first token).
    const typing = el('div', 'chat-typing');
    typing.setAttribute('role', 'status');
    typing.setAttribute('aria-live', 'polite');
    const typingDots = el('span', 'chat-typing-dots');
    for (let i = 0; i < 3; i++) typingDots.appendChild(el('i'));
    typing.appendChild(typingDots);
    const typingLabel = el('span', 'chat-typing-label', 'Thinking');
    typing.appendChild(typingLabel);
    const empty = el('div', 'chat-empty-hint');
    scroller.appendChild(empty);
    scroller.appendChild(list);
    pane.appendChild(scroller);

    const dock = el('div', 'chat-composer-dock');
    const form = el('form', 'chat-composer');
    const input = el('textarea', 'chat-input');
    input.rows = 1;
    input.spellcheck = false;
    input.setAttribute('autocomplete', 'off');
    const foot = el('div', 'chat-composer-foot');
    const attach = el('button', 'ce-composer-btn chat-attach');
    attach.type = 'button';
    attach.title = 'Attach a file';
    attach.appendChild(icon('attach'));
    attach.appendChild(document.createTextNode('Attach'));
    const meta = el('span', 'chat-composer-meta');
    const send = el('button', 'btn-primary chat-send');
    send.type = 'submit';
    send.title = 'Send (Enter)';
    send.setAttribute('aria-label', 'Send');
    send.appendChild(icon('send'));
    const stop = el('button', 'chat-stop');
    stop.type = 'button';
    stop.title = 'Stop (Esc)';
    stop.setAttribute('aria-label', 'Stop');
    stop.appendChild(icon('stop'));
    stop.hidden = true;
    // Shown in place of Send once the agent has exited, so the way on is the
    // button under the cursor rather than one in the header.
    const restart = el('button', 'btn-primary chat-restart', 'Restart');
    restart.type = 'button';
    restart.title = 'Start a new session with this agent';
    restart.hidden = true;
    foot.appendChild(attach);
    foot.appendChild(meta);
    foot.appendChild(el('span', 'chat-composer-spacer'));
    foot.appendChild(stop);
    foot.appendChild(restart);
    foot.appendChild(send);
    const ac = el('div', 'chat-ac');
    ac.id = 'chat-ac-' + String(tabId).replace(/[^A-Za-z0-9_-]/g, '');
    ac.setAttribute('role', 'listbox');
    ac.hidden = true;
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', ac.id);
    input.setAttribute('aria-expanded', 'false');
    form.appendChild(ac);
    form.appendChild(input);
    form.appendChild(foot);
    // Messages typed while a reply is still streaming wait here, in order, and
    // go out one per turn once the agent is free again.
    // Queued prompts sit in the thread itself, after the last item, as faded
    // user bubbles with a small Queued tag; no separate strip.
    const queueBox = el('div', 'chat-queue');
    queueBox.hidden = true;
    dock.appendChild(form);
    pane.appendChild(dock);
    if (host) host.appendChild(pane);

    // ── composer ──

    // Grows with its content up to about eight lines, then scrolls.
    const MAX_INPUT_PX = 8 * 21 + 16;
    function autogrow() {
      input.style.height = 'auto';
      const h = input.scrollHeight || 0;
      input.style.height = Math.min(h, MAX_INPUT_PX) + 'px';
      input.style.overflowY = h > MAX_INPUT_PX ? 'auto' : 'hidden';
    }

    // Edit and resend: the key of the prompt being replaced, while the field
    // holds its text. Sending cuts the thread from that prompt and sends anew.
    let editingKey = null;
    const editNote = el('div', 'chat-edit-note');
    editNote.hidden = true;
    const editNoteText = el('span', 'chat-edit-note-text', 'Editing an earlier message. Sending replaces it and everything after it.');
    const editCancel = el('button', 'chat-edit-cancel', 'Cancel');
    editCancel.type = 'button';
    editNote.appendChild(editNoteText);
    editNote.appendChild(editCancel);
    form.insertBefore(editNote, form.firstChild);
    function beginEdit(key, text) {
      if (!key) return;
      editingKey = key;
      editNote.hidden = false;
      setInputValue(str(text));
      try { input.focus(); } catch (_) {}
    }
    function cancelEdit(clear) {
      editingKey = null;
      editNote.hidden = true;
      if (clear) setInputValue('');
    }
    editCancel.addEventListener('click', () => cancelEdit(true));
    // Pasted images wait in a strip above the field until the message goes.
    // Each is { mimeType, data (base64), dataUrl } ; the wire gets data, the
    // bubble gets dataUrl.
    let pendingImages = [];
    const attachStrip = el('div', 'chat-attach-strip');
    attachStrip.hidden = true;
    form.insertBefore(attachStrip, input);
    function paintAttachments() {
      attachStrip.replaceChildren();
      pendingImages.forEach((im, i) => {
        const th = el('div', 'chat-attach-thumb');
        const img = document.createElement('img');
        img.src = im.dataUrl; img.alt = 'Pasted image ' + (i + 1);
        th.appendChild(img);
        const x = el('button', 'chat-attach-x', '\u00d7');
        x.type = 'button'; x.title = 'Remove image'; x.setAttribute('aria-label', 'Remove image');
        x.addEventListener('click', () => { pendingImages.splice(i, 1); paintAttachments(); syncComposer(); });
        th.appendChild(x);
        attachStrip.appendChild(th);
      });
      attachStrip.hidden = !pendingImages.length;
    }
    function addImageFile(file) {
      if (!file || !/^image\//.test(file.type)) return false;
      if (file.size > 6 * 1024 * 1024) { apply({ type: 'error', text: 'That image is over 6 MB; paste a smaller one.' }); return true; }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || '');
        const comma = dataUrl.indexOf(',');
        if (comma < 0) return;
        pendingImages.push({ mimeType: file.type, data: dataUrl.slice(comma + 1), dataUrl });
        paintAttachments();
        syncComposer();
      };
      reader.readAsDataURL(file);
      return true;
    }
    function takeImagesFrom(dt) {
      if (!dt) return false;
      let took = false;
      const items = dt.items ? Array.from(dt.items) : [];
      for (const it of items) {
        if (it.kind === 'file' && /^image\//.test(it.type)) { const f = it.getAsFile(); if (f && addImageFile(f)) took = true; }
      }
      if (!took && dt.files) for (const f of Array.from(dt.files)) if (addImageFile(f)) took = true;
      return took;
    }
    input.addEventListener('paste', (e) => {
      // Only an image paste is intercepted; text pastes stay native.
      if (takeImagesFrom(e.clipboardData)) e.preventDefault();
    });
    form.addEventListener('dragover', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) { e.preventDefault(); form.classList.add('is-dropping'); } });
    form.addEventListener('dragleave', () => form.classList.remove('is-dropping'));
    form.addEventListener('drop', (e) => { form.classList.remove('is-dropping'); if (takeImagesFrom(e.dataTransfer)) { e.preventDefault(); e.stopPropagation(); } });

    let queued = [];
    function paintQueue() {
      queueBox.replaceChildren();
      queued.forEach((q, i) => {
        const row = el('div', 'chat-item chat-item-user is-queued');
        const bubble = el('div', 'chat-bubble', q.text || (q.images && q.images.length ? '' : ''));
        if (q.images && q.images.length) bubble.prepend(imageRow(q.images));
        row.appendChild(bubble);
        const tag = el('span', 'chat-queued-tag');
        tag.appendChild(el('span', 'chat-queued-label', 'Queued'));
        const x = el('button', 'chat-queue-x', '\u00d7');
        x.type = 'button';
        x.title = 'Remove from queue';
        x.setAttribute('aria-label', 'Remove from queue');
        x.addEventListener('click', () => { queued.splice(i, 1); paintQueue(); });
        tag.appendChild(x);
        row.appendChild(tag);
        queueBox.appendChild(row);
      });
      queueBox.hidden = !queued.length;
      if (queued.length) { if (queueBox.parentNode !== list) list.appendChild(queueBox); updateTyping(); }
      else if (queueBox.parentNode) queueBox.remove();
      forceScroll = true;
      schedule();
    }
    function flushQueue() {
      if (!queued.length || running || starting || exited || destroyed) return;
      const next = queued.shift();
      paintQueue();
      doSend(next.text, next.images);
    }
    // Prompt history on the arrow keys, shell style: Up from the start of the
    // field walks back through what was sent, Down walks forward and the last
    // step restores whatever was being typed.
    let histIdx = -1;
    let histDraft = '';
    function historyList() {
      const out = [];
      for (const it of (state.items || [])) {
        if (it.kind !== 'user') continue;
        const t = str(it.text);
        if (t && out[out.length - 1] !== t) out.push(t);
      }
      return out;
    }
    function setInputValue(v) {
      input.value = v;
      try { input.setSelectionRange(v.length, v.length); } catch (_) {}
      autogrow();
      syncComposer();
    }
    function historyStep(dir) {
      const list = historyList();
      if (!list.length) return false;
      if (dir < 0) {
        if (histIdx === -1) { histDraft = input.value; histIdx = list.length; }
        if (histIdx === 0) return true;
        histIdx -= 1;
        setInputValue(list[histIdx]);
        return true;
      }
      if (histIdx === -1) return false;
      histIdx += 1;
      if (histIdx >= list.length) { histIdx = -1; setInputValue(histDraft); histDraft = ''; }
      else setInputValue(list[histIdx]);
      return true;
    }

    function syncComposer() {
      const busy = running || starting || exited;
      send.disabled = busy || (!input.value.trim() && !pendingImages.length);
      send.hidden = running || exited;
      stop.hidden = !running;
      restart.hidden = !exited || typeof o.onRestart !== 'function';
      pane.classList.toggle('is-running', running);
      pane.classList.toggle('is-exited', exited);
      input.placeholder = exited ? `${agentName} has exited. Press Restart to start a new session.`
        : starting ? `Starting ${agentName}...`
          : running ? `Message ${agentName}  (Enter queues it for after this reply)`
            : `Message ${agentName}  (Enter to send, Shift+Enter for a new line)`;
    }

    function paintMeta() {
      meta.textContent = '';
      const parts = [agentName];
      if (cwd) parts.push(basename(cwd));
      const modes = state.modes;
      if (modes && modes.current) {
        const found = Array.isArray(modes.available) ? modes.available.find((m) => m && m.id === modes.current) : null;
        parts.push(str(found && found.name ? found.name : modes.current));
      }
      parts.forEach((p, k) => {
        meta.appendChild(el('span', 'chat-chip' + (k === 1 && cwd ? ' chat-composer-cwd' : ''), p));
      });
      // The model chip opens the picker (ACP lists come from the agent, claude's
      // from Husk's catalog). Shown even before a model is known, as 'Model'.
      const mb = el('button', 'chat-chip chat-model-btn', state.model ? str(state.model) : 'Model');
      mb.type = 'button';
      mb.title = 'Switch model';
      mb.setAttribute('aria-haspopup', 'menu');
      mb.addEventListener('click', (ev) => { ev.stopPropagation(); toggleModelMenu(); });
      meta.appendChild(mb);
      // Context window fill, only from agents that report it.
      const ctx = usageLabel(state.usage);
      if (ctx) {
        const u = el('span', 'chat-chip chat-composer-usage', ctx.text);
        u.title = ctx.title;
        meta.appendChild(u);
      }
      if (cwd) meta.title = cwd;
      empty.textContent = '';
      empty.appendChild(el('div', 'chat-empty-title', `Talking to ${agentName}`));
      if (cwd) empty.appendChild(el('div', 'chat-empty-sub', `in ${basename(cwd)}`));
    }

    // ── model picker ──
    const modelMenu = el('div', 'chat-model-menu');
    modelMenu.setAttribute('role', 'menu');
    modelMenu.hidden = true;
    dock.appendChild(modelMenu);
    let modelMenuOpen = false;
    async function modelChoices() {
      const live = state.models && Array.isArray(state.models.available) ? state.models.available : [];
      // An agent that names only one model (copilot says just 'auto') gets the
      // CLI's own /model list merged in.
      if (live.length === 1) {
        try {
          const r = await window.husk.models.list({ command: o.agentCommand || agentName });
          const more = (r && Array.isArray(r.models) ? r.models : []).map((m) => ({ id: str(m.value), name: str(m.label || m.value), desc: '' })).filter((m) => m.id && m.id !== live[0].id);
          if (more.length) return { rows: [{ id: live[0].id, name: live[0].name || live[0].id, desc: live[0].description || '' }].concat(more), current: state.models.current, sourceLabel: `Listed by ${agentName}` };
        } catch (_) {}
      }
      if (live.length) return { rows: live.map((m) => ({ id: m.id, name: m.name || m.id, desc: m.description || '' })), current: state.models.current, sourceLabel: `Listed by ${agentName}` };
      // claude (and anything else without a live list): Husk's catalog for the CLI.
      try {
        const r = await window.husk.models.list({ command: o.agentCommand || agentName });
        const rows = (r && Array.isArray(r.models) ? r.models : []).map((m) => ({ id: str(m.value), name: str(m.label || m.value), desc: '' })).filter((m) => m.id);
        return { rows, current: null, sourceLabel: r && r.sourceLabel ? str(r.sourceLabel) : '' };
      } catch (_) { return { rows: [], current: null, sourceLabel: '' }; }
    }
    async function openModelMenu() {
      modelMenu.replaceChildren(el('div', 'chat-model-note', 'Loading models...'));
      modelMenu.hidden = false;
      modelMenuOpen = true;
      const { rows, current, sourceLabel } = await modelChoices();
      if (!modelMenuOpen) return;
      modelMenu.replaceChildren();
      const head = el('div', 'chat-model-head', 'Model');
      if (sourceLabel) head.appendChild(el('span', 'chat-model-source', sourceLabel));
      modelMenu.appendChild(head);
      if (!rows.length) modelMenu.appendChild(el('div', 'chat-model-note', `No model list for ${agentName} yet.`));
      for (const m of rows) {
        const b = el('button', 'chat-model-item' + ((current && m.id === current) || (!current && state.model && (m.name === state.model || m.id === state.model)) ? ' is-current' : ''));
        b.type = 'button';
        b.setAttribute('role', 'menuitemradio');
        b.dataset.model = m.id;
        b.appendChild(el('span', 'chat-model-name', m.name));
        if (m.id !== m.name) b.appendChild(el('span', 'chat-model-id', m.id));
        if (m.desc) b.appendChild(el('span', 'chat-model-desc', m.desc));
        b.addEventListener('click', () => { closeModelMenu(); chooseModel(m.id, m.name); });
        modelMenu.appendChild(b);
      }
      // Any id the CLI accepts, for a model newer than every list here.
      const custom = el('form', 'chat-model-custom');
      const ci = el('input', 'chat-model-custom-input');
      ci.type = 'text'; ci.placeholder = 'Other model id...'; ci.spellcheck = false; ci.setAttribute('aria-label', 'Other model id');
      const cb = el('button', 'chat-model-custom-go', 'Use');
      cb.type = 'submit';
      custom.appendChild(ci); custom.appendChild(cb);
      custom.addEventListener('submit', (ev) => { ev.preventDefault(); const v = ci.value.trim(); if (!v) return; closeModelMenu(); chooseModel(v, v); });
      custom.addEventListener('click', (ev) => ev.stopPropagation());
      modelMenu.appendChild(custom);
    }
    function closeModelMenu() { modelMenuOpen = false; modelMenu.hidden = true; }
    function toggleModelMenu() { if (modelMenuOpen) closeModelMenu(); else openModelMenu(); }
    document.addEventListener('click', (ev) => { if (modelMenuOpen && !modelMenu.contains(ev.target)) closeModelMenu(); });
    async function chooseModel(modelId, modelName) {
      if (!modelId) return;
      if (running) { apply({ type: 'status', text: 'Wait for the current reply to finish, then switch the model.' }); return; }
      let res = null;
      try { res = await api.setModel({ tabId, modelId, modelName }); } catch (err) { res = { ok: false, error: (err && err.message) || 'switch failed' }; }
      if (!res || !res.ok) { apply({ type: 'error', text: `Could not switch model: ${(res && res.error) || 'no reason given'}` }); return; }
      apply({ type: 'status', text: `Model set to ${modelName || modelId}${res.restarted ? ' (session resumed under the new model)' : ''}` });
      if (typeof o.onModelChange === 'function') { try { o.onModelChange(modelId, modelName); } catch (_) {} }
    }

    function doSend(textArg, imagesArg) {
      const text = str(textArg === undefined ? input.value : textArg).replace(/\s+$/, '').replace(/^\s*\n/, '');
      const images = imagesArg !== undefined ? (imagesArg || []) : (textArg === undefined ? pendingImages.slice() : []);
      if ((!text.trim() && !images.length) || exited || destroyed) return false;
      // /model is Husk's own: the CLI's TUI command does nothing over the wire.
      const mm = /^\/model(?:\s+(\S+))?\s*$/.exec(text);
      if (mm && textArg === undefined) {
        input.value = ''; autogrow(); closeAc(); syncComposer();
        if (mm[1]) chooseModel(mm[1], mm[1]); else openModelMenu();
        return true;
      }
      histIdx = -1;
      if (editingKey && textArg === undefined) {
        // The edited prompt and its reply leave the thread before the new one lands.
        const key = editingKey;
        cancelEdit(false);
        drain();
        state = api.reduce(state, { type: 'truncate', key }) || state;
        nodes.forEach((n, k) => { if (!state.items.some((it) => it.key === k)) { try { n.el.remove(); } catch (_) {} nodes.delete(k); } });
        paint();
      }
      if (running || starting) {
        queued.push({ text, images });
        if (textArg === undefined) { input.value = ''; autogrow(); closeAc(); pendingImages = []; paintAttachments(); }
        paintQueue();
        return true;
      }
      if (textArg === undefined) { input.value = ''; autogrow(); closeAc(); pendingImages = []; paintAttachments(); }
      apply({ type: 'user', text, images: images.map((im) => ({ mimeType: im.mimeType, data: im.dataUrl })) });
      forceScroll = true;
      // Running flips now rather than on the next frame, so a second Enter in
      // the same frame cannot send twice.
      setRunningInternal(true);
      if (typeof o.onSend === 'function') { try { o.onSend(text); } catch (_) {} }
      Promise.resolve()
        .then(() => api.prompt({ tabId, text, images: images.map((im) => ({ mimeType: im.mimeType, data: im.data })) }))
        .then((res) => { if (res && res.ok === false) apply({ type: 'error', text: res.error || 'The agent did not take that message.' }); })
        .catch((err) => apply({ type: 'error', text: (err && err.message) || 'The agent did not take that message.' }));
      syncComposer();
      return true;
    }

    function doStop() {
      if (!running) return;
      Promise.resolve().then(() => api.cancel({ tabId })).catch(() => {});
    }

    // ── autocomplete ──
    // One popover above the field serves two triggers: "/" lists the agent's
    // advertised commands, "@" lists files under the chat's working folder.
    let acRows = [];       // [{ insert, name, desc }]
    let acIndex = 0;
    let acRange = null;
    let acKind = null;
    let acDismissed = false;
    let fileIndex = null;  // relative paths, or null until loaded
    let fileIndexStale = true;
    let fileIndexLoading = null;
    let fileIndexFor = '';

    function closeAc() {
      acRows = [];
      acRange = null;
      acKind = null;
      ac.hidden = true;
      ac.replaceChildren();
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }

    function loadFileIndex() {
      if (fileIndexLoading) return;
      const root = cwd;
      const fs = window.husk && window.husk.fs;
      if (!root || !fs || typeof fs.indexFiles !== 'function') return;
      fileIndexLoading = Promise.resolve()
        .then(() => fs.indexFiles(root, false))
        .then((res) => {
          if (destroyed || root !== cwd) return;
          fileIndex = res && res.ok && Array.isArray(res.files) ? res.files.map(str) : [];
          fileIndexFor = root;
          fileIndexStale = false;
        })
        .catch(() => { if (root === cwd) { fileIndex = []; fileIndexFor = root; fileIndexStale = false; } })
        .then(() => { fileIndexLoading = null; if (!destroyed && document.activeElement === input) updateAc(); });
    }

    function paintAc() {
      ac.replaceChildren();
      acRows.forEach((r, k) => {
        const row = el('div', 'chat-ac-row' + (k === acIndex ? ' is-active' : ''));
        row.id = ac.id + '-' + k;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', k === acIndex ? 'true' : 'false');
        row.dataset.value = r.insert;
        row.title = r.title || r.insert;
        row.appendChild(el('span', 'chat-ac-name', r.name));
        if (r.desc) row.appendChild(el('span', 'chat-ac-desc', r.desc));
        // mousedown, not click: the field keeps focus and the caret.
        row.addEventListener('mousedown', (e) => { e.preventDefault(); acIndex = k; acceptAc(); });
        row.addEventListener('mousemove', () => {
          if (acIndex === k) return;
          acIndex = k;
          for (const n of ac.children) n.classList.toggle('is-active', n === row);
          for (const n of ac.children) n.setAttribute('aria-selected', n === row ? 'true' : 'false');
          input.setAttribute('aria-activedescendant', row.id);
        });
        ac.appendChild(row);
      });
      ac.hidden = !acRows.length;
      input.setAttribute('aria-expanded', acRows.length ? 'true' : 'false');
      if (acRows.length) {
        input.setAttribute('aria-activedescendant', ac.id + '-' + acIndex);
        const active = ac.children[acIndex];
        if (active && typeof active.scrollIntoView === 'function') { try { active.scrollIntoView({ block: 'nearest' }); } catch (_) {} }
      } else input.removeAttribute('aria-activedescendant');
    }

    function updateAc() {
      if (destroyed || acDismissed) { closeAc(); return; }
      const value = input.value;
      const caret = input.selectionStart === input.selectionEnd ? input.selectionStart : null;
      if (caret === null) { closeAc(); return; }
      const slash = slashContext(value, caret);
      const mention = slash ? null : mentionContext(value, caret);
      let rows = [];
      let kind = null;
      let range = null;
      if (slash && Array.isArray(state.commands) && state.commands.length) {
        kind = 'slash';
        range = slash;
        rows = matchCommands(state.commands, slash.query, AC_MAX_COMMANDS).map((c) => ({ insert: '/' + c.name, name: '/' + c.name, desc: c.description }));
      } else if (mention && cwd) {
        if (fileIndex === null || fileIndexStale || fileIndexFor !== cwd) loadFileIndex();
        if (fileIndex && fileIndexFor === cwd) {
          kind = 'mention';
          range = mention;
          const text = window.husk && window.husk.text;
          const fuzzy = text && typeof text.fuzzyFilter === 'function' ? (q, items) => text.fuzzyFilter(q, items) : null;
          rows = matchFiles(fileIndex, mention.query, AC_MAX_FILES, fuzzy).map((p) => {
            const cut = p.lastIndexOf('/');
            return { insert: '@' + p, title: p, name: cut === -1 ? p : p.slice(cut + 1), desc: cut === -1 ? '' : p.slice(0, cut) };
          });
        }
      }
      if (!rows.length) { closeAc(); return; }
      if (kind !== acKind || !acRange || range.start !== acRange.start) acIndex = 0;
      acIndex = Math.min(acIndex, rows.length - 1);
      acKind = kind;
      acRange = range;
      acRows = rows;
      paintAc();
    }

    function acceptAc() {
      const r = acRows[acIndex];
      if (!r || !acRange) { closeAc(); return; }
      const next = completeToken(input.value, acRange, r.insert);
      input.value = next.value;
      try { input.setSelectionRange(next.caret, next.caret); } catch (_) {}
      closeAc();
      autogrow();
      syncComposer();
    }

    function moveAc(step) {
      if (!acRows.length) return;
      acIndex = (acIndex + step + acRows.length) % acRows.length;
      paintAc();
      // The list scrolls; the active row follows the keys.
      const active = ac.querySelector('.chat-ac-row.is-active');
      if (active && typeof active.scrollIntoView === 'function') active.scrollIntoView({ block: 'nearest' });
    }

    form.addEventListener('submit', (e) => { e.preventDefault(); if (!acRows.length) doSend(); });
    input.addEventListener('input', () => { acDismissed = false; histIdx = -1; autogrow(); syncComposer(); updateAc(); });
    // Alt+Backspace deletes the word before the caret and Alt+Delete the one
    // after, the readline chords; Chromium only binds Ctrl for these. Done as
    // a selection plus the native delete so undo still works.
    function deleteWord(back) {
      const v = input.value;
      let a = input.selectionStart;
      let b = input.selectionEnd;
      if (a !== b) { input.setSelectionRange(a, b); }
      else if (back) {
        let i = a;
        while (i > 0 && /\s/.test(v[i - 1])) i--;
        while (i > 0 && !/\s/.test(v[i - 1])) i--;
        if (i === a) return false;
        input.setSelectionRange(i, a);
      } else {
        let i = b;
        while (i < v.length && /\s/.test(v[i])) i++;
        while (i < v.length && !/\s/.test(v[i])) i++;
        if (i === b) return false;
        input.setSelectionRange(b, i);
      }
      let did = false;
      try { did = document.execCommand('delete'); } catch (_) { did = false; }
      if (!did) { const s = input.selectionStart, e2 = input.selectionEnd; input.setRangeText('', s, e2, 'end'); }
      autogrow(); syncComposer(); updateAc();
      return true;
    }
    input.addEventListener('keydown', (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'Backspace' || e.key === 'Delete')) {
        if (deleteWord(e.key === 'Backspace')) { e.preventDefault(); return; }
      }
      if (acRows.length && !e.isComposing) {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveAc(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); moveAc(-1); return; }
        if ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'Tab' && !e.shiftKey)) { e.preventDefault(); acceptAc(); return; }
        if (e.key === 'Escape') { e.preventDefault(); acDismissed = true; closeAc(); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); doSend(); return; }
      if (e.key === 'Escape' && editingKey) { e.preventDefault(); cancelEdit(true); return; }
      if (e.key === 'Escape' && running) { e.preventDefault(); doStop(); return; }
      if (!e.isComposing && !e.altKey && !e.ctrlKey && !e.metaKey) {
        const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
        const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
        // Once a recall has started, the arrows keep walking the list wherever
        // the caret is, as a shell does; the first Up needs the caret at the start
        // so it never hijacks a multi-line draft.
        const walking = histIdx !== -1;
        // A queued message comes back first: Up on an empty field pulls the
        // most recent one into the field and out of the queue, so it can be
        // edited and re-sent, or deleted and never sent.
        if (e.key === 'ArrowUp' && !walking && !input.value && queued.length) {
          e.preventDefault();
          const q = queued.pop();
          paintQueue();
          pendingImages = (q.images || []).slice();
          paintAttachments();
          setInputValue(q.text || '');
          return;
        }
        if (e.key === 'ArrowUp' && (walking || atStart || !input.value) && historyStep(-1)) { e.preventDefault(); return; }
        if (e.key === 'ArrowDown' && walking && historyStep(1)) { e.preventDefault(); }
      }
    });
    input.addEventListener('keyup', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') updateAc();
    });
    input.addEventListener('click', updateAc);
    input.addEventListener('blur', closeAc);
    stop.addEventListener('click', doStop);
    restart.addEventListener('click', () => { if (typeof o.onRestart === 'function') o.onRestart(); });
    attach.addEventListener('click', () => { if (typeof o.onAttach === 'function') o.onAttach(); });

    // ── items ──

    // Thumbnails inside a bubble: live sends carry a data URL, a replayed log
    // only the kind, which shows as a labelled tile.
    function imageRow(images) {
      const wrap = el('div', 'chat-bubble-images');
      for (const im of images) {
        if (im && im.dataUrl) { const img = document.createElement('img'); img.src = im.dataUrl; img.alt = 'Attached image'; wrap.appendChild(img); }
        else if (im && typeof im.data === 'string' && im.data.startsWith('data:')) { const img = document.createElement('img'); img.src = im.data; img.alt = 'Attached image'; wrap.appendChild(img); }
        else wrap.appendChild(el('span', 'chat-bubble-image-tile', str(im && im.mimeType ? im.mimeType.replace('image/', '') : 'image')));
      }
      return wrap;
    }
    function buildUser(it) {
      const row = el('div', 'chat-item chat-item-user');
      const bubble = el('div', 'chat-bubble', it.text);
      if (Array.isArray(it.images) && it.images.length) bubble.prepend(imageRow(it.images));
      row.appendChild(bubble);
      return { el: row, update() {} };
    }

    function buildText() {
      const row = el('div', 'chat-item chat-item-text cmd');
      return {
        el: row,
        update(it) {
          row.replaceChildren(md(it.text));
          row.classList.toggle('is-streaming', !!it.open);
        },
      };
    }

    function buildThought() {
      const row = el('div', 'chat-item chat-item-thought');
      const head = el('button', 'chat-thought-head');
      head.type = 'button';
      head.setAttribute('aria-expanded', 'false');
      const label = el('span', 'chat-thought-label', 'Thinking');
      head.appendChild(label);
      head.appendChild(icon('chevron', 'chat-chev'));
      const body = el('div', 'chat-thought-body cmd');
      body.hidden = true;
      row.appendChild(head);
      row.appendChild(body);
      let last = null;
      let dirty = true;
      const paintBody = () => { if (last && dirty) { body.replaceChildren(md(last.text)); dirty = false; } };
      head.addEventListener('click', () => {
        body.hidden = !body.hidden;
        head.setAttribute('aria-expanded', String(!body.hidden));
        row.classList.toggle('is-expanded', !body.hidden);
        if (!body.hidden) paintBody();
      });
      return {
        el: row,
        update(it) {
          last = it;
          dirty = true;
          row.classList.toggle('is-live', !!it.open);
          label.textContent = it.open ? 'Thinking' : 'Thought';
          if (!body.hidden) paintBody();
        },
      };
    }

    // The label a bare string input goes under, by what the tool does.
    function inputKey(kind) {
      if (kind === 'execute') return 'command';
      if (kind === 'edit') return 'patch';
      if (kind === 'read') return 'path';
      if (kind === 'fetch') return 'url';
      return 'input';
    }

    function kvBlock(pairs) {
      const box = el('div', 'chat-kv');
      for (const [k, v] of pairs) {
        const row = el('div', 'chat-kv-row');
        row.appendChild(el('div', 'chat-kv-key', k));
        row.appendChild(el('pre', 'chat-kv-val chat-tool-pre', cap(v)));
        box.appendChild(row);
      }
      return box;
    }

    function rawJson(v) {
      if (v === undefined) return '';
      try { return JSON.stringify(v, null, 2); } catch (_) { return str(v); }
    }

    const TOOL_VERB = { running: 'Running:', done: 'Ran:', error: 'Failed:' };
    const TOOL_PILL = { running: 'Running', waiting: 'Waiting for approval', done: 'Done', error: 'Failed' };

    // A tool call is one light line: a status glyph, a verb and what it ran.
    // Pressing the line opens it in place into a card that shows the call two
    // ways (Formatted or Raw) from either end (Input or Output).
    function buildTool() {
      const item = el('div', 'chat-item chat-tool');
      const created = new Date();
      item.dataset.time = clock(created);
      const head = el('button', 'chat-tool-head');
      head.type = 'button';
      head.setAttribute('aria-expanded', 'false');
      const glyph = el('span', 'chat-tool-glyph');
      const text = el('span', 'chat-tool-text');
      const verb = el('span', 'chat-tool-verb');
      const title = el('span', 'chat-tool-title');
      const detail = el('span', 'chat-tool-detail');
      text.appendChild(verb);
      text.appendChild(title);
      text.appendChild(detail);
      head.appendChild(glyph);
      head.appendChild(text);
      const diffs = el('div', 'chat-tool-diffs');
      diffs.hidden = true;

      const card = el('div', 'chat-tool-card');
      card.hidden = true;
      const bar = el('div', 'chat-tool-bar');
      const timePill = el('span', 'chat-pill chat-pill-time', item.dataset.time);
      timePill.title = created.toLocaleString();
      const statusPill = el('span', 'chat-pill chat-pill-status');
      bar.appendChild(timePill);
      bar.appendChild(statusPill);
      bar.appendChild(el('span', 'chat-tool-bar-gap'));
      const toggle = (pairs, key) => {
        const g = el('div', 'chat-tg');
        g.setAttribute('role', 'group');
        const btns = {};
        for (const [value, label] of pairs) {
          const b = el('button', 'chat-tg-btn', label);
          b.type = 'button';
          b.dataset[key] = value;
          btns[value] = b;
          g.appendChild(b);
        }
        return { g, btns };
      };
      const viewTg = toggle([['formatted', 'Formatted'], ['raw', 'Raw']], 'view');
      const sideTg = toggle([['input', 'Input'], ['output', 'Output']], 'side');
      viewTg.g.setAttribute('aria-label', 'How the call is shown');
      sideTg.g.setAttribute('aria-label', 'Which end of the call is shown');
      bar.appendChild(viewTg.g);
      bar.appendChild(sideTg.g);
      const body = el('div', 'chat-tool-body');
      card.appendChild(bar);
      card.appendChild(body);
      item.appendChild(head);
      item.appendChild(card);
      item.appendChild(diffs);

      let last = null;
      let lastWaiting = false;
      let dirty = true;
      let diffSig = '';
      let view = 'formatted';
      let side = 'input';
      // Until the reader picks a side, the card opens on whichever side has
      // content: ACP agents often send no rawInput and put everything in output.
      let sidePicked = false;
      const hasOutput = () => !!(last && (str(last.output) || (Array.isArray(last.diffs) && last.diffs.length)));
      const hasInput = () => !!(last && last.input !== undefined && last.input !== null && str(prettyInput(last.input)).trim());

      const syncToggles = () => {
        for (const [v, b] of Object.entries(viewTg.btns)) { b.classList.toggle('is-on', v === view); b.setAttribute('aria-pressed', String(v === view)); }
        for (const [v, b] of Object.entries(sideTg.btns)) { b.classList.toggle('is-on', v === side); b.setAttribute('aria-pressed', String(v === side)); }
        sideTg.btns.output.disabled = !hasOutput();
      };

      const paintBody = () => {
        if (!last || !dirty) return;
        dirty = false;
        if (!sidePicked) { side = (!hasInput() && hasOutput()) ? 'output' : 'input'; syncToggles(); }
        body.replaceChildren();
        const ds = Array.isArray(last.diffs) ? last.diffs : [];
        if (side === 'input') {
          const inp = last.input;
          if (view === 'raw') {
            const raw = rawJson(inp);
            body.appendChild(raw ? el('pre', 'chat-tool-pre chat-tool-raw', cap(raw)) : el('div', 'chat-tool-none', 'No input'));
          } else {
            const pairs = [];
            if (typeof inp === 'string') { if (inp) pairs.push([inputKey(last.toolKind), inp]); }
            else if (inp && typeof inp === 'object') {
              for (const k of Object.keys(inp)) {
                const v = inp[k];
                pairs.push([k, typeof v === 'string' ? v : rawJson(v)]);
              }
            } else if (inp !== undefined && inp !== null) pairs.push([inputKey(last.toolKind), str(inp)]);
            if (Array.isArray(last.locations) && last.locations.length > 1) pairs.push(['files', last.locations.join('\n')]);
            body.appendChild(pairs.length ? kvBlock(pairs) : el('div', 'chat-tool-none', 'No input'));
          }
        } else if (view === 'raw') {
          const out = str(last.output);
          const raw = out || (ds.length ? rawJson(ds) : '');
          body.appendChild(raw ? el('pre', 'chat-tool-pre chat-tool-raw' + (last.status === 'error' ? ' is-error' : ''), cap(raw)) : el('div', 'chat-tool-none', 'No output'));
        } else {
          for (const d of ds) body.appendChild(renderDiff(d));
          if (str(last.output)) body.appendChild(kvBlock([[last.status === 'error' ? 'error' : 'output', last.output]]));
          if (last.status === 'error') for (const v of body.querySelectorAll('.chat-kv-val')) v.classList.add('is-error');
          if (!body.firstChild) body.appendChild(el('div', 'chat-tool-none', last.status === 'running' ? 'Running...' : 'No output'));
        }
      };

      const paintDiffs = () => {
        const ds = Array.isArray(last && last.diffs) ? last.diffs : [];
        // Open, the card shows the diffs under Output, so the preview steps aside.
        if (!card.hidden) { if (diffSig) { diffs.replaceChildren(); diffSig = ''; } diffs.hidden = true; return; }
        const nextSig = ds.map((d) => str(d.path) + ':' + str(d.newText).length + ':' + (d.oldText === null || d.oldText === undefined ? -1 : str(d.oldText).length)).join('|');
        if (nextSig !== diffSig) {
          diffSig = nextSig;
          diffs.replaceChildren(...ds.map(renderDiff));
        }
        diffs.hidden = !ds.length;
      };

      head.addEventListener('click', () => {
        card.hidden = !card.hidden;
        head.setAttribute('aria-expanded', String(!card.hidden));
        item.classList.toggle('is-expanded', !card.hidden);
        dirty = true;
        syncToggles();
        paintDiffs();
        if (!card.hidden) paintBody();
      });
      const onToggle = (e) => {
        const b = e.target.closest('.chat-tg-btn');
        if (!b || b.disabled) return;
        if (b.dataset.view) view = b.dataset.view;
        if (b.dataset.side) { side = b.dataset.side; sidePicked = true; }
        dirty = true;
        syncToggles();
        paintBody();
      };
      viewTg.g.addEventListener('click', onToggle);
      sideTg.g.addEventListener('click', onToggle);

      return {
        el: item,
        update(it, pending, waiting) {
          last = it;
          dirty = true;
          const status = it.status === 'done' || it.status === 'error' ? it.status : 'running';
          const isWaiting = status === 'running' && !!(waiting && waiting.has(it.id));
          item.dataset.status = it.status || 'running';
          if (isWaiting) item.dataset.waiting = '1'; else delete item.dataset.waiting;
          if (isWaiting !== lastWaiting || !glyph.firstChild || glyph.dataset.state !== (isWaiting ? 'waiting' : status)) {
            lastWaiting = isWaiting;
            glyph.dataset.state = isWaiting ? 'waiting' : status;
            glyph.replaceChildren(status === 'running' && !isWaiting ? el('span', 'chat-spin')
              : icon(isWaiting ? 'lock' : status === 'done' ? 'check' : 'cross'));
          }
          verb.textContent = TOOL_VERB[status];
          title.textContent = str(it.title) || 'Tool';
          detail.textContent = str(it.detail);
          head.title = [str(it.title), str(it.detail)].filter(Boolean).join('  ');
          const pillKey = isWaiting ? 'waiting' : status;
          statusPill.textContent = TOOL_PILL[pillKey];
          statusPill.dataset.state = pillKey;
          syncToggles();
          paintDiffs();
          if (!card.hidden) paintBody();
        },
      };
    }

    function decisionLabel(it) {
      const opt = (it.options || []).find((x) => x && x.optionId === it.decision);
      const kind = str(opt && opt.kind);
      if (kind === 'allow_always') return 'Always allowed';
      if (kind.startsWith('allow')) return 'Allowed';
      if (kind === 'reject_always') return 'Always denied';
      if (kind.startsWith('reject')) return 'Denied';
      return opt ? str(opt.name) : 'Dismissed';
    }

    function buildPermission() {
      const card = el('div', 'chat-item chat-perm');
      const created = clock(new Date());
      let wired = false;
      return {
        el: card,
        update(it, pending) {
          card.replaceChildren();
          const live = !it.decision && pending.indexOf(it.requestId) !== -1;
          card.classList.toggle('is-resolved', !live);
          if (!live) {
            const line = el('div', 'chat-perm-line');
            line.appendChild(icon('shield', 'chat-perm-icon'));
            line.appendChild(el('span', 'chat-perm-tool', str(it.title)));
            if (it.detail) line.appendChild(el('span', 'chat-perm-detail-inline', str(it.detail)));
            const verdict = it.decision ? decisionLabel(it) : 'No longer needed';
            const v = el('span', 'chat-perm-verdict', verdict);
            v.dataset.verdict = /allow/i.test(verdict) ? 'allow' : it.decision ? 'deny' : 'none';
            line.appendChild(v);
            card.appendChild(line);
            return;
          }
          const head = el('div', 'chat-perm-head');
          head.appendChild(el('span', 'chat-pill chat-pill-time', created));
          const pill = el('span', 'chat-pill chat-pill-status', 'Waiting for approval');
          pill.dataset.state = 'waiting';
          head.appendChild(pill);
          card.appendChild(head);
          card.appendChild(el('div', 'chat-perm-title', str(it.title)));
          const detail = str(it.detail) || prettyInput(it.input);
          if (detail) card.appendChild(el('pre', 'chat-perm-detail', cap(detail)));
          const actions = el('div', 'chat-perm-actions');
          const opts = Array.isArray(it.options) && it.options.length ? it.options
            : [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }];
          for (const opt of opts) {
            const kind = str(opt.kind);
            const b = el('button', kind.startsWith('allow') ? 'btn-primary chat-perm-btn' : 'ghost-btn chat-perm-btn', str(opt.name) || str(opt.optionId));
            b.type = 'button';
            b.addEventListener('click', () => {
              for (const other of actions.querySelectorAll('button')) other.disabled = true;
              const requestId = it.requestId;
              const optionId = opt.optionId;
              Promise.resolve()
                .then(() => api.permission({ tabId, requestId, optionId }))
                .then((res) => { if (res && res.ok === false) apply({ type: 'error', text: res.error || 'The decision did not reach the agent.' }); })
                .catch((err) => apply({ type: 'error', text: (err && err.message) || 'The decision did not reach the agent.' }));
              apply({ type: 'permission_resolved', requestId, optionId });
            });
            actions.appendChild(b);
          }
          card.appendChild(actions);
          if (!wired) { wired = true; forceScroll = true; }
        },
      };
    }

    const PLAN_MARK = { completed: '✓', in_progress: '◐', pending: '○' };
    function buildPlan() {
      const card = el('div', 'chat-item chat-plan');
      return {
        el: card,
        update(it) {
          card.replaceChildren();
          const entries = Array.isArray(it.entries) ? it.entries : [];
          const done = entries.filter((e) => e && e.status === 'completed').length;
          const head = el('div', 'chat-plan-head');
          head.appendChild(icon('plan', 'chat-plan-icon'));
          head.appendChild(el('span', 'chat-plan-title', 'Plan'));
          head.appendChild(el('span', 'chat-plan-count', `${done} of ${entries.length} done`));
          card.appendChild(head);
          const ul = el('ul', 'chat-plan-list');
          for (const e of entries) {
            const status = str(e && e.status) || 'pending';
            const li = el('li', 'chat-plan-entry');
            li.dataset.status = status;
            li.appendChild(el('span', 'chat-plan-mark', PLAN_MARK[status] || PLAN_MARK.pending));
            li.appendChild(el('span', 'chat-plan-text', str(e && e.content)));
            ul.appendChild(li);
          }
          card.appendChild(ul);
        },
      };
    }

    // The turn a footer closes: the user message that opened it and every
    // reply block since, read from the live state when an action is pressed.
    function turnOf(key) {
      const items = Array.isArray(state.items) ? state.items : [];
      const at = items.findIndex((x) => x && x.key === key);
      if (at === -1) return { prompt: '', reply: '' };
      let k = at - 1;
      const parts = [];
      while (k >= 0 && items[k] && items[k].kind !== 'user') {
        if (items[k].kind === 'text') parts.unshift(str(items[k].text));
        k--;
      }
      return { prompt: k >= 0 && items[k] ? str(items[k].text) : '', promptKey: k >= 0 && items[k] ? items[k].key : null, reply: parts.join('\n\n').trim() };
    }

    function actionBtn(name, label, cls, onClick) {
      const b = el('button', 'chat-act ' + cls);
      b.type = 'button';
      b.title = label;
      b.setAttribute('aria-label', label);
      b.appendChild(icon(name));
      b.addEventListener('click', onClick);
      return b;
    }

    function buildMeta(first) {
      const row = el('div', 'chat-item chat-meta');
      const key = first && first.key;
      return {
        el: row,
        update(it) {
          row.replaceChildren();
          row.classList.toggle('is-error', !!it.isError);
          if (it.stopReason !== undefined) {
            const parts = [];
            const reason = str(it.stopReason);
            const head = it.isError ? 'Failed' : (reason === 'cancelled' ? 'Stopped' : (reason === 'max_tokens' ? 'Cut off at the token limit' : 'Done'));
            const dur = fmtDuration(it.durationMs);
            parts.push(dur ? `${head} in ${dur}` : head);
            const cost = fmtCost(it.costUsd);
            if (cost) parts.push(cost);
            const acts = el('div', 'chat-turn-actions');
            acts.appendChild(actionBtn('copy', 'Copy response', 'chat-act-copy', (e) => {
              const b = e.currentTarget;
              const text = turnOf(key).reply;
              Promise.resolve()
                .then(() => navigator.clipboard.writeText(text))
                .then(() => { b.classList.add('is-done'); setTimeout(() => b.classList.remove('is-done'), 1200); })
                .catch(() => {});
            }));
            acts.appendChild(actionBtn('rerun', 'Edit and resend this prompt', 'chat-act-rerun', () => {
              const t = turnOf(key);
              if (!t.prompt || !t.promptKey) return;
              beginEdit(t.promptKey, t.prompt);
              try { input.setSelectionRange(t.prompt.length, t.prompt.length); } catch (_) {}
            }));
            if (typeof o.onOpenTerminal === 'function') {
            }
            acts.appendChild(el('span', 'chat-meta-line', parts.join(' · ')));
            row.appendChild(acts);
            if (it.isError && it.text) row.appendChild(el('div', 'chat-meta-error', str(it.text)));
            return;
          }
          row.appendChild(el('span', it.isError ? 'chat-meta-error' : 'chat-meta-line', str(it.text)));
        },
      };
    }

    const BUILDERS = { user: buildUser, text: buildText, thought: buildThought, tool: buildTool, permission: buildPermission, plan: buildPlan, meta: buildMeta };

    // ── paint ──

    function nearBottom() {
      return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= NEAR_BOTTOM_PX;
    }
    // Pinned to the bottom until the reader scrolls up. A thread replayed into a
    // hidden pane has no height yet, so the pin is kept and honoured the moment
    // the pane (or a late image) gives it one.
    let pinned = true;
    let pinning = false;
    function toBottom() { pinning = true; scroller.scrollTop = scroller.scrollHeight; requestAnimationFrame(() => { pinning = false; }); }
    scroller.addEventListener('scroll', () => { if (!pinning && scroller.clientHeight > 0) pinned = nearBottom(); });
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => { if (pinned && scroller.clientHeight > 0) toBottom(); });
      ro.observe(scroller);
      ro.observe(list);
    }

    function paint() {
      if (destroyed) return;
      const stick = forceScroll || pinned;
      if (forceScroll) pinned = true;
      forceScroll = false;
      const items = Array.isArray(state.items) ? state.items : [];
      const pending = Array.isArray(state.pending) ? state.pending : [];
      // Tool calls held on a live permission card read as waiting for approval.
      const waiting = new Set();
      for (const it of items) {
        if (it && it.kind === 'permission' && it.toolCallId && !it.decision && pending.indexOf(it.requestId) !== -1) waiting.add(it.toolCallId);
      }
      for (const it of items) {
        if (!it || !it.key) continue;
        let n = nodes.get(it.key);
        const sig = sigOf(it, pending, waiting);
        if (!n) {
          const build = BUILDERS[it.kind] || BUILDERS.meta;
          n = build(it);
          n.sig = null;
          nodes.set(it.key, n);
          list.appendChild(n.el);
        }
        if (n.sig !== sig) {
          n.sig = sig;
          try { n.update(it, pending, waiting); } catch (err) { n.el.textContent = str(it.text) || ''; }
        }
      }
      empty.hidden = items.length > 0;
      paintMeta();
      setRunningInternal(!!state.turnOpen);
      updateTyping();
      if (stick) toBottom();
      if (typeof o.onState === 'function') { try { o.onState(state); } catch (_) {} }
      // Commands can land after the user already typed "/", so a fresh list
      // refreshes an open or pending popover.
      if (state.commands !== lastCommands) {
        lastCommands = state.commands;
        if (document.activeElement === input) updateAc();
      }
    }

    // Adjacent stream chunks of one kind fold into one event before reducing.
    // The reducer appends a chunk to the open block of its kind, so a+b in one
    // call lands exactly where a then b would, at a fraction of the bridge cost.
    function coalesce(events) {
      const out = [];
      for (const ev of events) {
        const prev = out[out.length - 1];
        if (prev && (ev.type === 'text' || ev.type === 'thought') && prev.type === ev.type && prev._merged !== undefined) {
          prev._merged += str(ev.text);
          continue;
        }
        if (ev.type === 'text' || ev.type === 'thought') out.push({ type: ev.type, _merged: str(ev.text) });
        else out.push(ev);
      }
      return out.map((e) => (e._merged !== undefined ? { type: e.type, text: e._merged } : e));
    }

    function drain() {
      if (!queue.length) return;
      const batch = coalesce(queue);
      queue = [];
      for (const ev of batch) {
        try { state = reduce(state, ev) || state; } catch (_) {}
      }
    }

    function flush() {
      frame = null;
      if (destroyed) return;
      drain();
      paint();
    }

    function schedule() {
      if (frame !== null || destroyed) return;
      const raf = typeof window.requestAnimationFrame === 'function' ? window.requestAnimationFrame.bind(window) : (fn) => setTimeout(fn, 16);
      frame = raf(flush);
    }

    function apply(eventArg) {
      if (destroyed || !eventArg || typeof eventArg !== 'object') return;
      let event = eventArg;
      if (event.type === 'user') turnStartedAt = Date.now();
      // ACP reports no turn duration, so the footer falls back to the time
      // since the message was sent, measured here.
      if (event.type === 'turn_end' && typeof event.durationMs !== 'number' && turnStartedAt) {
        event = Object.assign({}, event, { durationMs: Date.now() - turnStartedAt });
      }
      if (event.type === 'turn_end' || event.type === 'error') turnStartedAt = 0;
      queue.push(event);
      schedule();
    }

    let lastCommands = null;

    // Shown while a turn runs, except when the agent is already streaming a
    // visible block or is waiting on the reader (a permission card is the state
    // then). Always last in the list so it reads as what comes next.
    function updateTyping() {
      const items = Array.isArray(state.items) ? state.items : [];
      const last = items.length ? items[items.length - 1] : null;
      const pendingPerm = Array.isArray(state.pending) && state.pending.length > 0;
      const streaming = !!(last && last.open && (last.kind === 'text' || last.kind === 'thought'));
      const toolRunning = !!(last && last.kind === 'tool' && last.status === 'running');
      const show = running && !exited && !pendingPerm && !streaming;
      typingLabel.textContent = toolRunning ? 'Running tool' : 'Thinking';
      if (queueBox.parentNode === list && list.lastElementChild !== queueBox && (!typing.parentNode || list.lastElementChild !== typing)) list.appendChild(queueBox);
      if (show) { if (typing.parentNode !== list || list.lastElementChild !== typing) list.appendChild(typing); }
      else if (typing.parentNode) typing.remove();
    }

    function setRunningInternal(on) {
      const next = !!on;
      if (next === running) { syncComposer(); return; }
      running = next;
      // A finished turn may have written files, so the next "@" reindexes.
      if (!running) fileIndexStale = true;
      syncComposer();
      if (typeof o.onRunningChange === 'function') { try { o.onRunningChange(running); } catch (_) {} }
      if (!running) setTimeout(flushQueue, 0);
      updateTyping();
    }

    function reset() {
      queue = [];
      state = emptyThread();
      nodes.clear();
      list.replaceChildren();
      exited = false;
      closeAc();
      fileIndexStale = true;
      paint();
    }

    // Rebuilds the thread from a recorded event log in one pass, the way a
    // reloaded window catches up with a chat whose agent kept running. No
    // turn timing is taken from replayed events; an open turn is timed from
    // now so its footer still reads a duration.
    function replay(events, replayOpts) {
      if (destroyed) return;
      const ro = replayOpts || {};
      for (const e of Array.isArray(events) ? events : []) {
        if (e && typeof e === 'object') queue.push(e);
      }
      drain();
      if (ro.turnOpen !== undefined && !!ro.turnOpen !== !!state.turnOpen) state = Object.assign({}, state, { turnOpen: !!ro.turnOpen });
      turnStartedAt = state.turnOpen ? Date.now() : 0;
      forceScroll = true;
      if (frame !== null) frame = null;
      paint();
    }

    paintMeta();
    syncComposer();
    paint();

    return {
      el: pane,
      apply,
      flush() { if (frame !== null) { frame = null; } drain(); paint(); },
      getState() { drain(); return state; },
      setRunning(on) {
        // An external stop (the process went away) has to close the turn in the
        // state too, or the next paint would read turnOpen and flip it back.
        if (!on && state.turnOpen) state = Object.assign({}, state, { turnOpen: false });
        setRunningInternal(on);
      },
      setStarting(on) { starting = !!on; syncComposer(); },
      setExited(on) {
        exited = !!on;
        if (exited && queued.length) {
          // Nobody will take them now; back into the field, in order.
          const back = queued.map((q) => q.text).filter(Boolean).join('\n');
          queued = [];
          paintQueue();
          setInputValue(input.value ? back + '\n' + input.value : back);
        }
        // Nobody is left to answer an open permission, so its card collapses.
        if (exited && Array.isArray(state.pending) && state.pending.length) {
          drain();
          state = Object.assign({}, state, { pending: [], turnOpen: false });
          paint();
        }
        if (exited) closeAc();
        syncComposer();
      },
      setInfo(info) {
        const i = info || {};
        if (i.agentName !== undefined) agentName = str(i.agentName) || 'the agent';
        if (i.title !== undefined) infoTitle = str(i.title);
        if (i.cwd !== undefined && str(i.cwd) !== cwd) { cwd = str(i.cwd); fileIndex = null; fileIndexStale = true; }
        paintMeta();
        syncComposer();
      },
      isRunning() { return running; },
      reset,
      replay,
      send(text) { return doSend(text); },
      // Puts text at the caret, the way a file attach drops a path into a
      // terminal prompt without submitting it.
      insert(text) {
        const t = str(text);
        if (!t) return;
        const at = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length;
        const end = typeof input.selectionEnd === 'number' ? input.selectionEnd : at;
        const before = input.value.slice(0, at);
        const pad = before && !/\s$/.test(before) ? ' ' : '';
        input.value = before + pad + t + ' ' + input.value.slice(end);
        const caret = (before + pad + t + ' ').length;
        try { input.setSelectionRange(caret, caret); } catch (_) {}
        autogrow();
        syncComposer();
        try { input.focus(); } catch (_) {}
      },
      show() { pane.classList.add('show'); },
      hide() { pane.classList.remove('show'); },
      focus() { try { input.focus(); } catch (_) {} },
      destroy() {
        destroyed = true;
        if (frame !== null && typeof window.cancelAnimationFrame === 'function') { try { window.cancelAnimationFrame(frame); } catch (_) {} }
        frame = null;
        queue = [];
        nodes.clear();
        closeAc();
        try { pane.remove(); } catch (_) {}
      },
    };
  }

  window.HuskChat = {
    mount,
    _lineDiff: lineDiff,
    _foldContext: foldContext,
    _usageLabel: usageLabel,
    _contextLabel: contextLabel,
    _fmtTokens: fmtTokens,
    // Pure trigger and matching logic behind the composer popover.
    _autocomplete: { slashContext, mentionContext, matchCommands, matchFiles, scorePath, completeToken, AC_MAX },
  };
})();
