'use strict';

// The Files page reads a single file's diff through fs:gitDiff. git matches a
// pathspec by wildmatch as well as literally, so these pin that a path whose own
// name holds glob characters is read as the one file it names.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { makeGlobRepo } = require('../helpers/git-repo');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function launch(config) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-'));
  const cfgDir = path.join(homeDir, '.config', 'husk');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, ...(config || {}),
  }, null, 2));
  return electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
}

async function ready(app) {
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  return win;
}

// The paths a diff names, read out of its `diff --git` headers.
function filesIn(diff) {
  const out = [];
  for (const line of String(diff || '').split('\n')) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) out.push(m[2]);
    const n = /^\+\+\+ b\/(.+)$/.exec(line);
    if (n && out.indexOf(n[1]) === -1) out.push(n[1]);
  }
  return [...new Set(out)];
}

test('a tracked path whose name is also a glob reads as the one file it names', async () => {
  test.setTimeout(90_000);
  const repo = makeGlobRepo('husk-files-glob');
  test.skip(!repo, 'this filesystem does not keep bracket characters in a file name');

  const app = await launch();
  const win = await ready(app);

  const res = await win.evaluate(
    ([root, rel]) => window.husk.fs.gitDiff(root, rel),
    [repo.dir, repo.bracket],
  );
  expect(res.ok).toBe(true);
  // The file beside it is modified too and its name is what the bracket name
  // matches as a pattern, so it is the one that would ride along.
  expect(filesIn(res.diff)).toEqual([repo.bracket]);
  expect(res.diff).not.toContain(repo.plain);

  // The plain file still reads on its own, so the guard did not cost a normal
  // path its diff.
  const plain = await win.evaluate(
    ([root, rel]) => window.husk.fs.gitDiff(root, rel),
    [repo.dir, repo.plain],
  );
  expect(plain.ok).toBe(true);
  expect(filesIn(plain.diff)).toEqual([repo.plain]);
  await app.close();
});

test('an untracked path whose name is also a glob still reads its whole content', async () => {
  test.setTimeout(90_000);
  const repo = makeGlobRepo('husk-files-glob-new');
  test.skip(!repo, 'this filesystem does not keep bracket characters in a file name');

  // An untracked file has no tracked diff, so this exercises the --no-index arm.
  const untracked = 'src/routes/[slug].js';
  fs.writeFileSync(path.join(repo.dir, untracked), "'use strict';\n\nmodule.exports = 1;\n");

  const app = await launch();
  const win = await ready(app);
  const res = await win.evaluate(
    ([root, rel]) => window.husk.fs.gitDiff(root, rel),
    [repo.dir, untracked],
  );
  expect(res.ok).toBe(true);
  expect(res.diff).toContain('module.exports = 1;');
  expect(res.diff).not.toContain(repo.plain);
  await app.close();
});

test('a path outside the root is refused rather than read', async () => {
  const repo = makeGlobRepo('husk-files-confine');
  test.skip(!repo, 'this filesystem does not keep bracket characters in a file name');

  const app = await launch();
  const win = await ready(app);
  for (const rel of ['../../etc/passwd', '/etc/passwd']) {
    const res = await win.evaluate(
      ([root, r]) => window.husk.fs.gitDiff(root, r),
      [repo.dir, rel],
    );
    expect(res.ok, rel).toBe(false);
  }
  await app.close();
});
