'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { extractPlan } = require('../../src/lib/autopilot-orchestrator');

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
