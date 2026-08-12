'use strict';

// Content-addressed snapshot store for Husk Autonomy Mode.
//
// Captures a workspace tree into a per-session, content-addressed blob
// store and restores from it, so an Autonomy run can always be undone.
//
// Storage layout (everything under storageRoot/sessions/<sessionId>/):
//   snapshot.json         the manifest: path -> { type, sha?, target?, mode? }
//   blobs/<sha256>        content-addressed file body, optionally encrypted
//
// The module is fs-only and cross-platform. Encryption is opt-in via a
// callback, so the unit tests run without Electron and the production
// supervisor wires electron safeStorage. Symlinks are recorded
// structurally rather than followed for content.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSION_DIR_RE = /^[A-Za-z0-9._-]+$/;
const DEFAULT_IGNORE = [
  '.git', 'node_modules', 'dist', 'build', '.DS_Store', '.husk-tmp',
  '.husk-autopilot-status.json',
  // Heavy build, cache, and tooling directories, skipped for walk speed.
  'libs', 'release', 'out', 'target', '.next', '.nuxt', '.cache',
  '.vscode', '.idea', '.parcel-cache', '.turbo', 'coverage',
  'test-results', 'playwright-report', '__pycache__', 'venv', '.venv',
];
// Upper bound on the number of files one snapshot walk captures.
const DEFAULT_MAX_ENTRIES = 50000;

function isSafeSessionId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && SESSION_DIR_RE.test(id);
}

function sessionDir(storageRoot, sessionId) {
  return path.join(storageRoot, 'sessions', sessionId);
}

function blobsDir(storageRoot, sessionId) {
  return path.join(sessionDir(storageRoot, sessionId), 'blobs');
}

function manifestPath(storageRoot, sessionId) {
  return path.join(sessionDir(storageRoot, sessionId), 'snapshot.json');
}

// Whether a run captured a pre-run snapshot.
function hasSnapshot(storageRoot, sessionId) {
  if (!isSafeSessionId(sessionId)) return false;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- manifestPath rooted in storageRoot
    return fs.existsSync(manifestPath(storageRoot, sessionId));
  } catch (_) { return false; }
}

