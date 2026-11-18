'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const {
  STEP_TIMEOUT_DEFAULT_MS,
  STEP_TIMEOUT_MIN_MS,
  STEP_TIMEOUT_MAX_MS,
  clampStepTimeout,
  stepTimeoutFor,
  armStepTimer,
  sanitizeGraph,
} = require('../../src/lib/workflow-graph');
const { buildArtifact, parseArtifact } = require('../../src/lib/workflow-artifact');

function graph(extra) {
  return Object.assign({
    nodes: [
      { id: 'a', name: 'Plan', agentCommand: 'claude', model: null, branchMode: 'parallel', prompt: 'p', passContext: 'full', x: 0, y: 0, timeoutMs: 1800000 },
      { id: 'b', name: 'Do', agentCommand: 'claude', model: null, branchMode: 'parallel', prompt: 'q', passContext: 'full', x: 0, y: 20 },
    ],
    edges: [{ id: 'e0', from: 'a', to: 'b', condition: { type: 'always', value: '' } }],
  }, extra || {});
}

test('a limit is clamped to 10 seconds at the low end and 2 hours at the high end', () => {
  assert.equal(clampStepTimeout(1), STEP_TIMEOUT_MIN_MS);
  assert.equal(clampStepTimeout(0), STEP_TIMEOUT_MIN_MS);
  assert.equal(clampStepTimeout(-5), STEP_TIMEOUT_MIN_MS);
  assert.equal(clampStepTimeout(10 * 60 * 60 * 1000), STEP_TIMEOUT_MAX_MS);
  assert.equal(clampStepTimeout(900000), 900000);
  assert.equal(clampStepTimeout('900000'), 900000);
});

test('an absent or non-numeric limit falls back to the workflow default, then 5 minutes', () => {
  for (const v of [undefined, null, '', 'soon', NaN, true]) assert.equal(clampStepTimeout(v), null);
  assert.equal(stepTimeoutFor({}, {}), STEP_TIMEOUT_DEFAULT_MS);
  assert.equal(STEP_TIMEOUT_DEFAULT_MS, 300000);
  assert.equal(stepTimeoutFor({}, { defaultTimeoutMs: 900000 }), 900000);
  assert.equal(stepTimeoutFor({ timeoutMs: 60000 }, { defaultTimeoutMs: 900000 }), 60000);
});

test('sanitizeGraph clamps step and workflow limits and adds none when absent', () => {
  const g = sanitizeGraph(graph({ defaultTimeoutMs: 99 }));
  assert.equal(g.defaultTimeoutMs, STEP_TIMEOUT_MIN_MS);
  assert.equal(g.nodes[0].timeoutMs, 1800000);
  assert.equal('timeoutMs' in g.nodes[1], false);
  assert.equal('defaultTimeoutMs' in sanitizeGraph(graph()), false);
  assert.equal(sanitizeGraph({ nodes: [{ id: 'x', timeoutMs: 1e12 }], edges: [] }).nodes[0].timeoutMs, STEP_TIMEOUT_MAX_MS);
});

test('an imported out-of-range limit is clamped and the requested value surfaced', () => {
  const built = buildArtifact({ id: 'wf-1', name: 'T', graph: graph({ defaultTimeoutMs: 900000 }) },
    { huskVersion: '2.11.0', publishedAt: '2026-02-06T10:02:41.117Z' });
  assert.equal(built.ok, true);
  const byName = (nodes) => Object.fromEntries(nodes.map((n) => [n.name, n]));
  const out = byName(built.artifact.graph.nodes);
  assert.equal(out.Plan.timeoutMs, 1800000);
  assert.equal(out.Do.timeoutMs, 900000, 'the workflow default is folded into each step');

  const file = JSON.parse(JSON.stringify(built.artifact));
  for (const n of file.graph.nodes) n.timeoutMs = n.name === 'Plan' ? 99999999 : 5;
  const parsed = parseArtifact(JSON.stringify(file));
  assert.equal(parsed.ok, true, parsed.error);
  const got = byName(parsed.artifact.graph.nodes);
  assert.equal(got.Plan.timeoutMs, STEP_TIMEOUT_MAX_MS);
  assert.equal(got.Plan.timeoutRequestedMs, 99999999);
  assert.equal(got.Do.timeoutMs, STEP_TIMEOUT_MIN_MS);
  assert.equal(got.Do.timeoutRequestedMs, 5);

  const inRange = JSON.parse(JSON.stringify(built.artifact));
  const ok = byName(parseArtifact(JSON.stringify(inRange)).artifact.graph.nodes);
  assert.equal(ok.Plan.timeoutMs, 1800000);
  assert.equal('timeoutRequestedMs' in ok.Plan, false);

  const bad = JSON.parse(JSON.stringify(built.artifact));
  bad.graph.nodes[0].timeoutMs = 'forever';
  assert.equal(parseArtifact(JSON.stringify(bad)).ok, false);
});

test('a slow step is stopped at its own limit: SIGTERM first, SIGKILL after the grace', async () => {
  // Ignores SIGTERM, so only the follow-up SIGKILL can end it.
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => console.log('term')); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  await new Promise((r) => setTimeout(r, 300));
  const started = Date.now();
  let expiredAt = 0;
  const limitMs = 400;
  const graceMs = 300;
  const cancel = armStepTimer(child, limitMs, () => { expiredAt = Date.now(); }, graceMs);
  const signal = await new Promise((resolve) => child.on('close', (_code, sig) => resolve(sig)));
  cancel();
  const elapsed = Date.now() - started;
  assert.ok(expiredAt - started >= limitMs - 20 && expiredAt - started < limitMs + 500, `expired at ${expiredAt - started}ms`);
  assert.equal(out.trim(), 'term', 'the agent saw SIGTERM first');
  assert.equal(signal, 'SIGKILL');
  assert.ok(elapsed >= limitMs + graceMs - 20 && elapsed < 5000, `ended at ${elapsed}ms, well under 5 minutes`);
});

test('a step that ends before its limit is never signalled', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 50)'], { stdio: 'ignore' });
  let fired = false;
  const cancel = armStepTimer(child, 2000, () => { fired = true; }, 100);
  await new Promise((resolve) => child.on('close', resolve));
  cancel();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fired, false);
});
