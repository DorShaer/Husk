'use strict';

// Content-addressed snapshot store for Husk Autonomy Mode.
//
// Captures a workspace tree into a per-session, content-addressed
// blob store and restores from it. The trust mechanic for Autonomy
// runs is "you can always undo": before the agent starts, we snap
// the workspace; after, the user can revert any or all changes from
// the snapshot.
//
// Storage layout (everything under storageRoot/sessions/<sessionId>/):
//   snapshot.json         the manifest: path -> { type, sha?, target?, mode? }
//   blobs/<sha256>        content-addressed file body, optionally encrypted
//
// The module is pure / fs-only. Cross-platform (path.join everywhere,
// no POSIX-only assumptions, no chmod for security). Encryption is
// opt-in via a callback so the unit tests can run without Electron
// and the production supervisor can wire electron safeStorage.
//
// Design rules enforced inside this module:
//   - never writes outside storageRoot/sessions/<sessionId>/
//   - never modifies files outside workspaceRoot during restore
//   - encryption (when supplied) wraps every blob, not just "secrets"
//   - symlinks are recorded structurally, never followed for content
//   - rejects sessionId values that could escape the storage dir

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSION_DIR_RE = /^[A-Za-z0-9._-]+$/;
const DEFAULT_IGNORE = [
  '.git', 'node_modules', 'dist', 'build', '.DS_Store', '.husk-tmp',
  '.husk-autopilot-status.json',
  // Common heavy directories that explode snapshot time without
  // contributing real "did the agent change my code" signal.
  'libs', 'release', 'out', 'target', '.next', '.nuxt', '.cache',
  '.vscode', '.idea', '.parcel-cache', '.turbo', 'coverage',
  'test-results', 'playwright-report', '__pycache__', 'venv', '.venv',
];
// Belt and suspenders: refuse to snapshot a workspace with more
// than this many files. An unguarded walk of $HOME would hang the
// app ("Husk is not responding"). A real project repo is well
// under this limit; if a user hits it, they almost certainly
// picked the wrong scope.
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

// Whether a run captured a pre-run snapshot. Runs started with the snapshot
// toggle off write no manifest, so revert has nothing to restore.
function hasSnapshot(storageRoot, sessionId) {
  if (!isSafeSessionId(sessionId)) return false;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- manifestPath rooted in storageRoot
    return fs.existsSync(manifestPath(storageRoot, sessionId));
  } catch (_) { return false; }
}

// sha256OfBuffer is a tiny helper kept separate so the test suite
// can synthesize expected hashes without rebuilding the whole module.
function sha256OfBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Write a content-addressed blob atomically. The `wx` flag is
// O_CREAT|O_EXCL: it creates the file only if it does not already exist,
// in a single syscall, so there is no check-then-write race. An EEXIST
// just means the identical content is already stored (blobs are keyed by
// their own sha256), so it is ignored.
//
// `seen` is an in-memory Set of shas already handled this run. It dedupes
// the (potentially expensive) encrypt + write so identical content is
// encrypted once per run, without an fs existence check.
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

