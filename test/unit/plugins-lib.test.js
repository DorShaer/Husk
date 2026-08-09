'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const P = require('../../src/lib/plugins');

// ─── isSafePluginId ─────────────────────────────────────────────────────────

test('isSafePluginId accepts bare names and name@marketplace', () => {
  assert.ok(P.isSafePluginId('caveman'));
  assert.ok(P.isSafePluginId('caveman@caveman'));
  assert.ok(P.isSafePluginId('rust-analyzer-lsp@claude-plugins-official'));
  assert.ok(P.isSafePluginId('a.b_c-d@m.x'));
});

test('isSafePluginId rejects flag injection and junk', () => {
  assert.equal(P.isSafePluginId('-rf'), false);
  assert.equal(P.isSafePluginId('--config=evil'), false);
  assert.equal(P.isSafePluginId('a b'), false);
  assert.equal(P.isSafePluginId('a;b'), false);
  assert.equal(P.isSafePluginId('a@b@c'), false);
  assert.equal(P.isSafePluginId('a/../b'), false);
  assert.equal(P.isSafePluginId(''), false);
  assert.equal(P.isSafePluginId(null), false);
  assert.equal(P.isSafePluginId('x'.repeat(201)), false);
});

test('buildPluginCliArgs returns argv for valid verb+id, null otherwise', () => {
  assert.deepEqual(P.buildPluginCliArgs('install', 'caveman@caveman'), ['plugin', 'install', 'caveman@caveman']);
  assert.deepEqual(P.buildPluginCliArgs('disable', 'x'), ['plugin', 'disable', 'x']);
  assert.equal(P.buildPluginCliArgs('exec', 'x'), null);
  assert.equal(P.buildPluginCliArgs('install', '--config=evil'), null);
  assert.equal(P.buildPluginCliArgs('', ''), null);
});

// ─── registry parsing ───────────────────────────────────────────────────────

function makeClaudeDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-plugins-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  return dir;
}

test('readInstalled joins registry with enabledPlugins; absent means disabled', (t) => {
  const dir = makeClaudeDir(t);
  fs.writeFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: {
      'alpha@official': [{ scope: 'user', installPath: '/x/alpha', version: '1.0.0', installedAt: 'a', lastUpdated: 'b' }],
      'beta@official': [{ scope: 'user', installPath: '/x/beta', version: '2.0.0', installedAt: 'a' }],
    },
  }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    enabledPlugins: { 'alpha@official': true },
  }));
  const list = P.readInstalled(dir);
  assert.equal(list.length, 2);
  const alpha = list.find((p) => p.name === 'alpha');
  const beta = list.find((p) => p.name === 'beta');
  assert.equal(alpha.enabled, true);
  assert.equal(alpha.marketplace, 'official');
  assert.equal(alpha.version, '1.0.0');
  assert.equal(beta.enabled, false);
  assert.equal(beta.lastUpdated, 'a');
});

test('readInstalled returns empty on missing or malformed registry', (t) => {
  const dir = makeClaudeDir(t);
  assert.deepEqual(P.readInstalled(dir), []);
  fs.writeFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), 'not json');
  assert.deepEqual(P.readInstalled(dir), []);
});

test('readCatalog unions marketplaces and skips malformed entries', (t) => {
  const dir = makeClaudeDir(t);
  const mpDir = path.join(dir, 'plugins', 'marketplaces', 'official');
  fs.mkdirSync(path.join(mpDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugins', 'known_marketplaces.json'), JSON.stringify({
    official: { source: { source: 'github', repo: 'o/o' }, installLocation: mpDir, lastUpdated: 'x' },
    ghost: { source: { source: 'github', repo: 'g/g' }, installLocation: path.join(dir, 'nope'), lastUpdated: 'y' },
  }));
  fs.writeFileSync(path.join(mpDir, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'official',
    plugins: [
      { name: 'good', description: 'd', category: 'c', author: { name: 'a' } },
      { name: 'alpha', description: 'first', category: 'tools', author: { name: 'z' } },
      { description: 'no name, skipped' },
      null,
    ],
  }));
  const cat = P.readCatalog(dir);
  assert.equal(cat.length, 2);
  assert.deepEqual(cat.map((p) => p.name), ['alpha', 'good']);
  assert.equal(cat[1].id, 'good@official');
  assert.equal(cat[0].marketplace, 'official');
  assert.equal(cat[1].author, 'a');
});

