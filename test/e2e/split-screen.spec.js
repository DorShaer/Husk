'use strict';

// Two chats side by side: Split opens a second pane, the divider drags, focus
// follows a click, and closing either half puts the thread back to one pane.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

async function launch() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({ firstRunDone: true, skipWelcome: true, agentCommand: 'true' }));
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  await win.waitForFunction(() => typeof openNewChatTab === 'function' && document.querySelector('.term-pane.show'), null, { timeout: 20_000 });
  return { app, win };
}

const state = (win) => win.evaluate(() => ({
  split: !!SPLIT,
  picking: document.querySelector('#tab-strip').classList.contains('is-picking'),
  hostSplit: document.querySelector('#terminal').classList.contains('is-split'),
  shown: [...document.querySelectorAll('.term-pane.show')].map((el) => el.dataset.sessionId),
  inSplit: [...document.querySelectorAll('.chat-tab.in-split')].map((el) => el.dataset.tab),
  active: activeTabId,
  activeTabs: document.querySelectorAll('.chat-tab.active').length,
  label: document.querySelector('#btn-split .btn-label').textContent,
  divider: !!(document.querySelector('#term-divider') && document.querySelector('#term-divider').offsetWidth),
  tabs: [...TABS.keys()],
  empty: document.querySelector('#chat-empty').classList.contains('show'),
}));

const geometry = (win) => win.evaluate(() => {
  const host = document.querySelector('#terminal').getBoundingClientRect();
  const panes = [...document.querySelectorAll('.term-pane.show')].map((el) => {
    const r = el.getBoundingClientRect();
    const tab = TABS.get(el.dataset.sessionId);
    return { id: el.dataset.sessionId, left: r.left, width: r.width, cols: tab.term.cols, ptyCols: tab._cols };
  });
  return { host: host.width, panes };
});

test('split shows two chats in a row and the divider resizes them', async () => {
  const { app, win } = await launch();
  const single = await geometry(win);
  expect(single.panes).toHaveLength(1);
  const fullCols = single.panes[0].cols;

  // One tab: Split opens a second chat beside it.
  await win.click('#btn-split');
  await win.waitForFunction(() => document.querySelectorAll('.term-pane.show').length === 2, null, { timeout: 10_000 });
  await win.waitForTimeout(300);
  let s = await state(win);
  expect(s.split).toBe(true);
  expect(s.hostSplit).toBe(true);
  expect(s.tabs).toHaveLength(2);
  expect(s.inSplit.sort()).toEqual([...s.tabs].sort());
  expect(s.activeTabs).toBe(1);
  expect(s.label).toBe('Unsplit');
  expect(s.divider).toBe(true);
  expect(s.empty).toBe(false);

  let g = await geometry(win);
  expect(g.panes).toHaveLength(2);
  expect(g.panes[0].width).toBeGreaterThan(0);
  expect(g.panes[1].width).toBeGreaterThan(0);
  expect(g.panes[0].left).toBeLessThan(g.panes[1].left);
  expect(Math.abs(g.panes[0].width + g.panes[1].width + 6 - g.host)).toBeLessThan(8);
  // Each pane is fitted to its own half and its own session.
  expect(g.panes[0].cols).toBeLessThan(fullCols);
  expect(g.panes[0].ptyCols).toBe(g.panes[0].cols);
  expect(g.panes[1].ptyCols).toBe(g.panes[1].cols);

  // Drag the divider to the right: the left pane grows and refits.
  const bar = await win.locator('#term-divider').boundingBox();
  const leftBefore = g.panes[0];
  await win.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
  await win.mouse.down();
  await win.mouse.move(bar.x + bar.width / 2 + 60, bar.y + bar.height / 2, { steps: 4 });
  await win.mouse.move(bar.x + bar.width / 2 + 120, bar.y + bar.height / 2, { steps: 4 });
  await win.mouse.up();
  await win.waitForTimeout(250);
  g = await geometry(win);
  expect(Math.abs(g.panes[0].width - (leftBefore.width + 120))).toBeLessThan(10);
  expect(g.panes[0].cols).toBeGreaterThan(leftBefore.cols);
  expect(g.panes[0].ptyCols).toBe(g.panes[0].cols);
  expect(g.panes[0].cols).not.toBe(g.panes[1].cols);

  // The share is clamped: a drag to the far edge stops at 80 percent.
  const bar2 = await win.locator('#term-divider').boundingBox();
  await win.mouse.move(bar2.x + 3, bar2.y + 20);
  await win.mouse.down();
  await win.mouse.move(bar2.x + 3000, bar2.y + 20, { steps: 3 });
  await win.mouse.up();
  await win.waitForTimeout(250);
  g = await geometry(win);
  expect(g.panes[0].width / g.host).toBeLessThan(0.82);
  expect(g.panes[0].width / g.host).toBeGreaterThan(0.78);

  // Clicking the other pane focuses it.
  const before = (await state(win)).active;
  const other = g.panes.find((p) => p.id !== before);
  const otherEl = win.locator(`.term-pane[data-session-id="${other.id}"]`);
  await otherEl.hover();
  await win.mouse.down();
  await win.mouse.up();
  await win.waitForTimeout(150);
  s = await state(win);
  expect(s.active).toBe(other.id);
  expect(s.split).toBe(true);
  expect(s.activeTabs).toBe(1);

  // Unsplit leaves the focused chat whole at full width.
  await win.click('#btn-split');
  await win.waitForTimeout(300);
  s = await state(win);
  expect(s.split).toBe(false);
  expect(s.hostSplit).toBe(false);
  expect(s.shown).toEqual([other.id]);
  expect(s.divider).toBe(false);
  expect(s.inSplit).toEqual([]);
  expect(s.label).toBe('Split');
  g = await geometry(win);
  expect(g.panes).toHaveLength(1);
  expect(g.panes[0].cols).toBe(fullCols);
  const pos = await win.evaluate(() => getComputedStyle(document.querySelector('.term-pane.show')).position);
  expect(pos).toBe('absolute');

  await app.close();
});

