'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = require('os').homedir();

// Managed root under which all Autopilot worktrees live.
// Pass userData as the first argument; worktrees land at
// <userData>/autopilot-worktrees/<runId>.
function worktreeRoot(userData) {
  return path.join(userData, 'autopilot-worktrees');
}

// Check that a resolved path sits under a given base (and is not the base).
function isConfined(resolved, base) {
  const b = path.resolve(base);
  return resolved.startsWith(b + path.sep);
}

// Create a git worktree for an Autopilot run.
//
//   userData       - Electron app.getPath('userData')
//   runId          - unique run identifier (used as dir name)
//   workspaceRoot  - the active project path (must be a git repo)
//
// Returns { ok: true, worktreePath } or { ok: false, error }.
function createRunWorktree(userData, runId, workspaceRoot) {
  if (!userData || !runId || !workspaceRoot) {
    return { ok: false, error: 'createRunWorktree: userData, runId, and workspaceRoot are required' };
  }

  const resolvedWs = path.resolve(workspaceRoot);
  const resolvedHome = path.resolve(HOME);

  // Belt and suspenders: never let a worktree be created for HOME.
  if (resolvedWs === resolvedHome) {
    return { ok: false, error: 'worktree refused for home directory' };
  }

  // Must be a git repository.
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: resolvedWs, stdio: 'pipe' });
  } catch (_) {
    return { ok: false, error: 'project is not a git repository; Autopilot requires git for worktree isolation' };
  }

  const wtRoot = worktreeRoot(userData);
  const wtPath = path.join(wtRoot, runId);
  const resolvedWt = path.resolve(wtPath);
  const resolvedWtRoot = path.resolve(wtRoot);

  // Confine the worktree path under its managed root.
  if (!isConfined(resolvedWt, resolvedWtRoot)) {
    return { ok: false, error: 'worktree path escapes managed root' };
  }

  // The worktree must not resolve to HOME or above it.
  if (resolvedWt === resolvedHome || resolvedHome.startsWith(resolvedWt + path.sep)) {
    return { ok: false, error: 'worktree path resolves to or above HOME' };
  }

  // The worktree must not resolve inside the project tree.
  if (isConfined(resolvedWt, resolvedWs)) {
    return { ok: false, error: 'worktree path must not be inside the project directory' };
  }

  try {
    fs.mkdirSync(wtRoot, { recursive: true });
    execFileSync('git', ['worktree', 'add', wtPath, 'HEAD'], { cwd: resolvedWs, stdio: 'pipe' });
    return { ok: true, worktreePath: wtPath };
  } catch (err) {
    return { ok: false, error: `git worktree add failed: ${(err && err.stderr && err.stderr.toString()) || (err && err.message) || String(err)}` };
  }
}

// Remove a worktree after a run ends.
// Uses `git worktree remove --force` first; falls back to rmSync if git fails.
//
//   worktreePath   - path returned by createRunWorktree
//   workspaceRoot  - the original project root (used as cwd for git)
function removeRunWorktree(worktreePath, workspaceRoot) {
  if (!worktreePath) return;
  const cwd = workspaceRoot || path.dirname(worktreePath);
  try {
    execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], { cwd, stdio: 'pipe' });
    return;
  } catch (_) {}
  // Fallback: manual rm.
  try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch (_) {}
}

module.exports = { createRunWorktree, removeRunWorktree, worktreeRoot };
