'use strict';

// Per-project MCP selection, end to end through the real app.
//
// The point of the feature is that a folder can drop a server the global list
// enables without disabling it everywhere, and that the launch actually carries
// that decision. So this asserts three things: the MCP page offers the project
// scope, setting a row to Off narrows the resolved set for that folder only,
// and the project panel reports what the folder really runs.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function makeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-pmcp-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(home, '.config', 'husk'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  // Two servers on the global list so the test can turn exactly one off.
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: {
      memory: { type: 'stdio', command: 'npx', args: ['-y', 'server-memory'] },
      tickets: { type: 'http', url: 'https://example.test/mcp' },
    },
  }));
  fs.writeFileSync(path.join(home, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true,
    skipWelcome: true,
    paiEnabled: false,
    voice: { enabled: false },
    agentCommand: 'claude',
    projects: [{ id: 'p1', name: 'proj', path: project }],
    activeProjectId: 'p1',
  }));
  return { root, home, project };
}

async function launch(env) {
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: env.home, USERPROFILE: env.home, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  return { app, win };
}

test('a project can drop one MCP server without disabling it everywhere', async () => {
  const env = makeEnv();
  const { app, win } = await launch(env);

  // Both servers start out inherited, so the folder resolves to the full list
  // and nothing is pinned at launch.
  const before = await win.evaluate((p) => window.husk.mcp.projectGet(p), env.project);
  expect(before.effective.sort()).toEqual(['memory', 'tickets']);
  expect(before.customized).toBe(false);
  expect(before.supported).toBe(true);

  // Turn one off for this folder.
  const set = await win.evaluate((p) => window.husk.mcp.projectSet({ path: p, id: 'memory', state: 'off' }), env.project);
  expect(set.ok).toBe(true);

  const after = await win.evaluate((p) => window.husk.mcp.projectGet(p), env.project);
  expect(after.effective).toEqual(['tickets']);
  expect(after.customized).toBe(true);
  expect(after.rows.find((r) => r.id === 'memory').source).toBe('project');

  // The global list is untouched: the server is still enabled everywhere else.
  const global = await win.evaluate(() => window.husk.mcp.list());
  expect(global.servers.find((s) => s.id === 'memory').enabled).toBe(true);
  const otherFolder = await win.evaluate(() => window.husk.mcp.projectGet('/tmp'));
  expect(otherFolder.effective.sort()).toEqual(['memory', 'tickets']);

  // Clearing puts the folder back on the global list.
  await win.evaluate((p) => window.husk.mcp.projectClear(p), env.project);
  const reset = await win.evaluate((p) => window.husk.mcp.projectGet(p), env.project);
  expect(reset.effective.sort()).toEqual(['memory', 'tickets']);
  expect(reset.customized).toBe(false);

  await app.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});

test('the MCP page offers a project scope with a three-way per server', async () => {
  const env = makeEnv();
  const { app, win } = await launch(env);

  await win.evaluate(() => window.husk.mcp.projectSet
    && document.querySelector('.rail-item[data-page="mcp"]').click());
  await win.waitForSelector('#mcp-scope:not([hidden])', { timeout: 10_000 });

  // Global scope is the default and keeps the existing on/off toggle.
  await win.waitForSelector('.mcp-row .toggle', { timeout: 10_000 });
  expect(await win.locator('.mcp-scope-btn').nth(0)).toBeTruthy();

  // Switching to the project scope swaps in the three-way.
  await win.locator('.mcp-scope-btn[data-scope="project"]').click();
  await win.waitForSelector('.mr-tri', { timeout: 10_000 });
  const row = win.locator('.mcp-row[data-id="memory"]');
  await expect(row.locator('.mr-tri-btn[data-tri="inherit"]')).toHaveClass(/on/);

  // Choosing Off narrows this folder and marks the row as the project's doing.
  await row.locator('.mr-tri-btn[data-tri="off"]').click();
  await win.waitForFunction(() => {
    const r = document.querySelector('.mcp-row[data-id="memory"]');
    return r && r.querySelector('.mr-tag');
  }, null, { timeout: 10_000 });
  const resolved = await win.evaluate((p) => window.husk.mcp.projectGet(p), env.project);
  expect(resolved.effective).toEqual(['tickets']);

  await app.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});

