(function () {
'use strict';

// Geometry of the agent branch canvas. One row per agent in pre-order, so a
// parent always sits above everything it started and no two rows can meet. A
// source (the chat or project the work came from) sits at the left, level with
// its first rows, and its fleet branches out to the right of it. Each source
// and its fleet is one system; systems stack down the page.

const G = {
  PITCH: 60,        // one agent row
  GLYPH: 30,        // agent tile
  INDENT: 30,       // per generation below the first
  ROOT: 40,         // source tile
  ROOT_W: 150,      // source name column
  ROOT_H: 96,       // source tile plus its two text lines
  STEM: 178,        // where the source's stem hands over to its branches
  FAN_MIN: 94,      // stem end to the first generation
  FAN_MAX: 200,
  TEXT_GAP: 12,     // tile to name
  TEXT_W: 230,      // name column at the first generation
  TEXT_MIN: 120,
  HB_GAP: 22,       // name column to heartbeat
  HB_W: 126,        // heartbeat width
  HB_TAIL: 120,     // room a waiting agent's words and its Respond button take past the heartbeat
  SYS_GAP: 48,
  ROOT_REACH: 3.5,  // a tall fleet keeps its source this many rows from the top
};

// tree: { roots: [node], kids: Map(id -> [node]) }, nodes carry `id`.
function layoutBranches(tree, { depthMax = 24 } = {}) {
  const roots = (tree && tree.roots) || [];
  const kids = (tree && tree.kids) || new Map();
  const systems = [];
  let deepest = 1;
  for (const root of roots) {
    const rows = [];
    const seen = new Set([root.id]);
    const walk = (p, depth, parent) => {
      for (const c of kids.get(p.id) || []) {
        if (!c || seen.has(c.id)) continue;
        seen.add(c.id);
        const row = { a: c, depth, parent };
        rows.push(row);
        deepest = Math.max(deepest, depth);
        if (depth < depthMax) walk(c, depth + 1, row);
      }
    };
    const head = { a: root, depth: 0, parent: null, root: true };
    walk(root, 1, head);
    systems.push({ head, rows });
  }

  // How far the first generation sits from the stem grows with how far the
  // fan has to spread, so a tall fleet does not draw near-vertical branches.
  let spread = 0;
  for (const s of systems) {
    const n = s.rows.length;
    const reach = Math.min((n - 1) / 2, G.ROOT_REACH);
    spread = Math.max(spread, Math.max(reach, n - 1 - reach) * G.PITCH);
  }
  const fan = Math.round(Math.min(G.FAN_MAX, Math.max(G.FAN_MIN, spread * 0.32)));
  const gx = (depth) => G.STEM + fan + (depth - 1) * G.INDENT;
  const textX = (depth) => gx(depth) + G.GLYPH + G.TEXT_GAP;
  const hx = Math.max(
    textX(Math.min(deepest, 4)) + G.TEXT_W,
    textX(deepest) + G.TEXT_MIN,
  ) + G.HB_GAP;

  const out = [];
  let top = 0;
  for (const { head, rows } of systems) {
    const first = top + G.GLYPH / 2;
    const last = first + Math.max(0, rows.length - 1) * G.PITCH;
    const ry = Math.round(Math.min((first + last) / 2, first + G.ROOT_REACH * G.PITCH));
    // The source's own text hangs under its tile, so a short fleet starts low
    // enough that the tile clears the system above.
    head.x = 0;
    head.y = ry - G.ROOT / 2;
    head.cy = ry;
    head.w = G.ROOT_W;
    head.h = G.ROOT_H;
    head.kids = rows.length;
    out.push(head);
    rows.forEach((r, i) => {
      r.x = gx(r.depth);
      r.y = top + i * G.PITCH;
      r.cy = r.y + G.GLYPH / 2;
      r.tx = textX(r.depth);
      r.tw = hx - G.HB_GAP - r.tx;
      r.w = hx + G.HB_W - r.x;
      r.h = G.PITCH;
      r.kids = 0;
      // The first generation leaves the source's stem; deeper ones drop out of
      // the bottom of their parent's tile and turn in.
      r.edge = r.parent.root
        ? { x1: G.STEM, y1: ry, x2: r.x, y2: r.cy, w1: 3.2, w2: 1.4, kind: 'fan' }
        : { x1: r.parent.x + G.GLYPH / 2, y1: r.parent.y + G.GLYPH, x2: r.x, y2: r.cy, w1: 2.4, w2: 1.3, kind: 'drop' };
      out.push(r);
    });
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const r = rows[i];
      if (!r.parent.root) r.parent.kids += 1 + r.kids;
    }
    const bottom = Math.max(last + G.GLYPH / 2, ry - G.ROOT / 2 + G.ROOT_H);
    top = bottom + G.SYS_GAP;
  }
  const width = hx + G.HB_W + G.HB_TAIL;
  const height = Math.max(0, top - G.SYS_GAP);
  return { nodes: out, hx, hw: G.HB_W, width, height, stem: G.STEM };
}

// A point on an edge's centre line at t in [0, 1]. A fan is an S between two
// horizontal tangents; a drop leaves straight down and turns in at the end.
function edgePoint(e, t) {
  const u = 1 - t;
  let c1x; let c1y; let c2x; let c2y;
  if (e.kind === 'drop') { c1x = e.x1; c1y = e.y2; c2x = e.x1; c2y = e.y2; }
  else { const cx = (e.x1 + e.x2) / 2; c1x = cx; c1y = e.y1; c2x = cx; c2y = e.y2; }
  return [
    u * u * u * e.x1 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * e.x2,
    u * u * u * e.y1 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * e.y2,
  ];
}

function centerPath(e) {
  if (e.kind === 'drop') return `M${e.x1} ${e.y1}C${e.x1} ${e.y2} ${e.x1} ${e.y2} ${e.x2} ${e.y2}`;
  const cx = (e.x1 + e.x2) / 2;
  return `M${e.x1} ${e.y1}C${cx} ${e.y1} ${cx} ${e.y2} ${e.x2} ${e.y2}`;
}

// A branch is a filled ribbon around the centre line, w1 wide at the source and
// w2 at the tip.
function ribbon(e, steps = 32) {
  const L = [];
  const R = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const [x, y] = edgePoint(e, t);
    const [xa, ya] = edgePoint(e, Math.max(0, t - 0.01));
    const [xb, yb] = edgePoint(e, Math.min(1, t + 0.01));
    let nx = -(yb - ya);
    let ny = xb - xa;
    const n = Math.hypot(nx, ny) || 1;
    nx /= n; ny /= n;
    const w = (e.w1 + (e.w2 - e.w1) * t) / 2;
    L.push(`${(x + nx * w).toFixed(1)} ${(y + ny * w).toFixed(1)}`);
    R.push(`${(x - nx * w).toFixed(1)} ${(y - ny * w).toFixed(1)}`);
  }
  return `M${L.join('L')}L${R.reverse().join('L')}Z`;
}

