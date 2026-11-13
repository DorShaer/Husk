'use strict';

// Brain: searchable memories, recall history, and contextual connections.
// User content is rendered with textContent.

(function () {
  const api = window.husk && window.husk.brain;
  if (!api) return;
  const byId = (id) => document.getElementById(id);

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  // ─── Rail signal ──────────────────────────────────────────────────────────
  // Lit while a chat turn is in flight, and for a moment after anything fires.
  const FLASH_MS = 2400;
  let busy = false;
  let flashUntil = 0;
  let flashTimer = null;
  function syncRail() {
    const pulse = byId('rail-brain-pulse');
    if (pulse) pulse.hidden = !(busy || Date.now() < flashUntil);
  }
  function flash() {
    flashUntil = Date.now() + FLASH_MS;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(syncRail, FLASH_MS + 20);
    syncRail();
  }

  const KIND_LABEL = { note: 'Note', file: 'File', chunk: 'Passage', decision: 'Decision' };
  const state = {
    open: false,
    data: { nodes: [], edges: [], log: [], stats: {}, enabled: true },
    selected: null, edge: null, query: '', tab: 'memories',
    handed: new Set(), touching: new Set(), pos: new Map(), made: '',
    all: (() => { try { return localStorage.getItem('husk.brain.all') !== '0'; } catch (_) { return true; } })(),
  };
  const isEdge = (e, pick) => !!pick && ((e.a === pick.a && e.b === pick.b) || (e.a === pick.b && e.b === pick.a));

  // ─── Data ─────────────────────────────────────────────────────────────────
  // Every call to the main process goes through here, so one that fails says
  // so on the page instead of leaving a button that seems to do nothing. A page
  // reloaded onto a main process that started before the Brain existed is the
  // usual cause, and the cure for that is a restart.
  async function call(fn) {
    try { return await fn(); } catch (err) {
      const why = String((err && err.message) || 'unknown error');
      say(/No handler registered/i.test(why)
        ? 'The Brain starts with Husk. Quit and reopen Husk to turn it on.'
        : 'The Brain could not do that: ' + why);
      return null;
    }
  }

  async function load() {
    const res = await call(() => api.graph({ all: state.all }));
    if (!res || !res.ok) { const empty = byId('br-empty'); if (empty) empty.hidden = false; return; }
    state.data = Object.assign({ log: [], stats: { prompts: 0, recalled: 0, chars: 0 } }, res);
    if (state.selected && !res.nodes.some((n) => n.id === state.selected)) state.selected = null;
    if (state.edge && !state.data.edges.some((e) => isEdge(e, state.edge))) state.edge = null;
    // A page opened while a turn is running shows what that turn holds.
    if (res.live) { state.handed = new Set(res.live.handed); state.touching = new Set(res.live.touching); }
    paintChrome();
  }

  // ─── What the agent is doing, on the network ──────────────────────────────
  // Nothing here moves by itself. Three real things are shown:
  //   handed    the memories recalled into the prompt of a turn in flight
  //   touching  the memories the agent's own words, thoughts and tool calls
  //             match as it goes, reported by the main process as they change
  //   made      the connections a finished turn's new memory was given
  // A cell rings and sends a light down its connections when it is first
  // touched; a dashed line marks the step from the last memory touched to the
  // next; a new memory's connections are drawn in one after another.
  const NS = 'http://www.w3.org/2000/svg';
  const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cellOf = (id) => byId('br-network').querySelector(`.br-neuron[data-id="${CSS.escape(String(id))}"]`);
  const titleOf = (id) => { const n = state.data.nodes.find((x) => x.id === id); return n ? (n.title || KIND_LABEL[n.kind]) : ''; };
  let effects = [];
  let effectFrame = 0;
  function runEffects() {
    if (effectFrame || !effects.length) return;
    const tick = (now) => {
      effectFrame = 0;
      effects = effects.filter((fx) => {
        if (now < fx.t0) return true;
        const t = Math.min(1, (now - fx.t0) / fx.ms);
        fx.step(t);
        if (t < 1) return true;
        if (fx.end) fx.end();
        return false;
      });
      if (effects.length && state.open) effectFrame = requestAnimationFrame(tick);
      else stopRecallMotion();
    };
    effectFrame = requestAnimationFrame(tick);
  }
  function stopRecallMotion() {
    cancelAnimationFrame(effectFrame);
    effectFrame = 0;
    for (const fx of effects) { if (fx.end) fx.end(); }
    effects = [];
    for (const node of document.querySelectorAll('.br-recall-ring, .br-signal, .br-signal-glow, .br-trail')) node.remove();
  }
  const mark = (tag, attrs) => {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    return node;
  };
  // A ring that opens out from a cell once.
  function ring(id, delay) {
    const cell = cellOf(id);
    if (!cell) return;
    const node = mark('circle', { class: 'br-recall-ring', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.2, r: 0 });
    cell.appendChild(node);
    effects.push({ t0: performance.now() + (delay || 0), ms: 1400, step: (t) => { node.setAttribute('r', String(5 + t * 22)); node.setAttribute('opacity', String((1 - t) * 0.9)); }, end: () => node.remove() });
  }
  // A light that leaves a cell along each of its connections.
  function signalsFrom(id, delay) {
    const svg = byId('br-network');
    if (!state.view) return;
    const per = panelShape().w / state.view.w;
    for (const group of svg.querySelectorAll('.br-synapse')) {
      const fromA = group.dataset.a === id;
      if (!fromA && group.dataset.b !== id) continue;
      const line = group.querySelector('.br-synapse-line');
      const length = line.getTotalLength();
      const halo = mark('circle', { class: 'br-signal-glow', r: 8 / per });
      const dot = mark('circle', { class: 'br-signal', r: 2.4 / per });
      svg.appendChild(halo);
      svg.appendChild(dot);
      group.classList.add('is-carrying');
      effects.push({
        t0: performance.now() + (delay || 0), ms: 900,
        step: (t) => {
          const at = line.getPointAtLength(length * (fromA ? t : 1 - t));
          halo.setAttribute('cx', at.x); halo.setAttribute('cy', at.y);
          dot.setAttribute('cx', at.x); dot.setAttribute('cy', at.y);
        },
        end: () => { halo.remove(); dot.remove(); group.classList.remove('is-carrying'); },
      });
    }
  }
  // The step from one memory the agent touched to the next: not a stored
  // connection, so it is dashed and fades.
  function trail(from, to) {
    const a = state.pos.get(from);
    const b = state.pos.get(to);
    if (!a || !b) return;
    const node = mark('path', { class: 'br-trail', d: `M${a.x},${a.y} L${b.x},${b.y}` });
    byId('br-network').appendChild(node);
    effects.push({ t0: performance.now(), ms: 2400, step: (t) => node.setAttribute('opacity', String(1 - t)), end: () => node.remove() });
  }
  // Marks the cells a turn in flight holds and is touching, and the
  // connections of the ones being touched.
  function markLive() {
    const svg = byId('br-network');
    if (!svg) return;
    for (const cell of svg.querySelectorAll('.br-neuron')) {
      cell.classList.toggle('is-handed', state.handed.has(cell.dataset.id));
      cell.classList.toggle('is-touching', state.touching.has(cell.dataset.id));
    }
    for (const group of svg.querySelectorAll('.br-synapse')) group.classList.toggle('is-live', state.touching.has(group.dataset.a) || state.touching.has(group.dataset.b));
    paintCaption();
  }
  // Says under the network what is going on in it.
  function paintCaption() {
    const el = byId('br-network-caption');
    if (!el) return;
    const names = (set) => [...set].map(titleOf).filter(Boolean).map((t) => (t.length > 34 ? t.slice(0, 33) + '…' : t)).join(' · ');
    if (state.touching.size) el.textContent = 'The agent is on: ' + names(state.touching);
    else if (state.handed.size) el.textContent = `In this turn: ${names(state.handed)}`;
    else if (busy) el.textContent = 'A turn is running. No memory has come up in it yet.';
    else el.textContent = state.made || 'Scroll to zoom, drag to move. Select a memory or connection to explore it.';
    el.classList.toggle('is-live', busy || state.touching.size > 0);
  }
  // A turn began with these memories in its prompt: they are brought into
  // view, and each rings and lights its connections.
  function showRecall(ids) {
    state.made = '';
    const cells = ids.map((id) => state.pos.get(id)).filter(Boolean);
    if (cells.length) { state.view = viewAround(cells); applyView(); }
    if (!state.open || still()) return;
    ids.forEach((id, i) => { ring(id, i * 160); signalsFrom(id, i * 160); });
    runEffects();
  }
  // The agent's words moved on to these memories.
  function showThinking(ids, before) {
    if (!state.open || still()) return;
    const fresh = ids.filter((id) => !before.includes(id));
    fresh.forEach((id, i) => { ring(id, i * 120); signalsFrom(id, i * 120); });
    if (before.length && fresh.length) trail(before[0], fresh[0]);
    runEffects();
  }
  // A finished turn became a memory: its cell is brought into view and its
  // connections are drawn in, one after another.
  function showCapture(id) {
    const at = state.pos.get(id);
    if (!at) return;
    const svg = byId('br-network');
    const lines = [...svg.querySelectorAll('.br-synapse')].filter((g) => g.dataset.a === id || g.dataset.b === id);
    const joined = lines.map((g) => state.pos.get(g.dataset.a === id ? g.dataset.b : g.dataset.a)).filter(Boolean);
    state.view = viewAround([at, ...joined]);
    applyView();
    state.made = `Remembered “${titleOf(id).slice(0, 40)}” · ${plural(lines.length, 'connection', 'connections')} made`;
    paintCaption();
    if (!state.open || still()) return;
    const per = panelShape().w / state.view.w;
    ring(id);
    lines.forEach((group, i) => {
      const line = group.querySelector('.br-synapse-line');
      const length = line.getTotalLength() * per;
      const fromA = group.dataset.a === id;
      group.classList.add('is-made');
      line.style.strokeDasharray = String(length);
      line.style.strokeDashoffset = String(fromA ? length : -length);
      effects.push({
        t0: performance.now() + 250 + i * 220, ms: 800,
        step: (t) => { line.style.strokeDashoffset = String((fromA ? 1 : -1) * length * (1 - t)); },
        end: () => { line.style.strokeDasharray = ''; line.style.strokeDashoffset = ''; setTimeout(() => group.classList.remove('is-made'), 2600); },
      });
    });
    runEffects();
  }
  async function toggleNetworkFull() {
    const panel = document.querySelector('.br-network-panel');
    try {
      if (document.fullscreenElement === panel) await document.exitFullscreen();
      else await panel.requestFullscreen();
    } catch (_) { say('The synapse view could not enter full screen.'); }
  }

  // ─── The view onto the synapses ─────────────────────────────────────────────
  // The network is laid out once in a field of its own size; the view is the
  // part of that field on screen. It keeps the panel's shape, so nothing is
  // letterboxed, and it is what zooming and dragging change.
  const VIEW_MIN = 200;   // the closest the view goes, in field units across
  function panelShape() {
    const svg = byId('br-network');
    const w = (svg && svg.clientWidth) || 800;
    const h = (svg && svg.clientHeight) || 340;
    return { w, h, ratio: w / h };
  }
  // The whole field, centred, in the panel's shape.
  function wholeView() {
    const { ratio } = panelShape();
    const world = state.world || { x: 0, y: 0, w: 800, h: 460 };
    const w = Math.max(world.w, world.h * ratio);
    const h = w / ratio;
    return { x: world.x + (world.w - w) / 2, y: world.y + (world.h - h) / 2, w, h };
  }
  // A view that holds the given cells, with room round them for their names.
  function viewAround(cells) {
    const { ratio } = panelShape();
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const c of cells) { x0 = Math.min(x0, c.x); x1 = Math.max(x1, c.x); y0 = Math.min(y0, c.y); y1 = Math.max(y1, c.y); }
    const pad = 110;
    let w = Math.max(560, x1 - x0 + pad * 2);
    let h = Math.max(w / ratio, y1 - y0 + pad * 2);
    w = Math.max(w, h * ratio);
    h = w / ratio;
    const whole = wholeView();
    if (w >= whole.w) return whole;
    return { x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - h / 2, w, h };
  }
  // Shows the view: the part of the field, the size of cells and names for
  // that closeness, and which names are worth showing.
  function applyView() {
    const svg = byId('br-network');
    const v = state.view;
    if (!svg || !v) return;
    const { w, ratio } = panelShape();
    v.h = v.w / ratio;
    svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
    const per = w / v.w;   // screen pixels per field unit
    // Cells shrink less than the field does, so they can still be hit from far out.
    svg.style.setProperty('--br-node', String(Math.min(2.6, Math.max(0.6, Math.pow(per, -0.6)))));
    svg.style.setProperty('--br-font', `${12.5 / per}px`);
    svg.style.setProperty('--br-hair', `${1 / per}px`);
    svg.classList.toggle('is-near', per >= 0.7);
    svg.classList.toggle('is-close', per >= 1.5);
    const readout = byId('br-net-zoom');
    if (readout) readout.textContent = Math.round((wholeView().w / v.w) * 100) + '%';
  }
  // Scales the view about a point of the panel, so what is under the pointer stays there.
  function zoomNetwork(factor, px, py) {
    const v = state.view;
    if (!v) return;
    const { w, h } = panelShape();
    const whole = wholeView();
    const next = Math.min(whole.w, Math.max(VIEW_MIN, v.w / factor));
    const fx = px === undefined ? 0.5 : px / w;
    const fy = py === undefined ? 0.5 : py / h;
    const wx = v.x + v.w * fx;
    const wy = v.y + v.h * fy;
    v.w = next;
    v.h = next / (w / h);
    v.x = wx - v.w * fx;
    v.y = wy - v.h * fy;
    if (next >= whole.w) state.view = whole;
    applyView();
  }
  function fitNetwork() {
    state.view = wholeView();
    applyView();
  }

  // A deterministic force layout: no enclosing model or perpetual animation.
  function paintNetwork() {
    const svg = byId('br-network');
    if (!svg) return;
    const ns = 'http://www.w3.org/2000/svg';
    const el = (tag, attrs) => {
      const node = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
      return node;
    };
    const relevant = new Set([state.selected, state.edge && state.edge.a, state.edge && state.edge.b]);
    for (const e of state.data.edges) {
      if (e.a === state.selected) relevant.add(e.b);
      if (e.b === state.selected) relevant.add(e.a);
    }
    const inUse = (n) => state.handed.has(n.id) || state.touching.has(n.id);
    const ranked = [...state.data.nodes].sort((a, b) => Number(inUse(b)) - Number(inUse(a)) || Number(relevant.has(b.id)) - Number(relevant.has(a.id)) || Number(b.kind !== 'chunk') - Number(a.kind !== 'chunk')).slice(0, 120);
    const nodes = state.data.nodes.length <= 120 ? state.data.nodes : ranked;
    // The field is as large as what it holds needs, so cells have room; the
    // view onto it is what zooms and moves.
    const grown = Math.max(1, Math.sqrt(nodes.length / 9));
    const W = 800 * grown;
    const H = 460 * grown;
    const points = new Map(nodes.map((n, i) => {
      const angle = i * 2.399963;
      const r = Math.sqrt((i + 0.5) / Math.max(1, nodes.length));
      return [n.id, { n, x: W / 2 + Math.cos(angle) * r * W * 0.42, y: H / 2 + Math.sin(angle) * r * H * 0.4 }];
    }));
    const edges = state.data.edges.filter((e) => points.has(e.a) && points.has(e.b));
    const pts = [...points.values()];
    for (let step = 0; step < 90; step++) {
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const a = pts[i], b = pts[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d2 = Math.max(36, dx * dx + dy * dy);
          // Cells only push on their neighbours, so none is driven to the edge.
          if (d2 > 240 * 240) continue;
          const force = 440 / d2;
          a.x += dx * force; a.y += dy * force;
          b.x -= dx * force; b.y -= dy * force;
        }
      }
      for (const e of edges) {
        const a = points.get(e.a), b = points.get(e.b);
        const dx = b.x - a.x, dy = b.y - a.y;
        const distance = Math.hypot(dx, dy) || 1;
        const pull = (distance - 150) / distance * 0.018;
        a.x += dx * pull; a.y += dy * pull;
        b.x -= dx * pull; b.y -= dy * pull;
      }
      for (const p of pts) {
        p.x = Math.max(40, Math.min(W - 40, p.x + (W / 2 - p.x) * 0.002));
        p.y = Math.max(36, Math.min(H - 36, p.y + (H / 2 - p.y) * 0.002));
      }
    }
    stopRecallMotion();
    svg.replaceChildren();
    // A different set of cells is a different field: it is shown whole. The
    // same set keeps the view the reader left it on.
    const key = `${nodes.length}:${state.all}`;
    // What the whole view has to hold: the cells as they settled, with room round them.
    const span = pts.reduce((b, q) => ({ x0: Math.min(b.x0, q.x), y0: Math.min(b.y0, q.y), x1: Math.max(b.x1, q.x), y1: Math.max(b.y1, q.y) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    state.world = pts.length ? { x: span.x0 - 70, y: span.y0 - 70, w: span.x1 - span.x0 + 140, h: span.y1 - span.y0 + 140 } : { x: 0, y: 0, w: W, h: H };
    if (state.viewKey !== key || !state.view) { state.viewKey = key; state.view = wholeView(); }
    byId('br-network-count').textContent = nodes.length < state.data.nodes.length
      ? `${nodes.length} of ${state.data.nodes.length} memories · selection first`
      : `${nodes.length} memories · ${edges.length} connections`;
    const activate = (node, fn) => {
      node.addEventListener('click', fn);
      node.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
      });
    };
    const focus = !!state.selected || !!state.edge;
    for (const e of edges) {
      const a = points.get(e.a), b = points.get(e.b);
      const lit = isEdge(e, state.edge) || e.a === state.selected || e.b === state.selected;
      const dx = b.x - a.x, dy = b.y - a.y;
      const length = Math.hypot(dx, dy) || 1;
      const nx = -dy / length, ny = dx / length;
      // One fine line with a gentle bow, always to the same side for the same
      // pair, so the weave is calm and a line can be followed by eye.
      const lean = (e.a < e.b ? 1 : -1) * Math.min(46, length * 0.16);
      const d = `M${a.x},${a.y} Q${(a.x + b.x) / 2 + nx * lean},${(a.y + b.y) / 2 + ny * lean} ${b.x},${b.y}`;
      const group = el('g', { class: 'br-synapse' + (e.kind === 'part' ? ' is-part' : '') + (lit ? ' is-lit' : '') + (focus && !lit ? ' is-muted' : ''), role: 'button', tabindex: 0, 'aria-label': `Connection: ${a.n.title} to ${b.n.title}` });
      group.dataset.a = e.a;
      group.dataset.b = e.b;
      group.appendChild(el('path', { d, class: 'br-synapse-glow' }));
      group.appendChild(el('path', { d, class: 'br-synapse-line' }));
      group.appendChild(el('path', { d, class: 'br-synapse-hit' }));
      activate(group, () => selectEdge(e));
      svg.appendChild(group);
    }
    for (const p of pts) {
      const lit = relevant.has(p.n.id);
      const group = el('g', { style: `transform: translate(${p.x}px, ${p.y}px) scale(var(--br-node, 1))`, class: 'br-neuron is-' + p.n.kind + (p.n.kind === 'chunk' ? ' is-fine' : '') + (lit ? ' is-lit' : '') + (focus && !lit ? ' is-muted' : ''), role: 'button', tabindex: 0, 'aria-label': `${KIND_LABEL[p.n.kind]}: ${p.n.title}` });
      const title = el('title'); title.textContent = p.n.title; group.appendChild(title);
      group.dataset.id = p.n.id;
      // A round bead in the colour of its kind, larger the more it has been
      // recalled, with a soft ring round it.
      const size = (p.n.kind === 'chunk' ? 3.2 : p.n.kind === 'file' ? 7.5 : 5.8) + Math.min(4, Math.sqrt(p.n.hits || 0) * 1.3);
      group.appendChild(el('circle', { r: size + 5, class: 'br-neuron-glow' }));
      group.appendChild(el('circle', { r: size, class: 'br-neuron-body' }));
      group.appendChild(el('circle', { cx: -size * 0.28, cy: -size * 0.3, r: size * 0.3, class: 'br-neuron-core' }));
      // Every cell has its name; which names show is a matter of how close
      // the view is, decided in the stylesheet.
      const label = el('text', { y: size + 17, 'text-anchor': p.x < 120 ? 'start' : p.x > W - 120 ? 'end' : 'middle', class: pts.length <= 8 ? 'is-always' : '' });
      label.textContent = (p.n.title || KIND_LABEL[p.n.kind]).slice(0, 34);
      group.appendChild(label);
      activate(group, () => select(p.n.id));
      svg.appendChild(group);
    }
    if (!nodes.length) {
      const label = el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'br-network-placeholder' });
      label.textContent = 'Your connections will grow as Husk learns.';
      svg.appendChild(label);
    }
    // A fresh pick is brought into view with what it is joined to.
    const picked = state.selected || (state.edge ? state.edge.a + '|' + state.edge.b : '');
    if (picked && picked !== state.framed) {
      const group = pts.filter((q) => relevant.has(q.n.id));
      if (group.length) state.view = viewAround(group);
    }
    state.framed = picked;
    state.pos = new Map(pts.map((q) => [q.n.id, { x: q.x, y: q.y }]));
    applyView();
    markLive();
  }

  // ─── Words and numbers ────────────────────────────────────────────────────
  function ago(ms) {
    const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 45) return 'now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }

  function compact(n) {
    if (n < 1000) return String(n);
    if (n < 1e6) return (n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '') + 'K';
    return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // What the log line says happened.
  function logVerb(e) {
    if (e.kind === 'recall') return e.ids.length ? `Recalled ${plural(e.ids.length, 'memory', 'memories')} for` : 'Nothing matched';
    if (e.kind === 'capture') return 'Remembered the outcome of';
    return 'Learned';
  }

  // ─── Chrome ───────────────────────────────────────────────────────────────
  // The figures that say whether the Brain is doing anything for its user.
  function paintStats() {
    const box = byId('br-stats');
    if (!box) return;
    const d = state.data;
    const st = d.stats || { prompts: 0, recalled: 0, chars: 0 };
    const chunks = d.nodes.filter((n) => n.kind === 'chunk').length;
    const synapses = d.edges.filter((e) => e.kind === 'synapse').length;
    const kinds = { note: 0, file: 0, decision: 0 };
    for (const n of d.nodes) if (n.kind in kinds) kinds[n.kind] += 1;
    const held = d.nodes.length - chunks;
    const linked = new Set();
    for (const e of d.edges) if (e.kind === 'synapse') { linked.add(e.a); linked.add(e.b); }
    const rate = st.prompts ? Math.round((st.recalled / st.prompts) * 100) : 0;
    // A thin bar beside a figure: the split by kind, in the colours of the dots.
    const split = () => {
      const bar = h('span', 'br-stat-bar');
      for (const k of Object.keys(kinds)) {
        if (!kinds[k]) continue;
        const seg = h('i');
        seg.dataset.kind = k;
        seg.style.flexGrow = String(kinds[k]);
        bar.appendChild(seg);
      }
      return bar;
    };
    const meter = (pct) => {
      const bar = h('span', 'br-meter');
      const fill = h('i');
      fill.style.width = pct + '%';
      bar.appendChild(fill);
      return bar;
    };
    // Two groups: what the Brain holds, then what it has done with it.
    const groups = [
      ['What the Brain holds', [
        ['Memories', compact(held), state.all ? 'Notes, files and decisions, from every workspace' : 'Notes, files and decisions in reach of this workspace',
          held ? Object.keys(kinds).filter((k) => kinds[k]).map((k) => plural(kinds[k], k, k + 's')).join(' · ') : 'Nothing kept yet', held ? split() : null],
        ['Passages', compact(chunks), 'Pieces of the files it learned from, each recallable on its own',
          chunks ? 'from ' + plural(kinds.file, 'file', 'files') : 'No files learned yet'],
        ['Connections', compact(synapses), 'Pairs of memories that share rare words. Select a memory to explore its connections',
          synapses ? `${linked.size} of ${d.nodes.length} linked` : 'None found yet'],
      ]],
      ['What the Brain has done', [
        ['Prompts seen', compact(st.prompts), 'Prompts the Brain looked at, across all workspaces',
          st.prompts ? `${compact(st.recalled)} woke a memory` : 'None yet'],
        ['Hit rate', st.prompts ? rate + '%' : '–', 'Share of those prompts that woke at least one memory',
          st.prompts ? 'of prompts seen' : 'No prompts yet', meter(rate)],
        ['Tokens added', st.chars ? '~' + compact(Math.round(st.chars / 4)) : '0', 'Rough size, in tokens, of everything recalled into prompts so far',
          st.chars && st.recalled ? `~${compact(Math.round(st.chars / 4 / st.recalled))} per recall` : 'Nothing yet'],
      ]],
    ];
    box.replaceChildren(...groups.map(([name, tiles]) => {
      const grp = h('div', 'br-stat-group');
      grp.setAttribute('role', 'group');
      grp.setAttribute('aria-label', name);
      for (const [label, value, title, sub, mark] of tiles) {
        const t = h('div', 'br-stat');
        t.title = `${title}. ${sub}.`;
        t.appendChild(h('span', 'br-stat-label', label));
        const row = h('span', 'br-stat-row');
        row.appendChild(h('span', 'br-stat-value', value));
        if (mark) row.appendChild(mark);
        t.appendChild(row);
        t.appendChild(h('span', 'br-stat-sub', sub));
        grp.appendChild(t);
      }
      return grp;
    }));
  }

  function paintChrome() {
    const d = state.data;
    const sub = byId('br-sub');
    if (sub) {
      const spaces = new Set(d.nodes.map((n) => n.scope).filter(Boolean)).size;
      sub.textContent = d.nodes.length
        ? (state.all ? `Everything Husk remembers${spaces > 1 ? `, across ${spaces} workspaces` : ''}` : `In ${d.scopeName || 'this workspace'}`)
        : 'What Husk remembers, and how it connects';
    }
    const sw = byId('br-enabled');
    if (sw) sw.checked = !!d.enabled;
    for (const b of document.querySelectorAll('.br-scope-btn')) {
      const on = (b.dataset.all === '1') === state.all;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const empty = byId('br-empty');
    if (empty) empty.hidden = !!state.selected || !!state.edge;
    const count = byId('br-tab-activity-count');
    if (count) count.textContent = d.log.length ? String(d.log.length) : '';
    paintStats();
    paintTab();
    paintDetail();
    paintNetwork();
  }

  function paintTab() {
    for (const t of document.querySelectorAll('.br-tab')) {
      const on = t.dataset.tab === state.tab;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    const search = byId('br-search');
    if (search) search.hidden = state.tab !== 'memories';
    if (state.tab === 'activity') paintActivity(); else paintList();
  }

  function paintList() {
    const list = byId('br-list');
    if (!list) return;
    const q = state.query.trim().toLowerCase();
    const rows = state.data.nodes
      .filter((n) => n.kind !== 'chunk')
      // Finished chat turns are the chat's own record; they live in the network
      // and the Activity tab. A pinned turn is kept in the list.
      .filter((n) => n.kind !== 'decision' || n.pinned)
      .filter((n) => !q || (n.title + ' ' + n.text).toLowerCase().includes(q))
      .sort((a, b) => (b.pinned - a.pinned) || (b.createdAt - a.createdAt));
    list.replaceChildren();
    if (!rows.length) {
      list.appendChild(h('div', 'br-list-empty', q ? 'Nothing matches that search.' : 'Nothing remembered yet.'));
      return;
    }
    for (const n of rows) {
      const row = h('button', 'br-row' + (n.id === state.selected ? ' is-selected' : ''));
      row.type = 'button';
      row.dataset.id = n.id;
      row.dataset.kind = n.kind;
      row.appendChild(h('span', 'br-dot'));
      const copy = h('span', 'br-row-copy');
      copy.appendChild(h('span', 'br-row-title', n.title || KIND_LABEL[n.kind]));
      copy.appendChild(h('span', 'br-row-preview', n.text || n.source || KIND_LABEL[n.kind]));
      row.appendChild(copy);
      row.appendChild(h('span', 'br-row-meta', n.pinned ? 'pinned' : (n.hits ? `${n.hits}×` : KIND_LABEL[n.kind].toLowerCase())));
      row.addEventListener('click', () => select(n.id, true));
      list.appendChild(row);
    }
  }

  function paintActivity() {
    const list = byId('br-list');
    if (!list) return;
    list.replaceChildren();
    const log = state.data.log || [];
    if (!log.length) {
      list.appendChild(h('div', 'br-list-empty', 'Nothing has happened yet. Ask something in a chat, and what the Brain did with it shows up here.'));
      return;
    }
    const known = new Set(state.data.nodes.map((n) => n.id));
    for (const e of log) {
      const ids = (e.ids || []).filter((id) => known.has(id));
      const row = h('button', 'br-act');
      row.type = 'button';
      row.dataset.kind = e.kind;
      row.dataset.hit = ids.length ? '1' : '0';
      const top = h('span', 'br-act-top');
      top.appendChild(h('span', 'br-act-verb', logVerb(e)));
      top.appendChild(h('span', 'br-act-when', ago(e.at)));
      row.appendChild(top);
      row.appendChild(h('span', 'br-act-title', e.title || '(no text)'));
      // The line points back at the memories it is about.
      row.disabled = !ids.length;
      row.addEventListener('click', () => { select(ids[0], true); });
      list.appendChild(row);
    }
  }

  function neighbours(id) {
    const out = [];
    for (const e of state.data.edges) {
      if (e.kind !== 'synapse') continue;
      const other = e.a === id ? e.b : (e.b === id ? e.a : null);
      const node = other && state.data.nodes.find((n) => n.id === other);
      if (node) out.push({ node, weight: e.weight || 0 });
    }
    return out.sort((a, b) => b.weight - a.weight);
  }

  function linkRows(box, label, nodes) {
    if (!nodes.length) return;
    box.appendChild(h('div', 'section-label br-detail-sub', label));
    for (const n of nodes) {
      const row = h('button', 'br-link', n.title);
      row.type = 'button';
      row.dataset.kind = n.kind;
      row.addEventListener('click', () => select(n.id, true));
      box.appendChild(row);
    }
  }

  function paintDetail() {
    const box = byId('br-detail');
    if (!box) return;
    const n = state.data.nodes.find((x) => x.id === state.selected);
    const line = state.edge && state.data.edges.find((e) => isEdge(e, state.edge));
    box.hidden = !n && !line;
    byId('br-empty').hidden = !!n || !!line;
    box.replaceChildren();
    if (line) { paintEdgeDetail(box, line); return; }
    if (!n) return;
    box.appendChild(h('div', 'section-label', KIND_LABEL[n.kind]));
    box.appendChild(h('div', 'br-detail-title', n.title));
    const parts = n.kind === 'file' ? state.data.nodes.filter((c) => c.parent === n.id) : [];
    box.appendChild(h('div', 'br-detail-text', n.kind === 'file' ? n.source : n.text));
    const meta = [
      n.scope ? 'this workspace' : 'all workspaces',
      n.hits ? `recalled ${plural(n.hits, 'time', 'times')}` : 'not recalled yet',
      'added ' + new Date(n.createdAt).toLocaleDateString(),
    ];
    box.appendChild(h('div', 'br-detail-meta', meta.join(' · ')));
    const acts = h('div', 'br-detail-acts');
    if (n.kind !== 'chunk') {
      const pin = h('button', 'ghost-btn', n.pinned ? 'Unpin' : 'Pin');
      pin.type = 'button';
      pin.title = 'A pinned memory wins ties when a prompt could wake several';
      pin.addEventListener('click', async () => { await call(() => api.pin(n.id, !n.pinned)); load(); });
      acts.appendChild(pin);
    }
    const drop = h('button', 'ghost-btn br-forget', n.kind === 'chunk' ? 'Forget this file' : 'Forget');
    drop.type = 'button';
    drop.addEventListener('click', async () => { await call(() => api.remove(n.kind === 'chunk' ? n.parent : n.id)); state.selected = null; load(); });
    acts.appendChild(drop);
    box.appendChild(acts);
    if (n.kind === 'chunk') linkRows(box, 'From', state.data.nodes.filter((x) => x.id === n.parent));
    linkRows(box, `${plural(parts.length, 'passage', 'passages')} learned`, parts.slice(0, 8));
    if (parts.length > 8) box.appendChild(h('div', 'br-detail-meta', `${parts.length - 8} more not listed`));
    const connections = state.data.edges.filter((e) => e.kind === 'synapse' && (e.a === n.id || e.b === n.id));
    if (connections.length) box.appendChild(h('div', 'section-label br-detail-sub', 'Connections'));
    for (const e of connections) {
      const other = state.data.nodes.find((x) => x.id === (e.a === n.id ? e.b : e.a));
      if (!other) continue;
      const row = h('button', 'br-link', other.title || KIND_LABEL[other.kind]);
      row.type = 'button';
      row.addEventListener('click', () => selectEdge(e));
      box.appendChild(row);
    }
  }

  // A picked line says what it joins and, for a synapse, why: how alike the two
  // memories are and the words they share.
  function paintEdgeDetail(box, e) {
    const ends = [e.a, e.b].map((id) => state.data.nodes.find((x) => x.id === id)).filter(Boolean);
    const syn = e.kind === 'synapse';
    box.appendChild(h('div', 'section-label', syn ? 'Connection' : 'Part of a file'));
    for (const n of ends) {
      const row = h('button', 'br-link br-end');
      row.type = 'button';
      row.dataset.kind = n.kind;
      row.appendChild(h('span', 'br-dot'));
      const copy = h('span', 'br-row-copy');
      copy.appendChild(h('span', 'br-row-title', n.title || KIND_LABEL[n.kind]));
      copy.appendChild(h('span', 'br-row-preview', n.text || n.source || KIND_LABEL[n.kind]));
      row.appendChild(copy);
      row.appendChild(h('span', 'br-row-meta', KIND_LABEL[n.kind].toLowerCase()));
      row.addEventListener('click', () => select(n.id, true));
      box.appendChild(row);
    }
    if (!syn) { box.appendChild(h('div', 'br-detail-meta', 'This passage was learned from this file.')); return; }
    const pct = Math.round((e.weight || 0) * 100);
    const strength = h('div', 'br-strength');
    strength.appendChild(h('span', 'br-detail-meta', 'Strength'));
    const bar = h('span', 'br-meter');
    const fill = h('i');
    fill.style.width = pct + '%';
    bar.appendChild(fill);
    strength.appendChild(bar);
    strength.appendChild(h('span', 'br-strength-value', pct + '%'));
    box.appendChild(strength);
    if (e.terms && e.terms.length) {
      box.appendChild(h('div', 'section-label br-detail-sub', 'Words they share'));
      const chips = h('div', 'br-chips');
      for (const t of e.terms) chips.appendChild(h('span', 'br-chip', t));
      box.appendChild(chips);
    }
    box.appendChild(h('div', 'br-detail-meta', 'A prompt that wakes one of these is close to waking the other.'));
  }

  // Picks a line: it stays lit, a signal runs it both ways, and the panel explains it.
  function selectEdge(e) {
    if (isEdge(e, state.edge)) {
      state.edge = null;
      if (state.tab === 'memories') paintList();
      paintDetail();
      paintNetwork();
      return;
    }
    state.selected = null;
    state.edge = { a: e.a, b: e.b };
    if (state.tab === 'memories') paintList();
    paintDetail();
    paintNetwork();
  }

  // Selecting a memory opens it in the reading panel.
  function select(id) {
    state.edge = null;
    state.selected = id || null;
    if (state.tab === 'memories') paintList();
    paintDetail();
    paintNetwork();
  }

  function say(text) {
    const last = byId('br-last');
    if (last) last.textContent = text;
  }

  function wire() {
    byId('br-network-full').addEventListener('click', toggleNetworkFull);
    byId('br-net-in').addEventListener('click', () => zoomNetwork(1.4));
    byId('br-net-out').addEventListener('click', () => zoomNetwork(1 / 1.4));
    byId('br-net-fit').addEventListener('click', fitNetwork);
    const net = byId('br-network');
    // The wheel zooms about the pointer; a press that moves slides the view.
    net.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = net.getBoundingClientRect();
      zoomNetwork(Math.exp(-e.deltaY * 0.0016), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    let slide = null;
    net.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !state.view) return;
      slide = { x: e.clientX, y: e.clientY, vx: state.view.x, vy: state.view.y, moved: false };
    });
    window.addEventListener('pointermove', (e) => {
      if (!slide) return;
      const dx = e.clientX - slide.x;
      const dy = e.clientY - slide.y;
      if (!slide.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
      slide.moved = true;
      net.classList.add('is-sliding');
      const per = panelShape().w / state.view.w;
      state.view.x = slide.vx - dx / per;
      state.view.y = slide.vy - dy / per;
      applyView();
    });
    window.addEventListener('pointerup', () => {
      if (!slide) return;
      const moved = slide.moved;
      slide = null;
      net.classList.remove('is-sliding');
      // The click that ends a slide is not a pick.
      if (moved) net.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); }, { capture: true, once: true });
    });
    new ResizeObserver(() => { if (state.view) applyView(); }).observe(net);
    byId('br-network').addEventListener('dblclick', (e) => {
      if (!e.target.closest('[role="button"]')) toggleNetworkFull();
    });
    document.addEventListener('fullscreenchange', () => {
      const full = document.fullscreenElement === document.querySelector('.br-network-panel');
      const button = byId('br-network-full');
      button.textContent = full ? 'Exit full screen' : 'Full screen';
      button.setAttribute('aria-pressed', String(full));
      button.setAttribute('aria-label', full ? 'Exit synapse full screen' : 'Expand synapse network');
      if (!full && state.open) button.focus();
    });
    for (const b of document.querySelectorAll('.br-scope-btn')) {
      b.addEventListener('click', () => {
        state.all = b.dataset.all === '1';
        try { localStorage.setItem('husk.brain.all', state.all ? '1' : '0'); } catch (_) {}
        load();
      });
    }

    for (const t of document.querySelectorAll('.br-tab')) {
      t.addEventListener('click', () => { state.tab = t.dataset.tab; paintTab(); });
    }
    byId('br-search').addEventListener('input', (e) => { state.query = e.target.value; paintList(); });
    byId('br-enabled').addEventListener('change', async (e) => {
      if (!await call(() => api.setEnabled(e.target.checked))) return;
      say(e.target.checked ? 'Recall is on: prompts wake matching memories.' : 'Recall is off: nothing is added to prompts or remembered.');
      load();
    });

    const form = byId('br-note-form');
    const text = byId('br-note-text');
    byId('br-add-note').addEventListener('click', () => { form.hidden = false; text.focus(); });
    byId('br-note-cancel').addEventListener('click', () => { form.hidden = true; text.value = ''; });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const res = await call(() => api.addNote({ text: text.value, global: byId('br-note-global').checked }));
      if (!res) return;
      if (!res.ok) { say(res.error || 'That note could not be saved.'); return; }
      form.hidden = true;
      text.value = '';
      await load();
      select(res.node.id, true);
    });

    byId('br-add-files').addEventListener('click', async () => {
      const res = await call(() => api.addFiles({ global: false }));
      if (!res || !res.ok) return;
      const bad = res.failed.map((f) => `${f.name}: ${f.error}`).join('; ');
      if (res.added.length) say(`Learned ${plural(res.added.length, 'file', 'files')}${bad ? `. Skipped ${bad}` : ''}`);
      else if (bad) say(`Skipped ${bad}`);
      await load();
    });
  }

  // ─── Activity ─────────────────────────────────────────────────────────────
  const onActivity = async (a) => {
    if (!a) return;
    busy = !!a.busy;
    const ids = Array.isArray(a.ids) ? a.ids : [];
    if (a.kind !== 'idle' && (ids.length || a.kind === 'recall')) flash();
    syncRail();
    if (!state.open) return;
    // The agent's words moved on: the cells are marked where they stand, and
    // the page is only redrawn if one of them is not on it yet.
    if (a.kind === 'think') {
      const before = [...state.touching];
      state.touching = new Set(ids);
      if (ids.some((id) => !cellOf(id))) paintNetwork(); else markLive();
      showThinking(ids, before);
      return;
    }
    if (a.kind === 'recall') { state.handed = new Set(ids); state.touching = new Set(); }
    if (a.kind === 'idle' || a.kind === 'capture') { state.handed = new Set(); state.touching = new Set(); }
    // Every firing moves the counts and the log, so the page reads them again
    // before refreshing the selected memory.
    if (a.kind !== 'idle') await load(); else markLive();
    if (a.kind === 'recall') say(ids.length ? `Recalled ${plural(ids.length, 'memory', 'memories')} into the last prompt` : 'Nothing in memory matched the last prompt');
    if (a.kind === 'recall') showRecall(ids);
    if (a.kind === 'capture') { say('Kept how the last turn ended'); if (ids[0]) showCapture(ids[0]); }
  };
  api.onActivity(onActivity);

  let wired = false;
  window.Brain = {
    open() {
      if (!wired) { wire(); wired = true; }
      state.open = true;
      if (!byId('br-last').textContent) say('Select a memory to see its details and connections.');
      load();
    },
    // For tests: an activity report, as the main process would send it.
    _activity: (a) => onActivity(a),
    close() { state.open = false; stopRecallMotion(); if (document.fullscreenElement === document.querySelector('.br-network-panel')) document.exitFullscreen().catch(() => {}); },
  };
})();
