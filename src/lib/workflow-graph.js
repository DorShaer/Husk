'use strict';

// Pure data-model helpers for the workflow graph: sanitization, migration,
// linear ordering, and edge resolution. No Electron, no fs, no spawn. The
// IPC handlers in main.js wrap these for the renderer.

// Workflow nodes are intended to invoke one of the supported agent CLIs.
// The allowlist below pins the agentCommand basename to that set. Update
// this list when a new agent CLI is added to KNOWN_AGENTS in main.js.
const ALLOWED_AGENT_COMMANDS = new Set([
  'claude',
  'copilot',
  'codex',
  'aider',
  'gemini',
  'kiro-cli',
]);

// Truncates to a maximum length by UTF-16 code unit, dropping a trailing high
// surrogate so the result never ends in half an astral character.
function clipText(value, max) {
  const s = String(value);
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return (last >= 0xd800 && last <= 0xdbff) ? cut.slice(0, -1) : cut;
}

// isAllowedAgentCommand(value) returns true when the first whitespace-
// separated token's basename (case-insensitive) is in the allowlist.
function isAllowedAgentCommand(value) {
  if (typeof value !== 'string') return false;
  const first = value.trim().split(/\s+/)[0];
  if (!first) return false;
  const base = first.split(/[\\/]/).pop().toLowerCase();
  return ALLOWED_AGENT_COMMANDS.has(base);
}

// agentCommand is the binary executeWorkflow spawns for a step. Values
// whose first token's basename is not in ALLOWED_AGENT_COMMANDS are
// dropped to null here. executeWorkflow then falls back to the user's
// config.agentCommand, which is independently checked against the same
// allowlist at run time.
function sanitizeNode(n) {
  n = n || {};
  const raw = clipText(n.agentCommand || '', 128);
  const agentCommand = (raw && isAllowedAgentCommand(raw)) ? raw : null;
  return {
    id: n.id || `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: clipText(n.name || 'Step', 64),
    agentCommand,
    // A pinned model id, e.g. "claude-opus-4-8" or "gemini-2.5-pro". Free text so
    // a new model works without a Husk update; the run engine only passes it when
    // the vendor exposes a model flag.
    model: n.model ? clipText(n.model, 128) : null,
    branchMode: n.branchMode === 'ai' ? 'ai' : 'parallel',
    prompt: clipText(n.prompt || '', 8192),
    passContext: ['full', 'last50', 'none'].includes(n.passContext) ? n.passContext : 'full',
    x: Number.isFinite(n.x) ? n.x : 0,
    y: Number.isFinite(n.y) ? n.y : 0,
  };
}

function sanitizeEdge(e) {
  e = e || {};
  const c = (e.condition && typeof e.condition === 'object') ? e.condition : {};
  return {
    id: e.id || `edge-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    from: String(e.from || ''),
    to: String(e.to || ''),
    condition: {
      type: ['always', 'contains', 'regex', 'otherwise'].includes(c.type) ? c.type : 'always',
      value: clipText(c.value || '', 256),
    },
  };
}

function sanitizeGraph(g) {
  if (!g || typeof g !== 'object') return { nodes: [], edges: [] };
  const nodes = Array.isArray(g.nodes) ? g.nodes.map(sanitizeNode) : [];
  const ids = new Set(nodes.map((n) => n.id));
  const edges = Array.isArray(g.edges)
    ? g.edges.map(sanitizeEdge).filter((e) => ids.has(e.from) && ids.has(e.to))
    : [];
  return { nodes, edges };
}

function migrateWorkflow(w) {
  if (w && w.graph && Array.isArray(w.graph.nodes)) {
    const { steps, ...rest } = w;
    return rest;
  }
  const steps = Array.isArray(w && w.steps) ? w.steps : [];
  const nodes = steps.map((s, i) => ({
    id: s.id || `node-mig-${i}-${Math.random().toString(36).slice(2, 6)}`,
    name: s.name || `Step ${i + 1}`,
    agentCommand: s.agentCommand || null,
    prompt: s.prompt || '',
    passContext: s.passContext || 'full',
    x: 80, y: 80 + i * 200,
  }));
  const edges = [];
  for (let i = 1; i < nodes.length; i++) {
    edges.push({ id: `edge-mig-${i}`, from: nodes[i - 1].id, to: nodes[i].id, condition: { type: 'always', value: '' } });
  }
  const { steps: _drop, ...rest } = w || {};
  return { ...rest, graph: { nodes, edges } };
}

