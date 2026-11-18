'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const B = require('../../src/lib/market-bundle');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUB = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

const SAMPLES = path.join(__dirname, '../fixtures/skill-bundles');

function manifest(over = {}) {
  return Object.assign({
    id: 'sample-skill',
    name: 'Sample skill',
    kind: 'skill',
    version: '1.0.0',
    publisher: 'Example publisher',
    description: 'A sample.',
    permissions: { runsCommands: false, networkHosts: [], fileAccess: 'none' },
  }, over);
}

const SKILL_MD = '---\nname: sample-skill\ndescription: A sample.\n---\n\nSteps.\n';

function file(p, content = 'x') {
  return { path: p, sha256: B.sha256Hex(Buffer.from(content, 'utf8')), content };
}

function raw(over = {}) {
  return Object.assign({ format: 'husk-bundle', formatVersion: 1, manifest: manifest(), files: [file('SKILL.md', SKILL_MD)] }, over);
}

function refused(input, code, opts) {
  const r = B.validateBundle(input, opts);
  assert.equal(r.ok, false, `expected ${code}`);
  assert.equal(r.code, code);
  assert.ok(r.error && typeof r.error === 'string');
  return r;
}

test('a well-formed bundle validates and its content comes back as bytes', () => {
  const r = B.validateBundle(raw());
  assert.equal(r.ok, true);
  assert.equal(r.bundle.manifest.kind, 'skill');
  assert.equal(r.bundle.files[0].content.toString('utf8'), SKILL_MD);
  assert.equal(r.bundle.files[0].size, Buffer.byteLength(SKILL_MD));
  assert.deepEqual(r.bundle.signature, { state: 'unsigned', publisher: null });
});

test('something that is not a bundle is refused', () => {
  for (const v of [null, [], 'text', {}, raw({ format: 'other' })]) refused(v, 'not-a-bundle');
  refused(raw({ formatVersion: 2 }), 'unsupported-version');
  assert.equal(B.parseBundle('{ nope').code, 'not-json');
  assert.equal(B.parseBundle(42).code, 'not-a-bundle');
  assert.equal(B.parseBundle('x'.repeat(B.MAX_BUNDLE_BYTES + 1)).code, 'bundle-too-large');
});

test('each manifest field is checked', () => {
  const bad = (over) => raw({ manifest: manifest(over) });
  refused(raw({ manifest: null }), 'bad-manifest');
  refused(bad({ id: 'Has Spaces' }), 'bad-manifest');
  refused(bad({ id: '../up' }), 'bad-manifest');
  refused(bad({ name: '' }), 'bad-manifest');
  refused(bad({ name: 'n'.repeat(81) }), 'bad-manifest');
  refused(bad({ version: 'latest' }), 'bad-manifest');
  refused(bad({ publisher: '  ' }), 'bad-manifest');
  refused(bad({ description: 5 }), 'bad-manifest');
  refused(bad({ description: 'd'.repeat(501) }), 'bad-manifest');
  refused(bad({ kind: 'plugin' }), 'bad-kind');
});

test('declared permissions are required and typed', () => {
  const bad = (permissions) => raw({ manifest: manifest({ permissions }) });
  refused(bad(undefined), 'bad-permissions');
  refused(bad({ runsCommands: 'no', networkHosts: [], fileAccess: 'none' }), 'bad-permissions');
  refused(bad({ runsCommands: false, networkHosts: 'example.invalid', fileAccess: 'none' }), 'bad-permissions');
  refused(bad({ runsCommands: false, networkHosts: ['has space'], fileAccess: 'none' }), 'bad-permissions');
  refused(bad({ runsCommands: false, networkHosts: [], fileAccess: 'everything' }), 'bad-permissions');
  const ok = B.validateBundle(bad({ runsCommands: true, networkHosts: ['api.example.invalid', '*.example.invalid'], fileAccess: 'write' }));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.bundle.manifest.permissions, { runsCommands: true, networkHosts: ['api.example.invalid', '*.example.invalid'], fileAccess: 'write' });
});

test('only relative paths inside the bundle are accepted', () => {
  const withPath = (p) => raw({ files: [file('SKILL.md', SKILL_MD), file(p)] });
  for (const p of ['../outside.md', 'a/../../b.md', 'a/./b.md', '/etc/passwd.md', 'C:/x.md', 'C:x.md', 'a\\b.md', 'a//b.md', 'a/', 'bad\u0000name.md', 'line\nbreak.md', `${'d/'.repeat(130)}x.md`]) {
    refused(withPath(p), 'bad-path');
  }
  refused(raw({ files: [file('SKILL.md', SKILL_MD), { sha256: 'x', content: 'x' }] }), 'bad-path');
  assert.equal(B.validateBundle(withPath('docs/deep/notes.md')).ok, true);
  assert.equal(B.pathProblem('ok/file.md'), null);
});

