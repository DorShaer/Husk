'use strict';

// Brain: what Husk remembers, drawn as it works.
//
// The field is a sphere in space. Memories hang inside it in three dimensions,
// each workspace a constellation of its own; it turns slowly, turns under a
// drag, and a memory picked from the list is brought round to face the reader.
//
// The store and the recall live in the main process (src/lib/brain.js). This
// page shows them: every memory is a dot, a line joins two that share rare
// words, and a firing travels along those lines when a prompt wakes a memory
// or a finished turn leaves one behind. Beside the field sit the numbers that
// say whether it is earning its place (how often a prompt found something, how
// much it added) and the log of what it did. The rail icon blinks on the same
// signal, on every page.
//
// Titles and text are whatever the user typed or a file held, so every string
// reaches the DOM through textContent.

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

  // ─── State ────────────────────────────────────────────────────────────────
  // The canvas draws at most this many dots. Notes, files and decisions always
  // make it; chunks fill what is left, the ones recall has used first.
  const DRAW_MAX = 320;
  const ZOOM_MIN = 0.2;
  const ZOOM_MAX = 6;
  const KIND_LABEL = { note: 'Note', file: 'File', chunk: 'Passage', decision: 'Decision' };
  const KIND_RADIUS = { note: 6, file: 8, chunk: 3.5, decision: 5 };
  const KIND_HUE = { note: 'accent', file: 'info', chunk: 'info', decision: 'emerald' };

  const state = {
    open: false,
    data: { nodes: [], edges: [], log: [], stats: { prompts: 0, recalled: 0, chars: 0 }, enabled: true, scopeName: '' },
    sim: new Map(),      // id -> { node, x, y, z, vx, vy, vz, glow } and where it was last drawn
    edges: [],           // drawn edges, both ends on the canvas
    signals: [],         // firings in flight: { a, b, t0 }
    heat: 0,             // how unsettled the layout is; the loop idles at zero
    selected: null,
    hover: null,
    edge: null,          // the picked line, as { a, b }
    hoverEdge: null,
    query: '',
    tab: 'memories',
    raf: 0,
    settle: 0,
    lastSpark: 0,
    view: { k: 1, x: 0, y: 0, yaw: 0.5, pitch: -0.3 },
    focus: null,         // the yaw and pitch the camera is easing toward
    anchors: new Map(),  // workspace -> where its constellation gathers
    globe: 120,          // radius of the sphere, eased toward its memories
    pointerIn: false,
    dragging: false,
    // The whole brain, or only what the open workspace can reach.
    all: (() => { try { return localStorage.getItem('husk.brain.all') !== '0'; } catch (_) { return true; } })(),
    // The view follows the field until the user zooms or drags; Fit hands it back.
    auto: true,
  };

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
    const anchors = res.nodes.filter((n) => n.kind !== 'chunk');
    const chunks = res.nodes.filter((n) => n.kind === 'chunk')
      .sort((a, b) => (b.hits - a.hits) || (b.createdAt - a.createdAt))
      .slice(0, Math.max(0, DRAW_MAX - anchors.length));
    const drawn = anchors.slice(-DRAW_MAX).concat(chunks);
    const keep = new Set(drawn.map((n) => n.id));
    for (const id of [...state.sim.keys()]) if (!keep.has(id)) state.sim.delete(id);
    setAnchors(drawn);
    drawn.forEach((n, i) => {
      if (state.sim.has(n.id)) { state.sim.get(n.id).node = n; return; }
      // A new dot starts near its parent, or around its workspace's place on
      // the sphere, each in its own direction so nothing stacks.
      const o = (n.parent && state.sim.get(n.parent)) || anchorOf(n.scope);
      const up = 1 - 2 * ((i * 0.618034) % 1);
      const flat = Math.sqrt(1 - up * up);
      const ang = i * 2.399963;
      const rad = n.parent ? 24 : 30 + 14 * Math.cbrt(i + 1);
      state.sim.set(n.id, {
        node: n, glow: 0, vx: 0, vy: 0, vz: 0, sx: 0, sy: 0, f: 1, near: 0.5,
        x: o.x + Math.cos(ang) * flat * rad, y: o.y + up * rad, z: o.z + Math.sin(ang) * flat * rad,
      });
    });
    state.edges = res.edges.filter((e) => keep.has(e.a) && keep.has(e.b));
    if (state.selected && !res.nodes.some((n) => n.id === state.selected)) state.selected = null;
    if (state.edge && !state.edges.some((e) => isEdge(e, state.edge))) state.edge = null;
    state.hoverEdge = null;
    state.heat = 1;
    paintChrome();
    kick();
  }

  // ─── Layout ───────────────────────────────────────────────────────────────
  // Memories settle in three dimensions. Each workspace pulls its own toward a
  // point of the sphere, so a whole brain reads as constellations; what belongs
  // everywhere gathers at the centre.
  const ORIGIN = { x: 0, y: 0, z: 0 };
  const baseName = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);
  const anchorOf = (scope) => state.anchors.get(scope || '') || ORIGIN;

  function setAnchors(nodes) {
    const scopes = [...new Set(nodes.map((n) => n.scope || ''))].filter(Boolean).sort();
    const spread = 110 + 7 * Math.sqrt(nodes.length);
    state.anchors = new Map();
    scopes.forEach((s, i) => {
      // One workspace sits at the centre; several spread evenly over a sphere.
      if (scopes.length < 2) { state.anchors.set(s, ORIGIN); return; }
      const y = 1 - (2 * (i + 0.5)) / scopes.length;
      const r = Math.sqrt(1 - y * y);
      const a = i * 2.399963;
      state.anchors.set(s, { x: Math.cos(a) * r * spread, y: y * spread, z: Math.sin(a) * r * spread, name: baseName(s) });
    });
  }

  function step() {
    const pts = [...state.sim.values()];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      for (let j = i + 1; j < n; j++) {
        const b = pts[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dz = a.z - b.z;
        let d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 1) { dx = (i % 2 ? 1 : -1); dy = (j % 2 ? 1 : -1); dz = ((i + j) % 2 ? 1 : -1); d2 = 3; }
        if (d2 > 40000) continue;
        const f = 520 / d2;
        const d = Math.sqrt(d2);
        a.vx += (dx / d) * f; a.vy += (dy / d) * f; a.vz += (dz / d) * f;
        b.vx -= (dx / d) * f; b.vy -= (dy / d) * f; b.vz -= (dz / d) * f;
      }
      // With several workspaces the pull home is firmer, so each keeps its own sky.
      const home = anchorOf(a.node.scope);
      const pull = state.anchors.size > 1 ? 0.012 : 0.004;
      a.vx -= (a.x - home.x) * pull;
      a.vy -= (a.y - home.y) * pull;
      a.vz -= (a.z - home.z) * pull;
    }
    for (const e of state.edges) {
      const a = state.sim.get(e.a);
      const b = state.sim.get(e.b);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dz = b.z - a.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      // A synapse between two workspaces is a long thread, not a tether.
      const far = e.kind !== 'part' && (a.node.scope || '') !== (b.node.scope || '');
      const f = (d - (e.kind === 'part' ? 34 : 70)) * (far ? 0.0015 : 0.012);
      a.vx += (dx / d) * f; a.vy += (dy / d) * f; a.vz += (dz / d) * f;
      b.vx -= (dx / d) * f; b.vy -= (dy / d) * f; b.vz -= (dz / d) * f;
    }
    let moved = 0;
    for (const p of pts) {
      p.vx *= 0.82; p.vy *= 0.82; p.vz *= 0.82;
      p.x += p.vx * state.heat; p.y += p.vy * state.heat; p.z += p.vz * state.heat;
      moved += Math.abs(p.vx) + Math.abs(p.vy) + Math.abs(p.vz);
    }
    state.heat = n && moved / n > 0.02 ? Math.max(0.05, state.heat * 0.992) : 0;
  }

  // ─── View ─────────────────────────────────────────────────────────────────
  // The camera looks at the centre of the sphere from CAM away. Yaw and pitch
  // turn the sphere under it; k scales it; x and y slide it off centre.
  const CAM = 900;
  const PITCH_MAX = 1.35;
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let trig = { cy: 1, sy: 0, cp: 1, sp: 0 };

  function turn(x, y, z) {
    const x1 = x * trig.cy + z * trig.sy;
    const z1 = z * trig.cy - x * trig.sy;
    return [x1, y * trig.cp - z1 * trig.sp, y * trig.sp + z1 * trig.cp];
  }

  // How far the outermost memory sits from the centre.
  function reach() {
    let r2 = 3600;
    for (const p of state.sim.values()) r2 = Math.max(r2, p.x * p.x + p.y * p.y + p.z * p.z);
    return Math.sqrt(r2);
  }

  // The figures float over the top of the field, so the sphere is framed in
  // what is left below them.
  function inset() {
    const strip = byId('br-stats');
    return strip && strip.offsetHeight ? strip.offsetHeight + 12 : 0;
  }

  function fitZoom(w, hgt) {
    return Math.min(3, Math.max(ZOOM_MIN, (Math.min(w, hgt - inset()) / 2 - 14) / (state.globe * 1.36)));
  }

  // Scales about a point on the canvas, so what is under the pointer stays there.
  function zoomAt(factor, cx, cy) {
    const cv = byId('br-canvas');
    const v = state.view;
    const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.k * factor));
    const ox = cx - cv.clientWidth / 2;
    const oy = cy - (cv.clientHeight + inset()) / 2;
    v.x = ox - (ox - v.x) * (k / v.k);
    v.y = oy - (oy - v.y) * (k / v.k);
    v.k = k;
    state.auto = false;
    paintZoom();
    kick();
  }

  function zoomStep(factor) {
    const cv = byId('br-canvas');
    zoomAt(factor, cv.clientWidth / 2, cv.clientHeight / 2);
  }

  function fit() {
    state.auto = true;
    kick();
  }

  // Turns the sphere until a memory faces the camera.
  function face(id) {
    const p = state.sim.get(id);
    if (!p) return;
    const flat = Math.sqrt(p.x * p.x + p.z * p.z);
    state.focus = { yaw: Math.atan2(-p.x, p.z), pitch: Math.max(-PITCH_MAX, Math.min(PITCH_MAX, Math.atan2(p.y, flat))) };
    kick();
  }

  // The field takes the whole window, or goes back to its place on the page.
  // Either way its box changed, so it is framed again.
  function setFull(on) {
    const stage = document.querySelector('.br-stage');
    const btn = byId('br-full');
    if (!stage || !btn) return;
    stage.classList.toggle('is-full', on);
    btn.classList.toggle('is-on', on);
    btn.title = on ? 'Back to the page (Esc)' : 'Fill the window';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    fit();
  }
  const isFull = () => !!document.querySelector('.br-stage.is-full');

  function paintZoom() {
    const z = byId('br-zoom');
    if (z) z.textContent = Math.round(state.view.k * 100) + '%';
  }

  // The sphere turns on its own while nobody is holding it or reading from it.
  function spinning() {
    return !still && !state.pointerIn && !state.dragging && !state.focus && !state.selected && !state.edge && state.sim.size > 0;
  }

  // ─── Lines ────────────────────────────────────────────────────────────────
  // A line is the same line whichever end it is read from.
  const isEdge = (e, pick) => !!pick && ((e.a === pick.a && e.b === pick.b) || (e.a === pick.b && e.b === pick.a));

  // The line under a point on the canvas, within a few pixels of it. Reads
  // where the last frame drew each end.
  function edgeAt(mx, my) {
    let best = null;
    let bestD = 6 * 6;
    for (const e of state.edges) {
      const a = state.sim.get(e.a);
      const b = state.sim.get(e.b);
      const dx = b.sx - a.sx; const dy = b.sy - a.sy;
      const t = Math.min(1, Math.max(0, ((mx - a.sx) * dx + (my - a.sy) * dy) / (dx * dx + dy * dy || 1)));
      const px = a.sx + dx * t - mx; const py = a.sy + dy * t - my;
      const d = px * px + py * py;
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  // ─── Sky ──────────────────────────────────────────────────────────────────
  // Stars and a few clouds of colour, fixed to the sky: they turn with the
  // sphere but never come closer, which is what gives the field its depth.
  // Seeded, so the sky is the same one every time the page opens.
  let seed = 20261111;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const skyPoint = () => {
    const y = rnd() * 2 - 1;
    const r = Math.sqrt(1 - y * y);
    const a = rnd() * Math.PI * 2;
    return { x: Math.cos(a) * r, y, z: Math.sin(a) * r };
  };
  const STARS = Array.from({ length: 700 }, () => Object.assign(skyPoint(), { size: 0.8 + rnd() * rnd() * 1.7, lum: 0.3 + rnd() * 0.7, rate: 0.0006 + rnd() * 0.0016, phase: rnd() * 6.28 }));
  const CLOUDS = ['accent', 'info', 'emerald', 'info', 'accent', 'info'].map((hue) => Object.assign(skyPoint(), { hue, size: 0.55 + rnd() * 0.4 }));

  // ─── Drawing ──────────────────────────────────────────────────────────────
  // The stage carries its own colours (space is dark in every theme), so the
  // palette is read from it, once a frame.
  function palette(stage) {
    const cs = getComputedStyle(stage);
    const get = (name) => cs.getPropertyValue(name).trim() || '#888';
    return { accent: get('--accent'), info: get('--info'), emerald: get('--emerald'), text: get('--text'), text2: get('--text-2'), text3: get('--text-3'), font: cs.fontFamily || 'sans-serif' };
  }

  // A soft round glow in one colour, drawn once and stamped wherever it is needed.
  const sprites = new Map();
  function glowSprite(color) {
    let s = sprites.get(color);
    if (s) return s;
    s = document.createElement('canvas');
    s.width = s.height = 64;
    const g = s.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, color);
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    g.globalAlpha = 0.9;
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    if (sprites.size > 24) sprites.clear();
    sprites.set(color, s);
    return s;
  }
  function glow(g, color, x, y, radius, alpha) {
    if (alpha <= 0.01) return;
    g.globalAlpha = Math.min(1, alpha);
    g.drawImage(glowSprite(color), x - radius, y - radius, radius * 2, radius * 2);
    g.globalAlpha = 1;
  }

  // A dot says what it is once there is room to read it: the anchors when the
  // field is small or zoomed in, passages only up close, and always the one
  // under the pointer, the selected one, the ends of a picked line and
  // anything firing. The far side of the sphere keeps quiet.
  function wantsLabel(p, anchors) {
    const n = p.node;
    if (n.id === state.selected || n.id === state.hover || p.glow > 0.3) return true;
    if (state.edge && (n.id === state.edge.a || n.id === state.edge.b)) return true;
    if (p.near < 0.45) return false;
    if (n.kind === 'chunk') return state.view.k >= 2.6;
    // Names never overlap, so the near face can always offer some.
    return anchors <= 14 || state.view.k >= 1.15 || p.near > 0.62;
  }

  function draw(now) {
    const cv = byId('br-canvas');
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const hgt = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hgt * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hgt * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    const C = palette(cv.parentElement);
    const v = state.view;

    // The camera: eased toward its fit, toward a memory it was asked to face,
    // or drifting on its own.
    state.globe += (reach() - state.globe) * 0.1;
    if (state.auto) {
      const k = fitZoom(w, hgt);
      v.k += (k - v.k) * 0.085; v.x += -v.x * 0.12; v.y += -v.y * 0.12;
      paintZoom();
    }
    if (state.focus) {
      const dy = Math.atan2(Math.sin(state.focus.yaw - v.yaw), Math.cos(state.focus.yaw - v.yaw));
      const dp = state.focus.pitch - v.pitch;
      v.yaw += dy * 0.12; v.pitch += dp * 0.12;
      if (Math.abs(dy) + Math.abs(dp) < 0.004) state.focus = null;
    } else if (spinning()) v.yaw += 0.0011;
    trig = { cy: Math.cos(v.yaw), sy: Math.sin(v.yaw), cp: Math.cos(v.pitch), sp: Math.sin(v.pitch) };
    const cx = w / 2 + v.x;
    const cy = (hgt + inset()) / 2 + v.y;

    // Sky first. Only the half in front of the camera is in view.
    const sky = Math.max(w, hgt) * 0.8;
    for (const c of CLOUDS) {
      const [x, y, z] = turn(c.x, c.y, c.z);
      if (z < 0) glow(g, C[c.hue], w / 2 + x * sky, hgt / 2 + y * sky, sky * c.size, 0.34 * -z);
    }
    g.fillStyle = C.text;
    for (const s of STARS) {
      const [x, y, z] = turn(s.x, s.y, s.z);
      if (z >= 0) continue;
      g.globalAlpha = s.lum * (still ? 0.8 : 0.65 + 0.35 * Math.sin(now * s.rate + s.phase));
      g.fillRect(w / 2 + x * sky, hgt / 2 + y * sky, s.size, s.size);
    }
    g.globalAlpha = 1;

    // The sphere itself: a breath of light at its edge and three great circles.
    const R = state.globe * 1.12;
    const rim = R * v.k * (CAM / Math.sqrt(CAM * CAM - R * R));
    if (state.sim.size) {
      const halo = g.createRadialGradient(cx, cy, rim * 0.72, cx, cy, rim * 1.1);
      halo.addColorStop(0, 'rgba(0, 0, 0, 0)');
      halo.addColorStop(0.82, C.accent);
      halo.addColorStop(1, 'rgba(0, 0, 0, 0)');
      g.globalAlpha = 0.1;
      g.fillStyle = halo;
      g.beginPath(); g.arc(cx, cy, rim * 1.1, 0, Math.PI * 2); g.fill();
      g.strokeStyle = C.text;
      g.lineWidth = 1;
      for (let ring = 0; ring < 3; ring++) {
        g.globalAlpha = 0.07;
        g.beginPath();
        for (let i = 0; i <= 72; i++) {
          const a = (i / 72) * Math.PI * 2;
          const c = Math.cos(a) * R; const s = Math.sin(a) * R;
          const [x, y, z] = ring === 0 ? turn(c, 0, s) : ring === 1 ? turn(c, s, 0) : turn(0, c, s);
          const f = (CAM / (CAM - z)) * v.k;
          if (i) g.lineTo(cx + x * f, cy + y * f); else g.moveTo(cx + x * f, cy + y * f);
        }
        g.stroke();
      }
      g.globalAlpha = 1;
    }

    // Where every memory lands on the canvas this frame. The pointer reads these.
    const span = state.globe * 2 || 1;
    const pts = [...state.sim.values()];
    for (const p of pts) {
      const [x, y, z] = turn(p.x, p.y, p.z);
      const f = (CAM / (CAM - Math.min(z, CAM - 60))) * v.k;
      p.sx = cx + x * f; p.sy = cy + y * f; p.f = f / v.k;
      p.near = Math.min(1, Math.max(0, z / span + 0.5));
    }

    for (const e of state.edges) {
      const a = state.sim.get(e.a);
      const b = state.sim.get(e.b);
      const lit = Math.max(a.glow, b.glow);
      const chosen = state.selected && (e.a === state.selected || e.b === state.selected);
      // The picked line stays lit; the one under the pointer says it can be picked.
      const picked = isEdge(e, state.edge);
      const over = isEdge(e, state.hoverEdge);
      const depth = 0.35 + 0.65 * (a.near + b.near) / 2;
      g.lineWidth = picked ? 2 : over ? 1.5 : 1;
      if (picked) { g.strokeStyle = C.accent; g.globalAlpha = 1; }
      else if (lit > 0.05) { g.strokeStyle = C.accent; g.globalAlpha = 0.25 + lit * 0.6; }
      else if (chosen || over) { g.strokeStyle = C.text2; g.globalAlpha = 0.9; }
      else { g.strokeStyle = C.text3; g.globalAlpha = (e.kind === 'part' ? 0.24 : 0.38) * depth; }
      g.beginPath(); g.moveTo(a.sx, a.sy); g.lineTo(b.sx, b.sy); g.stroke();
    }
    g.globalAlpha = 1;
    g.lineWidth = 1;

    // A firing is a bright point travelling one synapse.
    const SIGNAL_MS = 900;
    state.signals = state.signals.filter((s) => now - s.t0 < SIGNAL_MS && state.sim.has(s.a) && state.sim.has(s.b));
    for (const s of state.signals) {
      const a = state.sim.get(s.a);
      const b = state.sim.get(s.b);
      const t = (now - s.t0) / SIGNAL_MS;
      const x = a.sx + (b.sx - a.sx) * t;
      const y = a.sy + (b.sy - a.sy) * t;
      glow(g, C.accent, x, y, 9, 1 - t * 0.5);
      g.fillStyle = C.text;
      g.beginPath(); g.arc(x, y, 1.6, 0, Math.PI * 2); g.fill();
      if (t > 0.85) b.glow = Math.max(b.glow, 0.5);
    }

    // Each workspace names its constellation, from just outside it.
    if (state.anchors.size > 1) {
      g.font = '600 10px ' + C.font;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = C.text2;
      for (const a of state.anchors.values()) {
        const [x, y, z] = turn(a.x * 1.5, a.y * 1.5, a.z * 1.5);
        const f = (CAM / (CAM - z)) * v.k;
        g.globalAlpha = 0.25 + 0.5 * Math.min(1, Math.max(0, z / span + 0.5));
        g.fillText(a.name.toUpperCase().slice(0, 28), cx + x * f, cy + y * f);
      }
      g.globalAlpha = 1;
      g.textAlign = 'left';
    }

    let anchors = 0;
    for (const p of pts) if (p.node.kind !== 'chunk') anchors += 1;
    g.font = '11px ' + C.font;
    g.textBaseline = 'middle';
    // Far side first, so what is near is drawn over it.
    pts.sort((a, b) => a.near - b.near);
    for (const p of pts) {
      const n = p.node;
      // Dots shrink a little with the sphere, so a far view is not a blot.
      const r = (KIND_RADIUS[n.kind] + Math.min(4, n.hits * 0.4)) * p.f * Math.min(1.4, Math.max(0.6, Math.sqrt(v.k)));
      const x = p.sx;
      const y = p.sy;
      p.glow = p.glow > 0.02 ? p.glow * 0.965 : 0;
      if (x < -60 || y < -20 || x > w + 60 || y > hgt + 20) continue;
      const color = C[KIND_HUE[n.kind]];
      const depth = 0.4 + 0.6 * p.near;
      // Every memory is a small star; one that is firing flares.
      glow(g, color, x, y, r * 3.2, (n.kind === 'chunk' ? 0.3 : 0.55) * depth);
      if (p.glow) glow(g, C.accent, x, y, r * 3 + 8 + p.glow * 22, p.glow * 0.8);
      g.globalAlpha = (n.kind === 'chunk' ? 0.7 : 1) * depth;
      g.fillStyle = color;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 1;
      const marked = n.id === state.selected || n.id === state.hover;
      if (n.pinned || marked) {
        g.strokeStyle = n.id === state.selected ? C.text : C.text2;
        g.lineWidth = 1.5;
        g.beginPath(); g.arc(x, y, r + 3, 0, Math.PI * 2); g.stroke();
        g.lineWidth = 1;
      }
      p.r = r;
    }

    // Names, nearest first, and never one over another: what must be read
    // (picked, hovered, firing) claims its place before the rest.
    const placed = [];
    const loudOf = (p) => p.node.id === state.selected || p.node.id === state.hover || p.glow > 0.3
      || (state.edge && (p.node.id === state.edge.a || p.node.id === state.edge.b));
    const named = pts.filter((p) => p.sx > -60 && p.sx < w + 60 && p.sy > -20 && p.sy < hgt + 20 && wantsLabel(p, anchors))
      .sort((a, b) => (loudOf(b) - loudOf(a)) || (b.near - a.near));
    for (const p of named) {
      const n = p.node;
      const label = n.title.length > 30 ? n.title.slice(0, 29) + '…' : n.title;
      const loud = loudOf(p);
      const box = { x: p.sx + p.r + 6, y: p.sy - 8, w: g.measureText(label).width, h: 16 };
      if (!loud && placed.some((o) => box.x < o.x + o.w + 6 && o.x < box.x + box.w + 6 && box.y < o.y + o.h && o.y < box.y + box.h)) continue;
      placed.push(box);
      g.fillStyle = loud ? C.text : C.text2;
      g.globalAlpha = loud ? 1 : 0.45 + 0.55 * p.near;
      g.fillText(label, box.x, p.sy);
    }
    g.globalAlpha = 1;
  }

  // While a turn runs the field keeps a low hum: a stray firing now and then.
  function hum(now) {
    if (!busy || !state.edges.length || now - state.lastSpark < 260) return;
    state.lastSpark = now;
    const e = state.edges[Math.floor(Math.random() * state.edges.length)];
    state.signals.push(Math.random() < 0.5 ? { a: e.a, b: e.b, t0: now } : { a: e.b, b: e.a, t0: now });
  }

  // The sky twinkles for as long as the page is open, so the loop only rests
  // for someone who asked for less motion.
  function alive() {
    if (!still || state.heat > 0 || state.signals.length || busy || state.focus) return true;
    for (const p of state.sim.values()) if (p.glow > 0.02) return true;
    return false;
  }

  function frame(now) {
    state.raf = 0;
    if (!state.open) return;
    if (state.heat > 0) step();
    hum(now);
    draw(now);
    // The view eases toward its fit for a few frames after the layout rests.
    if (alive() || state.settle-- > 0) state.raf = requestAnimationFrame(frame);
  }
  function kick() {
    state.settle = 60;
    if (state.open && !state.raf) state.raf = requestAnimationFrame(frame);
  }

  // Lights the memories that fired and sends a signal down each of their synapses.
  function fire(ids) {
    const now = performance.now();
    for (const id of ids) {
      const p = state.sim.get(id);
      if (!p) continue;
      p.glow = 1;
      for (const e of state.edges) {
        if (e.a === id) state.signals.push({ a: e.a, b: e.b, t0: now });
        else if (e.b === id) state.signals.push({ a: e.b, b: e.a, t0: now });
      }
    }
    kick();
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
        ['Connections', compact(synapses), 'Pairs of memories that share rare words. Click a line on the field to see why',
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
      const shown = state.sim.size;
      const spaces = new Set(d.nodes.map((n) => n.scope).filter(Boolean)).size;
      sub.textContent = d.nodes.length
        ? (state.all ? `Everything Husk remembers${spaces > 1 ? `, across ${spaces} workspaces` : ''}` : `In ${d.scopeName || 'this workspace'}`) + (shown < d.nodes.length ? `. The field shows ${shown} of ${d.nodes.length}, the most used first` : '')
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
    if (empty) empty.hidden = d.nodes.length > 0;
    const count = byId('br-tab-activity-count');
    if (count) count.textContent = d.log.length ? String(d.log.length) : '';
    paintStats();
    paintTab();
    paintDetail();
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
      row.appendChild(h('span', 'br-row-title', n.title || KIND_LABEL[n.kind]));
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
      row.addEventListener('click', () => { select(ids[0], true); fire(ids); });
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
    linkRows(box, 'Connected to', neighbours(n.id).slice(0, 6).map((x) => x.node));
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
      row.appendChild(h('span', 'br-row-title', n.title || KIND_LABEL[n.kind]));
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
    state.selected = null;
    state.edge = { a: e.a, b: e.b };
    const now = performance.now();
    for (const id of [e.a, e.b]) { const p = state.sim.get(id); if (p) p.glow = Math.max(p.glow, 0.6); }
    state.signals.push({ a: e.a, b: e.b, t0: now }, { a: e.b, b: e.a, t0: now });
    if (state.tab === 'memories') paintList();
    paintDetail();
    kick();
  }

  // `turn` brings the memory round to face the reader: for picks made off the
  // canvas, where it may be on the far side.
  function select(id, turnTo) {
    state.edge = null;
    state.selected = id || null;
    if (id && turnTo) face(id);
    if (state.tab === 'memories') paintList();
    paintDetail();
    kick();
  }

  function say(text) {
    const last = byId('br-last');
    if (last) last.textContent = text;
  }

  // ─── Canvas pointer ───────────────────────────────────────────────────────
  function nodeAt(ev) {
    const cv = byId('br-canvas');
    const r = cv.getBoundingClientRect();
    const mx = ev.clientX - r.left;
    const my = ev.clientY - r.top;
    let best = null;
    let bestD = 14 * 14;
    // Reads where the last frame drew each dot; of two that overlap, the nearer.
    for (const p of state.sim.values()) {
      const dx = p.sx - mx;
      const dy = p.sy - my;
      const d = dx * dx + dy * dy - p.near;
      if (d < bestD) { bestD = d; best = p; }
    }
    return { p: best, mx, my };
  }

  function wire() {
    const cv = byId('br-canvas');
    const tip = byId('br-tip');
    // A press that moves turns the sphere (or slides it, with Shift held); one
    // that does not is a click.
    let drag = null;
    cv.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      drag = { x: ev.clientX, y: ev.clientY, vx: state.view.x, vy: state.view.y, yaw: state.view.yaw, pitch: state.view.pitch, slide: ev.shiftKey, moved: false };
    });
    window.addEventListener('mousemove', (ev) => {
      if (!drag) return;
      const dx = ev.clientX - drag.x;
      const dy = ev.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      drag.moved = true;
      state.dragging = true;
      state.focus = null;
      if (drag.slide) {
        state.auto = false;
        state.view.x = drag.vx + dx;
        state.view.y = drag.vy + dy;
      } else {
        state.view.yaw = drag.yaw + dx * 0.006;
        state.view.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, drag.pitch + dy * 0.006));
      }
      cv.style.cursor = 'grabbing';
      kick();
    });
    window.addEventListener('mouseup', (ev) => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      state.dragging = false;
      cv.style.cursor = 'grab';
      if (moved || ev.target !== cv) return;
      // A dot wins over the line it sits on; a line over the empty field.
      const hit = nodeAt(ev);
      const line = hit.p ? null : edgeAt(hit.mx, hit.my);
      if (line) selectEdge(line); else select(hit.p ? hit.p.node.id : null);
    });
    cv.addEventListener('mousemove', (ev) => {
      if (drag && drag.moved) { if (tip) tip.hidden = true; return; }
      const hit = nodeAt(ev);
      const id = hit.p ? hit.p.node.id : null;
      const line = hit.p ? null : edgeAt(hit.mx, hit.my);
      state.pointerIn = true;
      cv.style.cursor = hit.p || line ? 'pointer' : 'grab';
      if (tip) {
        tip.hidden = !hit.p && !line;
        if (hit.p) tip.textContent = `${KIND_LABEL[hit.p.node.kind]}: ${hit.p.node.title}`;
        else if (line) tip.textContent = `${line.kind === 'synapse' ? 'Connection' : 'Part of'}: ${state.sim.get(line.a).node.title} ↔ ${state.sim.get(line.b).node.title}`;
        tip.style.left = `${hit.mx + 14}px`; tip.style.top = `${hit.my + 10}px`;
      }
      if (id !== state.hover || line !== state.hoverEdge) { state.hover = id; state.hoverEdge = line; kick(); }
    });
    cv.addEventListener('mouseleave', () => { state.pointerIn = false; state.hover = null; state.hoverEdge = null; if (tip) tip.hidden = true; kick(); });
    // The wheel zooms about the pointer; nothing on the field scrolls.
    cv.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const r = cv.getBoundingClientRect();
      zoomAt(Math.exp(-ev.deltaY * 0.0015), ev.clientX - r.left, ev.clientY - r.top);
    }, { passive: false });
    cv.addEventListener('dblclick', fit);
    new ResizeObserver(() => kick()).observe(cv);

    for (const b of document.querySelectorAll('.br-scope-btn')) {
      b.addEventListener('click', () => {
        state.all = b.dataset.all === '1';
        try { localStorage.setItem('husk.brain.all', state.all ? '1' : '0'); } catch (_) {}
        load();
      });
    }

    byId('br-zoom-in').addEventListener('click', () => zoomStep(1.25));
    byId('br-zoom-out').addEventListener('click', () => zoomStep(1 / 1.25));
    byId('br-zoom').addEventListener('click', fit);
    byId('br-fit').addEventListener('click', fit);
    byId('br-full').addEventListener('click', () => setFull(!isFull()));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.open && isFull()) { e.preventDefault(); setFull(false); }
    });

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
      fire([res.node.id]);
    });

    byId('br-add-files').addEventListener('click', async () => {
      const res = await call(() => api.addFiles({ global: false }));
      if (!res || !res.ok) return;
      const bad = res.failed.map((f) => `${f.name}: ${f.error}`).join('; ');
      if (res.added.length) say(`Learned ${plural(res.added.length, 'file', 'files')}${bad ? `. Skipped ${bad}` : ''}`);
      else if (bad) say(`Skipped ${bad}`);
      await load();
      fire(res.added.map((a) => a.id));
    });
  }

  // ─── Activity ─────────────────────────────────────────────────────────────
  api.onActivity(async (a) => {
    if (!a) return;
    busy = !!a.busy;
    const ids = Array.isArray(a.ids) ? a.ids : [];
    if (a.kind !== 'idle' && (ids.length || a.kind === 'recall')) flash();
    syncRail();
    if (!state.open) return;
    // Every firing moves the counts and the log, so the page reads them again
    // before it lights what fired.
    if (a.kind !== 'idle') await load();
    if (a.kind === 'recall') say(ids.length ? `Recalled ${plural(ids.length, 'memory', 'memories')} into the last prompt` : 'Nothing in memory matched the last prompt');
    if (a.kind === 'capture') say('Kept how the last turn ended');
    fire(ids);
  });

  let wired = false;
  window.Brain = {
    open() {
      if (!wired) { wire(); wired = true; }
      state.open = true;
      // Arriving: the camera starts far out and falls in toward the sphere.
      if (!still) { state.view.k = ZOOM_MIN; state.view.x = 0; state.view.y = 0; state.auto = true; }
      if (!byId('br-last').textContent) say('Drag to turn the sphere, scroll to zoom, click a memory or a line.');
      load();
    },
    // Leaving the page while the field fills the window would strand it there.
    close() { state.open = false; if (isFull()) setFull(false); },
    // For tests: what the canvas is holding.
    _state: () => ({ dots: state.sim.size, edges: state.edges.length, signals: state.signals.length, busy, zoom: state.view.k, auto: state.auto, x: state.view.x, yaw: state.view.yaw, all: state.all, edge: state.edge ? state.edge.a + '|' + state.edge.b : null }),
    // For tests: the middle of the first line of a kind, in canvas pixels.
    _edgeMid(kind) {
      const e = state.edges.find((x) => x.kind === kind);
      if (!e) return null;
      const a = state.sim.get(e.a); const b = state.sim.get(e.b);
      return { x: (a.sx + b.sx) / 2, y: (a.sy + b.sy) / 2 };
    },
  };
})();