function graphToOrderedSteps(graph) {
  const g = sanitizeGraph(graph);
  if (!g.nodes.length) return [];
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const hasIncoming = new Set(g.edges.map((e) => e.to));
  // Outgoing adjacency in edge-declaration order, so branch order is
  // stable and follows how the user wired the graph.
  const out = new Map();
  for (const e of g.edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from).push(e.to);
  }
  const order = [];
  const seen = new Set();
  // Breadth-first from every root (a node with no incoming edge). A
  // pure-cycle graph has no root, so seed with the first node to stay
  // terminating while still emitting every node.
  //
  // Roots are seeded in wiring order, so the walk is a function of the graph
  // rather than of the order the node array happened to arrive in. Roots wired
  // to nothing follow in node order, after the wired ones.
  const rooted = new Set();
  const queue = [];
  const seedRoot = (id) => {
    if (rooted.has(id) || hasIncoming.has(id) || !byId.has(id)) return;
    rooted.add(id);
    queue.push(id);
  };
  for (const e of g.edges) seedRoot(e.from);
  for (const n of g.nodes) seedRoot(n.id);
  if (!queue.length) queue.push(g.nodes[0].id);
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    const node = byId.get(id);
    if (!node) continue;
    seen.add(id);
    order.push(node);
    for (const to of (out.get(id) || [])) {
      if (!seen.has(to)) queue.push(to);
    }
  }
  // Append any node not reachable from a root (a disconnected
  // component) so no step is silently lost.
  for (const n of g.nodes) {
    if (!seen.has(n.id)) { seen.add(n.id); order.push(n); }
  }
  return order;
}

// layoutGraph(graph, opts) computes tidy coordinates for every node: steps in
// columns by how deep they sit in the graph, parallel branches stacked in
// their column, each column centred on the shared middle. Pure: returns
// { nodes, edges } with only x and y rewritten; everything else, edge order
// included, travels through untouched.
//
// Columns come from a longest-path layering over a Kahn walk, so a step lands
// one column right of the deepest step that feeds it. A node on a cycle never
// leaves Kahn's queue; those keep node order and land one column right of
// their deepest already-ranked predecessor, which terminates and puts a loop's
// re-entry beside the step it loops back over rather than at the origin.
//
// Row order inside a column is the barycentre of each node's predecessors in
// the previous column, walked left to right, so branches that fan out of one
// step sit together instead of crossing. Ties keep node order.
function layoutGraph(graph, opts) {
  const g = sanitizeGraph(graph);
  const o = (opts && typeof opts === 'object') ? opts : {};
  const nodeW = Number.isFinite(o.nodeW) ? o.nodeW : 216;
  const nodeH = Number.isFinite(o.nodeH) ? o.nodeH : 64;
  const gapX = Number.isFinite(o.gapX) ? o.gapX : 72;
  const gapY = Number.isFinite(o.gapY) ? o.gapY : 40;
  if (!g.nodes.length) return g;

  const indexOf = new Map(g.nodes.map((n, i) => [n.id, i]));
  const preds = new Map(g.nodes.map((n) => [n.id, []]));
  const succs = new Map(g.nodes.map((n) => [n.id, []]));
  const indegree = new Map(g.nodes.map((n) => [n.id, 0]));
  for (const e of g.edges) {
    // Self-loops contribute nothing to depth and would wedge Kahn's queue.
    if (e.from === e.to) continue;
    preds.get(e.to).push(e.from);
    succs.get(e.from).push(e.to);
    indegree.set(e.to, indegree.get(e.to) + 1);
  }

  // Longest-path ranks over a Kahn walk, in node order for determinism.
  const rank = new Map();
  const queue = g.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  for (const id of queue) rank.set(id, 0);
  while (queue.length) {
    const id = queue.shift();
    for (const to of succs.get(id)) {
      const r = Math.max(rank.get(to) ?? 0, rank.get(id) + 1);
      rank.set(to, r);
      indegree.set(to, indegree.get(to) - 1);
      if (indegree.get(to) === 0) queue.push(to);
    }
  }
  // Cycle members: one column right of the deepest ranked predecessor.
  for (const n of g.nodes) {
    if (rank.has(n.id)) continue;
    const ranked = preds.get(n.id).filter((p) => rank.has(p));
    rank.set(n.id, ranked.length ? Math.max(...ranked.map((p) => rank.get(p))) + 1 : 0);
  }

  const columns = [];
  for (const n of g.nodes) {
    const r = rank.get(n.id);
    if (!columns[r]) columns[r] = [];
    columns[r].push(n.id);
  }

  // Order each column by predecessor barycentre in the column to its left.
  const rowOf = new Map();
  (columns[0] || []).forEach((id, i) => rowOf.set(id, i));
  for (let c = 1; c < columns.length; c += 1) {
    const col = columns[c] || [];
    const keyed = col.map((id) => {
      const rows = preds.get(id).map((p) => rowOf.get(p)).filter((v) => v !== undefined);
      const bary = rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : Infinity;
      return { id, bary };
    });
    keyed.sort((a, b) => a.bary - b.bary || indexOf.get(a.id) - indexOf.get(b.id));
    keyed.forEach((k, i) => rowOf.set(k.id, i));
    columns[c] = keyed.map((k) => k.id);
  }

  const tallest = Math.max(...columns.map((col) => (col || []).length));
  const xy = new Map();
  columns.forEach((col, c) => {
    const list = col || [];
    // Centre the column on the tallest one's middle.
    const offset = ((tallest - list.length) * (nodeH + gapY)) / 2;
    list.forEach((id, i) => {
      xy.set(id, { x: c * (nodeW + gapX), y: offset + i * (nodeH + gapY) });
    });
  });

  return {
    nodes: g.nodes.map((n) => ({ ...n, ...xy.get(n.id) })),
    edges: g.edges,
  };
}

