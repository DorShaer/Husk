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
]);

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
  const raw = String(n.agentCommand || '').slice(0, 128);
  const agentCommand = (raw && isAllowedAgentCommand(raw)) ? raw : null;
  return {
    id: n.id || `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: String(n.name || 'Step').slice(0, 64),
    agentCommand,
    // A pinned model id, e.g. "claude-opus-4-8" or "gemini-2.5-pro". Free text so
    // a new model works without a Husk update; the run engine only passes it when
    // the vendor exposes a model flag.
    model: n.model ? String(n.model).slice(0, 128) : null,
    branchMode: n.branchMode === 'ai' ? 'ai' : 'parallel',
    prompt: String(n.prompt || '').slice(0, 8192),
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
      value: String(c.value || '').slice(0, 256),
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
  const roots = g.nodes.filter((n) => !hasIncoming.has(n.id));
  const queue = (roots.length ? roots : [g.nodes[0]]).map((n) => n.id);
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

function wfEdgeMatches(condition, output) {
  const c = condition || { type: 'always' };
  const text = String(output || '');
  if (c.type === 'contains') return text.toLowerCase().includes(String(c.value || '').toLowerCase());
  if (c.type === 'regex') {
    // c.value is the user's own workflow routing pattern, capped at
    // 256 chars by sanitizeEdge. Match runs against this node's output,
    // not against any privileged input.
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
  isAllowedAgentCommand,
  sanitizeNode,
  sanitizeEdge,
  sanitizeGraph,
  migrateWorkflow,
  graphToOrderedSteps,
  wfEdgeMatches,
  wfPickNextEdge,
  wfIsAiRouted,
  wfRouteInstruction,
  wfResolveNext,
};