test('an entry that is not a regular file is refused', () => {
  const entry = (extra) => raw({ files: [file('SKILL.md', SKILL_MD), Object.assign(file('other.md'), extra)] });
  refused(entry({ type: 'symlink' }), 'link-not-allowed');
  refused(entry({ link: '/etc/hosts' }), 'link-not-allowed');
  refused(entry({ target: '../x' }), 'link-not-allowed');
  assert.equal(B.validateBundle(entry({ type: 'file' })).ok, true);
});

test('a path may appear once, whatever its case', () => {
  refused(raw({ files: [file('SKILL.md', SKILL_MD), file('notes.md'), file('Notes.md')] }), 'duplicate-path');
});

test('each kind carries only its own file types', () => {
  const skillWith = (p) => raw({ files: [file('SKILL.md', SKILL_MD), file(p)] });
  for (const p of ['tool.exe', 'lib.so', 'archive.zip', 'noext', '.env', 'image.png']) refused(skillWith(p), 'type-not-allowed');
  for (const p of ['index.js', 'monitor.py', 'run.sh', 'data.json', 'conf.yaml']) assert.equal(B.validateBundle(skillWith(p)).ok, true, p);
  refused(raw({ manifest: manifest({ kind: 'agent' }), files: [file('agents/a.js')] }), 'type-not-allowed');
  refused(raw({ manifest: manifest({ kind: 'prompt' }), files: [file('p.json')] }), 'type-not-allowed');
  refused(raw({ manifest: manifest({ kind: 'workflow' }), files: [file('w.md')] }), 'type-not-allowed');
  refused(raw({ manifest: manifest({ kind: 'mcp' }), files: [file('mcp.md')] }), 'type-not-allowed');
});

test('each kind has the layout its importer reads', () => {
  const of = (kind, files) => raw({ manifest: manifest({ kind }), files });
  refused(raw({ files: [file('notes.md')] }), 'bad-layout');
  refused(of('agent', [file('reviewer.md')]), 'bad-layout');
  refused(of('agent', [file('agents/deep/reviewer.md')]), 'bad-layout');
  assert.equal(B.validateBundle(of('agent', [file('agents/reviewer.md'), file('agents/planner.md')])).ok, true);
  refused(of('prompt', [file('a.md'), file('b.md')]), 'bad-layout');
  refused(of('prompt', [file('dir/a.md')]), 'bad-layout');
  refused(of('prompt', [file('Has_Caps.md')]), 'bad-layout');
  assert.equal(B.validateBundle(of('prompt', [file('explain-this.md')])).ok, true);
  refused(of('workflow', [file('a.json'), file('b.json')]), 'bad-layout');
  assert.equal(B.validateBundle(of('workflow', [file('flow.husk.json', '{}')])).ok, true);
  refused(of('mcp', [file('servers.json')]), 'bad-layout');
  assert.equal(B.validateBundle(of('mcp', [file('mcp.json', '{}')])).ok, true);
});

test('file count, file size and total size are capped', () => {
  refused(raw({ files: [] }), 'no-files');
  refused(raw({ files: 'none' }), 'no-files');
  const many = [file('SKILL.md', SKILL_MD)];
  for (let i = 0; i < B.MAX_FILES; i += 1) many.push(file(`f${i}.md`));
  refused(raw({ files: many }), 'too-many-files');
  refused(raw({ files: [file('SKILL.md', SKILL_MD), file('big.md', 'a'.repeat(B.MAX_FILE_BYTES + 1))] }), 'file-too-large');
  const chunk = 'a'.repeat(B.MAX_FILE_BYTES);
  const heavy = [file('SKILL.md', SKILL_MD)];
  for (let i = 0; i <= B.MAX_TOTAL_BYTES / B.MAX_FILE_BYTES; i += 1) heavy.push(file(`h${i}.md`, chunk));
  refused(raw({ files: heavy }), 'bundle-too-large');
});

test('every file must match its sha256', () => {
  const f = file('SKILL.md', SKILL_MD);
  refused(raw({ files: [Object.assign({}, f, { content: `${SKILL_MD}extra` })] }), 'hash-mismatch');
  refused(raw({ files: [Object.assign({}, f, { sha256: 'abc' })] }), 'bad-hash');
  refused(raw({ files: [{ path: 'SKILL.md', content: SKILL_MD }] }), 'bad-hash');
  refused(raw({ files: [{ path: 'SKILL.md', sha256: f.sha256 }] }), 'bad-file');
  refused(raw({ files: ['SKILL.md'] }), 'bad-file');
  refused(raw({ files: [Object.assign({}, f, { encoding: 'hex' })] }), 'bad-file');
  refused(raw({ files: [Object.assign({}, f, { encoding: 'base64', content: 'not base64!' })] }), 'bad-file');
});