function wfEdgeMatches(condition, output) {
  const c = condition || { type: 'always' };
  const text = String(output || '');
  if (c.type === 'contains') return text.toLowerCase().includes(String(c.value || '').toLowerCase());
  if (c.type === 'regex') {
    // c.value is the workflow's own routing pattern, capped at 256 characters
    // by sanitizeEdge, and matches against this node's output.
    try {
      // eslint-disable-next-line security/detect-non-literal-regexp
      return new RegExp(c.value || '').test(text);
    } catch (_) { return false; }
  }
  return false;
}

function wfPickNextEdge(graph, nodeId, output) {
  const out = graph.edges.filter((e) => e.from === nodeId);
  if (!out.length) return null;
  const conditional = out.filter((e) => e.condition && (e.condition.type === 'contains' || e.condition.type === 'regex'));
  for (const e of conditional) {
    if (wfEdgeMatches(e.condition, output)) return e;
  }
  const fallback = out.find((e) => !e.condition || e.condition.type === 'always' || e.condition.type === 'otherwise');
  return fallback || null;
}

function wfIsAiRouted(graph, nodeId) {
  const out = graph.edges.filter((e) => e.from === nodeId);
  if (out.length < 2) return false;
  return !out.some((e) => e.condition && (e.condition.type === 'contains' || e.condition.type === 'regex'));
}

function wfRouteInstruction(targetNames) {
  return `\n\nThis step decides which step runs next. After your full response, on a final separate line, output exactly:\nROUTE: <name>\nwhere <name> is one of: ${targetNames.join(' | ')}. To end the workflow instead, output ROUTE: END. The ROUTE line must be the very last line, with nothing after it.`;
}

function wfResolveNext(graph, node, output, byId) {
  const out = graph.edges.filter((e) => e.from === node.id);
  if (!out.length) return null;
  if (out.length === 1) return { edge: out[0], decision: null };

  if (!wfIsAiRouted(graph, node.id)) {
    const edge = wfPickNextEdge(graph, node.id, output);
    return edge ? { edge, decision: null } : null;
  }

  const matches = String(output || '').match(/ROUTE:\s*([^\n\r]+)/gi);
  if (matches && matches.length) {
    const raw = matches[matches.length - 1].replace(/ROUTE:\s*/i, '').trim();
    if (/^END\b/i.test(raw)) return { edge: null, decision: 'END' };
    const want = raw.toLowerCase();
    let edge = out.find((e) => {
      const n = byId.get(e.to);
      return n && n.name.trim().toLowerCase() === want;
    });
    if (!edge) {
      edge = out.find((e) => {
        const n = byId.get(e.to);
        return n && n.name.trim() && want.includes(n.name.trim().toLowerCase());
      });
    }
    if (edge) return { edge, decision: (byId.get(edge.to) || {}).name };
  }
  return { edge: out[0], decision: null };
}

module.exports = {
  ALLOWED_AGENT_COMMANDS,
  clipText,
  isAllowedAgentCommand,
  sanitizeNode,
  sanitizeEdge,
  sanitizeGraph,
  migrateWorkflow,
  graphToOrderedSteps,
  layoutGraph,
  wfEdgeMatches,
  wfPickNextEdge,
  wfIsAiRouted,
  wfRouteInstruction,
  wfResolveNext,
};
