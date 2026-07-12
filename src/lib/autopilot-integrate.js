'use strict';

const { applyWorktreeChanges } = require('./autopilot-apply');

function normalizeWorker(worker) {
  if (!worker || typeof worker !== 'object') return null;
  const worktreePath = typeof worker.worktreePath === 'string' ? worker.worktreePath : '';
  const role = typeof worker.role === 'string' && worker.role.trim() ? worker.role.trim() : 'worker';
  const changes = Array.isArray(worker.changes) ? worker.changes : [];
  if (!worktreePath || !changes.length) return null;
  return { role, worktreePath, changes };
}

function applyWorkerChangesToIntegrator(integratorWorktree, workers) {
  if (!integratorWorktree) {
    return { ok: false, applied: [], failed: [], error: 'integratorWorktree is required' };
  }
  if (!Array.isArray(workers)) {
    return { ok: false, applied: [], failed: [], error: 'workers must be an array' };
  }
  const applied = [];
  const failed = [];
  for (const raw of workers) {
    const worker = normalizeWorker(raw);
    if (!worker) continue;
    const result = applyWorktreeChanges(worker.worktreePath, integratorWorktree, worker.changes);
    for (const item of result.applied || []) applied.push({ ...item, role: worker.role });
    for (const item of result.failed || []) failed.push({ ...item, role: worker.role });
  }
  return { ok: failed.length === 0, applied, failed };
}

function applyWorkersWhenIntegratorEmpty(currentChanges, integratorWorktree, workers) {
  if (Array.isArray(currentChanges) && currentChanges.length > 0) {
    return { skipped: true, ok: true, applied: [], failed: [], reason: 'integrator already has changes' };
  }
  const result = applyWorkerChangesToIntegrator(integratorWorktree, workers);
  return { ...result, skipped: false };
}

module.exports = {
  applyWorkersWhenIntegratorEmpty,
  applyWorkerChangesToIntegrator,
  normalizeWorker,
};
