'use strict';

// Bounded, in-memory before/after comparison for folders without Git. Nothing
// is written into the workspace; symlinks and special files are never read.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { constants } = require('node:fs');
const SKIP = new Set(['.git', '.hg', '.svn', 'node_modules', 'vendor', 'dist', 'build', 'coverage', '.cache', '.next', '__pycache__', '.venv', 'venv', '.ssh', '.aws', '.gnupg']);
const sensitive = (name) => name === '.env' || name.startsWith('.env.') || /\.(pem|key|p12|pfx)$/i.test(name);
const LIMITS = { files: 2000, entries: 12000, bytes: 4 * 1024 * 1024, fileBytes: 256 * 1024, ms: 2000 };

function textDiff(before, after) {
  const lines = s => s ? s.replace(/\r\n/g, '\n').split('\n').slice(0, s.endsWith('\n') ? -1 : undefined) : [];
  if (before === null || after === null) return { binary: true, hunks: [], adds: 0, dels: 0, note: 'Binary or oversized file. Line comparison is unavailable.' };
  const a = lines(before), b = lines(after);
  if (before !== after && a.length === b.length && a.every((line, i) => line === b[i])) return { hunks: [], adds: 0, dels: 0, note: 'Only line endings or the final newline changed.' };
  if (a.length + b.length > 12000) return { hunks: [], adds: 0, dels: 0, note: 'This file has too many lines to compare here.' };
  let prefix = 0, suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const left = a.slice(prefix, a.length - suffix), right = b.slice(prefix, b.length - suffix);
  const edits = [];
  if (left.length * right.length <= 250000) {
    const table = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
    for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    let i = 0, j = 0;
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && left[i] === right[j]) { edits.push(['ctx', left[i++]]); j++; }
      else if (i < left.length && (j >= right.length || table[i + 1][j] >= table[i][j + 1])) edits.push(['del', left[i++]]);
      else edits.push(['add', right[j++]]);
    }
  } else {
    for (const line of left) edits.push(['del', line]);
    for (const line of right) edits.push(['add', line]);
  }
  const start = Math.max(0, prefix - 3), tail = Math.min(3, suffix);
  const operations = a.slice(start, prefix).map(s => ['ctx', s]).concat(edits, a.slice(a.length - suffix, a.length - suffix + tail).map(s => ['ctx', s]));
  let oldNo = start + 1, newNo = start + 1, adds = 0, dels = 0;
  const painted = operations.map(([kind, text]) => {
    if (kind === 'add') { adds++; return { kind, oldNo: null, newNo: newNo++, text }; }
    if (kind === 'del') { dels++; return { kind, oldNo: oldNo++, newNo: null, text }; }
    return { kind, oldNo: oldNo++, newNo: newNo++, text };
  });
  return { adds, dels, hunks: [{ header: `@@ -${start + 1},${oldNo - start - 1} +${start + 1},${newNo - start - 1} @@`, lines: painted }] };
}

