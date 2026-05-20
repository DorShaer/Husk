'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const wf = require('../../src/lib/workflow-graph');

// ─── sanitizeNode ────────────────────────────────────────────────────────────

test('sanitizeNode: clamps name to 64 chars', () => {
  const n = wf.sanitizeNode({ name: 'a'.repeat(100) });
  assert.equal(n.name.length, 64);
});

test('sanitizeNode: clamps prompt to 8192 chars', () => {
  const n = wf.sanitizeNode({ prompt: 'x'.repeat(10000) });
  assert.equal(n.prompt.length, 8192);
});

test('sanitizeNode: clamps agentCommand to 128 chars', () => {
  const n = wf.sanitizeNode({ agentCommand: 'c'.repeat(500) });
  assert.equal(n.agentCommand.length, 128);
});

test('sanitizeNode: empty agentCommand becomes null', () => {
  const n = wf.sanitizeNode({ agentCommand: '' });
  assert.equal(n.agentCommand, null);
});

test('sanitizeNode: invalid passContext falls back to full', () => {
  const n = wf.sanitizeNode({ passContext: 'evil' });
  assert.equal(n.passContext, 'full');
});

test('sanitizeNode: valid passContext is preserved', () => {
  for (const v of ['full', 'last50', 'none']) {
    assert.equal(wf.sanitizeNode({ passContext: v }).passContext, v);
  }
});

test('sanitizeNode: non-finite coords default to 0', () => {
  const n = wf.sanitizeNode({ x: NaN, y: Infinity });
  assert.equal(n.x, 0);
  assert.equal(n.y, 0);
});

test('sanitizeNode: generates id when missing', () => {
  const n = wf.sanitizeNode({});
  assert.match(n.id, /^node-\d+-[a-z0-9]{4}$/);
});

// ─── sanitizeEdge ────────────────────────────────────────────────────────────

test('sanitizeEdge: unknown condition type defaults to always', () => {
  const e = wf.sanitizeEdge({ from: 'a', to: 'b', condition: { type: 'pwn', value: 'x' } });
  assert.equal(e.condition.type, 'always');
});

test('sanitizeEdge: valid types preserved', () => {
  for (const t of ['always', 'contains', 'regex', 'otherwise']) {
    const e = wf.sanitizeEdge({ from: 'a', to: 'b', condition: { type: t } });
    assert.equal(e.condition.type, t);
  }
});

test('sanitizeEdge: clamps condition value to 256 chars', () => {
  const e = wf.sanitizeEdge({ from: 'a', to: 'b', condition: { type: 'contains', value: 'x'.repeat(1000) } });
  assert.equal(e.condition.value.length, 256);
});

// ─── sanitizeGraph ───────────────────────────────────────────────────────────

test('sanitizeGraph: null returns empty graph', () => {
  assert.deepEqual(wf.sanitizeGraph(null), { nodes: [], edges: [] });
});

test('sanitizeGraph: drops edges with unknown endpoints', () => {
  const g = wf.sanitizeGraph({
    nodes: [{ id: 'a' }, { id: 'b' }],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'ghost' },
      { from: 'ghost', to: 'b' },
    ],
  });
  assert.equal(g.edges.length, 1);
  assert.equal(g.edges[0].from, 'a');
  assert.equal(g.edges[0].to, 'b');
});

// ─── graphToOrderedSteps ─────────────────────────────────────────────────────

test('graphToOrderedSteps: linear chain produces ordered list', () => {
  const g = {
    nodes: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
    edges: [
      { from: 'a', to: 'b', condition: { type: 'always' } },
      { from: 'b', to: 'c', condition: { type: 'always' } },
    ],
  };
  const order = wf.graphToOrderedSteps(g);
  assert.deepEqual(order.map((n) => n.id), ['a', 'b', 'c']);
});

test('graphToOrderedSteps: cycle terminates without infinite loop', () => {
  const g = {
    nodes: [{ id: 'a' }, { id: 'b' }],
    edges: [
      { from: 'a', to: 'b', condition: { type: 'always' } },
      { from: 'b', to: 'a', condition: { type: 'always' } },
    ],
  };
  const order = wf.graphToOrderedSteps(g);
  assert.equal(order.length, 2);
});

test('graphToOrderedSteps: empty graph returns []', () => {
  assert.deepEqual(wf.graphToOrderedSteps({ nodes: [], edges: [] }), []);
});

// ─── wfEdgeMatches ───────────────────────────────────────────────────────────

test('wfEdgeMatches: contains is case-insensitive', () => {
  assert.equal(wf.wfEdgeMatches({ type: 'contains', value: 'YES' }, 'yes please'), true);
});

test('wfEdgeMatches: contains miss returns false', () => {
  assert.equal(wf.wfEdgeMatches({ type: 'contains', value: 'yes' }, 'no thanks'), false);
});

test('wfEdgeMatches: regex matches', () => {
  assert.equal(wf.wfEdgeMatches({ type: 'regex', value: '^OK' }, 'OK done'), true);
});

test('wfEdgeMatches: bad regex returns false instead of throwing', () => {
  assert.equal(wf.wfEdgeMatches({ type: 'regex', value: '[invalid' }, 'anything'), false);
});

test('wfEdgeMatches: always type returns false (caller handles)', () => {
  assert.equal(wf.wfEdgeMatches({ type: 'always' }, 'anything'), false);
});

// ─── wfPickNextEdge ──────────────────────────────────────────────────────────

const branchGraph = {
  nodes: [{ id: 'a' }, { id: 'yes' }, { id: 'no' }, { id: 'else' }],
  edges: [
    { id: 'e1', from: 'a', to: 'yes', condition: { type: 'contains', value: 'OK' } },
    { id: 'e2', from: 'a', to: 'no', condition: { type: 'contains', value: 'FAIL' } },
    { id: 'e3', from: 'a', to: 'else', condition: { type: 'always' } },
  ],
};

