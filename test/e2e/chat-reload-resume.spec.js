'use strict';

// The thread survives a reload of a chat that was itself resumed from disk.
//
// A claude chat resumed on boot (or from the Sessions column) paints its past
// turns in the renderer from the on-disk log, but the chat runtime began with
// an empty replay log. A later reload rebuilds each live chat from that runtime
// log, so the resumed chat came back blank: the child was alive, nothing
// painted, and only reopening the session from the column (which re-reads the
// disk log) brought the thread back. The fix seeds the runtime log with the
// resumed turns and, for a chat already running with an empty log, reads the
// disk log during reattach.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'fake-claude-stream.js');
const sanitize = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

function makeHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-reload-resume-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  const proj = homeDir; // chats open in HOME by default here
  // A past claude chat the user held in Husk: one real typed turn and a reply.
  const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const dir = path.join(homeDir, '.claude', 'projects', sanitize(proj));
  fs.mkdirSync(dir, { recursive: true });
  const t = new Date().toISOString();
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), [
    JSON.stringify({ type: 'user', promptSource: 'sdk', entrypoint: 'sdk-cli', cwd: proj, sessionId, timestamp: t, message: { role: 'user', content: 'remember the frog' } }),
    JSON.stringify({ type: 'assistant', timestamp: t, message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'The frog is remembered.' }] } }),
  ].join('\n') + '\n');
  // Marked as one of Husk's own chats so the Sessions list keeps it and boot
  // resume picks it rather than hiding it as an SDK run.
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'chat-sessions.json'), JSON.stringify([sessionId]));
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, agentCommand: 'claude', resumeLastOnLaunch: true,
  }));
  const bin = path.join(homeDir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  return { homeDir, bin, sessionId };
}

test('a resumed chat keeps its thread across a reload', async () => {
  test.setTimeout(90_000);
  const env = makeHome();
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: env.homeDir, USERPROFILE: env.homeDir, PATH: `${env.bin}${path.delimiter}${process.env.PATH}`, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  try {
    const win = await app.firstWindow({ timeout: 30_000 });
    await win.waitForLoadState('domcontentloaded');
    await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });

    // Boot resumes the past chat: its one turn is painted from the on-disk log.
    const pane = win.locator('.chat-pane.show');
    await expect(pane.locator('.chat-item-user .chat-bubble')).toHaveText('remember the frog', { timeout: 30_000 });
    await expect(pane.locator('.chat-item-text')).toContainText('The frog is remembered.');

    // The runtime now holds the resumed turns, so a reload rebuilds them.
    await win.reload();
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => window.HuskChat && document.querySelector('.chat-pane.show'), null, { timeout: 20_000 });

    const pane2 = win.locator('.chat-pane.show');
    await expect(pane2.locator('.chat-item-user .chat-bubble')).toHaveText('remember the frog', { timeout: 20_000 });
    await expect(pane2.locator('.chat-item-text')).toContainText('The frog is remembered.');
    await expect(win.locator('#chat-empty')).not.toHaveClass(/show/);
    // The same resumed child, still reachable: a new turn goes through.
    await pane2.locator('.chat-input').fill('and the toad');
    await pane2.locator('.chat-input').press('Enter');
    await expect(pane2.locator('.chat-item-user')).toHaveCount(2);
    await expect(pane2.locator('.chat-item-text').last()).toContainText('Echo: and the toad');
  } finally {
    await app.close();
  }
});
