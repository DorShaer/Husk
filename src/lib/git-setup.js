'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');

const INSTALL_URL = 'https://git-scm.com/install/';

async function folderInfo(root) {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller supplies an authorized chat/project root, or a read-only git status root.
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) return { ok: false, error: 'The working folder is no longer a directory.' };
    let writable = true;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- only tests access to the selected directory; the actual write reports its own result.
    try { await fs.access(root, constants.W_OK); } catch (_) { writable = false; }
    return { ok: true, writable };
  } catch (_) { return { ok: false, error: 'The working folder is missing or cannot be accessed.' }; }
}

async function findRepository(root) {
  let dir = path.resolve(root);
  for (;;) {
    // A .git file also marks a worktree or submodule. Detect the marker even
    // when Git refuses to read it (ownership, permissions or corrupt metadata).
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- examines only .git metadata while walking ancestors of the selected directory.
      const marker = await fs.lstat(path.join(dir, '.git'));
      if (dir === path.resolve(root) || marker.isFile()) return dir;
      // An empty .git directory in an ancestor is not a Git repository. A
      // directory repository has HEAD; a worktree/submodule uses a .git file.
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads only the ancestor repository's HEAD metadata.
      await fs.stat(path.join(dir, '.git', 'HEAD'));
      return dir;
    } catch (_) {}
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- bare repositories have HEAD, objects and refs directly in the selected ancestor.
      const head = await fs.stat(path.join(dir, 'HEAD'));
      if (head.isFile()) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- inspect only the two fixed bare-repository metadata directories.
        const objects = await fs.stat(path.join(dir, 'objects'));
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- inspect only the fixed bare-repository refs directory.
        const refs = await fs.stat(path.join(dir, 'refs'));
        if (objects.isDirectory() && refs.isDirectory()) return dir;
      }
    } catch (_) {}
    const parent = path.dirname(dir);
    if (parent === dir) return '';
    dir = parent;
  }
}

function initFailure(result) {
  if (result.errorCode === 'ENOENT' || result.code === 127) return { ok: false, code: 'git-missing', error: 'Git is not installed or is not on Husk’s PATH. File change tracking still works without it.' };
  if (result.timedOut) return { ok: false, code: 'git-timeout', error: 'Git initialization timed out. Check whether a repository was created before trying again.' };
  if (/permission denied|access is denied|read-only file system|operation not permitted/i.test(result.stderr || '')) return { ok: false, code: 'folder-readonly', error: 'Git could not write to this folder. Choose a writable folder or update its permissions.' };
  return { ok: false, code: 'git-init-failed', error: 'Git could not initialize this folder. Your files are unchanged; check folder permissions and Git configuration before retrying.' };
}

function createGitSetup({ run }) {
  let cached = null, pending = null;
  const initializing = new Set();
  async function available(refresh = false) {
    if (!refresh && cached && Date.now() - cached.at < 15000) return cached.value;
    if (pending) return pending;
    pending = (async () => {
      const result = await run(['--version'], { timeout: 3000 });
      const value = { ok: true, available: result.ok && /^git version\b/i.test(result.stdout || ''), installUrl: INSTALL_URL };
      if (!value.available) value.error = result.errorCode === 'ENOENT' || result.code === 127
        ? 'Git is not installed or is not on Husk’s PATH.'
        : 'Git could not start. Check its installation and try again.';
      cached = { at: Date.now(), value };
      return value;
    })();
    try { return await pending; } finally { pending = null; }
  }
  return {
    available,
    async nonRepository(root) {
      const info = await folderInfo(root);
      if (!info.ok) return info;
      if (await findRepository(root)) return { ok: false, isRepo: true, code: 'git-repository-error', error: 'Git could not read this repository. Check its ownership, permissions or configuration in Source.' };
      return { ok: true, isRepo: false, gitAvailable: true, canInit: info.writable };
    },
    async initialize(root) {
      if (initializing.has(root)) return { ok: false, code: 'git-init-pending', error: 'Git initialization is already in progress for this folder.' };
      initializing.add(root);
      try {
        const git = await available(true);
        if (!git.available) return { ok: false, code: 'git-missing', error: git.error + ' File change tracking still works without it.' };
        const info = await folderInfo(root);
        if (!info.ok) return info;
        if (await findRepository(root)) return { ok: false, code: 'already-repository', error: 'This folder already belongs to a Git repository.' };
        if (!info.writable) return { ok: false, code: 'folder-readonly', error: 'This folder is read-only. Choose a writable folder to initialize Git.' };
        let result = await run(['-C', root, 'init', '-b', 'main'], { timeout: 10000 });
        // Older Git versions cannot name the initial branch during init.
        if (!result.ok && /unknown (switch|option)/i.test(result.stderr || '')) {
          result = await run(['-C', root, 'init'], { timeout: 10000 });
          if (result.ok) result = await run(['-C', root, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { timeout: 3000 });
        }
        if (!result.ok) { cached = null; return initFailure(result); }
        return { ok: true, toplevel: root };
      } finally { initializing.delete(root); }
    },
  };
}

module.exports = { createGitSetup, findRepository, folderInfo, initFailure };
