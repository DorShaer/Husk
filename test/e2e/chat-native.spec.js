'use strict';

// What an agent's chat protocol does not carry is answered by its CLI, as a
// card in the conversation it was asked in. The chat view never gives way to
// a terminal: the thread, the composer and the tab stay, and the card settles
// into a record when the CLI is idle again. Covered here: a CLI that refuses
// to start until it is signed in, and a slash command only the CLI answers.

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLAUDE = path.join(__dirname, 'fixtures', 'fake-claude-stream.js');
const ACP = path.join(__dirname, 'fixtures', 'fake-acp-agent.js');

function makeHome(agentCommand, script) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-native-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, agentCommand, resumeLastOnLaunch: false,
  }));
  const bin = path.join(homeDir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, agentCommand), script(homeDir));
  fs.chmodSync(path.join(bin, agentCommand), 0o755);
  return { homeDir, bin };
}

async function launch({ homeDir, bin }) {
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal, #whatsnew').forEach((m) => { m.hidden = true; }); });
  return { app, win };
}

const ready = (win) => win.waitForFunction(() => {
  const i = document.querySelector('.chat-pane.show .chat-input');
  return i && !i.disabled && !/Starting|has exited/.test(i.placeholder);
}, null, { timeout: 30_000 });

const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);

test('a CLI that is not signed in signs in from a card in the chat, and the chat starts when it is through', async () => {
  // Refuses to serve until `login` has been run, the way kiro-cli does.
  const home = makeHome('kiro-cli', (dir) => `#!/bin/sh
if [ "$1" = "login" ]; then echo login >> "${dir}/calls.log"; touch "${dir}/signed-in"; echo "Signed in"; exit 0; fi
if [ ! -f "${dir}/signed-in" ]; then echo "error: You are not logged in, please log in with kiro-cli login" >&2; exit 1; fi
exec "${process.execPath}" "${ACP}" "$@"
`);
  const { app, win } = await launch(home);
  try {
    // The sign-in ran, as the CLI's own command, without a second tab.
    await expect.poll(() => lines(path.join(home.homeDir, 'calls.log')), { timeout: 30_000 }).toEqual(['login']);
    expect(await win.evaluate(() => TABS.size)).toBe(1); // eslint-disable-line no-undef
    // Through sign-in, nothing of the CLI is left on screen and the same
    // chat is live and takes a prompt.
    await expect(win.locator('.chat-native-term')).toHaveCount(0, { timeout: 30_000 });
    await ready(win);
    const pane = win.locator('.chat-pane.show');
    await expect(pane).not.toContainText('Terminal mode');
    await pane.locator('.chat-input').fill('quiet: hello');
    await pane.locator('.chat-input').press('Enter');
    await expect(pane.locator('.chat-item-user .chat-bubble')).toHaveText('quiet: hello');
    expect(lines(path.join(home.homeDir, 'calls.log'))).toEqual(['login']);
  } finally { await app.close(); }
});

test('a slash command only the CLI answers is answered in a card in the thread, which settles when the CLI is idle', async () => {
  // Speaks the chat protocol when asked to; otherwise it is "the interface":
  // it records what is typed at it and leaves on a second line. Like a real
  // one it never stops drawing (a clock, a cursor), so it is never silent.
  const home = makeHome('claude', (dir) => `#!/bin/sh
case " $* " in *" --input-format "*) exec "${process.execPath}" "${CLAUDE}" "$@";; esac
case "$1" in auth|agents|mcp|--version|-v) exec "${process.execPath}" "${CLAUDE}" "$@";; esac
[ -t 0 ] || exit 0
echo "interface start screen"
( while :; do printf '\\033[s\\033[1;60H%s\\033[u' "$(date +%S)"; sleep 0.2; done ) &
while :; do
  printf '> '
  IFS= read -r line || exit 0
  [ -n "$line" ] || continue
  echo "$line" >> "${dir}/typed.log"
  echo "showing $line"; echo "  server one   connected"
  IFS= read -r back || exit 0
done
`);
  const { app, win } = await launch(home);
  try {
    await ready(win);
    const pane = win.locator('.chat-pane.show');
    await pane.locator('.chat-input').fill('/mcp');
    await pane.locator('.chat-input').press('Enter');
    if (await pane.locator('.chat-input').inputValue()) await pane.locator('.chat-input').press('Enter');

    // A card in the thread, live, showing the CLI's answer and not its start
    // screen. The thread, the composer and the tab are all still there.
    const card = pane.locator('.chat-thread-inner > .chat-native-card');
    await expect(card).toBeVisible();
    await expect(card.locator('.chat-native-title')).toHaveText('claude /mcp');
    await expect.poll(() => lines(path.join(home.homeDir, 'typed.log')), { timeout: 20_000 }).toEqual(['/mcp']);
    await expect(card.locator('.chat-native-pill')).toHaveText('live');
    await expect(card.locator('.chat-native-term')).toContainText('server one');
    await expect(card.locator('.chat-native-term')).not.toContainText('interface start screen');
    await expect(pane.locator('.chat-input')).toBeVisible();
    await expect(pane.locator('.chat-thread')).toBeVisible();
    expect(await win.evaluate(() => TABS.size)).toBe(1); // eslint-disable-line no-undef
    // The card is part of the conversation's width, not a screen over it.
    const box = await card.boundingBox();
    const whole = await pane.boundingBox();
    expect(box.height).toBeLessThan(whole.height * 0.75);
    // Nothing stood in for the CLI: the command did not go to the agent as a
    // prompt and no listing was printed into the thread.
    await expect(pane.locator('.chat-item-user')).toHaveCount(0);
    await expect(pane.locator('.chat-item-text')).toHaveCount(0);
    await win.screenshot({ path: path.join(REPO_ROOT, 'test-results', 'chat-native-card-live.png') });

    // Keys go to the CLI. When it is idle again the card settles by itself
    // into a record of what it showed.
    await card.locator('.chat-native-term').click();
    await win.keyboard.press('Enter');
    await expect(card).toHaveClass(/is-done/, { timeout: 15_000 });
    await expect(card.locator('.chat-native-pill')).toHaveText('closed');
    await expect(card.locator('.chat-native-term')).toHaveCount(0);
    await expect(card.locator('.chat-native-said')).toContainText('server one   connected');
    await win.screenshot({ path: path.join(REPO_ROOT, 'test-results', 'chat-native-card-done.png') });

    // The conversation was there throughout and still takes a prompt.
    await ready(win);
    const again = win.locator('.chat-pane.show');
    await again.locator('.chat-input').fill('still here');
    await again.locator('.chat-input').press('Enter');
    await expect(again.locator('.chat-item-user .chat-bubble').last()).toHaveText('still here');
  } finally { await app.close(); }
});

test('a command that acts on the conversation still goes to the agent', async () => {
  const home = makeHome('claude', () => `#!/bin/sh\nexec "${process.execPath}" "${CLAUDE}" "$@"\n`);
  const { app, win } = await launch(home);
  try {
    await ready(win);
    const pane = win.locator('.chat-pane.show');
    await pane.locator('.chat-input').fill('/compact');
    await pane.locator('.chat-input').press('Enter');
    if (await pane.locator('.chat-input').inputValue()) await pane.locator('.chat-input').press('Enter');
    await expect(pane.locator('.chat-item-user .chat-bubble')).toHaveText('/compact');
    await expect(pane.locator('.chat-native-card')).toHaveCount(0);
  } finally { await app.close(); }
});
