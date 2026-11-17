'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createGitSetup, initFailure, folderInfo } = require('../../src/lib/git-setup');
const version = { ok: true, stdout: 'git version 2.50.0' };

async function folder(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'husk-git-setup-'));
  try { await fn(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('missing Git is explicit, cached, and never attempts initialization', async () => folder(async root => {
  const calls = [];
  const setup = createGitSetup({ run: async args => { calls.push(args); return { ok: false, errorCode: 'ENOENT' }; } });
  assert.equal((await setup.available()).available, false);
  await setup.available();
  assert.equal(calls.length, 1);
  const init = await setup.initialize(root);
  assert.equal(init.code, 'git-missing');
  assert.ok(calls.every(a => a[0] === '--version'));
  assert.match(init.error, /tracking still works/);
}));

test('Check again discovers Git installed after an earlier failed probe', async () => {
  let installed = false;
  const setup = createGitSetup({ run: async () => installed ? version : { ok: false, errorCode: 'ENOENT' } });
  assert.equal((await setup.available()).available, false);
  installed = true;
  assert.equal((await setup.available(true)).available, true);
});

test('broken Git reports an actionable state instead of claiming it is absent', async () => {
  const setup = createGitSetup({ run: async () => ({ ok: false, errorCode: 'EACCES' }) });
  assert.match((await setup.available()).error, /could not start/);
});

test('existing repositories, nested folders and worktree markers refuse initialization', async () => folder(async root => {
  const calls = [];
  const setup = createGitSetup({ run: async args => { calls.push(args); return version; } });
  await fs.writeFile(path.join(root, '.git'), 'gitdir: unavailable\n');
  await fs.mkdir(path.join(root, 'nested'));
  assert.equal((await setup.nonRepository(root)).code, 'git-repository-error');
  assert.equal((await setup.initialize(root)).code, 'already-repository');
  assert.equal((await setup.initialize(path.join(root, 'nested'))).code, 'already-repository');
  assert.ok(calls.every(args => args[0] === '--version'));
  assert.equal(await fs.readFile(path.join(root, '.git'), 'utf8'), 'gitdir: unavailable\n');
}));

test('older Git falls back to init plus setting HEAD, without a commit or remote', async () => folder(async root => {
  const calls = [];
  const setup = createGitSetup({ run: async args => {
    calls.push(args);
    if (args[0] === '--version') return version;
    if (args.includes('-b')) return { ok: false, stderr: 'unknown switch b' };
    return { ok: true };
  } });
  assert.equal((await setup.initialize(root)).ok, true);
  assert.deepEqual(calls.slice(1), [['-C', root, 'init', '-b', 'main'], ['-C', root, 'init'], ['-C', root, 'symbolic-ref', 'HEAD', 'refs/heads/main']]);
}));

test('a duplicate initialization is rejected while the first request is still running', async () => folder(async root => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const setup = createGitSetup({ run: async args => {
    if (args[0] === '--version') return version;
    entered(); await new Promise(resolve => { release = resolve; }); return { ok: true };
  } });
  const first = setup.initialize(root);
  await started;
  assert.equal((await setup.initialize(root)).code, 'git-init-pending');
  release(); assert.equal((await first).ok, true);
}));

test('read-only and vanished folders and timeouts get specific explanations', async () => folder(async root => {
  assert.equal(initFailure({ stderr: 'Permission denied' }).code, 'folder-readonly');
  assert.equal(initFailure({ timedOut: true }).code, 'git-timeout');
  assert.match(initFailure({ timedOut: true }).error, /Check whether a repository was created/);
  assert.equal((await folderInfo(path.join(root, 'missing'))).ok, false);
  await fs.writeFile(path.join(root, 'file'), 'not a folder');
  assert.equal((await folderInfo(path.join(root, 'file'))).ok, false);
}));

test('a genuinely read-only folder refuses initialization before git init is invoked', { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) }, async () => folder(async root => {
  const calls = [];
  const setup = createGitSetup({ run: async args => { calls.push(args); return version; } });
  await fs.chmod(root, 0o500);
  try {
    assert.equal((await setup.nonRepository(root)).canInit, false);
    assert.equal((await setup.initialize(root)).code, 'folder-readonly');
    assert.ok(calls.every(args => args[0] === '--version'));
  } finally { await fs.chmod(root, 0o700); }
}));

test('bare repositories are never reinitialized', async () => folder(async root => {
  await fs.writeFile(path.join(root, 'HEAD'), 'ref: refs/heads/main\n');
  await fs.mkdir(path.join(root, 'objects')); await fs.mkdir(path.join(root, 'refs'));
  const calls = [];
  const setup = createGitSetup({ run: async args => { calls.push(args); return version; } });
  assert.equal((await setup.initialize(root)).code, 'already-repository');
  assert.ok(calls.every(args => args[0] === '--version'));
}));