test('pick mode chooses the second chat from the strip and a close unsplits', async () => {
  const { app, win } = await launch();
  await win.evaluate(() => openNewChatTab({ command: 'true', skipWelcome: true }));
  await win.evaluate(() => openNewChatTab({ command: 'true', skipWelcome: true }));
  await win.waitForFunction(() => TABS.size === 3, null, { timeout: 10_000 });
  const ids = await win.evaluate(() => [...TABS.keys()]);
  const focused = await win.evaluate(() => activeTabId);
  expect(focused).toBe(ids[2]);

  // Split with several tabs open asks for a pick; Escape backs out.
  await win.click('#btn-split');
  let s = await state(win);
  expect(s.picking).toBe(true);
  expect(s.label).toBe('Pick a chat');
  await win.keyboard.press('Escape');
  s = await state(win);
  expect(s.picking).toBe(false);
  expect(s.split).toBe(false);

  // Pick the first tab with a real centre-of-tab click: in pick mode the hover
  // pencil and close stand down, so the whole tab is one target.
  await win.click('#btn-split');
  const pickBox = await win.locator(`.chat-tab[data-tab="${ids[0]}"]`).boundingBox();
  await win.mouse.move(pickBox.x + pickBox.width / 2, pickBox.y + pickBox.height / 2);
  const underCursor = await win.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return { edit: !!(el && el.closest('[data-edit]')), close: !!(el && el.closest('[data-close]')) };
  }, { x: pickBox.x + pickBox.width / 2, y: pickBox.y + pickBox.height / 2 });
  expect(underCursor.edit).toBe(false);
  expect(underCursor.close).toBe(false);
  await win.mouse.down();
  await win.mouse.up();
  await win.waitForTimeout(300);
  s = await state(win);
  expect(s.picking).toBe(false);
  expect(s.split).toBe(true);
  expect(s.shown.sort()).toEqual([ids[0], ids[2]].sort());
  expect(s.active).toBe(ids[2]);
  const order = await win.evaluate(() => [...document.querySelectorAll('.term-pane.show')]
    .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
    .map((el) => el.dataset.sessionId));
  expect(order).toEqual([ids[2], ids[0]]);

  // Clicking the other half in the strip focuses it, the pair stays.
  await win.click(`.chat-tab[data-tab="${ids[0]}"] .chat-tab-label`);
  await win.waitForTimeout(150);
  s = await state(win);
  expect(s.active).toBe(ids[0]);
  expect(s.shown.sort()).toEqual([ids[0], ids[2]].sort());

  // Clicking a chat outside the pair puts it in the focused pane's seat.
  await win.click(`.chat-tab[data-tab="${ids[1]}"] .chat-tab-label`);
  await win.waitForTimeout(300);
  s = await state(win);
  expect(s.split).toBe(true);
  expect(s.active).toBe(ids[1]);
  expect(s.shown.sort()).toEqual([ids[1], ids[2]].sort());

  // Ctrl+\ with the page focused toggles the split off and on.
  await win.evaluate(() => { document.activeElement && document.activeElement.blur(); });
  await win.keyboard.press('Control+\\');
  await win.waitForTimeout(200);
  expect((await state(win)).split).toBe(false);
  await win.keyboard.press('Control+\\');
  await win.waitForTimeout(200);
  s = await state(win);
  expect(s.picking).toBe(true);
  await win.keyboard.press('Escape');

  // Closing one half of a split leaves the other whole.
  await win.click('#btn-split');
  await win.click(`.chat-tab[data-tab="${ids[2]}"] .chat-tab-label`);
  await win.waitForTimeout(300);
  s = await state(win);
  expect(s.split).toBe(true);
  await win.evaluate((id) => closeTab(id), ids[2]);
  await win.waitForTimeout(400);
  s = await state(win);
  expect(s.split).toBe(false);
  expect(s.hostSplit).toBe(false);
  expect(s.shown).toHaveLength(1);
  expect(s.tabs).not.toContain(ids[2]);
  expect(s.shown[0]).toBe(s.active);
  expect(s.tabs).toContain(s.active);

  await app.close();
});

test('opening a new chat while split ends the split and shows the new chat', async () => {
  const { app, win } = await launch();
  // One tab: Split opens a second chat beside it.
  await win.click('#btn-split');
  await win.waitForFunction(() => document.querySelectorAll('.term-pane.show').length === 2, null, { timeout: 10_000 });
  expect((await state(win)).split).toBe(true);

  // A brand-new chat is its own single pane. The split ends, the new tab is the
  // one on screen, and it is the one the keyboard reaches: no pane is active
  // yet hidden.
  await win.evaluate(() => openNewChatTab({ command: 'true', skipWelcome: true }));
  await win.waitForFunction(() => TABS.size === 3, null, { timeout: 10_000 });
  await win.waitForTimeout(300);
  const s = await state(win);
  expect(s.split).toBe(false);
  expect(s.hostSplit).toBe(false);
  expect(s.shown).toHaveLength(1);
  expect(s.shown[0]).toBe(s.active);

  // The visible pane has real geometry, so its PTY was fit to the window rather
  // than left at the terminal default.
  const g = await win.evaluate(() => {
    const el = document.querySelector('.term-pane.show');
    const tab = TABS.get(el.dataset.sessionId);
    return { width: el.getBoundingClientRect().width, cols: tab.term.cols };
  });
  expect(g.width).toBeGreaterThan(0);
  expect(g.cols).toBeGreaterThan(24);

  await app.close();
});
