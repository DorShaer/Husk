'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { STATUS_FILE, normalizeStatus, readStatus, statusPath } = require('../../src/lib/autopilot-status');

test('normalizeStatus accepts complete verified state', () => {
  const res = normalizeStatus({
    status: 'complete',
    progress: 100,
    currentStep: 'Verified dependency bump',
    summary: 'Updated manifests and lockfile.',
    blockers: [],
    files: ['package.json', 'package-lock.json'],
    verification: { passed: true, commands: ['npm test'], notes: 'all passed' },
  });
  assert.equal(res.ok, true);
  assert.equal(res.state.status, 'complete');
  assert.equal(res.state.progress, 100);
  assert.deepEqual(res.state.files, ['package.json', 'package-lock.json']);
  assert.equal(res.state.verification.passed, true);
});

test('normalizeStatus rejects unknown states and clamps progress', () => {
  assert.equal(normalizeStatus({ status: 'waiting' }).ok, false);
  const res = normalizeStatus({ status: 'running', progress: 120 });
  assert.equal(res.ok, true);
  assert.equal(res.state.progress, 100);
});

test('readStatus reads the status file from the workspace root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-status-test-'));
  try {
    fs.writeFileSync(path.join(dir, STATUS_FILE), JSON.stringify({
      status: 'blocked',
      progress: 40,
      currentStep: 'Waiting on dependency resolver',
      blockers: ['lockfile conflict'],
    }));
    const res = readStatus(dir);
    assert.equal(res.ok, true);
    assert.equal(res.path, statusPath(dir));
    assert.equal(res.state.status, 'blocked');
    assert.deepEqual(res.state.blockers, ['lockfile conflict']);
    assert.ok(res.signature);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
