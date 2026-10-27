'use strict';

// Clone on the MCP page opens the server form prefilled from the source,
// named clone-<id>, so the copy can be renamed or changed before it is
// saved as a new server. The source is never touched.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const SOURCE = {
  id: 'filesystem',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/u/safe'],
  env: { TOKEN: 'user-secret' },
};

async function launch() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-mcp-clone-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({ firstRunDone: true, skipWelcome: true, agentCommand: 'claude', chatView: 'terminal' }));
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1', COPILOT_HOME: path.join(homeDir, '.copilot') },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  return { app, win, homeDir };
}

const readClaudeJson = (homeDir) => JSON.parse(fs.readFileSync(path.join(homeDir, '.claude.json'), 'utf8'));

test('Clone opens the prefilled form as clone-<id>, and Save creates the copy without touching the source', async () => {
  const { app, win, homeDir } = await launch();
  const added = await win.evaluate((s) => window.husk.mcp.add(s), SOURCE);
  expect(added.ok).toBe(true);
  await win.evaluate(async () => { setPage('mcp'); await renderMcp(); });
  const row = win.locator('.mcp-row[data-id="filesystem"]');
  await expect(row).toBeVisible();
  await row.locator('.mr-clone').click();

  const modal = win.locator('#mcp-install');
  await expect(modal).toBeVisible();
  await expect(win.locator('#mcp-install-title')).toHaveText('Clone MCP server: filesystem');
  await expect(win.locator('#mig-custom-id')).toHaveValue('clone-filesystem');
  await expect(win.locator('#mig-custom-cmd')).toHaveValue('npx');
  await expect(win.locator('#mig-custom-args')).toHaveValue(SOURCE.args.join('\n'));
  await expect(win.locator('#mig-custom-env')).toHaveValue('TOKEN=user-secret');
  await expect(win.locator('#mcp-install-confirm')).toHaveText('Save clone');
  // Nothing on disk changes until Save.
  expect(readClaudeJson(homeDir).mcpServers['clone-filesystem']).toBeUndefined();

  await win.locator('#mig-custom-id').fill('fs-readonly');
  await win.locator('#mig-custom-args').fill(['-y', '@modelcontextprotocol/server-filesystem', '/home/u/docs'].join('\n'));
  await win.locator('#mcp-install-confirm').click();
  await expect(modal).toBeHidden();

  await expect(win.locator('.mcp-row[data-id="fs-readonly"]')).toBeVisible();
  await expect(win.locator('.mcp-row[data-id="filesystem"]')).toBeVisible();
  const servers = readClaudeJson(homeDir).mcpServers;
  expect(servers['fs-readonly'].command).toBe('npx');
  expect(servers['fs-readonly'].args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '/home/u/docs']);
  expect(servers['fs-readonly'].env.TOKEN).toBe('user-secret');
  expect(servers.filesystem.args).toEqual(SOURCE.args);
  expect(servers['clone-filesystem']).toBeUndefined();
  await app.close();
});

test('saving a clone under a name that already exists is refused on the name field', async () => {
  const { app, win } = await launch();
  await win.evaluate((s) => window.husk.mcp.add(s), SOURCE);
  await win.evaluate(async () => { setPage('mcp'); await renderMcp(); });
  await win.locator('.mcp-row[data-id="filesystem"] .mr-clone').click();
  await win.locator('#mig-custom-id').fill('filesystem');
  await win.locator('#mcp-install-confirm').click();
  await expect(win.locator('#mcp-install')).toBeVisible();
  await expect(win.locator('#mcp-form-status')).toBeVisible();
  await expect(win.locator('#mig-custom-id')).toHaveClass(/input-error/);
  await expect(win.locator('.mcp-row')).toHaveCount(1);
  await app.close();
});
