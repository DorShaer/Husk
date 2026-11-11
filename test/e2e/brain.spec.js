'use strict';

// The Brain end to end: a note and a file are learned on its page, a prompt
// that matches them reaches the agent carrying them, the rail icon signals
// while the turn runs, and the finished turn is remembered. The agent is the
// codex fixture, which reports whether its prompt arrived with Brain notes.

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CODEX = path.join(__dirname, 'fixtures', 'fake-codex-app-server.js');

function makeHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-brain-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, agentCommand: 'codex', resumeLastOnLaunch: false,
  }));
  const bin = path.join(homeDir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nexec "${process.execPath}" "${CODEX}" "$@"\n`);
  fs.chmodSync(path.join(bin, 'codex'), 0o755);
  const doc = path.join(homeDir, 'runbook.md');
  fs.writeFileSync(doc, '# Runbook\n\nRestart the ingest worker with the supervisor command.\n\nThe ledger export runs nightly.\n');
  return { homeDir, bin, doc };
}

async function launch(homeDir, bin) {
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  await win.waitForFunction(() => window.husk && window.husk.brain && window.Brain && document.querySelector('.chat-stage'));
  return { app, win };
}

async function chatReady(win) {
  await win.waitForFunction(() => {
    const i = document.querySelector('.chat-pane.show .chat-input');
    return i && !/Starting/.test(i.placeholder);
  });
}

async function ask(win, text) {
  const pane = win.locator('.chat-pane.show');
  await pane.locator('.chat-input').fill(text);
  await pane.locator('.chat-input').press('Enter');
  await expect(pane.locator('.chat-perm:not(.is-resolved)')).toBeVisible();
  return pane;
}

test('the Brain learns, recalls into a prompt, signals on the rail and remembers the turn', async () => {
  const { homeDir, bin, doc } = makeHome();
  const { app, win } = await launch(homeDir, bin);
  try {
    await chatReady(win);
    await win.evaluate(() => setPage('brain')); // eslint-disable-line no-undef
    await expect(win.locator('#br-empty')).toBeVisible();
    // An empty Brain still reads: zeros and words, no broken figures.
    await expect(win.locator('#br-stats .br-stat')).toHaveCount(6);
    await expect(win.locator('#br-stats')).not.toContainText(/NaN|undefined|Infinity/);
    await expect(win.locator('#br-stats .br-stat').nth(0)).toContainText('Nothing kept yet');

    // A note, typed on the page.
    await win.click('#br-add-note');
    await win.fill('#br-note-text', 'The staging cluster deploy goes through the blue pipeline');
    await win.click('#br-note-form button[type="submit"]');
    await expect(win.locator('#br-list .br-row')).toHaveCount(1);
    await expect(win.locator('#br-empty')).toBeHidden();
    await expect(win.locator('#br-detail')).toContainText('blue pipeline');

    // A file, through the system picker (answered here in its place).
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, doc);
    await win.click('#br-add-files');
    await expect(win.locator('#br-list .br-row[data-kind="file"]')).toHaveCount(1);
    await expect(win.locator('#br-last')).toContainText('Learned 1 file');
    // The note, the file and its passage are all on the canvas.
    await expect.poll(() => win.evaluate(() => window.Brain._state().dots)).toBe(3);
    await win.screenshot({ path: path.join(REPO_ROOT, 'test-results', 'brain-page.png') });

    // The sphere zooms from its controls and from the wheel, turns under a
    // drag, and fits back.
    const view = () => win.evaluate(() => window.Brain._state());
    await expect.poll(async () => (await view()).auto).toBe(true);
    const before = (await view()).zoom;
    await win.click('#br-zoom-in');
    expect((await view()).zoom).toBeGreaterThan(before);
    expect((await view()).auto).toBe(false);
    await expect(win.locator('#br-zoom')).toHaveText(Math.round((await view()).zoom * 100) + '%');
    const zoomedIn = (await view()).zoom;
    await win.locator('#br-canvas').hover({ position: { x: 200, y: 200 } });
    await win.mouse.wheel(0, 600);
    await expect.poll(async () => (await view()).zoom).toBeLessThan(zoomedIn);
    const yaw0 = (await view()).yaw;
    await win.locator('#br-canvas').dragTo(win.locator('#br-canvas'), { sourcePosition: { x: 300, y: 300 }, targetPosition: { x: 380, y: 300 } });
    expect((await view()).yaw).toBeGreaterThan(yaw0 + 0.3);
    await win.click('#br-fit');
    await expect.poll(async () => (await view()).auto).toBe(true);

    // Full screen gives the field the whole window; the button or Esc gives it back.
    const stageBox = async () => win.locator('.br-stage').boundingBox();
    const small = await stageBox();
    await win.click('#br-full');
    const size = await win.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    await expect.poll(async () => Math.round((await stageBox()).width)).toBe(size.w);
    expect(Math.round((await stageBox()).height)).toBe(size.h);
    await expect(win.locator('#br-full')).toHaveAttribute('aria-pressed', 'true');
    // Over the page, not through it: the field paints a solid colour of its own.
    const paint = await win.evaluate(() => { const c = getComputedStyle(document.querySelector('.br-stage')); return { color: c.backgroundColor, image: c.backgroundImage }; });
    expect(paint.color).toMatch(/^rgb\(/);
    expect(paint.image).not.toMatch(/\/ 0?\.\d+\)/);
    await win.keyboard.press('Escape');
    await expect.poll(async () => Math.round((await stageBox()).width)).toBe(Math.round(small.width));
    await win.click('#br-full');
    await win.click('#br-full');
    await expect(win.locator('#br-full')).toHaveAttribute('aria-pressed', 'false');

    // The counts say what is here; nothing has been asked yet.
    await expect(win.locator('#br-stats .br-stat')).toHaveCount(6);
    await expect(win.locator('#br-stats .br-stat').nth(0)).toContainText('2');
    await expect(win.locator('#br-stats .br-stat').nth(4)).toContainText('–');
    // A file lists what was learned from it, and a passage leads back to its file.
    await win.locator('#br-list .br-row[data-kind="file"]').click();
    await expect(win.locator('#br-detail')).toContainText('1 passage learned');
    await win.locator('#br-detail .br-link').first().click();
    await expect(win.locator('#br-detail')).toContainText('supervisor command');
    await expect(win.locator('#br-detail')).toContainText('From');

    // A prompt that matches the note carries it to the agent, and the rail
    // icon signals for as long as the turn runs.
    await win.evaluate(() => setPage('chat')); // eslint-disable-line no-undef
    let pane = await ask(win, 'how does the staging cluster deploy work?');
    // The dot is unhidden; on the collapsed rail that makes the icon itself blink.
    await expect(win.locator('#rail-brain-pulse')).toHaveJSProperty('hidden', false);
    await expect(win.locator('#rail-brain .ri-icon')).toHaveCSS('animation-name', 'ap-icon-blink');
    // The thread shows what was typed, not what was added for the agent.
    await expect(pane.locator('.chat-item-user .chat-bubble')).toHaveText('how does the staging cluster deploy work?');
    await pane.locator('.chat-perm:not(.is-resolved) .chat-perm-btn', { hasText: 'Allow' }).click();
    await expect(pane.locator('.chat-item-text').last()).toContainText('brain=yes');
    await expect(pane.locator('.chat-meta .chat-meta-line')).toContainText('Done');

    // The finished turn is a memory now.
    await win.evaluate(() => setPage('brain')); // eslint-disable-line no-undef
    await expect(win.locator('#br-list .br-row[data-kind="decision"]')).toHaveCount(1);
    await expect(win.locator('#br-list .br-row[data-kind="decision"] .br-row-title')).toHaveText('how does the staging cluster deploy work?');
    // The numbers moved with it, and the log says what happened, newest first.
    await expect(win.locator('#br-stats .br-stat').nth(3)).toContainText('1');
    await expect(win.locator('#br-stats .br-stat').nth(4)).toContainText('100%');
    // The strip says more than the counts: the split by kind beside the first
    // figure, in two groups, and a meter on the hit rate.
    await expect(win.locator('#br-stats .br-stat-group')).toHaveCount(2);
    await expect(win.locator('#br-stats .br-stat').nth(0)).toContainText('1 note · 1 file · 1 decision');
    await expect(win.locator('#br-stats .br-stat').nth(0).locator('.br-stat-bar i')).toHaveCount(3);
    await expect(win.locator('#br-stats .br-stat').nth(4).locator('.br-meter i')).toHaveCount(1);

    // A line on the field can be picked. The decision shares words with the
    // note, so a synapse joins them, and picking it says which words.
    const pick = async (kind) => {
      await expect.poll(async () => {
        const at = await win.evaluate((k) => window.Brain._edgeMid(k), kind);
        if (!at) return null;
        await win.locator('#br-canvas').click({ position: at });
        return (await view()).edge;
      }).toBeTruthy();
    };
    await pick('synapse');
    await expect(win.locator('#br-detail')).toContainText('Connection');
    await expect(win.locator('#br-detail .br-end')).toHaveCount(2);
    await expect(win.locator('#br-detail')).toContainText('blue pipeline');
    await expect(win.locator('#br-detail')).toContainText('Strength');
    await expect(win.locator('#br-detail .br-chip', { hasText: 'staging' })).toHaveCount(1);
    await win.screenshot({ path: path.join(REPO_ROOT, 'test-results', 'brain-synapse.png') });
    // Either end leads to its memory, and that lets go of the line.
    await win.locator('#br-detail .br-end[data-kind="note"]').click();
    await expect(win.locator('#br-list .br-row.is-selected')).toHaveCount(1);
    expect((await view()).edge).toBe(null);
    // The line from a file to its passage is not a dead one either.
    await pick('part');
    await expect(win.locator('#br-detail')).toContainText('Part of a file');
    await expect(win.locator('#br-list .br-row.is-selected')).toHaveCount(0);

    await win.click('.br-tab[data-tab="activity"]');
    await expect(win.locator('#br-list .br-act').first()).toContainText('Remembered the outcome of');
    await expect(win.locator('#br-list .br-act').nth(1)).toContainText('Recalled 1 memory for');
    await win.locator('#br-list .br-act').nth(1).click();
    await expect(win.locator('#br-detail')).toContainText('blue pipeline');
    await win.click('.br-tab[data-tab="memories"]');
    await expect(win.locator('#rail-brain-pulse')).toHaveJSProperty('hidden', true, { timeout: 6000 });

    // Switched off, nothing rides along and nothing new is kept.
    await win.uncheck('#br-enabled');
    await win.evaluate(() => setPage('chat')); // eslint-disable-line no-undef
    pane = await ask(win, 'tell me about the staging cluster deploy again');
    await pane.locator('.chat-perm:not(.is-resolved) .chat-perm-btn', { hasText: 'Allow' }).click();
    await expect(pane.locator('.chat-item-text').last()).toContainText('brain=no');
    await win.evaluate(() => setPage('brain')); // eslint-disable-line no-undef
    await expect(win.locator('#br-list .br-row[data-kind="decision"]')).toHaveCount(1);

    // Forgetting the file takes its passages with it.
    await win.locator('#br-list .br-row[data-kind="file"]').click();
    await win.click('#br-detail .br-forget');
    await expect(win.locator('#br-list .br-row[data-kind="file"]')).toHaveCount(0);
    const saved = JSON.parse(fs.readFileSync(path.join(homeDir, '.config', 'husk', 'brain.json'), 'utf8'));
    expect(saved.nodes.map((n) => n.kind).sort()).toEqual(['decision', 'note']);
  } finally { await app.close(); }
});