function sha256OfBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Write a content-addressed blob atomically. The `wx` flag creates the
// file in one syscall only when it is absent; EEXIST means the identical
// content is already stored. `seen` holds the shas handled this run and
// dedupes the encrypt plus write.
function writeBlobAtomic(bdir, sha, content, encrypt, seen) {
  if (seen) {
    if (seen.has(sha)) return;
    seen.add(sha);
  }
  const blobAbs = path.join(bdir, sha);
  const toWrite = typeof encrypt === 'function' ? encrypt(content) : content;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- blobAbs is path.join(bdir, sha) bounded to bdir
    fs.writeFileSync(blobAbs, toWrite, { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

// shouldIgnore matches a relative path against the ignore entries by whole
// path segment, so 'dist' matches 'dist' and 'dist/foo' but not 'distinct'.
function shouldIgnore(relPath, ignores) {
  for (const ig of ignores) {
    if (relPath === ig) return true;
    if (relPath.startsWith(ig + path.sep) || relPath.startsWith(ig + '/')) return true;
  }
  return false;
}

// captureSnapshot walks workspaceRoot, records every entry into the
// manifest, and writes content-addressed blobs into the storage dir.
//
// opts:
//   ignore?: string[]        extra ignore patterns (added to DEFAULT_IGNORE)
//   encrypt?: (buf) => Buffer  wrap each blob before writing it
//
// Returns { ok: true, manifest } on success or { ok: false, error }.
function captureSnapshot(workspaceRoot, storageRoot, sessionId, opts = {}) {
  if (!isSafeSessionId(sessionId)) {
    return { ok: false, error: 'invalid sessionId' };
  }
  if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) {
    return { ok: false, error: 'workspaceRoot must be an absolute path' };
  }
  if (typeof storageRoot !== 'string' || !path.isAbsolute(storageRoot)) {
    return { ok: false, error: 'storageRoot must be an absolute path' };
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to workspaceRoot
  if (!fs.existsSync(workspaceRoot)) return { ok: false, error: 'workspaceRoot does not exist' };

  const ignores = DEFAULT_IGNORE.slice();
  if (Array.isArray(opts.ignore)) for (const p of opts.ignore) if (typeof p === 'string' && p) ignores.push(p);

  const bdir = blobsDir(storageRoot, sessionId);
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to storageRoot subdirs
    fs.mkdirSync(bdir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `could not create storage dir: ${err.message}` };
  }

  const entries = {};
  const warnings = [];
  const seen = new Set();
  // Scoped capture records only the named paths instead of walking the tree,
  // so it costs O(named paths) rather than a full project walk.
  const scoped = Array.isArray(opts.paths);
  if (scoped) {
    captureScoped(workspaceRoot, opts.paths, entries, warnings, opts, bdir, seen);
  } else {
    walk(workspaceRoot, '', ignores, entries, warnings, opts, bdir, seen);
  }

  const manifest = {
    v: 1,
    sessionId,
    capturedAt: new Date().toISOString(),
    workspaceRoot,
    // Marks a manifest that describes a slice of the tree rather than the
    // whole tree. Restore takes its additive path for these.
    scoped,
    entries,
  };
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- manifestPath is rooted in storageRoot
    fs.writeFileSync(manifestPath(storageRoot, sessionId), JSON.stringify(manifest, null, 2));
  } catch (err) {
    return { ok: false, error: `could not write manifest: ${err.message}` };
  }
  return { ok: true, manifest, warnings };
}

function walk(absRoot, rel, ignores, entries, warnings, opts, bdir, seen) {
  const here = rel ? path.join(absRoot, rel) : absRoot;
  let dirents;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- absRoot is the validated workspace root
    dirents = fs.readdirSync(here, { withFileTypes: true });
  } catch (err) {
    warnings.push({ path: rel || '.', reason: err.message });
    return 0;
  }
  let captured = 0;
  for (const ent of dirents) {
    const relChild = rel ? path.join(rel, ent.name) : ent.name;
    if (shouldIgnore(relChild, ignores)) continue;
    const abs = path.join(here, ent.name);
    try {
      if (ent.isSymbolicLink()) {
        // Record the symlink structurally; the stored target restores it
        // byte-exact.
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- abs is bounded to absRoot
        const target = fs.readlinkSync(abs);
        entries[relChild] = { type: 'symlink', target };
        captured++;
      } else if (ent.isDirectory()) {
        const n = walk(absRoot, relChild, ignores, entries, warnings, opts, bdir, seen);
        if (!n) {
          entries[relChild] = { type: 'dir' };
          captured++;
        } else {
          captured += n;
        }
      } else if (ent.isFile()) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- abs is bounded to absRoot
        const content = fs.readFileSync(abs);
        const sha = sha256OfBuffer(content);
        writeBlobAtomic(bdir, sha, content, opts.encrypt, seen);
        entries[relChild] = { type: 'file', sha };
        captured++;
      } else {
        // Sockets, devices, and fifos are not captured.
        continue;
      }
    } catch (err) {
      // An entry that vanished or could not be read warns and the walk
      // continues. A file gets an entry with no sha, so the diff reads it
      // as pre-existing and restore leaves its content alone.
      warnings.push({ path: relChild, reason: err.message });
      try { if (ent.isFile()) { entries[relChild] = { type: 'unreadable' }; captured++; } } catch (_) {}
    }
  }
  return captured;
}

