'use strict';

const test = require('node:test');
const assert = require('node:assert');
const B = require('../../src/lib/agent-branches');

function tree(roots, edges) {
  const kids = new Map();
  for (const [p, c] of edges) {
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push({ id: c });
  }
  return { roots: roots.map((id) => ({ id })), kids };
}

test('rows come out in pre-order, a parent above everything it started', () => {
  const t = tree(['chat'], [['chat', 'a'], ['chat', 'b'], ['a', 'a1'], ['a1', 'a11'], ['a', 'a2']]);
  const { nodes } = B.layoutBranches(t);
  assert.deepStrictEqual(nodes.map((n) => n.a.id), ['chat', 'a', 'a1', 'a11', 'a2', 'b']);
  const at = Object.fromEntries(nodes.map((n) => [n.a.id, n]));
  assert.strictEqual(at.a1.parent, at.a);
  assert.strictEqual(at.a.parent, at.chat);
  assert.ok(at.a11.x > at.a1.x && at.a1.x > at.a.x, 'each generation indents');
  assert.strictEqual(at.a.edge.kind, 'fan');
  assert.strictEqual(at.a1.edge.kind, 'drop');
  assert.strictEqual(at.a.kids, 3);
  assert.strictEqual(at.chat.kids, 5);
});

test('no two rows overlap, in a deep fleet of many systems', () => {
  const edges = [];
  for (let i = 0; i < 22; i += 1) edges.push(['c1', `x${i}`]);
  let p = 'x0';
  for (let d = 0; d < 9; d += 1) { edges.push([p, `d${d}`]); p = `d${d}`; }
  edges.push(['c2', 'y0']);
  const { nodes, width, height } = B.layoutBranches(tree(['c1', 'c2'], edges));
  const boxes = nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.root ? n.h : B.G.PITCH - 1 }));
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]; const b = boxes[j];
      const hit = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!hit, `${nodes[i].a.id} overlaps ${nodes[j].a.id}`);
    }
  }
  for (const n of nodes) {
    assert.ok(n.x + n.w <= width && n.y + (n.h || 0) <= height + B.G.PITCH, `${n.a.id} sits inside the bounds`);
    if (!n.root) assert.ok(n.tw >= B.G.TEXT_MIN, `${n.a.id} keeps a readable name column`);
  }
});

test('a tall fleet keeps its source near the top, a short one centres it', () => {
  const short = B.layoutBranches(tree(['c'], [['c', 'a'], ['c', 'b'], ['c', 'd']])).nodes;
  assert.strictEqual(short[0].cy, short[2].cy);
  const edges = [];
  for (let i = 0; i < 20; i += 1) edges.push(['c', `a${i}`]);
  const tall = B.layoutBranches(tree(['c'], edges)).nodes;
  assert.strictEqual(tall[0].cy, tall[1].cy + B.G.ROOT_REACH * B.G.PITCH);
});

test('a loop in the lineage is drawn once and ends', () => {
  const t = { roots: [{ id: 'c' }], kids: new Map([['c', [{ id: 'a' }]], ['a', [{ id: 'b' }]], ['b', [{ id: 'a' }]]]) };
  assert.deepStrictEqual(B.layoutBranches(t).nodes.map((n) => n.a.id), ['c', 'a', 'b']);
});

test('the heartbeat buckets real calls and claims nothing before its data', () => {
  const now = 1_000_000_000;
  const min = 60_000;
  const hb = B.heartbeat([now - 59 * min, now - 30 * min, now - 30 * min + 1, now - 61 * min, now + 5], { now, windowMs: 60 * min, buckets: 30 });
  assert.strictEqual(hb.total, 3);
  assert.strictEqual(hb.counts[15], 2);
  assert.strictEqual(hb.from, 0);
  assert.strictEqual(hb.last, now - 30 * min + 1);
  const partial = B.heartbeat([now - min], { now, windowMs: 60 * min, buckets: 30, since: now - 10 * min });
  assert.strictEqual(partial.from, 25);
  const pts = B.heartbeatPoints(partial, { w: 100, h: 20, peak: 1 });
  assert.strictEqual(pts.length, 5);
  assert.ok(pts.every(([x]) => x >= 80), 'the line starts where the data does');
  assert.deepStrictEqual(B.heartbeat([], { now }).counts.every((c) => c === 0), true);
});

test('ribbons taper from source to tip and model ids read short', () => {
  const e = { x1: 0, y1: 0, x2: 100, y2: 60, w1: 3, w2: 1, kind: 'fan' };
  assert.match(B.ribbon(e, 4), /^M[\d. L-]+Z$/);
  assert.deepStrictEqual(B.edgePoint(e, 0), [0, 0]);
  assert.deepStrictEqual(B.edgePoint(e, 1), [100, 60]);
  assert.strictEqual(B.shortModel('claude-opus-4-5-20251101'), 'opus 4.5');
  assert.strictEqual(B.shortModel('claude-sonnet-4-6'), 'sonnet 4.6');
  assert.strictEqual(B.shortModel('claude-opus-5'), 'opus 5');
  assert.strictEqual(B.shortModel('gpt-5.4'), 'gpt-5.4');
});

test('the pulse is read off the transcript: tool call times, newest own row, model', () => {
  const { pulseFromTranscript } = require('../../src/lib/session-peek');
  const now = Date.parse('2026-01-01T12:00:00Z');
  const at = (m) => new Date(now - m * 60_000).toISOString();
  const tool = (m, name, input) => JSON.stringify({ type: 'assistant', timestamp: at(m), message: { model: 'claude-opus-4-5', content: [{ type: 'tool_use', name, input }] } });
  const text = [
    JSON.stringify({ type: 'user', timestamp: at(200), message: { content: 'go' } }),
    tool(150, 'Read', { file_path: '/a/b/old.js' }),
    tool(30, 'Read', { file_path: '/a/b/c.js' }),
    tool(5, 'Bash', { command: 'npm test' }),
    JSON.stringify({ type: 'user', timestamp: at(1), message: { content: 'keep going' } }),
  ].join('\n');
  const p = pulseFromTranscript(text, { now });
  assert.deepStrictEqual(p.calls, [now - 30 * 60_000, now - 5 * 60_000]);
  assert.deepStrictEqual(p.last, { kind: 'tool', tool: 'Bash', text: 'npm test', ts: now - 5 * 60_000 });
  assert.strictEqual(p.model, 'claude-opus-4-5');
  assert.strictEqual(p.since, 0);
  assert.strictEqual(pulseFromTranscript(text, { now, truncated: true }).since, now - 200 * 60_000);
  assert.strictEqual(pulseFromTranscript(JSON.stringify({ type: 'user', message: { content: 'hi' } }), { now }).last, null);
});
