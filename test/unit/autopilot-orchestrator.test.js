'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { planCollab, extractPlan, buildPlanPrompt, resolveTier } = require('../../src/lib/autopilot-orchestrator');

function withPlannerScript(source, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-planner-test-'));
  const script = path.join(dir, 'planner');
  fs.writeFileSync(script, `#!/usr/bin/env node\n${source}`);
  fs.chmodSync(script, 0o755);
  return Promise.resolve()
    .then(() => fn({ dir, script }))
    .finally(() => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    });
}

test('extractPlan pulls agents + tiers from prose-wrapped JSON', () => {
  const out = 'Here is the plan:\n{"agents":[{"role":"api","tier":"smart","subgoal":"refactor the API"},{"role":"deps","tier":"cheap","subgoal":"bump devDependencies"}]}\nDone.';
  const agents = extractPlan(out, 4);
  assert.equal(agents.length, 2);
  assert.equal(agents[0].tier, 'smart');
  assert.equal(agents[1].tier, 'cheap');
});

test('extractPlan falls back to the classifier when tier is missing', () => {
  const out = '{"agents":[{"role":"deps","subgoal":"bump the package versions in package.json"},{"role":"core","subgoal":"debug the race condition"}]}';
  const agents = extractPlan(out, 4);
  assert.equal(agents[0].tier, 'cheap');   // mechanical -> classified cheap
  assert.equal(agents[1].tier, 'smart');   // reasoning -> classified smart
});

test('an explicit planner tier is respected as-is', () => {
  const out = '{"agents":[{"role":"todo","tier":"smart","subgoal":"find all TODO and FIXME comments in the backend and list them"},{"role":"core","tier":"cheap","subgoal":"debug the race condition in the pty layer"}]}';
  const agents = extractPlan(out, 4);
  assert.equal(agents[0].tier, 'smart');   // planner saw the whole plan; its tier wins
  assert.equal(agents[1].tier, 'cheap');
});

test('resolveTier: explicit planner tier wins; classifier decides only when tier is absent', () => {
  assert.equal(resolveTier({ tier: 'smart', subgoal: 'reformat the codebase with prettier' }), 'smart');
  assert.equal(resolveTier({ tier: 'cheap', subgoal: 'implement OAuth login' }), 'cheap');
  assert.equal(resolveTier({ subgoal: 'reformat the codebase with prettier' }), 'cheap');
  assert.equal(resolveTier({ subgoal: 'implement OAuth login' }), 'smart');
});

test('extractPlan normalizes a garbage tier to smart', () => {
  const out = '{"agents":[{"role":"a","tier":"turbo","subgoal":"x"},{"role":"b","tier":"cheap","subgoal":"y"}]}';
  const agents = extractPlan(out, 4);
  assert.equal(agents[0].tier, 'smart');
  assert.equal(agents[1].tier, 'cheap');
});

test('extractPlan returns null when fewer than 2 usable agents', () => {
  assert.equal(extractPlan('{"agents":[{"role":"solo","subgoal":"x"}]}', 4), null);
  assert.equal(extractPlan('no json here', 4), null);
});

test('buildPlanPrompt includes the repo snapshot contract, agent cap, and JSON-only contract', () => {
  const prompt = buildPlanPrompt('Add focused unit tests', 3);
  assert.match(prompt, /Shared goal: Add focused unit tests/);
  assert.match(prompt, /bounded repository snapshot/);
  assert.match(prompt, /Use as FEW agents as the goal genuinely needs \(2 to 3\)/);
  assert.match(prompt, /Reply with ONLY a JSON object/);
  assert.match(prompt, /"tier":"cheap\|smart"/);
});

test('planCollab launches the planner and returns parsed agents', async () => {
  await withPlannerScript(`
const promptIndex = process.argv.indexOf('-p');
if (promptIndex === -1 || !process.argv[promptIndex + 1].includes('Shared goal: Improve tests')) {
  console.error('missing prompt');
  process.exit(2);
}
console.log(JSON.stringify({
  agents: [
    { role: 'unit tests', tier: 'smart', subgoal: 'add unit tests for orchestrator behavior' },
    { role: 'docs sweep', tier: 'smart', subgoal: 'find TODO comments in docs and list them' }
  ]
}));
`, async ({ dir, script }) => {
    let childSeen = false;
    const result = await planCollab({
      goal: 'Improve tests',
      agentCommand: script,
      cwd: dir,
      maxAgents: 4,
      env: process.env,
      onChild: (child) => { childSeen = Boolean(child && child.pid); },
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(childSeen, true);
    assert.equal(result.agents.length, 2);
    assert.deepEqual(result.agents.map((a) => a.role), ['unit tests', 'docs sweep']);
    assert.equal(result.agents[0].tier, 'smart');
    assert.equal(result.agents[1].tier, 'smart');
  });
});

test('planCollab reports planner output that cannot be parsed', async () => {
  await withPlannerScript(`
console.log('I cannot produce a plan today.');
`, async ({ dir, script }) => {
    const result = await planCollab({
      goal: 'Improve tests',
      agentCommand: script,
      cwd: dir,
      maxAgents: 4,
      env: process.env,
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /no parseable team plan/);
  });
});

test('planCollab includes stderr when the planner exits non-zero', async () => {
  await withPlannerScript(`
console.error('planner crashed loudly');
process.exit(7);
`, async ({ dir, script }) => {
    const result = await planCollab({
      goal: 'Improve tests',
      agentCommand: script,
      cwd: dir,
      maxAgents: 4,
      env: process.env,
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /planner exited 7: planner crashed loudly/);
  });
});

test('planCollab reports spawn errors from an unavailable planner command', async () => {
  const result = await planCollab({
    goal: 'Improve tests',
    agentCommand: 'husk-missing-planner-command-for-test',
    cwd: process.cwd(),
    maxAgents: 4,
    env: process.env,
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /ENOENT|spawn/i);
});

test('planCollab continues if onChild observer throws', async () => {
  await withPlannerScript(`
console.log(JSON.stringify({
  agents: [
    { role: 'a', tier: 'smart', subgoal: 'implement a feature' },
    { role: 'b', tier: 'smart', subgoal: 'debug a regression' }
  ]
}));
`, async ({ dir, script }) => {
    const result = await planCollab({
      goal: 'Improve tests',
      agentCommand: script,
      cwd: dir,
      maxAgents: 4,
      env: process.env,
      onChild: () => { throw new Error('observer failed'); },
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.agents.length, 2);
  });
});