// captureScoped records the current state of exactly the paths it is given,
// including the ones that do not exist yet. An 'absent' entry lets restore
// remove that path again, so an undo is symmetric with the apply.
function captureScoped(absRoot, paths, entries, warnings, opts, bdir, seen) {
  for (const rel of paths) {
    if (typeof rel !== 'string' || !rel) continue;
    const abs = joinSafely(absRoot, rel);
    if (!abs) { warnings.push({ path: String(rel), reason: 'path escapes workspaceRoot' }); continue; }
    const key = path.normalize(rel);
    // A link is recorded by its target rather than followed, and readlink says
    // so in one call: it answers only for links, so the kind of everything else
    // comes off the descriptor opened below.
    let target = null;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- abs is bounded to absRoot
    try { target = fs.readlinkSync(abs); } catch (_) { target = null; }
    if (target !== null) { entries[key] = { type: 'symlink', target }; continue; }

    // O_NOFOLLOW refuses a link that appeared since, and O_NONBLOCK keeps a
    // fifo from parking the open until someone writes to it.
    let fd;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- abs is bounded to absRoot
      fd = fs.openSync(abs, fs.constants.O_RDONLY
        | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    } catch (err) {
      if (err && err.code === 'ENOENT') { entries[key] = { type: 'absent' }; continue; }
      // Where a directory cannot be opened for reading it still records as one.
      if (err && err.code === 'EISDIR') { entries[key] = { type: 'dir' }; continue; }
      // Sockets and devices refuse the open and carry no content anyway.
      if (err && (err.code === 'ENXIO' || err.code === 'ENODEV' || err.code === 'ELOOP')) {
        entries[key] = { type: 'unreadable' };
        continue;
      }
      warnings.push({ path: key, reason: err.message });
      entries[key] = { type: 'unreadable' };
      continue;
    }
    try {
      const st = fs.fstatSync(fd);
      if (st.isDirectory()) {
        entries[key] = { type: 'dir' };
      } else if (st.isFile()) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads the numeric fd opened above, not a path
        const content = fs.readFileSync(fd);
        const sha = sha256OfBuffer(content);
        writeBlobAtomic(bdir, sha, content, opts.encrypt, seen);
        entries[key] = { type: 'file', sha };
      } else {
        // Sockets, devices, and fifos are recorded without content.
        entries[key] = { type: 'unreadable' };
      }
    } catch (err) {
      warnings.push({ path: key, reason: err.message });
      entries[key] = { type: 'unreadable' };
    } finally { fs.closeSync(fd); }
  }
}

// pruneEmptyParents removes the directories left empty above a file the
// restore just deleted. Stops at baseAbs and at the first non-empty directory.
function pruneEmptyParents(baseAbs, fileAbs) {
  const baseN = path.resolve(baseAbs);
  let cur = path.dirname(path.resolve(fileAbs));
  while (cur !== baseN && cur.startsWith(baseN + path.sep)) {
    let names;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded under baseAbs
      names = fs.readdirSync(cur);
    } catch (_) { return; }
    if (names.length) return;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded under baseAbs
      fs.rmdirSync(cur);
    } catch (_) { return; }
    cur = path.dirname(cur);
  }
}