async function capture(root, overrides = {}) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- root is authorized by chatFolderGate; canonicalize before enumerating children.
  root = await fs.realpath(root);
  const limits = { ...LIMITS, ...overrides }, started = Date.now();
  const files = new Map();
  let entries = 0, bytes = 0, partial = false, incomplete = false;
  async function walk(dir, rel = '') {
    if (Date.now() - started > limits.ms || entries >= limits.entries || files.size >= limits.files) { partial = incomplete = true; return; }
    let children;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dir is root or a real directory confined to root immediately before recursion.
    try { children = await fs.readdir(dir, { withFileTypes: true }); } catch (_) {
      if (dir === root) throw new Error('The working folder cannot be read. Check its permissions.');
      partial = incomplete = true; return;
    }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entries > limits.entries || files.size >= limits.files || Date.now() - started > limits.ms) { partial = incomplete = true; break; }
      if (SKIP.has(child.name) || sensitive(child.name) || child.isSymbolicLink()) continue;
      const file = path.join(dir, child.name), key = rel ? rel + '/' + child.name : child.name;
      if (child.isDirectory()) {
        // Recheck directory identity before descending; no links outside root.
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- file is formed from a directory entry under root and checked before descent.
        const real = await fs.realpath(file).catch(() => '');
        if (real && (real === root || real.startsWith(root + path.sep))) await walk(file, key);
        continue;
      }
      if (!child.isFile()) continue;
      let handle;
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- enumerated regular file; no-follow open and realpath containment checked before reading.
        handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
        const stat = await handle.stat();
        if (!stat.isFile()) continue;
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- verify the opened entry remains inside the authorized root.
        const real = await fs.realpath(file);
        if (!real.startsWith(root + path.sep)) continue;
        if (stat.size > limits.fileBytes || bytes + stat.size > limits.bytes) {
          files.set(key, { sig: `${stat.size}:${stat.mtimeMs}`, text: null }); partial = true; continue;
        }
        const buffer = Buffer.alloc(stat.size + 1);
        const read = await handle.read(buffer, 0, buffer.length, 0);
        if (read.bytesRead !== stat.size) { partial = incomplete = true; continue; }
        bytes += stat.size;
        const data = buffer.subarray(0, read.bytesRead), text = data.toString('utf8');
        files.set(key, { sig: crypto.createHash('sha256').update(data).digest('hex'), text: data.includes(0) || text.includes('\ufffd') ? null : text });
      } catch (_) { partial = incomplete = true; }
      finally { if (handle) await handle.close().catch(() => {}); }
    }
  }
  await walk(root);
  return { root, files, partial, incomplete };
}

function compare(before, after) {
  const files = [], diffs = new Map();
  let adds = 0, dels = 0;
  for (const name of [...new Set([...before.files.keys(), ...after.files.keys()])].sort()) {
    const a = before.files.get(name), b = after.files.get(name);
    if (a && b && a.sig === b.sig) continue;
    // An incomplete scan cannot establish that an unseen path was deleted or
    // created. Report only paths whose presence was established on both sides.
    if ((!a && before.incomplete) || (!b && after.incomplete)) continue;
    const diff = textDiff(a ? a.text : '', b ? b.text : '');
    const status = !a ? 'added' : !b ? 'deleted' : 'modified';
    files.push({ path: name, status, staged: false, unstaged: true, adds: diff.adds, dels: diff.dels });
    adds += diff.adds; dels += diff.dels; diffs.set(name, diff);
  }
  return { ok: true, isRepo: false, files, diffs, adds, dels, partial: before.partial || after.partial };
}

function createFolderChanges({ limits } = {}) {
  const snapshots = new Map(), recent = new Map(), pending = new Map();
  function sequence(root, read) {
    const previous = pending.get(root) || Promise.resolve();
    const next = previous.catch(() => {}).then(read);
    pending.set(root, next);
    const clear = () => { if (pending.get(root) === next) pending.delete(root); };
    next.then(clear, clear);
    return next;
  }
  let next = 0;
  return {
    begin(root) {
      return sequence(root, async () => {
        const snap = await capture(root, limits);
        const id = String(++next);
        snapshots.set(id, { root: path.resolve(root), snap });
        while (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value);
        return { ok: true, id };
      });
    },
    finish(root, id) {
      return sequence(root, async () => {
        const saved = snapshots.get(id);
        if (!saved || saved.root !== path.resolve(root)) return { ok: false, error: 'The folder comparison is no longer available.' };
        snapshots.delete(id);
        const after = await capture(root, limits);
        const result = compare(saved.snap, after);
        recent.delete(root); recent.set(root, result);
        while (recent.size > 4) recent.delete(recent.keys().next().value);
        return this.status(root);
      });
    },
    status(root) {
      const result = recent.get(root);
      if (!result) return { ok: true, isRepo: false, files: [], adds: 0, dels: 0, partial: false };
      const { diffs, ...plain } = result;
      return plain;
    },
    diff(root, rel) {
      const diff = recent.get(root)?.diffs.get(rel);
      return diff ? { ok: true, file: diff } : { ok: false, error: 'This folder comparison is no longer available. Changes are kept until the next turn or app restart.' };
    },
  };
}

module.exports = { capture, compare, textDiff, createFolderChanges };
