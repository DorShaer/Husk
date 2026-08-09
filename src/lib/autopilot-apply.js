'use strict';

// Apply or discard the changes an Autopilot run made inside its isolated
// worktree. A run executes in <userData>/autopilot-worktrees/<runId>, a full
// git worktree of the project at run start. Its edits live there and NOWHERE
// else until the operator explicitly applies them, so this module is what
// turns a reviewed run into real changes in the workspace.
//
// Design rules:
//   - Never copy outside the destination workspace root (path confinement).
//   - Report per-file results honestly: a partial apply must be visible, not
//     hidden behind a single "success". This mirrors the snapshot/revert
//     contract elsewhere in the codebase.
//   - Deterministic and side-effect-scoped: only the paths named in `changes`
//     are touched.

const fs = require('fs');
const path = require('path');
const { STATUS_FILE } = require('./autopilot-status');
const { realParentInside, realPathInside } = require('./path-confine');

// A change entry is { path: <relative>, status: 'added'|'modified'|'deleted' },
// exactly the shape diffWorkspace/diffWorkspaceAsync already emit.
function isSafeRelPath(rel) {
  if (typeof rel !== 'string' || !rel) return false;
  if (path.isAbsolute(rel)) return false;
  const norm = path.normalize(rel);
  if (norm === '..' || norm.startsWith('..' + path.sep)) return false;
  if (norm.split(path.sep).includes('..')) return false;
  return true;
}

// Copy one file from the worktree into the workspace, creating parent dirs.
function copyInto(worktreePath, workspaceRoot, rel) {
  const src = path.join(worktreePath, rel);
  const dst = path.join(workspaceRoot, rel);
  // Re-confine after join: both must still sit under their roots.
  if (!path.resolve(dst).startsWith(path.resolve(workspaceRoot) + path.sep)) {
    return { path: rel, ok: false, reason: 'destination escapes workspace root' };
  }
  if (!path.resolve(src).startsWith(path.resolve(worktreePath) + path.sep)) {
    return { path: rel, ok: false, reason: 'source escapes worktree root' };
  }
  try {
    // Source must resolve to a regular file under the worktree.
    let srcReal;
    try { srcReal = fs.realpathSync(src); } catch (_) {
      return { path: rel, ok: false, reason: 'source could not be resolved' };
    }
    if (!realPathInside(src, worktreePath)) {
      return { path: rel, ok: false, reason: 'source resolves outside worktree root' };
    }
    if (!fs.lstatSync(srcReal).isFile()) {
      return { path: rel, ok: false, reason: 'source is not a regular file' };
    }

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dst re-confined under workspaceRoot above
    fs.mkdirSync(path.dirname(dst), { recursive: true });

    // Destination parent must resolve under the workspace.
    if (!realParentInside(dst, workspaceRoot)) {
      return { path: rel, ok: false, reason: 'destination resolves outside workspace root' };
    }
    let existing = null;
    try { existing = fs.lstatSync(dst); } catch (_) { existing = null; }
    if (existing && existing.isSymbolicLink()) {
      return { path: rel, ok: false, reason: 'destination is a symbolic link' };
    }
    if (existing && !existing.isFile()) {
      return { path: rel, ok: false, reason: 'destination is not a regular file' };
    }

    const buf = fs.readFileSync(srcReal);
    const fd = fs.openSync(dst, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC
      | (fs.constants.O_NOFOLLOW || 0), 0o644);
    try { fs.writeFileSync(fd, buf); } finally { fs.closeSync(fd); }
    return { path: rel, ok: true, status: 'written' };
  } catch (err) {
    return { path: rel, ok: false, reason: (err && err.message) || String(err) };
  }
}

// Delete one file from the workspace, with its parent confined under root.
function deleteFrom(workspaceRoot, rel) {
  const dst = path.join(workspaceRoot, rel);
  if (!path.resolve(dst).startsWith(path.resolve(workspaceRoot) + path.sep)) {
    return { path: rel, ok: false, reason: 'target escapes workspace root' };
  }
  try {
    try {
      if (!realParentInside(dst, workspaceRoot)) {
        return { path: rel, ok: false, reason: 'target resolves outside workspace root' };
      }
    } catch (_) {
      // No parent means nothing to delete.
      return { path: rel, ok: true, status: 'deleted' };
    }
    fs.rmSync(dst, { force: true });
    return { path: rel, ok: true, status: 'deleted' };
  } catch (err) {
    return { path: rel, ok: false, reason: (err && err.message) || String(err) };
  }
}

// Apply a run's changes from its worktree into the real workspace.
//
//   worktreePath  - the run's isolated worktree
//   workspaceRoot - the original project root to write into
//   changes       - [{ path, status }] from the run summary/diff
//
// Returns { ok, applied: [...], failed: [...] }. `ok` is true only when every
// change succeeded; a partial apply returns ok:false with the failures named.
function applyWorktreeChanges(worktreePath, workspaceRoot, changes) {
  if (!worktreePath || !workspaceRoot) {
    return { ok: false, applied: [], failed: [], error: 'worktreePath and workspaceRoot are required' };
  }
  if (!Array.isArray(changes)) {
    return { ok: false, applied: [], failed: [], error: 'changes must be an array' };
  }
  const applied = [];
  const failed = [];
  for (const c of changes) {
    const rel = c && c.path;
    if (rel === STATUS_FILE) continue;
    if (!isSafeRelPath(rel)) {
      failed.push({ path: String(rel), ok: false, reason: 'unsafe or non-relative path' });
      continue;
    }
    let res;
    if (c.status === 'deleted') {
      res = deleteFrom(workspaceRoot, rel);
    } else {
      // added or modified both resolve to a copy from the worktree.
      res = copyInto(worktreePath, workspaceRoot, rel);
    }
    if (res.ok) applied.push(res); else failed.push(res);
  }
  return { ok: failed.length === 0, applied, failed };
}

module.exports = { applyWorktreeChanges, isSafeRelPath };