// restoreFromSnapshot writes every entry from the manifest back to
// workspaceRoot. Files present in workspace but NOT in the manifest
// are deleted, so the workspace is left byte-equivalent to the
// captured state.
function restoreFromSnapshot(workspaceRoot, storageRoot, sessionId, opts = {}) {
  if (!isSafeSessionId(sessionId)) return { ok: false, error: 'invalid sessionId' };
  if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) {
    return { ok: false, error: 'workspaceRoot must be an absolute path' };
  }
  if (typeof storageRoot !== 'string' || !path.isAbsolute(storageRoot)) {
    return { ok: false, error: 'storageRoot must be an absolute path' };
  }
  let manifest;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- manifestPath rooted in storageRoot
    const raw = fs.readFileSync(manifestPath(storageRoot, sessionId), 'utf8');
    manifest = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `could not read manifest: ${err.message}` };
  }
  if (!manifest || !manifest.entries || typeof manifest.entries !== 'object') {
    return { ok: false, error: 'manifest malformed' };
  }
  // The restore target must be the same directory the snapshot was captured
  // from. A manifest with no recorded root is refused.
  if (!manifest.workspaceRoot || path.resolve(manifest.workspaceRoot) !== path.resolve(workspaceRoot)) {
    return { ok: false, error: 'workspaceRoot does not match the snapshot manifest; refusing to restore' };
  }
  const bdir = blobsDir(storageRoot, sessionId);

  const restored = [];
  const warnings = [];

  // First pass: bring every snapshot entry to its recorded state.
  // Ancestor-chain validation runs once per entry, before any fs mutation.
  for (const relPath of Object.keys(manifest.entries)) {
    const meta = manifest.entries[relPath];
    // No content was captured for an unreadable entry, so whatever is on
    // disk stays. It remains in the keep-set, so the delete pass skips it.
    if (meta && meta.type === 'unreadable') continue;
    const abs = joinSafely(workspaceRoot, relPath);
    if (!abs) { warnings.push({ path: relPath, reason: 'path escapes workspaceRoot' }); continue; }
    // The path did not exist when the snapshot was taken, so restoring it
    // removes whatever sits there now.
    if (meta && meta.type === 'absent') {
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- abs is bounded to workspaceRoot
        fs.rmSync(abs, { recursive: true, force: true });
        pruneEmptyParents(workspaceRoot, abs);
        restored.push(relPath);
      } catch (err) {
        warnings.push({ path: relPath, reason: err.message });
      }
      continue;
    }
    if (!ensureRestoreParent(workspaceRoot, abs)) {
      warnings.push({ path: relPath, reason: 'ancestor path is a symlink, refusing write' });
      continue;
    }
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- abs is bounded to workspaceRoot
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (meta.type === 'dir') {
        try {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- abs is bounded
          const lst = fs.lstatSync(abs);
          if (!lst.isDirectory() || lst.isSymbolicLink()) {
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- abs is bounded
            fs.rmSync(abs, { recursive: true, force: true });
          }
        } catch (_) {}
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- abs is bounded
        fs.mkdirSync(abs, { recursive: true });
      } else if (meta.type === 'symlink') {
        try {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- abs is bounded
          fs.rmSync(abs, { recursive: true, force: true });
        } catch (_) {}
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- abs is bounded
        fs.symlinkSync(meta.target, abs);
      } else if (meta.type === 'file') {
        // Blob names are 64-char lowercase hex, which confines the read to
        // a blob inside bdir.
        if (typeof meta.sha !== 'string' || !/^[a-f0-9]{64}$/.test(meta.sha)) {
          warnings.push({ path: relPath, reason: 'manifest sha is not a 64-char hex string' });
          continue;
        }
        const blobAbs = path.join(bdir, meta.sha);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- blobAbs is path.join(bdir, validated sha)
        let buf = fs.readFileSync(blobAbs);
        if (typeof opts.decrypt === 'function') buf = opts.decrypt(buf);
        // Re-hash the decrypted content and require it to match the manifest.
        if (sha256OfBuffer(buf) !== meta.sha) {
          warnings.push({ path: relPath, reason: 'blob sha mismatch after decrypt' });
          continue;
        }
        // Pre-unlink so the write below lands on a fresh regular file.
        try {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- abs is bounded
          fs.lstatSync(abs);
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- abs is bounded
          fs.rmSync(abs, { recursive: true, force: true });
        } catch (_) {
          // abs did not exist; the write below creates it fresh.
        }
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- abs is bounded
        fs.writeFileSync(abs, buf);
      }
      restored.push(relPath);
    } catch (err) {
      warnings.push({ path: relPath, reason: err.message });
    }
  }

  // Second pass: remove files in the workspace that are NOT in the manifest,
  // so the tree matches the captured state. Honors the same default ignore
  // list, so directories that were never snapped stay put.
  //
  // opts.preserveExtras: true skips this pass and keeps whatever the agent
  // added. A scoped manifest always takes that additive path, since it
  // describes a slice of the tree rather than the whole of it.
  if (opts.preserveExtras !== true && manifest.scoped !== true) {
    const ignores = DEFAULT_IGNORE.slice();
    if (Array.isArray(opts.ignore)) for (const p of opts.ignore) if (typeof p === 'string' && p) ignores.push(p);
    removeExtras(workspaceRoot, '', new Set(Object.keys(manifest.entries)), ignores, warnings);
  }

  return { ok: true, restored, warnings };
}