test('packing produces a bundle that validates and round-trips bytes', () => {
  const bin = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
  const packed = B.packBundle(manifest(), [{ path: 'SKILL.md', content: SKILL_MD }, { path: 'data.csv', content: bin }]);
  assert.equal(packed.ok, true);
  assert.equal(packed.bundle.files[1].encoding, 'base64');
  const back = B.parseBundle(packed.text);
  assert.equal(back.ok, true);
  assert.equal(back.bundle.files[0].content.toString('utf8'), SKILL_MD);
  assert.ok(back.bundle.files[1].content.equals(bin));
  assert.equal(packed.bundle.signature, undefined);
});

test('packing refuses what validation refuses', () => {
  assert.equal(B.packBundle(manifest(), [{ path: '../SKILL.md', content: 'x' }]).code, 'bad-path');
  assert.equal(B.packBundle(manifest({ kind: 'nope' }), [{ path: 'SKILL.md', content: 'x' }]).code, 'bad-kind');
  assert.equal(B.packBundle(manifest(), []).code, 'no-files');
  assert.equal(B.packBundle(manifest(), [{ path: 'SKILL.md', content: 'x' }], { privateKey: 'not a key' }).code, 'sign-failed');
});

test('a signature from a trusted publisher verifies', () => {
  const packed = B.packBundle(manifest(), [{ path: 'SKILL.md', content: SKILL_MD }], { privateKey });
  assert.equal(packed.ok, true);
  const trusted = B.parseBundle(packed.text, { trustedPublishers: [{ name: 'Known publisher', publicKey: PUB }] });
  assert.deepEqual(trusted.bundle.signature, { state: 'verified', publisher: 'Known publisher' });
});

test('a valid signature from an unlisted key is reported as untrusted', () => {
  const packed = B.packBundle(manifest(), [{ path: 'SKILL.md', content: SKILL_MD }], { privateKey });
  const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  for (const trustedPublishers of [undefined, [], [{ name: 'Someone else', publicKey: other }], [{ publicKey: 'junk' }, null]]) {
    assert.deepEqual(B.parseBundle(packed.text, { trustedPublishers }).bundle.signature, { state: 'untrusted', publisher: null });
  }
});

test('a signature that does not match the contents rejects the bundle', () => {
  const trustedPublishers = [{ name: 'Known publisher', publicKey: PUB }];
  const fresh = () => JSON.parse(B.packBundle(manifest(), [{ path: 'SKILL.md', content: SKILL_MD }, { path: 'notes.md', content: 'n' }], { privateKey }).text);

  const renamed = fresh();
  renamed.manifest.publisher = 'Another name';
  refused(renamed, 'bad-signature', { trustedPublishers });

  const widened = fresh();
  widened.manifest.permissions.runsCommands = true;
  refused(widened, 'bad-signature', { trustedPublishers });

  const swapped = fresh();
  swapped.files[1] = file('notes.md', 'different');
  refused(swapped, 'bad-signature', { trustedPublishers });

  const added = fresh();
  added.files.push(file('extra.md'));
  refused(added, 'bad-signature', { trustedPublishers });

  const moved = fresh();
  moved.files[1].path = 'moved.md';
  refused(moved, 'bad-signature', { trustedPublishers });

  for (const signature of ['yes', {}, { publicKey: PUB }, { publicKey: 'junk', value: 'AAAA' }, { publicKey: PUB, value: 'AAAA' }]) {
    refused(Object.assign(fresh(), { signature }), 'bad-signature', { trustedPublishers });
  }
});

test('the signature does not depend on file order', () => {
  const b = JSON.parse(B.packBundle(manifest(), [{ path: 'SKILL.md', content: SKILL_MD }, { path: 'notes.md', content: 'n' }], { privateKey }).text);
  b.files.reverse();
  assert.equal(B.validateBundle(b).ok, true);
});

test('the content hash follows the files and ignores their order', () => {
  const a = [{ path: 'a.md', sha256: '1' }, { path: 'b.md', sha256: '2' }];
  assert.equal(B.contentHash(a), B.contentHash(a.slice().reverse()));
  assert.notEqual(B.contentHash(a), B.contentHash([{ path: 'a.md', sha256: '1' }, { path: 'b.md', sha256: '3' }]));
  assert.notEqual(B.contentHash(a), B.contentHash([{ path: 'a.md', sha256: '1' }, { path: 'c.md', sha256: '2' }]));
  assert.match(B.contentHash(a), /^[a-f0-9]{64}$/);
});

