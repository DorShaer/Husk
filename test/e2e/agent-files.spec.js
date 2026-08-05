'use strict';

// Husk agents must be usable by whichever CLI the user runs, so each agent is
// written into every installed CLI's native agents dir (~/.claude/agents and
// ~/.copilot/agents). Verifies (a) creating an agent writes the file to both,
// and (b) the stored record is the source of truth for every tool, so an edit
// reaches each dir and no single tool's copy outranks the record.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function makeHome(extraConfig = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-agentfiles-'));
  fs.mkdirSync(path.join(dir, '.config', 'husk'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.copilot', 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.config', 'husk', 'config.json'),
    JSON.stringify({ firstRunDone: true, skipWelcome: true, ...extraConfig }),
  );
  return dir;
}

async function boot(homeDir) {
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => {
    try { return typeof cfg !== 'undefined' && cfg && cfg.agentCommand !== undefined; } catch (_) { return false; } // eslint-disable-line no-undef
  }, null, { timeout: 15_000 });
  return { app, win };
}

test('creating an agent writes it into both claude and copilot agent dirs', async () => {
  const homeDir = makeHome();
  const { app, win } = await boot(homeDir);
  await win.evaluate(() => window.husk.profiles.create({
    name: 'Sec Auditor', description: 'finds bugs', systemPrompt: 'You are Sec. Be careful.',
  }));
  await win.waitForTimeout(200);
  await app.close();

  const claudeFile = path.join(homeDir, '.claude', 'agents', 'sec-auditor.md');
  const copilotFile = path.join(homeDir, '.copilot', 'agents', 'sec-auditor.md');
  expect(fs.existsSync(claudeFile)).toBe(true);
  expect(fs.existsSync(copilotFile)).toBe(true);
  expect(fs.readFileSync(copilotFile, 'utf8')).toContain('You are Sec. Be careful.');
});

test('startup writes the stored record into every tool dir, over a stale file', async () => {
  const homeDir = makeHome({
    profiles: [{ id: 'p1', name: 'Reviewer', description: 'review agent', systemPrompt: 'You are a senior reviewer.', builtin: false }],
  });
  // A stale file from an earlier version of the same agent.
  fs.writeFileSync(path.join(homeDir, '.claude', 'agents', 'reviewer.md'), '---\nname: Reviewer\n---\n\nold body\n');

  const { app } = await boot(homeDir);
  // boot() already waited for the renderer; the startup sync runs in whenReady.
  await new Promise((r) => setTimeout(r, 400));
  await app.close();

  const claudeFile = path.join(homeDir, '.claude', 'agents', 'reviewer.md');
  const copilotFile = path.join(homeDir, '.copilot', 'agents', 'reviewer.md');
  expect(fs.existsSync(copilotFile)).toBe(true);
  for (const f of [claudeFile, copilotFile]) {
    const text = fs.readFileSync(f, 'utf8');
    expect(text).toContain('You are a senior reviewer.');
    expect(text).not.toContain('old body');
  }
});

test('editing an agent reaches every tool dir', async () => {
  const homeDir = makeHome();
  const { app, win } = await boot(homeDir);
  const created = await win.evaluate(() => window.husk.profiles.create({
    name: 'Sec Auditor', description: 'finds bugs', systemPrompt: 'first prompt',
  }));
  await win.evaluate((id) => window.husk.profiles.update({
    id, name: 'Sec Auditor', description: 'finds bugs', systemPrompt: 'second prompt',
  }), created.id);
  await win.waitForTimeout(200);
  await app.close();

  for (const tool of ['.claude', '.copilot']) {
    const text = fs.readFileSync(path.join(homeDir, tool, 'agents', 'sec-auditor.md'), 'utf8');
    expect(text).toContain('second prompt');
    expect(text).not.toContain('first prompt');
  }
});