// validateAncestorChain returns true when every path component between
// baseAbs and the parent of fileAbs is either non-existent (mkdirSync
// creates it freshly) or a real directory. A symlink on the chain
// returns false.
function validateAncestorChain(baseAbs, fileAbs) {
  const baseN = path.resolve(baseAbs);
  const parent = path.dirname(fileAbs);
  if (parent === baseN || parent === path.dirname(baseN)) return true;
  const rel = path.relative(baseN, parent);
  if (!rel || rel.startsWith('..')) return false;
  let cur = baseN;
  for (const seg of rel.split(path.sep)) {
    cur = path.join(cur, seg);
    let lst;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded under baseAbs
      lst = fs.lstatSync(cur);
    } catch (_) {
      // does not exist; mkdirSync will create it as a real directory
      return true;
    }
    if (lst.isSymbolicLink()) return false;
    if (!lst.isDirectory()) return false;
  }
  return true;
}

function ensureRestoreParent(baseAbs, fileAbs) {
  const baseN = path.resolve(baseAbs);
  const parent = path.dirname(fileAbs);
  if (parent === baseN || parent === path.dirname(baseN)) return true;
  const rel = path.relative(baseN, parent);
  if (!rel || rel.startsWith('..')) return false;
  let cur = baseN;
  for (const seg of rel.split(path.sep)) {
    cur = path.join(cur, seg);
    let lst;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded under baseAbs
      lst = fs.lstatSync(cur);
    } catch (_) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded under baseAbs
      fs.mkdirSync(parent, { recursive: true });
      return true;
    }
    if (lst.isSymbolicLink()) return false;
    if (!lst.isDirectory()) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded under baseAbs
      fs.rmSync(cur, { recursive: true, force: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded under baseAbs
      fs.mkdirSync(parent, { recursive: true });
      return true;
    }
  }
  return true;
}

function joinSafely(base, rel) {
  // Confines the path to the root. Returns null when the normalized entry
  // resolves outside base. path.resolve normalizes any trailing separator.
  const baseN = path.resolve(base);
  const norm = path.normalize(rel);
  if (norm.startsWith('..') || path.isAbsolute(norm)) return null;
  const abs = path.join(baseN, norm);
  if (!abs.startsWith(baseN + path.sep) && abs !== baseN) return null;
  return abs;
}

function removeExtras(absRoot, rel, keepSet, ignores, warnings) {
  const here = rel ? path.join(absRoot, rel) : absRoot;
  let dirents;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- absRoot bounded
    dirents = fs.readdirSync(here, { withFileTypes: true });
  } catch (err) {
    warnings.push({ path: rel || '.', reason: err.message });
    return;
  }
  for (const ent of dirents) {
    const relChild = rel ? path.join(rel, ent.name) : ent.name;
    if (shouldIgnore(relChild, ignores)) continue;
    const abs = path.join(here, ent.name);
    if (ent.isDirectory() && !ent.isSymbolicLink()) {
      removeExtras(absRoot, relChild, keepSet, ignores, warnings);
      // Remove the directory when it ended up empty and is not in the
      // manifest.
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- abs bounded
        if (fs.readdirSync(abs).length === 0 && !anyKeptUnder(keepSet, relChild)) {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- abs bounded
          fs.rmdirSync(abs);
        }
      } catch (_) {}
    } else if (!keepSet.has(relChild)) {
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- abs bounded
        fs.rmSync(abs, { force: true });
      } catch (err) {
        warnings.push({ path: relChild, reason: err.message });
      }
    }
  }
}