// The selection is only real if the launch carries it, so this drives a fake
// `claude` on PATH and reads back the argv Husk actually spawned it with.
test('the launch pins the folder\'s resolved set and leaves the global config alone', async () => {
  const env = makeEnv();
  const bin = path.join(env.root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const exe = path.join(bin, 'claude');
  const fake = path.join(__dirname, 'fixtures', 'fake-cli.js');
  fs.writeFileSync(exe, `#!/bin/sh\nexec node ${JSON.stringify(fake)} "$@"\n`);
  fs.chmodSync(exe, 0o755);
  const capture = path.join(env.root, 'capture.json');

  const cfgPath = path.join(env.home, '.config', 'husk', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  fs.writeFileSync(cfgPath, JSON.stringify({
    ...cfg,
    agentCommand: exe,
    agentCwd: env.project,
    projectMcp: { [env.project]: { memory: 'off' } },
  }));

  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: env.home,
      USERPROFILE: env.home,
      ELECTRON_DISABLE_SANDBOX: '1',
      HUSK_E2E: '1',
      CAPTURE: capture,
    },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => window.husk.pty.start({ cols: 100, rows: 30 }));
  await win.waitForTimeout(2000);
  await app.close();

  const invocations = fs.readFileSync(capture, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const launch = invocations.find((i) => i.argv.includes('--strict-mcp-config'));
  expect(launch, `no launch carried the MCP flags: ${JSON.stringify(invocations)}`).toBeTruthy();

  // The file the flag points at holds the resolved set, minus the server this
  // project turned off.
  const idx = launch.argv.indexOf('--mcp-config');
  expect(idx).toBeGreaterThan(-1);
  const written = JSON.parse(fs.readFileSync(launch.argv[idx + 1], 'utf8'));
  expect(Object.keys(written.mcpServers)).toEqual(['tickets']);

  // The user's own config still has both servers, so a CLI started outside
  // Husk is unaffected.
  const claudeJson = JSON.parse(fs.readFileSync(path.join(env.home, '.claude.json'), 'utf8'));
  expect(Object.keys(claudeJson.mcpServers).sort()).toEqual(['memory', 'tickets']);

  fs.rmSync(env.root, { recursive: true, force: true });
});

test('a folder with no overrides launches with no MCP flags at all', async () => {
  const env = makeEnv();
  const bin = path.join(env.root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const exe = path.join(bin, 'claude');
  const fake = path.join(__dirname, 'fixtures', 'fake-cli.js');
  fs.writeFileSync(exe, `#!/bin/sh\nexec node ${JSON.stringify(fake)} "$@"\n`);
  fs.chmodSync(exe, 0o755);
  const capture = path.join(env.root, 'capture.json');

  const cfgPath = path.join(env.home, '.config', 'husk', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, agentCommand: exe, agentCwd: env.project }));

  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: {
      ...process.env, HOME: env.home, USERPROFILE: env.home,
      ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1', CAPTURE: capture,
    },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => window.husk.pty.start({ cols: 100, rows: 30 }));
  await win.waitForTimeout(2000);
  await app.close();

  const invocations = fs.readFileSync(capture, 'utf8').split('\n').filter(Boolean).map((i) => JSON.parse(i));
  expect(invocations.length).toBeGreaterThan(0);
  for (const inv of invocations) {
    expect(inv.argv, JSON.stringify(inv.argv)).not.toContain('--strict-mcp-config');
    expect(inv.argv, JSON.stringify(inv.argv)).not.toContain('--mcp-config');
  }

  fs.rmSync(env.root, { recursive: true, force: true });
});

test('the project panel lists what the folder runs, not a config key', async () => {
  const env = makeEnv();
  const { app, win } = await launch(env);

  await win.evaluate((p) => window.husk.mcp.projectSet({ path: p, id: 'memory', state: 'off' }), env.project);
  const ins = await win.evaluate(() => window.husk.projects.inspect('p1'));
  expect(ins.ok).toBe(true);
  // Inherited server is listed, the folder's own removal is reported separately.
  expect(ins.mcpServers).toEqual(['tickets']);
  expect(ins.mcpExcluded).toEqual(['memory']);
  expect(ins.mcpRows.find((r) => r.id === 'tickets').source).toBe('global');

  await app.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});
