'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('MCP registry is shared across Claude, Copilot, and Gemini configs', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-shared-mcp-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true,
    agentCommand: 'copilot',
  }));
  fs.writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify({
    mcpServers: {
      claude_only: { command: 'node', args: ['/tmp/claude-only.js'] },
    },
  }, null, 2));

  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1', COPILOT_HOME: path.join(homeDir, '.copilot') },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });

  const listed = await win.evaluate(() => window.husk.mcp.list());
  expect(listed.ok).toBe(true);
  expect(listed.servers.map((s) => s.id)).toContain('claude_only');
  expect(readJson(path.join(homeDir, '.copilot', 'mcp-config.json')).mcpServers.claude_only.command).toBe('node');
  expect(readJson(path.join(homeDir, '.gemini', 'settings.json')).mcpServers.claude_only.args[0]).toBe('/tmp/claude-only.js');

  const added = await win.evaluate(() => window.husk.mcp.add({
    id: 'shared_memory',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
  }));
  expect(added.ok).toBe(true);
  expect(readJson(path.join(homeDir, '.claude.json')).mcpServers.shared_memory.command).toBe('npx');
  expect(readJson(path.join(homeDir, '.copilot', 'mcp-config.json')).mcpServers.shared_memory.args[1]).toBe('@modelcontextprotocol/server-memory');
  expect(readJson(path.join(homeDir, '.gemini', 'settings.json')).mcpServers.shared_memory.command).toBe('npx');

  await app.close();
});
