'use strict';

// Tests for src/lib/repo-agents.js: URL validation, local-path validation,
// and friendly error mapping for the agent install-from-repo flow. Each
// fs-touching test mints a private tmpdir; no test touches the real home
// directory.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  validateRepoUrl,
  validateLocalRoot,
  friendlyCloneError,
  friendlyScanError,
} = require('../../src/lib/repo-agents');

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-repoagents-')); });
afterEach(() => {
  try { fs.chmodSync(path.join(tmp, 'locked'), 0o755); } catch (_) {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
});

// ── validateRepoUrl ──────────────────────────────────────────────────────

test('validateRepoUrl accepts a plain https repo URL', () => {
  const r = validateRepoUrl('https://github.com/dev/agent-repo');
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://github.com/dev/agent-repo');
  assert.equal(r.dirName, 'github.com-dev-agent-repo');
});

test('validateRepoUrl strips a trailing .git from the dir name', () => {
  const r = validateRepoUrl('https://github.com/dev/agent-repo.git');
  assert.equal(r.ok, true);
  assert.equal(r.dirName, 'github.com-dev-agent-repo');
});

test('validateRepoUrl rejects an empty input', () => {
  const r = validateRepoUrl('   ');
  assert.equal(r.ok, false);
  assert.match(r.error, /enter a repository url/i);
});

test('validateRepoUrl rejects garbage that is not a URL', () => {
  const r = validateRepoUrl('not a url at all');
  assert.equal(r.ok, false);
  assert.match(r.error, /does not look like a repository url/i);
});

test('validateRepoUrl rejects non-https schemes', () => {
  for (const bad of ['http://github.com/dev/repo', 'git://github.com/dev/repo', 'file:///etc/passwd', 'ssh://git@github.com/dev/repo']) {
    const r = validateRepoUrl(bad);
    assert.equal(r.ok, false, bad);
    assert.match(r.error, /only https/i, bad);
  }
});

test('validateRepoUrl rejects URLs with embedded credentials', () => {
  const r = validateRepoUrl('https://user:token@github.com/dev/repo');
  assert.equal(r.ok, false);
  assert.match(r.error, /credentials/i);
});

test('validateRepoUrl rejects a bare host with no repo path', () => {
  const r = validateRepoUrl('https://github.com/');
  assert.equal(r.ok, false);
  assert.match(r.error, /site, not a repository/i);
});

test('validateRepoUrl rejects an oversized URL', () => {
  const r = validateRepoUrl('https://github.com/' + 'a'.repeat(3000));
  assert.equal(r.ok, false);
  assert.match(r.error, /too long/i);
});

test('validateRepoUrl sanitizes hostile path characters out of the dir name', () => {
  const r = validateRepoUrl('https://github.com/dev/agent%20repo');
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.dirName, /[^a-zA-Z0-9._-]/);
  assert.ok(!r.dirName.includes('..' + path.sep));
});

// ── validateLocalRoot ────────────────────────────────────────────────────

test('validateLocalRoot accepts a readable directory', () => {
  const r = validateLocalRoot(tmp);
  assert.equal(r.ok, true);
  assert.equal(r.root, tmp);
});

test('validateLocalRoot trims surrounding whitespace', () => {
  const r = validateLocalRoot(`  ${tmp}  `);
  assert.equal(r.ok, true);
  assert.equal(r.root, tmp);
});

test('validateLocalRoot rejects an empty input', () => {
  const r = validateLocalRoot('');
  assert.equal(r.ok, false);
  assert.match(r.error, /enter a folder path/i);
});