function anyKeptUnder(keepSet, relDir) {
  const prefix = relDir + path.sep;
  for (const k of keepSet) if (k === relDir || k.startsWith(prefix) || k.startsWith(relDir + '/')) return true;
  return false;
}

// diffWorkspace compares the live workspace to the captured manifest
// and returns one record per changed path. unchanged files are omitted.
function diffWorkspace(workspaceRoot, storageRoot, sessionId, opts = {}) {
  if (!isSafeSessionId(sessionId)) return { ok: false, error: 'invalid sessionId' };
  if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) {
    return { ok: false, error: 'workspaceRoot must be an absolute path' };
  }
  if (typeof storageRoot !== 'string' || !path.isAbsolute(storageRoot)) {
    return { ok: false, error: 'storageRoot must be an absolute path' };
  }
  let manifest;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- manifestPath rooted
    manifest = JSON.parse(fs.readFileSync(manifestPath(storageRoot, sessionId), 'utf8'));
  } catch (err) {
    return { ok: false, error: `could not read manifest: ${err.message}` };
  }

  const ignores = DEFAULT_IGNORE.slice();
  if (Array.isArray(opts.ignore)) for (const p of opts.ignore) if (typeof p === 'string' && p) ignores.push(p);

  const seen = new Set();
  const changes = [];
  const warnings = [];
  walkForDiff(workspaceRoot, '', ignores, manifest.entries, seen, changes, warnings);
  for (const relPath of Object.keys(manifest.entries)) {
    if (!seen.has(relPath)) changes.push({ path: relPath, status: 'deleted' });
  }
  return { ok: true, changes, warnings };
}

function walkForDiff(absRoot, rel, ignores, manifestEntries, seen, changes, warnings) {
  const here = rel ? path.join(absRoot, rel) : absRoot;
  let dirents;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- absRoot bounded
    dirents = fs.readdirSync(here, { withFileTypes: true });
  } catch (err) {
    warnings.push({ path: rel || '.', reason: err.message });
    return;
  }
  for (const ent of dirents) {
    const relChild = rel ? path.join(rel, ent.name) : ent.name;
    if (shouldIgnore(relChild, ignores)) continue;
    const abs = path.join(here, ent.name);
    try {
      if (ent.isSymbolicLink()) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- abs bounded
        const target = fs.readlinkSync(abs);
        const expected = manifestEntries[relChild];
        seen.add(relChild);
        if (!expected) { changes.push({ path: relChild, status: 'added' }); continue; }
        if (expected.type !== 'symlink' || expected.target !== target) {
          changes.push({ path: relChild, status: 'modified' });
        }
      } else if (ent.isDirectory()) {
        const expected = manifestEntries[relChild];
        if (expected) {
          seen.add(relChild);
          if (expected.type !== 'dir') changes.push({ path: relChild, status: 'modified' });
        }
        walkForDiff(absRoot, relChild, ignores, manifestEntries, seen, changes, warnings);
      } else if (ent.isFile()) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- abs bounded
        const sha = sha256OfBuffer(fs.readFileSync(abs));
        const expected = manifestEntries[relChild];
        seen.add(relChild);
        if (!expected) { changes.push({ path: relChild, status: 'added' }); continue; }
        if (expected.type !== 'file' || expected.sha !== sha) {
          changes.push({ path: relChild, status: 'modified' });
        }
      }
    } catch (err) {
      warnings.push({ path: relChild, reason: err.message });
    }
  }
}