test('wfPickNextEdge: conditional wins over always', () => {
  const e = wf.wfPickNextEdge(branchGraph, 'a', 'OK done');
  assert.equal(e.to, 'yes');
});

test('wfPickNextEdge: fallback used when no conditional matches', () => {
  const e = wf.wfPickNextEdge(branchGraph, 'a', 'nothing matches');
  assert.equal(e.to, 'else');
});

test('wfPickNextEdge: returns null when node has no outgoing edges', () => {
  assert.equal(wf.wfPickNextEdge(branchGraph, 'ghost', 'x'), null);
});

// ─── wfIsAiRouted ────────────────────────────────────────────────────────────

test('wfIsAiRouted: single edge is not AI-routed', () => {
  const g = { edges: [{ from: 'a', to: 'b' }] };
  assert.equal(wf.wfIsAiRouted(g, 'a'), false);
});

test('wfIsAiRouted: 2+ unconditioned edges is AI-routed', () => {
  const g = { edges: [
    { from: 'a', to: 'b', condition: { type: 'always' } },
    { from: 'a', to: 'c', condition: { type: 'always' } },
  ]};
  assert.equal(wf.wfIsAiRouted(g, 'a'), true);
});

test('wfIsAiRouted: any conditional edge disables AI routing', () => {
  const g = { edges: [
    { from: 'a', to: 'b', condition: { type: 'contains', value: 'x' } },
    { from: 'a', to: 'c', condition: { type: 'always' } },
  ]};
  assert.equal(wf.wfIsAiRouted(g, 'a'), false);
});

// ─── wfResolveNext ───────────────────────────────────────────────────────────

const aiRoutedGraph = {
  nodes: [
    { id: 'router', name: 'Router' },
    { id: 'b', name: 'Branch B' },
    { id: 'c', name: 'Branch C' },
  ],
  edges: [
    { from: 'router', to: 'b', condition: { type: 'always' } },
    { from: 'router', to: 'c', condition: { type: 'always' } },
  ],
};

function byIdOf(g) { return new Map(g.nodes.map((n) => [n.id, n])); }

test('wfResolveNext: AI-routed parses ROUTE: <name>', () => {
  const r = wf.wfResolveNext(aiRoutedGraph, aiRoutedGraph.nodes[0], 'work\nROUTE: Branch C', byIdOf(aiRoutedGraph));
  assert.equal(r.edge.to, 'c');
  assert.equal(r.decision, 'Branch C');
});

test('wfResolveNext: ROUTE: END returns null edge with END decision', () => {
  const r = wf.wfResolveNext(aiRoutedGraph, aiRoutedGraph.nodes[0], 'done\nROUTE: END', byIdOf(aiRoutedGraph));
  assert.equal(r.edge, null);
  assert.equal(r.decision, 'END');
});

test('wfResolveNext: multiple ROUTE lines uses the last one', () => {
  const out = 'thinking\nROUTE: Branch B\nmore work\nROUTE: Branch C';
  const r = wf.wfResolveNext(aiRoutedGraph, aiRoutedGraph.nodes[0], out, byIdOf(aiRoutedGraph));
  assert.equal(r.edge.to, 'c');
});

test('wfResolveNext: missing ROUTE directive falls back to first branch', () => {
  const r = wf.wfResolveNext(aiRoutedGraph, aiRoutedGraph.nodes[0], 'no directive here', byIdOf(aiRoutedGraph));
  assert.equal(r.edge.to, 'b');
  assert.equal(r.decision, null);
});

test('wfResolveNext: single outgoing edge returns it without parsing', () => {
  const g = { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b', condition: { type: 'always' } }] };
  const r = wf.wfResolveNext(g, g.nodes[0], 'anything', byIdOf(g));
  assert.equal(r.edge.to, 'b');
});

test('wfResolveNext: no outgoing edges returns null', () => {
  const g = { nodes: [{ id: 'a' }], edges: [] };
  const r = wf.wfResolveNext(g, g.nodes[0], '', byIdOf(g));
  assert.equal(r, null);
});

// ─── migrateWorkflow ─────────────────────────────────────────────────────────

test('migrateWorkflow: legacy steps[] becomes a chained graph', () => {
  const legacy = { id: 'wf1', steps: [
    { id: 's1', name: 'Step 1', prompt: 'a' },
    { id: 's2', name: 'Step 2', prompt: 'b' },
  ]};
  const w = wf.migrateWorkflow(legacy);
  assert.ok(w.graph);
  assert.equal(w.graph.nodes.length, 2);
  assert.equal(w.graph.edges.length, 1);
  assert.equal(w.graph.edges[0].from, 's1');
  assert.equal(w.graph.edges[0].to, 's2');
  assert.equal(w.steps, undefined);
});

test('migrateWorkflow: already-graph workflow drops legacy steps field', () => {
  const newWf = { id: 'wf2', steps: [{ id: 'legacy' }], graph: { nodes: [{ id: 'a' }], edges: [] } };
  const w = wf.migrateWorkflow(newWf);
  assert.equal(w.steps, undefined);
  assert.equal(w.graph.nodes[0].id, 'a');
});

test('migrateWorkflow: empty workflow yields empty graph', () => {
  const w = wf.migrateWorkflow({});
  assert.deepEqual(w.graph, { nodes: [], edges: [] });
});

// ─── wfRouteInstruction ──────────────────────────────────────────────────────

test('wfRouteInstruction: includes all target names and END option', () => {
  const txt = wf.wfRouteInstruction(['A', 'B', 'C']);
  assert.match(txt, /A \| B \| C/);
  assert.match(txt, /ROUTE: END/);
});
