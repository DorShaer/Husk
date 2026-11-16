'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveTaskRoute, resolveCollabRoutes, migrateTaskRouting, availableRoutes } = require('../../src/lib/task-routing');
const available = [{ command: 'claude', available: true }, { command: 'codex', available: true }, { command: 'gemini', available: false }];
const config = { agentCommand: 'gemini', taskRouting: {
  cheap: { vendor: 'codex', model: 'test-codex' }, smart: { vendor: 'claude', model: 'test-claude' },
  planner: { vendor: 'claude', model: '' }, integrator: { vendor: 'codex', model: 'test-integrator' },
} };

test('simple and complex jobs use independent vendors and model pins', () => {
  assert.equal(resolveTaskRoute({ config, role: 'cheap', available }).command, 'codex --model test-codex');
  assert.equal(resolveTaskRoute({ config, role: 'smart', available }).command, 'claude --model test-claude');
});
test('run vendor/model overrides role settings; run Automatic follows role', () => {
  assert.equal(resolveTaskRoute({ config, role: 'cheap', available, requested: { vendor: 'claude', model: 'override' } }).command, 'claude --model override');
  assert.equal(resolveTaskRoute({ config, role: 'cheap', available, requested: { vendor: 'auto', model: '' } }).command, 'codex --model test-codex');
  assert.equal(resolveTaskRoute({ config, role: 'cheap', available, requested: { vendor: 'claude', model: '' } }).command, 'claude --model haiku');
});
test('a job type with no CLI chosen does not run, whatever is installed or open in chat', () => {
  for (const agentCommand of ['codex', 'gemini', 'claude']) {
    const simple = resolveTaskRoute({ config: { agentCommand }, role: 'cheap', available });
    assert.equal(simple.ok, false);
    assert.equal(simple.needsSetup, true);
    assert.match(simple.error, /No CLI is set for simple jobs/);
    assert.match(resolveTaskRoute({ config: { agentCommand }, role: 'smart', available }).error, /No CLI is set for complex jobs/);
    assert.match(resolveTaskRoute({ config: { agentCommand, taskRouting: { smart: { vendor: 'auto', model: '' } } }, role: 'smart', available }).error, /No CLI is set/);
  }
  assert.deepEqual(availableRoutes([{}, { command: 'gemini', available: false }, 'codex', 'claude', 'codex']).map((a) => a.vendor), ['claude', 'codex']);
});
test('unavailable vendor, empty installation, and unsafe models fail visibly', () => {
  assert.match(resolveTaskRoute({ available, requested: { vendor: 'gemini', model: '' } }).error, /not installed/);
  assert.match(resolveTaskRoute({ available: [] }).error, /No CLI is set/);
  assert.match(resolveTaskRoute({ available: [], requested: { vendor: 'claude', model: '' } }).error, /not installed/);
  assert.equal(resolveTaskRoute({ available, requested: { vendor: 'auto', model: 'test-model' } }).ok, false);
  assert.equal(resolveTaskRoute({ available, requested: { vendor: 'codex', model: '--dangerous' } }).ok, false);
});
test('legacy migration preserves explicit valid pins only', () => {
  assert.deepEqual(migrateTaskRouting({ agentCommand: 'codex', modelRouting: { codex: { cheap: 'test-model', smart: '' } } }), { cheap: { vendor: 'codex', model: 'test-model' } });
  assert.deepEqual(migrateTaskRouting({ agentCommand: 'codex' }), {});
  assert.deepEqual(migrateTaskRouting({ ...config, modelRouting: { gemini: { cheap: 'old' } } }), config.taskRouting);
});
test('explicit race/custom commands remain unchanged', () => {
  assert.equal(resolveTaskRoute({ config, available: [], agentCommand: 'node test-agent.js --mode demo' }).command, 'node test-agent.js --mode demo');
  assert.equal(resolveTaskRoute({ config: { agentCommand: 'node test-agent.js' }, available: [] }).command, 'node test-agent.js');
  assert.equal(resolveTaskRoute({ config: { agentCommand: 'node test-agent.js' }, available, requested: { vendor: 'codex', model: '' } }).command, 'codex');
});
const agents = [{ role: 'small', tier: 'cheap', vendor: 'claude', subgoal: 'format' }, { role: 'large', tier: 'smart', vendor: 'codex', subgoal: 'implement' }];
test('team worker role choices override planner suggestions; planner and integration remain independent', () => {
  const team = resolveCollabRoutes({ config, agents, available });
  assert.equal(team.ok, true);
  assert.deepEqual(team.workers.map((a) => a.vendor), ['codex', 'claude']);
  assert.equal(team.planner.command, 'claude --model opus');
  assert.equal(team.integrator.command, 'codex --model test-integrator');
  assert.ok(team.workers.every((a) => a.reason && a.route.vendor && a.model));
});
test('a team with no CLI set for its jobs does not start, and planner suggestions never pick a CLI', () => {
  const unset = resolveCollabRoutes({ agents, available });
  assert.equal(unset.ok, false);
  assert.match(unset.error, /No CLI is set for planner jobs/);
  const suggested = resolveCollabRoutes({ config, agents: agents.map((a) => ({ ...a, vendor: 'gemini' })), available });
  assert.equal(suggested.ok, true);
  assert.deepEqual(suggested.workers.map((a) => a.vendor), ['codex', 'claude']);
});
test('queued worker and integrator commands survive later configuration edits', () => {
  const mutable = structuredClone(config);
  const team = resolveCollabRoutes({ config: mutable, agents, available });
  const queuedPayload = { agentCommand: team.workers[0].agentCommand, route: team.workers[0].route };
  const savedIntegrator = team.integrator;
  mutable.agentCommand = 'gemini';
  mutable.taskRouting.cheap = { vendor: 'claude', model: 'new' };
  mutable.taskRouting.integrator = { vendor: 'claude', model: 'new' };
  assert.equal(queuedPayload.agentCommand, 'codex --model test-codex');
  assert.equal(savedIntegrator.command, 'codex --model test-integrator');
  assert.equal(resolveTaskRoute({ config: mutable, role: 'cheap', available }).command, 'claude --model new');
});