test('staging writes into a new private folder', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-bundle-test-'));
  const v = B.validateBundle(raw({ files: [file('SKILL.md', SKILL_MD), file('docs/deep/notes.md', 'n')] }));
  const s = B.stageFiles(fs, v.bundle.files, root);
  assert.equal(s.ok, true);
  assert.equal(path.dirname(s.dir), root);
  assert.equal(fs.statSync(s.dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(s.dir, 'SKILL.md')).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(s.dir, 'docs', 'deep', 'notes.md'), 'utf8'), 'n');
  const again = B.stageFiles(fs, v.bundle.files, root);
  assert.notEqual(again.dir, s.dir);
});

test('staging refuses a path that leaves its folder and leaves nothing behind', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-bundle-test-'));
  const s = B.stageFiles(fs, [{ path: 'ok.md', content: Buffer.from('a') }, { path: '../escaped.md', content: Buffer.from('b') }], root);
  assert.equal(s.ok, false);
  assert.equal(s.code, 'stage-failed');
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(fs.existsSync(path.join(path.dirname(root), 'escaped.md')), false);
  assert.equal(B.stageFiles(fs, [{ path: 'a.md', content: Buffer.from('a') }], path.join(root, 'missing')).ok, false);
});

test('a folder is collected as relative regular files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-collect-'));
  fs.writeFileSync(path.join(dir, 'SKILL.md'), SKILL_MD);
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib', 'helper.js'), '// helper\n');
  const r = B.collectDir(fs, dir);
  assert.equal(r.ok, true);
  assert.deepEqual(r.files.map((f) => f.path), ['SKILL.md', 'lib/helper.js']);
  assert.equal(B.packBundle(manifest(), r.files).ok, true);
});

test('a folder holding a link is not collected', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-collect-'));
  fs.writeFileSync(path.join(dir, 'SKILL.md'), SKILL_MD);
  fs.symlinkSync('/etc/hosts', path.join(dir, 'hosts.md'));
  assert.equal(B.collectDir(fs, dir).code, 'link-not-allowed');
  const linkDir = path.join(os.tmpdir(), `husk-collect-link-${process.pid}`);
  try { fs.unlinkSync(linkDir); } catch (_) {}
  fs.symlinkSync(dir, linkDir);
  assert.equal(B.collectDir(fs, linkDir).code, 'not-a-folder');
  fs.unlinkSync(linkDir);
});

test('collecting applies the size caps and reports a missing folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-collect-'));
  fs.writeFileSync(path.join(dir, 'big.md'), Buffer.alloc(B.MAX_FILE_BYTES + 1, 0x61));
  assert.equal(B.collectDir(fs, dir).code, 'file-too-large');
  assert.equal(B.collectDir(fs, path.join(dir, 'nope')).code, 'read-failed');
  assert.equal(B.collectDir(fs, path.join(dir, 'big.md')).code, 'not-a-folder');
});

test('the sample skill folders pack, validate and stage without being run', { skip: !fs.existsSync(SAMPLES) }, () => {
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-sample-stage-'));
  const names = fs.readdirSync(SAMPLES).filter((n) => n.startsWith('skill-'));
  assert.equal(names.length, 3);
  for (const name of names) {
    const collected = B.collectDir(fs, path.join(SAMPLES, name));
    assert.equal(collected.ok, true, name);
    const packed = B.packBundle(manifest({ id: name, name }), collected.files);
    assert.equal(packed.ok, true, `${name}: ${packed.error}`);
    const parsed = B.parseBundle(packed.text);
    assert.equal(parsed.ok, true, name);
    const s = B.stageFiles(fs, parsed.bundle.files, stageRoot);
    assert.equal(s.ok, true, name);
    for (const f of collected.files) {
      assert.ok(fs.readFileSync(path.join(s.dir, f.path)).equals(f.content), `${name}/${f.path}`);
    }
  }
});

test('paths use portable regular file names', () => {
  for (const name of ['a:stream.md', 'NUL.md', 'folder./file.md', 'a /file.md']) assert.ok(B.pathProblem(name));
});

test('staging enforces byte and file-count limits before writing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-stage-bounds-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(B.stageFiles(fs, [{ path: 'file.md', content: Buffer.alloc(B.MAX_FILE_BYTES + 1) }], dir).ok, false);
  assert.equal(B.stageFiles(fs, Array.from({ length: B.MAX_FILES + 1 }, (_, i) => ({ path: `${i}.md`, content: Buffer.alloc(0) })), dir).ok, false);
  assert.equal(B.stageFiles(fs, [{ path: 'a.md', content: Buffer.from('a') }, { path: 'A.md', content: Buffer.from('b') }], dir).ok, false);
  assert.deepEqual(fs.readdirSync(dir), []);
});
