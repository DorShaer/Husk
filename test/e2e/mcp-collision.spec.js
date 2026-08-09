'use strict';

// Installing an MCP server over an id that already exists, through the app.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const VENDOR_CONFIGS = ['.claude.json', '.copilot/mcp-config.json', '.gemini/settings.json'];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// The server already installed.
const EXISTING = {
  id: 'filesystem',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/u/safe'],
  env: { TOKEN: 'user-secret' },
};

async function launch() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-mcp-collision-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true,
    skipWelcome: true,
    agentCommand: 'claude',
  }));

  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      ELECTRON_DISABLE_SANDBOX: '1',
      HUSK_E2E: '1',
      COPILOT_HOME: path.join(homeDir, '.copilot'),
    },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  return { app, win, homeDir };
}

// Every vendor config still holds the installed server, field for field.
function expectUntouched(homeDir) {
  for (const rel of VENDOR_CONFIGS) {
    const server = readJson(path.join(homeDir, rel)).mcpServers.filesystem;
    expect(server.command, `${rel} command`).toBe('npx');
    expect(server.args, `${rel} args`).toEqual(EXISTING.args);
    expect(server.env.TOKEN, `${rel} env`).toBe('user-secret');
  }
}

test('installing over an existing server id is refused and nothing on disk changes', async () => {
  const { app, win, homeDir } = await launch();
  try {
    const added = await win.evaluate((s) => window.husk.mcp.add(s), EXISTING);
    expect(added.ok, 'the first install failed').toBe(true);

    const collided = await win.evaluate(() => window.husk.mcp.add({
      id: 'filesystem',
      transport: 'stdio',
      command: 'node',
      args: ['/tmp/other-server.js'],
    }));

    expect(collided.ok, 'a colliding install reported success').toBe(false);
    expect(collided.error, `unexpected error: ${collided.error}`).toMatch(/already exists/i);
    expectUntouched(homeDir);

    // One entry by that name, still the original.
    const listed = await win.evaluate(() => window.husk.mcp.list());
    const matches = listed.servers.filter((s) => s.id === 'filesystem');
    expect(matches.length, 'the refusal left a duplicate entry').toBe(1);
    expect(matches[0].command).toBe('npx');
  } finally {
    await app.close();
  }
});

test('a pasted snippet installs its new servers and reports only the collision', async () => {
  const { app, win, homeDir } = await launch();
  try {
    await win.evaluate((s) => window.husk.mcp.add(s), EXISTING);

    const res = await win.evaluate(() => window.husk.mcp.addMany([
      { id: 'filesystem', transport: 'stdio', command: 'node', args: ['/tmp/other-server.js'] },
      { id: 'brand-new', transport: 'stdio', command: 'npx', args: ['-y', 'thing'] },
    ]));

    expect(res.results.filesystem.status, 'the collision was reported as installed').toBe('error');
    expect(res.results.filesystem.error).toMatch(/already exists/i);
    expect(res.results['brand-new'].status, 'a clean entry was blocked by the collision').toBe('installed');
    expect(res.installed, 'the installed count included the refused entry').toBe(1);

    expectUntouched(homeDir);
    expect(readJson(path.join(homeDir, '.claude.json')).mcpServers['brand-new'].command).toBe('npx');
  } finally {
    await app.close();
  }
});

test('editing an existing server still works, because an edit names what it edits', async () => {
  const { app, win, homeDir } = await launch();
  try {
    await win.evaluate((s) => window.husk.mcp.add(s), EXISTING);

    const res = await win.evaluate(() => window.husk.mcp.update({
      id: 'filesystem',
      oldId: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/u/other'],
      env: { TOKEN: 'user-secret' },
    }));

    expect(res.ok, `a legitimate edit was refused: ${res.error}`).toBe(true);
    for (const rel of VENDOR_CONFIGS) {
      expect(readJson(path.join(homeDir, rel)).mcpServers.filesystem.args, rel)
        .toEqual(['-y', '@modelcontextprotocol/server-filesystem', '/home/u/other']);
    }
  } finally {
    await app.close();
  }
});

test('a server with a free name installs normally', async () => {
  const { app, win, homeDir } = await launch();
  try {
    await win.evaluate((s) => window.husk.mcp.add(s), EXISTING);

    const res = await win.evaluate(() => window.husk.mcp.add({
      id: 'memory',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
    }));

    expect(res.ok, `an uncontested install was refused: ${res.error}`).toBe(true);
    for (const rel of VENDOR_CONFIGS) {
      expect(readJson(path.join(homeDir, rel)).mcpServers.memory.command, rel).toBe('npx');
    }
    expectUntouched(homeDir);
  } finally {
    await app.close();
  }
});