// captureSnapshotAsync matches captureSnapshot but yields to the event loop
// every YIELD_EVERY entries, so the main process keeps painting while a
// large workspace is walked. fs reads stay synchronous.
const YIELD_EVERY = 50;
async function captureSnapshotAsync(workspaceRoot, storageRoot, sessionId, opts = {}) {
  // A scoped capture touches only the paths it is handed, so there is no
  // long walk to yield out of.
  if (Array.isArray(opts.paths)) return captureSnapshot(workspaceRoot, storageRoot, sessionId, opts);
  if (!isSafeSessionId(sessionId)) return { ok: false, error: 'invalid sessionId' };
  if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) {
    return { ok: false, error: 'workspaceRoot must be an absolute path' };
  }
  if (typeof storageRoot !== 'string' || !path.isAbsolute(storageRoot)) {
    return { ok: false, error: 'storageRoot must be an absolute path' };
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to workspaceRoot
  if (!fs.existsSync(workspaceRoot)) return { ok: false, error: 'workspaceRoot does not exist' };

  const ignores = DEFAULT_IGNORE.slice();
  if (Array.isArray(opts.ignore)) for (const p of opts.ignore) if (typeof p === 'string' && p) ignores.push(p);

  const bdir = blobsDir(storageRoot, sessionId);
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to storageRoot subdirs
    fs.mkdirSync(bdir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `could not create storage dir: ${err.message}` };
  }

  const entries = {};
  const warnings = [];
  const maxEntries = Number.isFinite(opts.maxEntries) && opts.maxEntries > 0 ? opts.maxEntries : DEFAULT_MAX_ENTRIES;
  const state = { count: 0, aborted: false, maxEntries, seen: new Set(), onProgress: typeof opts.onProgress === 'function' ? opts.onProgress : null };
  await walkAsync(workspaceRoot, '', ignores, entries, warnings, opts, bdir, state);
  if (state.aborted) {
    return { ok: false, error: `workspace exceeds ${maxEntries} files; pick a narrower scope` };
  }

  const manifest = { v: 1, sessionId, capturedAt: new Date().toISOString(), workspaceRoot, entries };
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- manifestPath rooted in storageRoot
    fs.writeFileSync(manifestPath(storageRoot, sessionId), JSON.stringify(manifest, null, 2));
  } catch (err) {
    return { ok: false, error: `could not write manifest: ${err.message}` };
  }
  return { ok: true, manifest, warnings, fileCount: state.count };
}

async function walkAsync(absRoot, rel, ignores, entries, warnings, opts, bdir, state) {
  if (state.aborted) return 0;
  const here = rel ? path.join(absRoot, rel) : absRoot;
  let dirents;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- absRoot is the validated workspace root
    dirents = fs.readdirSync(here, { withFileTypes: true });
  } catch (err) {
    warnings.push({ path: rel || '.', reason: err.message });
    return 0;
  }
  let captured = 0;
  for (const ent of dirents) {
    if (state.aborted) return captured;
    const relChild = rel ? path.join(rel, ent.name) : ent.name;
    if (shouldIgnore(relChild, ignores)) continue;
    const abs = path.join(here, ent.name);
    try {
      if (ent.isSymbolicLink()) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- abs is bounded
        const target = fs.readlinkSync(abs);
        entries[relChild] = { type: 'symlink', target };
        captured++;
      } else if (ent.isDirectory()) {
        const n = await walkAsync(absRoot, relChild, ignores, entries, warnings, opts, bdir, state);
        if (!n) {
          entries[relChild] = { type: 'dir' };
          captured++;
        } else {
          captured += n;
        }
      } else if (ent.isFile()) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- abs is bounded
        const content = fs.readFileSync(abs);
        const sha = sha256OfBuffer(content);
        writeBlobAtomic(bdir, sha, content, opts.encrypt, state.seen);
        entries[relChild] = { type: 'file', sha };
        captured++;
        state.count++;
        if (state.count >= state.maxEntries) { state.aborted = true; return captured; }
        if (state.count % YIELD_EVERY === 0) {
          if (state.onProgress) {
            try { state.onProgress({ count: state.count, currentPath: relChild }); } catch (_) {}
          }
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    } catch (err) {
      warnings.push({ path: relChild, reason: err.message });
      // See walk(): an unreadable file still gets a content-less entry, so
      // the diff reads it as pre-existing.
      try { if (ent.isFile()) { entries[relChild] = { type: 'unreadable' }; captured++; } } catch (_) {}
    }
  }
  return captured;
}