// shouldIgnore returns true when the relative path (as walked) starts
// with any of the ignore entries. Match is "starts with the entry as
// a full path segment", so an ignore entry of 'dist' matches 'dist'
// and 'dist/foo' but not 'distinct'.
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
  walk(workspaceRoot, '', ignores, entries, warnings, opts, bdir, seen);

  const manifest = {
    v: 1,
    sessionId,
    capturedAt: new Date().toISOString(),
    workspaceRoot,
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
        // Record the symlink without following it. Storing the target
        // verbatim is enough to restore the link byte-exact later.
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
        // Sockets, devices, fifos. Ignore: not meaningful for the
        // "did the agent change my files" question.
        continue;
      }
    } catch (err) {
      // A file vanished, became unreadable, or hit a transient FS
      // error mid-walk. Record a warning and move on; do NOT abort
      // the whole snapshot.
      warnings.push({ path: relChild, reason: err.message });
      // If it was a file we simply could not read (transient lock,
      // permission blip), still record it as a pre-existing entry so the
      // diff does not later call it "added" and a revert does not delete
      // a file the agent never touched. We cannot hash it, so it carries
      // no sha and restore leaves its content alone.
      try { if (ent.isFile()) { entries[relChild] = { type: 'unreadable' }; captured++; } } catch (_) {}
    }
  }
  return captured;
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
  // Safety cross-check: the restore target must be the same directory the
  // snapshot was captured from. The second pass deletes every workspace
  // file not in the manifest, so restoring into the wrong root (e.g. a
  // caller that fell back to HOME for an empty workspaceRoot) would wipe
  // an unrelated directory. Refuse rather than trust the caller. A manifest
  // with no recorded root is refused outright so the check can never be
  // short-circuited by a legacy or hand-crafted manifest.
  if (!manifest.workspaceRoot || path.resolve(manifest.workspaceRoot) !== path.resolve(workspaceRoot)) {
    return { ok: false, error: 'workspaceRoot does not match the snapshot manifest; refusing to restore' };
  }
  const bdir = blobsDir(storageRoot, sessionId);

  const restored = [];
  const warnings = [];

  // First pass: ensure every snapshot entry exists at the right state.
  // Ancestor-chain validation runs once per entry, before any fs
  // mutation, so mkdirSync cannot accidentally resolve through a
  // hostile or pre-existing symlink in the workspace.
  for (const relPath of Object.keys(manifest.entries)) {
    const meta = manifest.entries[relPath];
    // Pre-existing file we could not read at capture time: we never
    // captured its content, so leave whatever is on disk untouched. It
    // stays in the keep-set below, so the delete pass will not remove it.
    if (meta && meta.type === 'unreadable') continue;
    const abs = joinSafely(workspaceRoot, relPath);
    if (!abs) { warnings.push({ path: relPath, reason: 'path escapes workspaceRoot' }); continue; }
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
        // Reject blob names that are not lowercase-hex 64-char strings.
        // meta.sha is caller-influenced (from the manifest on disk); a
        // tampered manifest must not be able to point us at random
        // files outside bdir.
        if (typeof meta.sha !== 'string' || !/^[a-f0-9]{64}$/.test(meta.sha)) {
          warnings.push({ path: relPath, reason: 'manifest sha is not a 64-char hex string' });
          continue;
        }
        const blobAbs = path.join(bdir, meta.sha);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- blobAbs is path.join(bdir, validated sha)
        let buf = fs.readFileSync(blobAbs);
        if (typeof opts.decrypt === 'function') buf = opts.decrypt(buf);
        // Re-hash the decrypted content and require it match the
        // manifest. Defends against blob tampering, decrypt-with-wrong
        // -key corruption, and any future cache-skew hazard.
        if (sha256OfBuffer(buf) !== meta.sha) {
          warnings.push({ path: relPath, reason: 'blob sha mismatch after decrypt' });
          continue;
        }
        // Pre-unlink so a hostile or pre-existing symlink at abs does
        // not get followed by writeFileSync. Directories at this path
        // are post-snapshot type conflicts and must be replaced.
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

  // Second pass: remove files in workspace that are NOT in the
  // manifest. This is what makes restore truly revert the run.
  // Honors the same default ignore list so node_modules etc. that
  // were never snapped are not torn out from under the user.
  //
  // opts.preserveExtras: true skips this destructive pass. The
  // supervisor wires that flag for "additive restore" flows where
  // the user wants the snapshotted files back without losing
  // anything the agent added. Default stays strict-revert because
  // that is the trust promise (a restore matches what was captured).
  if (opts.preserveExtras !== true) {
    const ignores = DEFAULT_IGNORE.slice();
    if (Array.isArray(opts.ignore)) for (const p of opts.ignore) if (typeof p === 'string' && p) ignores.push(p);
    removeExtras(workspaceRoot, '', new Set(Object.keys(manifest.entries)), ignores, warnings);
  }

  return { ok: true, restored, warnings };
}

// validateAncestorChain returns true iff every path component
// between baseAbs and the parent of fileAbs is either non-existent
// (mkdirSync will create it freshly) OR a real directory. A symlink
// anywhere on the chain is refused. This stops a hostile or
// pre-existing symlink in the workspace from being followed when
// writeFileSync resolves the path. There is a TOCTOU window between
// this check and the eventual write, but for Phase 1 the threat is
// manifest / workspace tampering, not a concurrent attacker.
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
  // Path traversal guard: a manifest entry whose normalized form
  // escapes the workspaceRoot is rejected, never written. Normalize
  // base via path.resolve so a caller-supplied trailing separator
  // does not break the prefix check.
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
      // Remove the directory if it ended up empty AND was not in the
      // manifest (e.g., the agent created a new empty dir).
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

// captureSnapshotAsync is the same as captureSnapshot but yields to
// the event loop every YIELD_EVERY entries so the main process stays
// responsive while large workspaces are walked. fs reads remain
// synchronous; the only difference is we hand control back to the
// event loop frequently enough that the renderer keeps painting.
const YIELD_EVERY = 50;
async function captureSnapshotAsync(workspaceRoot, storageRoot, sessionId, opts = {}) {
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
      // See walk(): a momentarily-unreadable pre-existing file is recorded
      // so the diff does not call it "added" and a revert does not delete it.
      try { if (ent.isFile()) { entries[relChild] = { type: 'unreadable' }; captured++; } } catch (_) {}
    }
  }
  return captured;
}

// diffWorkspaceAsync is the same as diffWorkspace but yields to the
// event loop every YIELD_EVERY entries so polling the live diff from
// the autonomy page does not freeze the main process while the agent
// is mid-edit.
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