// Tool calls bucketed over the window that ends at `now`. A bucket before
// `since` is unknown rather than quiet, so the line starts where the data does.
function heartbeat(calls, { now, windowMs = 3600 * 1000, buckets = 30, since = 0 } = {}) {
  const start = now - windowMs;
  const span = windowMs / buckets;
  const counts = new Array(buckets).fill(0);
  let last = 0;
  for (const ts of calls || []) {
    if (!(ts > start) || ts > now) continue;
    counts[Math.min(buckets - 1, Math.floor((ts - start) / span))] += 1;
    last = Math.max(last, ts);
  }
  const from = since > start ? Math.min(buckets - 1, Math.floor((since - start) / span)) : 0;
  return { counts, from, last, total: counts.reduce((n, c) => n + c, 0) };
}

// Bucket counts to polyline points in a w by h box, baseline at the bottom.
// `peak` is shared across rows so two agents compare on one scale.
function heartbeatPoints(hb, { w, h, peak }) {
  const n = hb.counts.length;
  const top = Math.max(1, peak);
  const pts = [];
  for (let i = hb.from; i < n; i += 1) {
    const v = Math.sqrt(hb.counts[i] / top);
    pts.push([n > 1 ? (i / (n - 1)) * w : 0, h - v * (h - 2)]);
  }
  return pts;
}

// claude-opus-4-5-20251101 reads as "opus 4.5"; anything else is kept.
function shortModel(id) {
  const s = String(id || '').trim();
  const parts = s.toLowerCase().split('-');
  if (parts[0] !== 'claude' || !/^[a-z]{1,24}$/.test(parts[1] || '') || !/^\d{1,4}$/.test(parts[2] || '')) return s;
  let rest = parts.slice(3);
  if (rest.length && /^\d{8}$/.test(rest[rest.length - 1])) rest = rest.slice(0, -1);
  if (!rest.length) return `${parts[1]} ${parts[2]}`;
  if (rest.length === 1 && /^\d{1,2}$/.test(rest[0])) return `${parts[1]} ${parts[2]}.${rest[0]}`;
  return s;
}

(function publish(exports) {
  if (typeof module !== 'undefined' && module.exports) module.exports = exports;
  if (typeof window !== 'undefined') window.HuskBranches = exports;
})({ G, layoutBranches, edgePoint, centerPath, ribbon, heartbeat, heartbeatPoints, shortModel });
})();