// diffWorkspaceAsync matches diffWorkspace but yields to the event loop
// every YIELD_EVERY entries, so polling the live diff from the autonomy
// page keeps the main process responsive.
async function diffWorkspaceAsync(workspaceRoot, storageRoot, sessionId, opts = {}) {
  if (!isSafeSessionId(sessionId)) return { ok: false, error: 'invalid sessionId' };
  if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) {
    return { ok: false, error: 'workspaceRoot must be an absolute path' };
  }
  if (typeof storageRoot !== 'string' || !path.isAbsolute(storageRoot)) {
    return { ok: false, error: 'storageRoot must be an absolute path' };
  }
  let manifest;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- manifestPath rooted
    manifest = JSON.parse(fs.readFileSync(manifestPath(storageRoot, sessionId), 'utf8'));
  } catch (err) {
    return { ok: false, error: `could not read manifest: ${err.message}` };
  }
  const ignores = DEFAULT_IGNORE.slice();
  if (Array.isArray(opts.ignore)) for (const p of opts.ignore) if (typeof p === 'string' && p) ignores.push(p);
  const seen = new Set();
  const changes = [];
  const warnings = [];
  const state = { count: 0 };
  await walkForDiffAsync(workspaceRoot, '', ignores, manifest.entries, seen, changes, warnings, state);
  for (const relPath of Object.keys(manifest.entries)) {
    if (!seen.has(relPath)) changes.push({ path: relPath, status: 'deleted' });
  }
  return { ok: true, changes, warnings };
}

async function walkForDiffAsync(absRoot, rel, ignores, manifestEntries, seen, changes, warnings, state) {
  const here = rel ? path.join(absRoot, rel) : absRoot;
  let dirents;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- absRoot bounded
    dirents = fs.readdirSync(here, { withFileTypes: true });
  } catch (err) {
    warnings.push({ path: rel || '.', reason: err.message });
    return;
  }
  for (const ent of dirents) {
    const relChild = rel ? path.join(rel, ent.name) : ent.name;
    if (shouldIgnore(relChild, ignores)) continue;
    const abs = path.join(here, ent.name);
    try {
      if (ent.isSymbolicLink()) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- abs bounded
        const target = fs.readlinkSync(abs);
        const expected = manifestEntries[relChild];
        seen.add(relChild);
        if (!expected) { changes.push({ path: relChild, status: 'added' }); continue; }
        if (expected.type !== 'symlink' || expected.target !== target) {
          changes.push({ path: relChild, status: 'modified' });
        }
      } else if (ent.isDirectory()) {
        const expected = manifestEntries[relChild];
        if (expected) {
          seen.add(relChild);
          if (expected.type !== 'dir') changes.push({ path: relChild, status: 'modified' });
        }
        await walkForDiffAsync(absRoot, relChild, ignores, manifestEntries, seen, changes, warnings, state);
      } else if (ent.isFile()) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- abs bounded
        const sha = sha256OfBuffer(fs.readFileSync(abs));
        const expected = manifestEntries[relChild];
        seen.add(relChild);
        if (!expected) { changes.push({ path: relChild, status: 'added' }); }
        else if (expected.type !== 'file' || expected.sha !== sha) {
          changes.push({ path: relChild, status: 'modified' });
        }
        state.count++;
        if (state.count % 50 === 0) await new Promise((resolve) => setImmediate(resolve));
      }
    } catch (err) {
      warnings.push({ path: relChild, reason: err.message });
    }
  }
}

module.exports = {
  DEFAULT_IGNORE,
  DEFAULT_MAX_ENTRIES,
  captureSnapshot,
  captureSnapshotAsync,
  restoreFromSnapshot,
  diffWorkspace,
  diffWorkspaceAsync,
  hasSnapshot,
  // exported for unit tests; not part of the public API.
  _internal: { sha256OfBuffer, isSafeSessionId, shouldIgnore, joinSafely, validateAncestorChain },
};
