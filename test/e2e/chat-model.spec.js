'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

test('status panel shows the active model', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });

  // A real cwd for the pty, and a matching claude session log carrying a model.
  const realCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-cwd-'));
  const encoded = realCwd.replace(/[/\\:]/g, '-');
  const projDir = path.join(homeDir, '.claude', 'projects', encoded);
  fs.mkdirSync(projDir, { recursive: true });
  const lines = [
    JSON.stringify({ timestamp: new Date().toISOString(), cwd: realCwd, type: 'user', message: { content: 'hi' } }),
    JSON.stringify({ timestamp: new Date().toISOString(), type: 'assistant', message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'hello' }] } }),
  ];
  fs.writeFileSync(path.join(projDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'), lines.join('\n') + '\n');

  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });

  // Spawn a pty in the matching cwd so activePtyCwd is set, then read stats.
  await win.evaluate((cwd) => window.husk.pty.restart({ cols: 80, rows: 24, command: 'true', cwd }), realCwd);
  await win.waitForTimeout(300);

  const result = await win.evaluate(async () => {
    const s = await window.husk.stats.get();
    // Render the status panel from fresh stats.
    await refreshStats();
    refreshStatusline();
    const sp = document.getElementById('sp-content');
    const rows = Array.from(sp.querySelectorAll('.sp-row')).map((r) => r.textContent.replace(/\s+/g, ' ').trim());
    const modelRow = rows.find((t) => t.startsWith('Model'));
    return { statModel: s.usage && s.usage.session && s.usage.session.model, modelRow };
  });
  expect(result.statModel).toBe('claude-opus-4-8');
  expect(result.modelRow).toContain('Opus 4.8');
  await app.close();
});

test('status panel shows Copilot event-log usage', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-copilot-usage-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true,
    agentCommand: 'copilot',
  }));
  const realCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-copilot-cwd-'));
  const sessDir = path.join(homeDir, '.copilot', 'session-state', 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff');
  fs.mkdirSync(sessDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(sessDir, 'workspace.yaml'), [
    'id: bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
    'name: null',
    `cwd: ${realCwd}`,
    `created_at: ${now}`,
    `updated_at: ${now}`,
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(sessDir, 'events.jsonl'), [
    JSON.stringify({ type: 'session.model_change', data: { newModel: 'gpt-5.5' } }),
    JSON.stringify({ type: 'user.message', data: { content: 'show usage' } }),
    JSON.stringify({ type: 'assistant.message', data: { model: 'gpt-5.5', outputTokens: 70, content: 'ok' } }),
    JSON.stringify({
      type: 'session.shutdown',
      data: {
        currentModel: 'gpt-5.5',
        currentTokens: 17408,
        conversationTokens: 161,
        systemTokens: 8437,
        toolDefinitionsTokens: 8806,
        totalPremiumRequests: 3,
        totalApiDurationMs: 3210,
        modelMetrics: {
          'gpt-5.5': {
            requests: { count: 1, cost: 3 },
            usage: { inputTokens: 17656, outputTokens: 70, cacheReadTokens: 0, cacheWriteTokens: 17653, reasoningTokens: 15 },
            totalNanoAiu: 0,
          },
        },
      },
    }),
  ].join('\n') + '\n');

  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1', COPILOT_HOME: path.join(homeDir, '.copilot') },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  await win.evaluate((cwd) => window.husk.pty.restart({ cols: 80, rows: 24, command: 'true', cwd }), realCwd);
  await win.waitForTimeout(300);

  const result = await win.evaluate(async () => {
    await refreshStats();
    refreshStatusline();
    const rows = Array.from(document.querySelectorAll('#sp-content .sp-row')).map((r) => r.textContent.replace(/\s+/g, ' ').trim());
    return { rows, session: lastStats.usage.session };
  });
  expect(result.session.currentTokens).toBe(17408);
  expect(result.rows.join(' ')).toContain('Current tokens 17k');
  expect(result.rows.join(' ')).toContain('Output tokens 70');
  expect(result.rows.join(' ')).toContain('Premium requests 3');
  expect(result.rows.join(' ')).not.toContain('Plan usage limits appear here');
  await app.close();
});
