'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const autonomy = require('../../src/lib/autonomy');

test('autonomy barrel exposes every autonomy submodule', () => {
  assert.deepEqual(Object.keys(autonomy).sort(), [
    'audit',
    'budget',
    'progress',
    'receipt',
    'snapshot',
    'supervisor',
  ]);
  assert.equal(autonomy.snapshot.captureSnapshot, require('../../src/lib/autonomy/snapshot').captureSnapshot);
  assert.equal(autonomy.audit.createAuditLog, require('../../src/lib/autonomy/audit').createAuditLog);
  assert.equal(autonomy.budget.createBudgetMeter, require('../../src/lib/autonomy/budget').createBudgetMeter);
  assert.equal(autonomy.progress.createProgressMeter, require('../../src/lib/autonomy/progress').createProgressMeter);
  assert.equal(autonomy.supervisor.startRun, require('../../src/lib/autonomy/supervisor').startRun);
  assert.equal(autonomy.receipt.buildFleetReceipt, require('../../src/lib/autonomy/receipt').buildFleetReceipt);
});
