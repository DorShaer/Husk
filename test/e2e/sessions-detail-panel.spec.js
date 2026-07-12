'use strict';

// Session detail panels keep their full width when the status panel is
// collapsed. The layout should reserve a usable detail column, not the compact
// status-toggle column.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function makeIsolatedHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-'));
  fs.mkdirSync(path.join(dir, '.config', 'husk'), { recursive: true });
  // Without firstRunDone, boot() blocks on the welcome wizard (no agent CLI
  // on CI runners) and its modal intercepts the session-row click.
  fs.writeFileSync(path.join(dir, '.config', 'husk', 'config.json'), JSON.stringify({ firstRunDone: true }));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  const proj = path.join(dir, '.claude', 'projects', '-home-test-proj');
  fs.mkdirSync(proj, { recursive: true });
  // sessions:list skips user-only files as queue-operation receipts, so the
  // fixture needs an assistant turn to count as a real conversation.
  const lines = [
    JSON.stringify({ timestamp: new Date().toISOString(), cwd: '/home/test/proj', type: 'user', message: { content: 'hello world first message' } }),
    JSON.stringify({ timestamp: new Date().toISOString(), type: 'assistant', message: { content: [{ type: 'text', text: 'hello back' }] } }),
  ];
  fs.writeFileSync(path.join(proj, '11111111-2222-3333-4444-555555555555.jsonl'), lines.join('\n') + '\n');
  return dir;
}

test('session detail panel stays full width when status panel is collapsed', async () => {
  const homeDir = makeIsolatedHome();
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');

  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  // The trigger condition: status panel collapsed.
  await win.evaluate(() => { document.body.dataset.status = 'collapsed'; });
  await win.evaluate(() => setPage('sessions'));
  await win.waitForSelector('.session-row', { timeout: 10_000 });
  await win.click('.session-row');
  await win.waitForTimeout(400); // dp-in animation settles

  const info = await win.evaluate(() => {
    const panel = document.getElementById('detail-panel');
    const cs = getComputedStyle(panel);
    const rect = panel.getBoundingClientRect();
    return { display: cs.display, visibility: cs.visibility, width: Math.round(rect.width) };
  });
  expect(info.display).not.toBe('none');
  expect(info.visibility).toBe('visible');
  // Must be the real panel width, not the 28px collapsed-status sliver.
  expect(info.width).toBeGreaterThan(380);
  await app.close();
});

test('copilot sessions use the first prompt when workspace name is null', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-copilot-sessions-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true,
    agentCommand: 'copilot',
  }));
  const sessionDir = path.join(homeDir, '.copilot', 'session-state', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  fs.mkdirSync(sessionDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(sessionDir, 'workspace.yaml'), [
    'id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    'name: null',
    'cwd: /tmp/copilot-project',
    `created_at: ${now}`,
    `updated_at: ${now}`,
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), [
    JSON.stringify({ type: 'user.message', data: { content: 'Troubleshoot Copilot Plugin Sessions naming bug' } }),
    JSON.stringify({ type: 'assistant.message', data: { content: 'Working on it.' } }),
  ].join('\n') + '\n');
  const autoDir = path.join(homeDir, '.copilot', 'session-state', 'ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb');
  fs.mkdirSync(autoDir, { recursive: true });
  const autoCwd = path.join(homeDir, '.config', 'Husk', 'autopilot-worktrees', 'ap-test-worker');
  fs.mkdirSync(autoCwd, { recursive: true });
  fs.writeFileSync(path.join(autoDir, 'workspace.yaml'), [
    'id: ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb',
    'name: Hidden autopilot worker',
    `cwd: ${autoCwd}`,
    `created_at: ${now}`,
    `updated_at: ${now}`,
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(autoDir, 'events.jsonl'), [
    JSON.stringify({ type: 'user.message', data: { content: 'Autopilot worker should not show in Sessions' } }),
    JSON.stringify({ type: 'assistant.message', data: { content: 'Hidden worker output.' } }),
  ].join('\n') + '\n');
  const plannerDir = path.join(homeDir, '.copilot', 'session-state', '11111111-2222-3333-4444-555555555555');
  fs.mkdirSync(plannerDir, { recursive: true });
  fs.writeFileSync(path.join(plannerDir, 'workspace.yaml'), [
    'id: 11111111-2222-3333-4444-555555555555',
    'name: null',
    'cwd: /tmp/copilot-project',
    `created_at: ${now}`,
    `updated_at: ${now}`,
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(plannerDir, 'events.jsonl'), [
    JSON.stringify({ type: 'user.message', data: { content: 'You are an orchestrator planning a team of autonomous coding agents that will work IN PARALLEL on one shared goal.' } }),
    JSON.stringify({ type: 'assistant.message', data: { content: 'Hidden planner output.' } }),
  ].join('\n') + '\n');
  const yamlTitleDir = path.join(homeDir, '.copilot', 'session-state', '22222222-3333-4444-5555-666666666666');
  fs.mkdirSync(yamlTitleDir, { recursive: true });
  fs.writeFileSync(path.join(yamlTitleDir, 'workspace.yaml'), [
    'id: 22222222-3333-4444-5555-666666666666',
    'name: null',
    'cwd: /tmp/copilot-project',
    `created_at: ${now}`,
    `updated_at: ${now}`,
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(yamlTitleDir, 'events.jsonl'), [
    JSON.stringify({ type: 'user.message', data: { content: '|-\n[AUTONOMOUS MODE] You are running unattended. No human is available to answer questions.\nMaintain .husk-autopilot-status.json.' } }),
    JSON.stringify({ type: 'assistant.message', data: { content: 'Hidden autonomous output.' } }),
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
  await win.evaluate(() => setPage('sessions'));
  await win.waitForSelector('.session-row', { timeout: 10_000 });

  const rows = await win.evaluate(() => Array.from(document.querySelectorAll('.session-row')).map((r) => r.textContent.replace(/\s+/g, ' ').trim()));
  expect(rows.join(' ')).toContain('Troubleshoot Copilot Plugin Sessions naming bug');
  expect(rows.join(' ')).not.toContain('(unnamed session)');
  expect(rows.join(' ')).not.toContain('Autopilot worker should not show in Sessions');
  expect(rows.join(' ')).not.toContain('orchestrator planning a team');
  expect(rows.join(' ')).not.toContain('[AUTONOMOUS MODE]');
  const sub = await win.textContent('#sessions-sub');
  expect(sub).toContain('3 Autopilot sessions');
  await app.close();
});