test('validateLocalRoot rejects a relative path', () => {
  const r = validateLocalRoot('some/relative/dir');
  assert.equal(r.ok, false);
  assert.match(r.error, /full path starting with \//i);
});

test('validateLocalRoot rejects a path that does not exist', () => {
  const r = validateLocalRoot(path.join(tmp, 'nope', 'missing'));
  assert.equal(r.ok, false);
  assert.match(r.error, /does not exist/i);
});

test('validateLocalRoot rejects a file path with a pointer to the folder', () => {
  const f = path.join(tmp, 'file.md');
  fs.writeFileSync(f, 'x');
  const r = validateLocalRoot(f);
  assert.equal(r.ok, false);
  assert.match(r.error, /is a file/i);
});

test('validateLocalRoot reports unreadable directories as a permission problem', (t) => {
  if (process.getuid && process.getuid() === 0) { t.skip('root ignores directory modes'); return; }
  const locked = path.join(tmp, 'locked');
  fs.mkdirSync(locked);
  fs.chmodSync(locked, 0o000);
  const r = validateLocalRoot(locked);
  assert.equal(r.ok, false);
  assert.match(r.error, /permission/i);
});

// ── friendlyCloneError ───────────────────────────────────────────────────

test('friendlyCloneError maps a missing git binary', () => {
  const msg = friendlyCloneError({ code: 'ENOENT', message: 'spawn git ENOENT' });
  assert.match(msg, /git is not installed/i);
});

test('friendlyCloneError maps a timeout kill', () => {
  const msg = friendlyCloneError({ killed: true, signal: 'SIGTERM', message: 'Command failed' });
  assert.match(msg, /timed out/i);
});

test('friendlyCloneError maps a nonexistent repository', () => {
  const msg = friendlyCloneError({ message: "Command failed: git clone ...\nfatal: repository 'https://github.com/x/y/' not found" });
  assert.match(msg, /repository not found/i);
});

test('friendlyCloneError maps a private or missing repository prompt', () => {
  const msg = friendlyCloneError({ message: 'fatal: could not read Username for https://github.com: terminal prompts disabled' });
  assert.match(msg, /not found, or it is private/i);
});

test('friendlyCloneError maps an unreachable host', () => {
  const msg = friendlyCloneError({ message: "fatal: unable to access 'https://nowhere.invalid/': Could not resolve host: nowhere.invalid" });
  assert.match(msg, /could not reach/i);
});

test('friendlyCloneError maps a local write-permission failure', () => {
  const msg = friendlyCloneError({ message: "fatal: could not create work tree dir 'x': Permission denied" });
  assert.match(msg, /cannot write/i);
});

test('friendlyCloneError never echoes the git command line or local paths', () => {
  const msg = friendlyCloneError({ message: 'Command failed: git clone --depth 1 https://github.com/a/b /home/someone/.config/husk/agent-repos/x\nfatal: mysterious breakage' });
  assert.ok(!msg.includes('git clone'));
  assert.ok(!msg.includes('/home/'));
  assert.match(msg, /mysterious breakage/);
});

test('friendlyCloneError falls back to a generic message', () => {
  const msg = friendlyCloneError({ message: 'Command failed: git clone ...' });
  assert.match(msg, /clone failed/i);
  assert.ok(!msg.includes('git clone'));
});

// ── friendlyScanError ────────────────────────────────────────────────────

test('friendlyScanError maps permission errors', () => {
  assert.match(friendlyScanError({ code: 'EACCES' }), /permission/i);
  assert.match(friendlyScanError({ code: 'EPERM' }), /permission/i);
});

test('friendlyScanError maps missing paths', () => {
  assert.match(friendlyScanError({ code: 'ENOENT' }), /does not exist/i);
});

test('friendlyScanError falls back to a generic message without leaking raw errors', () => {
  const msg = friendlyScanError(new Error('EWEIRD: something exploded at /home/user/secret'));
  assert.ok(!msg.includes('/home/'));
  assert.match(msg, /could not read/i);
});

// ─── main.js wiring assertions (same convention as the plugins editor test) ──

test('repoAgents:install resolves real paths and confines picks to the agents dir', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf8');
  const block = src.slice(src.indexOf("ipcMain.handle('repoAgents:install'"), src.indexOf('// ─── MCP install-from-repo flow'));
  assert.ok(block.includes('realpathSync'), 'install must resolve picks to their real path');
  assert.ok(block.includes('realAgentsDir'), 'install must compare against the real agents dir');
  assert.ok(block.includes("startsWith(realAgentsDir + path.sep)"), 'install must confine real paths to the agents dir');
  assert.ok(block.includes('validateLocalRoot'), 'install must validate the repo root');
});
