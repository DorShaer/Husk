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

test('claude Sessions list hides SDK-driven transcripts but keeps typed chats', async () => {
  // Husk shells out to `claude --print` for background scoring and drives the
  // autopilot/workflow orchestrators over the SDK; each leaves an auto-titled
  // transcript in the same projects dir. One real chat used to show up beside a
  // crowd of these look-alikes. The first turn's origin is the tell: human-typed
  // chats carry origin.kind "human"/promptSource "typed"; background runs carry
  // promptSource "sdk". Old files predate the field and must be kept.
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-claude-sessions-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({ firstRunDone: true }));
  const proj = path.join(homeDir, '.claude', 'projects', '-home-test-proj');
  fs.mkdirSync(proj, { recursive: true });
  const now = () => new Date().toISOString();
  const write = (id, lines) => fs.writeFileSync(path.join(proj, `${id}.jsonl`), lines.join('\n') + '\n');

  // A real chat the user typed.
  write('aaaaaaaa-0000-0000-0000-000000000001', [
    JSON.stringify({ timestamp: now(), cwd: '/home/test/proj', type: 'user', promptSource: 'typed', origin: { kind: 'human' }, message: { content: 'REAL typed conversation about widgets' } }),
    JSON.stringify({ timestamp: now(), type: 'assistant', message: { content: [{ type: 'text', text: 'sure' }] } }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Discuss the widget design' }),
  ]);
  // A `claude --print` background run: has an assistant turn, so the old
  // receipt-skip would not catch it -- the origin filter must.
  write('bbbbbbbb-0000-0000-0000-000000000002', [
    JSON.stringify({ timestamp: now(), cwd: '/home/test/proj', type: 'queue-operation', operation: 'enqueue', content: 'SENTIMENT: score this' }),
    JSON.stringify({ timestamp: now(), cwd: '/home/test/proj', type: 'user', promptSource: 'sdk', message: { content: 'SENTIMENT: score this' } }),
    JSON.stringify({ timestamp: now(), type: 'assistant', message: { content: [{ type: 'text', text: '7' }] } }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Background sentiment scoring run' }),
  ]);
  // An SDK orchestrator run, likewise auto-titled and otherwise chat-shaped.
  write('cccccccc-0000-0000-0000-000000000003', [
    JSON.stringify({ timestamp: now(), cwd: '/home/test/proj', type: 'user', promptSource: 'sdk', message: { content: 'You are an orchestrator planning a team of autonomous coding agents' } }),
    JSON.stringify({ timestamp: now(), type: 'assistant', message: { content: [{ type: 'text', text: 'planning' }] } }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Orchestrator planning run' }),
  ]);
  // A pre-promptSource file: no origin signal, so it must be kept, not hidden.
  write('dddddddd-0000-0000-0000-000000000004', [
    JSON.stringify({ timestamp: now(), cwd: '/home/test/proj', type: 'user', message: { content: 'OLD chat from before origin tracking' } }),
    JSON.stringify({ timestamp: now(), type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }),
  ]);
  // A real chat that OPENS with a prepended SDK context turn (a PAI hook fired
  // early) but continues with human-typed turns. Keying on the first turn alone
  // would wrongly hide it; one human turn anywhere must keep it.
  write('eeeeeeee-0000-0000-0000-000000000005', [
    JSON.stringify({ timestamp: now(), cwd: '/home/test/proj', type: 'user', promptSource: 'sdk', message: { content: 'PREVIOUS AI RESPONSE: injected context' } }),
    JSON.stringify({ timestamp: now(), type: 'assistant', message: { content: [{ type: 'text', text: 'noted' }] } }),
    JSON.stringify({ timestamp: now(), cwd: '/home/test/proj', type: 'user', promptSource: 'typed', origin: { kind: 'human' }, message: { content: 'REAL follow-up I actually typed' } }),
    JSON.stringify({ timestamp: now(), type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Chat that opened with injected context' }),
  ]);

  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  await win.evaluate(() => setPage('sessions'));
  await win.waitForSelector('.session-row', { timeout: 10_000 });

  const rows = await win.evaluate(() => Array.from(document.querySelectorAll('.session-row')).map((r) => r.textContent.replace(/\s+/g, ' ').trim()));
  const joined = rows.join(' ');
  expect(joined).toContain('Discuss the widget design');       // typed chat kept
  expect(joined).toContain('OLD chat from before origin tracking'); // fail-open kept
  expect(joined).toContain('Chat that opened with injected context'); // human turn anywhere kept
  expect(joined).not.toContain('Background sentiment scoring run'); // --print hidden
  expect(joined).not.toContain('Orchestrator planning run');        // SDK orchestrator hidden
  expect(rows.length).toBe(3);
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

test('copilot resume rejection closes the transient chat tab', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-copilot-reject-'));
  const copilotHome = path.join(homeDir, '.custom-copilot');
  const resumeMarker = path.join(homeDir, 'resume-called.txt');
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true,
    skipWelcome: true,
    agentCommand: 'copilot',
  }));

  const rejectedId = '99999999-aaaa-bbbb-cccc-dddddddddddd';
  const sessionDir = path.join(copilotHome, 'session-state', rejectedId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(sessionDir, 'workspace.yaml'), [
    `id: ${rejectedId}`,
    'name: null',
    'cwd: /tmp/copilot-project',
    `created_at: ${now}`,
    `updated_at: ${now}`,
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), [
    JSON.stringify({ type: 'user.message', data: { content: 'Rejected resume should not leave a tab' } }),
    JSON.stringify({ type: 'assistant.message', data: { content: 'A previous answer.' } }),
  ].join('\n') + '\n');

  const binDir = path.join(homeDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const fakeCopilot = path.join(binDir, 'copilot');
  fs.writeFileSync(fakeCopilot, `#!/usr/bin/env node
const fs = require('fs');
if (process.argv.includes('--version') || process.argv.includes('-v') || process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('1.0.75');
  process.exit(0);
}
if (process.argv.includes('--list-models')) {
  console.log('Model Reasoning\\nGPT-5.5 high');
  process.exit(0);
}
const resumeArg = process.argv.find((a) => a.startsWith('--resume='));
if (resumeArg) {
  const id = resumeArg.slice('--resume='.length);
  fs.writeFileSync(process.env.HUSK_RESUME_MARKER, id);
  process.stdout.write("Error: No session, task, or name matched '" + id + "'.\\n");
  process.exit(0);
}
for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, () => process.exit(0));
process.stdout.write('fake copilot ready\\n');
setInterval(() => {}, 1000);
`);
  fs.chmodSync(fakeCopilot, 0o755);

  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
      HOME: homeDir,
      USERPROFILE: homeDir,
      COPILOT_HOME: copilotHome,
      HUSK_RESUME_MARKER: resumeMarker,
      ELECTRON_DISABLE_SANDBOX: '1',
      HUSK_E2E: '1',
    },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  await win.waitForFunction(() => typeof TABS !== 'undefined' && TABS.size === 1, null, { timeout: 10_000 });

  await win.evaluate(() => setPage('sessions'));
  await win.waitForSelector('.session-row', { timeout: 10_000 });
  const where = await win.getAttribute('#btn-sessions-open', 'title');
  expect(where).toContain(path.join(copilotHome, 'session-state'));
  await win.click('.session-row');
  await win.click('#dp-foot .btn-primary');

  await expect.poll(() => fs.existsSync(resumeMarker), { timeout: 10_000 }).toBe(true);
  await expect.poll(
    () => win.evaluate(() => TABS.size),
    { timeout: 10_000 },
  ).toBe(1);
  const state = await win.evaluate(() => {
    const tab = [...TABS.values()][0];
    const buf = tab.term.buffer.active;
    let text = '';
    for (let y = 0; y < buf.length; y++) text += (buf.getLine(y)?.translateToString(true) || '');
    return { sub: document.getElementById('statusbar').textContent, text };
  });
  expect(state.sub).not.toContain('--resume');
  expect(state.text).not.toContain('No session, task, or name matched');

  await app.close();
});
