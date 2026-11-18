'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { capture, compare, textDiff, createFolderChanges } = require('../../src/lib/folder-changes');

test('plain folders report added, edited and deleted files with readable line changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'husk-folder-unit-'));
  try {
    await fs.writeFile(path.join(root, 'edit.txt'), 'keep\nold\ntail\n');
    await fs.writeFile(path.join(root, 'delete.txt'), 'gone\n');
    const before = await capture(root);
    await fs.writeFile(path.join(root, 'edit.txt'), 'keep\nnew\ntail\n');
    await fs.unlink(path.join(root, 'delete.txt'));
    await fs.writeFile(path.join(root, 'added.txt'), 'new file\n');
    const result = compare(before, await capture(root));
    assert.deepEqual(result.files.map(f => [f.path, f.status]), [['added.txt', 'added'], ['delete.txt', 'deleted'], ['edit.txt', 'modified']]);
    assert.equal(result.adds, 2); assert.equal(result.dels, 2);
    assert.deepEqual(result.diffs.get('edit.txt').hunks[0].lines.filter(l => l.kind !== 'ctx').map(l => [l.kind, l.text]), [['del', 'old'], ['add', 'new']]);
    assert.equal((await fs.readdir(root)).includes('.git'), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('folder scans skip links, dependency directories, environment files and private key files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'husk-folder-boundary-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'husk-folder-outside-'));
  try {
    await fs.mkdir(path.join(root, 'node_modules'));
    await fs.writeFile(path.join(root, 'node_modules', 'ignored.js'), 'ignored');
    await fs.writeFile(path.join(outside, 'private.txt'), 'outside');
    await fs.symlink(outside, path.join(root, 'linked'), 'dir');
    for (const file of ['.env', '.env.local', 'private.pem', 'key.key']) await fs.writeFile(path.join(root, file), 'private');
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules\n');
    assert.deepEqual([...((await capture(root)).files.keys())], ['.gitignore']);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); }
});

test('incomplete listings do not report false additions or deletions; oversized content remains bounded', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'husk-folder-limit-'));
  try {
    for (const file of ['a', 'b', 'c']) await fs.writeFile(path.join(root, file), file);
    const full = await capture(root);
    const partial = await capture(root, { files: 1 });
    assert.equal(partial.partial, true);
    assert.deepEqual(compare(full, partial).files, []);
    assert.deepEqual(compare(partial, full).files, []);
    const before = await capture(root, { fileBytes: 0 });
    await fs.writeFile(path.join(root, 'new'), 'new');
    const added = compare(before, await capture(root, { fileBytes: 0 }));
    assert.equal(added.files[0].path, 'new');
    assert.match(added.diffs.get('new').note, /oversized/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('comparison tokens are scoped to their root and are consumed after finishing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'husk-folder-token-'));
  const service = createFolderChanges();
  try {
    const { id } = await service.begin(root);
    assert.equal((await service.finish(root + '-different', id)).ok, false);
    await fs.writeFile(path.join(root, 'added.txt'), 'hello\n');
    assert.equal((await service.finish(root, id)).files[0].path, 'added.txt');
    assert.equal((await service.finish(root, id)).ok, false);
    assert.equal(service.diff(root, '../outside').ok, false);
    assert.equal(service.diff(root, 'added.txt').file.adds, 1);
    assert.equal(service.status(root).diffs, undefined);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('binary and large line comparisons produce an explicit explanation', () => {
  assert.equal(textDiff(null, 'text').binary, true);
  assert.match(textDiff('a\n'.repeat(13000), 'b\n').note, /too many lines/);
});

test('an unreadable root fails explicitly instead of reporting an empty successful snapshot', { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'husk-folder-unreadable-'));
  try {
    await fs.chmod(root, 0o000);
    await assert.rejects(capture(root), /cannot be read/);
  } finally { await fs.chmod(root, 0o700); await fs.rm(root, { recursive: true, force: true }); }
});