test('readMarketplaces lists known marketplaces with repo', (t) => {
  const dir = makeClaudeDir(t);
  fs.writeFileSync(path.join(dir, 'plugins', 'known_marketplaces.json'), JSON.stringify({
    m1: { source: { source: 'github', repo: 'a/b' }, installLocation: '/tmp/m1', lastUpdated: 'z' },
  }));
  const mps = P.readMarketplaces(dir);
  assert.equal(mps.length, 1);
  assert.equal(mps[0].repo, 'a/b');
});

// ─── editor guard rails ─────────────────────────────────────────────────────

test('isEditableFile allows small text files, blocks binaries and giants', () => {
  assert.ok(P.isEditableName('.env'));
  assert.ok(P.isEditableName('.gitignore'));
  assert.ok(P.isEditableName('hooks/run.SH'));
  assert.equal(P.isEditableName('README'), false);
  assert.equal(P.isEditableName('archive.zip'), false);
  assert.ok(P.isEditableFile('README.md', 100));
  assert.ok(P.isEditableFile('README.md', P.MAX_FILE_BYTES));
  assert.ok(P.isEditableFile('hooks/run.sh', 100));
  assert.equal(P.isEditableFile('logo.png', 100), false);
  assert.equal(P.isEditableFile('big.md', P.MAX_FILE_BYTES + 1), false);
});

test('listPluginFiles walks the dir, skips .git, marks editable', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-plugin-files-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'hooks'));
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, 'README.md'), 'hi');
  fs.writeFileSync(path.join(dir, 'hooks', 'h.sh'), 'echo');
  fs.writeFileSync(path.join(dir, '.git', 'config'), 'x');
  fs.writeFileSync(path.join(dir, 'img.png'), Buffer.from([0x89, 0x50]));
  const files = P.listPluginFiles(dir);
  const paths = files.map((f) => f.path);
  assert.deepEqual(paths, ['README.md', 'hooks/h.sh', 'img.png']);
  assert.equal(files.find((f) => f.path === 'img.png').editable, false);
  assert.equal(files.find((f) => f.path === 'README.md').editable, true);
});

// ─── confinement ────────────────────────────────────────────────────────────

test('isInsidePluginsRoot confines to the plugins dir', () => {
  const claude = '/home/u/.claude';
  assert.ok(P.isInsidePluginsRoot(claude, '/home/u/.claude/plugins/cache/m/p/1.0/README.md'));
  assert.equal(P.isInsidePluginsRoot(claude, '/home/u/.claude/settings.json'), false);
  assert.equal(P.isInsidePluginsRoot(claude, '/home/u/.claude/plugins/../settings.json'), false);
  assert.equal(P.isInsidePluginsRoot(claude, '/etc/passwd'), false);
});

// ─── main.js wiring assertions ──────────────────────────────────────────────

