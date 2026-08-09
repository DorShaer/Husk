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
const { realParentInside } = require('./path-confine');

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

// Why the string check below is not the whole confinement.
//
// path.resolve is pure string arithmetic: it collapses "..", it does not read
// the filesystem, and it therefore says nothing about what a name points at. A
// destination that is a symlink still resolves to a string under the workspace
// root, and copyFileSync follows it and writes to the target. A directory
// component that is a symlink does the same for everything beneath it.
//
// That gap is reachable here rather than theoretical. Autopilot runs the agent
// with every approval gate disabled (see autopilot-args.js), steered by the
// contents of a repository somebody else wrote, and git stores symlinks, so a
// checked-in link at a path the agent is nudged into writing turns a diff the
// operator approved for `config.json` into a write to whatever that link names.
//
// So the destination is confined by the filesystem's own answer: the parent
// directory is canonicalized and re-checked, and the final component is refused
// outright when it is a link. An apply writes the path the operator reviewed or
// it writes nothing.
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
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dst re-confined under workspaceRoot above
    fs.mkdirSync(path.dirname(dst), { recursive: true });

    // The parent as the filesystem resolves it, so a symlinked directory
    // anywhere along the path is caught rather than trusted.
    if (!realParentInside(dst, workspaceRoot)) {
      return { path: rel, ok: false, reason: 'destination resolves outside workspace root' };
    }
    // The final component, by lstat so the link itself is what is inspected.
    let existing = null;
    try { existing = fs.lstatSync(dst); } catch (_) { existing = null; }
    if (existing && existing.isSymbolicLink()) {
      return { path: rel, ok: false, reason: 'destination is a symbolic link' };
    }
    if (existing && !existing.isFile()) {
      return { path: rel, ok: false, reason: 'destination is not a regular file' };
    }

    // Written through a descriptor opened with O_NOFOLLOW, so the path cannot
    // be swapped for a link between the check above and the write. O_NOFOLLOW
    // is POSIX; where it is absent the checks above remain the guard.
    const buf = fs.readFileSync(src);
    const fd = fs.openSync(dst, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC
      | (fs.constants.O_NOFOLLOW || 0), 0o644);
    try { fs.writeFileSync(fd, buf); } finally { fs.closeSync(fd); }
    return { path: rel, ok: true, status: 'written' };
  } catch (err) {
    return { path: rel, ok: false, reason: (err && err.message) || String(err) };
  }
}

// Delete one file from the workspace (the run removed it in its worktree).
// rmSync on a link removes the link and not its target, so a delete cannot
// destroy a file outside the workspace by that route. The parent is still
// canonicalized for the same reason as the copy: a symlinked directory
// component would place the whole delete somewhere the operator never saw.
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
      // A parent that no longer exists means there is nothing to delete, which
      // is the same end state a successful delete reaches.
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