test('workflow defaults follow role routes while explicit node vendors stay pinned throughout the run', () => {
  const { resolveWorkflowRoutes } = require('../../src/lib/task-routing');
  const mutable = structuredClone(config);
  const result = resolveWorkflowRoutes({ config: mutable, available, nodes: [
    { id: 'a', prompt: 'format the source' },
    { id: 'b', prompt: 'debug the API', agentCommand: 'codex', model: 'node-model' },
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.routes.a.command, 'codex --model test-codex');
  assert.equal(result.routes.b.command, 'codex --model node-model');
  mutable.taskRouting.cheap.vendor = 'claude';
  assert.equal(result.routes.a.vendor, 'codex');
  assert.equal(resolveWorkflowRoutes({ available, nodes: [{ id: 'missing', agentCommand: 'gemini' }] }).ok, false);
});

test('explicit workflow commands preserve their arguments and paths with node model overriding command model', () => {
  const { resolveWorkflowRoutes } = require('../../src/lib/task-routing');
  const result = resolveWorkflowRoutes({ available, nodes: [
    { id: 'a', agentCommand: 'codex --profile work --model old', model: 'replacement' },
    { id: 'b', agentCommand: '/local/tools/claude --setting custom' },
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.routes.a.command, 'codex --profile work --model replacement');
  assert.equal(result.routes.b.command, '/local/tools/claude --setting custom');
});

test('a job without a model pin follows its CLI routing, and a stale pick falls back with a notice', () => {
  const routing = { taskRouting: { cheap: { vendor: 'codex', model: '' } }, modelRouting: { codex: { cheap: 'mini-1', smart: 'big-1', seenAt: 1 } } };
  assert.equal(resolveTaskRoute({ config: routing, role: 'cheap', available }).command, 'codex --model mini-1');
  const stale = resolveTaskRoute({ config: routing, role: 'cheap', available, catalogs: { codex: { live: ['mini-2'] } } });
  assert.equal(stale.command, 'codex');
  assert.equal(stale.model, '');
  assert.match(stale.notice, /mini-1 is no longer in codex's model list/);
  assert.match(stale.reason, /own default model/);
  const unrouted = resolveTaskRoute({ config: { taskRouting: { cheap: { vendor: 'codex', model: '' } } }, role: 'cheap', available });
  assert.equal(unrouted.command, 'codex');
  assert.equal(unrouted.notice, '');
});

test('a legacy single-vendor routing table supplies models through the CLI routing', () => {
  const legacy = { agentCommand: 'codex', modelRouting: { codex: { cheap: 'mini-1', smart: 'big-1', seenAt: 1 } } };
  const r = resolveTaskRoute({ config: legacy, role: 'cheap', available, catalogs: { codex: { live: ['big-1'] } } });
  assert.equal(r.command, 'codex');
  assert.match(r.notice, /no longer/);
});

test('an explicit command reports the model it pins', () => {
  assert.equal(resolveTaskRoute({ available, agentCommand: 'codex --model gpt-x' }).model, 'gpt-x');
  assert.equal(resolveTaskRoute({ available, agentCommand: 'gemini -m=flash' }).model, 'flash');
  assert.equal(resolveTaskRoute({ available, agentCommand: 'codex' }).model, '');
});
