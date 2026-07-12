'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyWorkerChangesToIntegrator, applyWorkersWhenIntegratorEmpty } = require('../../src/lib/autopilot-integrate');

let tmp;
let worker;
let integrator;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-integrate-test-'));
  worker = path.join(tmp, 'worker');
  integrator = path.join(tmp, 'integrator');
  fs.mkdirSync(worker, { recursive: true });
  fs.mkdirSync(integrator, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
});

test('copies worker changes into the integrator worktree', () => {
  fs.mkdirSync(path.join(worker, 'src'), { recursive: true });
  fs.writeFileSync(path.join(worker, 'src', 'new.js'), 'new');
  fs.writeFileSync(path.join(integrator, 'old.js'), 'old');
  const result = applyWorkerChangesToIntegrator(integrator, [{
    role: 'packages',
    worktreePath: worker,
    changes: [
      { path: 'src/new.js', status: 'added' },
      { path: 'old.js', status: 'deleted' },
    ],
  }]);
  assert.equal(result.ok, true);
  assert.equal(result.applied.length, 2);
  assert.equal(fs.readFileSync(path.join(integrator, 'src', 'new.js'), 'utf8'), 'new');
  assert.equal(fs.existsSync(path.join(integrator, 'old.js')), false);
});

test('reports failed worker copies without aborting other workers', () => {
  const worker2 = path.join(tmp, 'worker2');
  fs.mkdirSync(worker2, { recursive: true });
  fs.writeFileSync(path.join(worker2, 'good.txt'), 'ok');
  const result = applyWorkerChangesToIntegrator(integrator, [
    { role: 'bad', worktreePath: worker, changes: [{ path: 'missing.txt', status: 'added' }] },
    { role: 'good', worktreePath: worker2, changes: [{ path: 'good.txt', status: 'added' }] },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(fs.readFileSync(path.join(integrator, 'good.txt'), 'utf8'), 'ok');
});

test('re-applies worker changes only when integrator has no changes', () => {
  fs.writeFileSync(path.join(worker, 'worker.txt'), 'worker');
  const skipped = applyWorkersWhenIntegratorEmpty([{ path: 'integrated.txt', status: 'added' }], integrator, [
    { role: 'worker', worktreePath: worker, changes: [{ path: 'worker.txt', status: 'added' }] },
  ]);
  assert.equal(skipped.skipped, true);
  assert.equal(fs.existsSync(path.join(integrator, 'worker.txt')), false);

  const applied = applyWorkersWhenIntegratorEmpty([], integrator, [
    { role: 'worker', worktreePath: worker, changes: [{ path: 'worker.txt', status: 'added' }] },
  ]);
  assert.equal(applied.skipped, false);
  assert.equal(applied.ok, true);
  assert.equal(fs.readFileSync(path.join(integrator, 'worker.txt'), 'utf8'), 'worker');
});