test('plugins editor IPC refuses symlinks via O_NOFOLLOW and gates exec behind the allowlist', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf8');
  const block = src.slice(src.indexOf("ipcMain.handle('plugins:run'"), src.indexOf("ipcMain.handle('plugins:openFolder'"));
  assert.ok(block.includes('isAllowedAgentCommand'), 'plugins:run must gate the spawn');
  assert.ok(block.includes('buildPluginCliArgs'), 'plugins:run must build argv via the validating helper');
  assert.ok(!block.includes('shell: true'), 'plugins:run must never use a shell');
  const readBlock = src.slice(src.indexOf("ipcMain.handle('plugins:readFile'"), src.indexOf("ipcMain.handle('plugins:writeFile'"));
  const writeBlock = src.slice(src.indexOf("ipcMain.handle('plugins:writeFile'"), src.indexOf("ipcMain.handle('plugins:openFolder'"));
  assert.ok(readBlock.includes('O_NOFOLLOW'), 'readFile must open with O_NOFOLLOW to refuse symlinks');
  assert.ok(writeBlock.includes('O_NOFOLLOW'), 'writeFile must open with O_NOFOLLOW to refuse symlinks');
  assert.ok(readBlock.includes('fstatSync') && readBlock.includes('isFile'), 'readFile must verify a regular file on the open descriptor');
  assert.ok(writeBlock.includes('fstatSync') && writeBlock.includes('isFile'), 'writeFile must verify a regular file on the open descriptor');
  assert.ok(readBlock.includes('resolveInside'), 'readFile must confine the path');
  assert.ok(writeBlock.includes('resolveInside'), 'writeFile must confine the path');
});

// ─── the editor's confinement, end to end ──────────────────────────────────

// The editor resolves a requested name under the plugin's install directory and
// then confines the canonical path to that same directory.
test('a plugin cannot reach outside its install directory through a linked directory', () => {
  const fsx = require('node:fs');
  const osx = require('node:os');
  const px = require('node:path');
  const { resolveInside, realPathInside } = require('../../src/lib/path-confine');

  const base = fsx.mkdtempSync(px.join(osx.tmpdir(), 'husk-plugconf-'));
  try {
    const installPath = px.join(base, 'plugins', 'p');
    const outside = px.join(base, 'outside');
    fsx.mkdirSync(installPath, { recursive: true });
    fsx.mkdirSync(outside, { recursive: true });
    fsx.writeFileSync(px.join(outside, 'secret.md'), 'OUTSIDE');
    fsx.writeFileSync(px.join(installPath, 'own.md'), 'OWN');
    fsx.symlinkSync(outside, px.join(installPath, 'linkdir'));

    // The handler's own chain: resolveInside, then the resolved-path check.
    const reach = (rel) => {
      let abs;
      try { abs = resolveInside(installPath, rel); } catch (_) { return 'refused'; }
      return realPathInside(abs, installPath) ? 'reached' : 'refused';
    };

    assert.equal(reach('linkdir/secret.md'), 'refused',
      'a linked directory let the editor reach outside the plugin');
    assert.equal(reach('../../outside/secret.md'), 'refused');
    assert.equal(reach('own.md'), 'reached', 'the plugin cannot read its own file');
  } finally { fsx.rmSync(base, { recursive: true, force: true }); }
});

test('both plugin file channels check the resolved path, not just the name', () => {
  const fsx = require('node:fs');
  const px = require('node:path');
  const MAIN = fsx.readFileSync(px.resolve(__dirname, '..', '..', 'src', 'main.js'), 'utf8');
  for (const ch of ['plugins:readFile', 'plugins:writeFile']) {
    const h = MAIN.match(new RegExp("ipcMain\\.handle\\('" + ch + "'[\\s\\S]*?\\n\\}\\);"));
    assert.ok(h, `${ch} handler was not found`);
    assert.match(h[0], /realPathInside\(abs, installPath\)/,
      `${ch} confines only the name, so a linked directory reaches past it`);
  }
});

// The sessions:read channel confines every path it reads to a single root.
test('the session read channel names the root it is confined to', () => {
  const fsx = require('node:fs');
  const px = require('node:path');
  const MAIN = fsx.readFileSync(px.resolve(__dirname, '..', '..', 'src', 'main.js'), 'utf8');
  const h = MAIN.match(/ipcMain\.handle\('sessions:read'[\s\S]*?\n\}\);/);
  assert.ok(h, 'the sessions:read handler was not found');
  const guardAt = h[0].search(/isInside\(workDir|realPathInside\(prdPath/);
  const readAt = h[0].indexOf('readFileSync');
  assert.ok(guardAt > -1, 'sessions:read reads a renderer path with no confinement at all');
  assert.ok(guardAt < readAt, 'the confinement runs after the file has been read');
});
