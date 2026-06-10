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
      { description: 'no name, skipped' },
      null,
    ],
  }));
  const cat = P.readCatalog(dir);
  assert.equal(cat.length, 1);
  assert.equal(cat[0].id, 'good@official');
  assert.equal(cat[0].marketplace, 'official');
  assert.equal(cat[0].author, 'a');
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
  assert.ok(P.isEditableFile('README.md', 100));
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

// ─── main.js wiring assertions (same convention as the workflow spawn-gate test) ──

test('plugins editor IPC refuses symlinks via lstat and gates exec behind the allowlist', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf8');
  const block = src.slice(src.indexOf("ipcMain.handle('plugins:run'"), src.indexOf("ipcMain.handle('plugins:openFolder'"));
  assert.ok(block.includes('isAllowedAgentCommand'), 'plugins:run must gate the spawn');
  assert.ok(block.includes('buildPluginCliArgs'), 'plugins:run must build argv via the validating helper');
  assert.ok(!block.includes('shell: true'), 'plugins:run must never use a shell');
  const readBlock = src.slice(src.indexOf("ipcMain.handle('plugins:readFile'"), src.indexOf("ipcMain.handle('plugins:writeFile'"));
  const writeBlock = src.slice(src.indexOf("ipcMain.handle('plugins:writeFile'"), src.indexOf("ipcMain.handle('plugins:openFolder'"));
  assert.ok(readBlock.includes('lstatSync'), 'readFile must lstat, not stat');
  assert.ok(writeBlock.includes('lstatSync'), 'writeFile must lstat, not stat');
  assert.ok(readBlock.includes('resolveInside'), 'readFile must confine the path');
  assert.ok(writeBlock.includes('resolveInside'), 'writeFile must confine the path');
});
