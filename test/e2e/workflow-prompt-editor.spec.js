'use strict';

// A step prompt is prose, so the editor wraps it. The old editor did not: it
// ran one endless line off to the right and numbered a whole paragraph "1".
// These pin the three things that fixed it: soft wrap, a gutter that measures
// wrapped lines, and a panel whose width is the writer's to set.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const PROMPT = [
  'Summarise the current diff: what changed, which files, and what the change is trying to do. Keep it under fifteen lines.',
  '',
  'The reviewers after this step read only your summary and the code, so leave nothing important out.',
].join('\n');

function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-prompt-'));
  fs.mkdirSync(path.join(dir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.config', 'husk', 'config.json'),
    JSON.stringify({ firstRunDone: true, skipWelcome: true }),
  );
  return dir;
}

async function openStepPanel(homeDir) {
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  // Widening is capped at window.innerWidth - 140, so on a small default window
  // the wide width collapses onto the narrow one and the panel cannot grow.
  // The size is set here rather than inherited from whatever the runner gives.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1600, height: 1000 });
  });
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => typeof setPage === 'function', null, { timeout: 20_000 });
  await win.evaluate(() => setPage('workflows'));
  await win.waitForTimeout(500);
  await win.evaluate(() => openWorkflowBuilder(null));
  await win.waitForTimeout(700);
  await win.click('#btn-add-wf-node');
  await win.waitForTimeout(500);
  await win.evaluate(() => {
    const n = document.querySelector('#wf-canvas .drawflow-node');
    showNodePanel(n.id.replace(/^node-/, ''));
  });
  await win.waitForSelector('#wf-node-panel:not([hidden])', { timeout: 10_000 });
  return { app, win };
}

// Gutter geometry: one entry per logical line, each as tall as that line
// actually renders. A wrapped paragraph is one number over several rows.
const readEditor = () => ({
  whiteSpace: getComputedStyle(document.getElementById('wf-np-prompt')).whiteSpace,
  overflowX: (() => { const t = document.getElementById('wf-np-prompt'); return t.scrollWidth - t.clientWidth; })(),
  numbers: [...document.querySelectorAll('#wf-np-gutter > div')].map((d) => d.textContent),
  heights: [...document.querySelectorAll('#wf-np-gutter > div')].map((d) => Math.round(d.getBoundingClientRect().height)),
  measure: document.getElementById('wf-np-measure').textContent,
  panelWidth: Math.round(document.querySelector('#wf-node-panel .wf-drawer-panel').getBoundingClientRect().width),
  widenLabel: document.getElementById('wf-np-widen-label').textContent,
});

test('the prompt wraps and the gutter numbers logical lines, not rows', async () => {
  test.setTimeout(90_000);
  const { app, win } = await openStepPanel(makeHome());
  try {
    await win.fill('#wf-np-prompt', PROMPT);
    await win.waitForTimeout(300);
    const s = await win.evaluate(readEditor);

    expect(s.whiteSpace).toBe('pre-wrap');
    expect(s.overflowX).toBe(0);                 // nothing runs off to the right
    expect(s.numbers).toEqual(['1', '2', '3']);  // three logical lines, three numbers
    // The first line wraps over several rows, the blank second line is one row.
    expect(s.heights[0]).toBeGreaterThan(s.heights[1] * 2);
    expect(s.heights[2]).toBeGreaterThan(s.heights[1]);
    expect(s.measure).toMatch(/^\d+ words · ~\d+ tokens$/);
  } finally {
    await app.close();
  }
});

// Deleting a step cannot be undone, so it may not look like a link next to a
// solid primary button. It carries the same weight, in the destructive colour.
test('delete node reads as destructive and matches the Done button', async () => {
  test.setTimeout(90_000);
  const { app, win } = await openStepPanel(makeHome());
  try {
    const foot = await win.evaluate(() => {
      const del = document.getElementById('wf-np-delete');
      const done = document.getElementById('wf-node-panel-done');
      const dc = getComputedStyle(del);
      const rose = getComputedStyle(document.documentElement).getPropertyValue('--rose').trim();
      const toRgb = (hex) => {
        const h = hex.replace('#', '');
        return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`;
      };
      return {
        delH: Math.round(del.getBoundingClientRect().height),
        doneH: Math.round(done.getBoundingClientRect().height),
        delW: Math.round(del.getBoundingClientRect().width),
        doneW: Math.round(done.getBoundingClientRect().width),
        color: dc.color,
        expected: toRgb(rose),
        hasBorder: parseFloat(dc.borderTopWidth) > 0,
      };
    });
    expect(foot.delH).toBe(foot.doneH);
    expect(Math.abs(foot.delW - foot.doneW)).toBeLessThanOrEqual(24);
    expect(foot.color).toBe(foot.expected);
    expect(foot.hasBorder).toBe(true);
  } finally {
    await app.close();
  }
});

test('widening the panel gives the prompt the room and remeasures the gutter', async () => {
  test.setTimeout(90_000);
  const homeDir = makeHome();
  const { app, win } = await openStepPanel(homeDir);
  try {
    // The wide width is capped by the window, so on a small screen it collapses
    // onto the narrow one. Stated as a precondition, a failure here names that
    // instead of comparing two equal widths further down.
    const room = await win.evaluate(() => wfDrawerWide());   // eslint-disable-line no-undef
    expect(room, 'window too narrow for widening to do anything').toBeGreaterThan(560);

    await win.fill('#wf-np-prompt', PROMPT);
    await win.waitForTimeout(300);
    const narrow = await win.evaluate(readEditor);
    expect(narrow.widenLabel).toBe('Widen');

    await win.click('#wf-np-widen');
    // The panel animates to its new width. On a virtual display frames are
    // throttled enough that the transition outlasts any fixed sleep, so this
    // waits for the width itself rather than for a clock.
    await win.waitForFunction((target) => {
      const p = document.querySelector('#wf-node-panel .wf-drawer-panel');
      return p && Math.round(p.getBoundingClientRect().width) >= target;
    }, room, { timeout: 10_000 });
    const wide = await win.evaluate(readEditor);

    expect(wide.panelWidth).toBeGreaterThan(narrow.panelWidth);
    expect(wide.widenLabel).toBe('Narrow');
    expect(wide.overflowX).toBe(0);
    expect(wide.numbers).toEqual(narrow.numbers);          // same lines
    expect(wide.heights[0]).toBeLessThan(narrow.heights[0]); // fewer wrapped rows

    // The wide panel is a composer, not a stretched form: settings sit in a
    // left column with the editor beside them, so no pixel is dead space.
    const columns = await win.evaluate(() => {
      const fields = document.querySelector('.wf-nm-fields').getBoundingClientRect();
      const editor = document.querySelector('.wf-nm-editor').getBoundingClientRect();
      return {
        fieldsRight: Math.round(fields.right),
        editorLeft: Math.round(editor.left),
        editorTop: Math.round(editor.top),
        fieldsTop: Math.round(fields.top),
        editorWidth: Math.round(editor.width),
      };
    });
    expect(columns.editorLeft).toBeGreaterThanOrEqual(columns.fieldsRight);  // side by side
    expect(Math.abs(columns.editorTop - columns.fieldsTop)).toBeLessThan(4); // same row
    expect(columns.editorWidth).toBeGreaterThan(400);

    // The choice is the writer's, so it survives closing the panel.
    await win.evaluate(() => hideNodePanel());
    await win.waitForTimeout(200);
    await win.evaluate(() => {
      const n = document.querySelector('#wf-canvas .drawflow-node');
      showNodePanel(n.id.replace(/^node-/, ''));
    });
    await win.waitForTimeout(300);
    const reopened = await win.evaluate(readEditor);
    expect(reopened.panelWidth).toBe(wide.panelWidth);
    expect(reopened.widenLabel).toBe('Narrow');
  } finally {
    await app.close();
  }
});

test('dragging the panel edge resizes it and the width is remembered', async () => {
  test.setTimeout(90_000);
  const { app, win } = await openStepPanel(makeHome());
  try {
    const before = await win.evaluate(() => Math.round(document.querySelector('#wf-node-panel .wf-drawer-panel').getBoundingClientRect().width));

    // hover() resolves the grip's own hit point; raw boundingBox coordinates
    // drift from the page's client coordinates in this window, so read the
    // point back from the event the hover actually delivered.
    await win.evaluate(() => {
      window.__pt = null;
      document.addEventListener('mousemove', (e) => { window.__pt = { x: e.clientX, y: e.clientY }; }, true);
    });
    await win.locator('#wf-drawer-grip').hover();
    const pt = await win.evaluate(() => window.__pt);
    expect(pt).toBeTruthy();

    await win.mouse.down();
    await win.mouse.move(pt.x - 200, pt.y, { steps: 10 });
    await win.mouse.up();
    await win.waitForTimeout(300);

    const after = await win.evaluate(() => ({
      width: Math.round(document.querySelector('#wf-node-panel .wf-drawer-panel').getBoundingClientRect().width),
      stored: parseInt(localStorage.getItem('husk.wfNodeDrawerWidth') || '0', 10),
      dragging: document.querySelector('#wf-node-panel .wf-drawer-panel').classList.contains('is-dragging'),
    }));

    expect(after.width).toBeGreaterThan(before + 150);
    expect(after.stored).toBe(after.width);
    expect(after.dragging).toBe(false);   // the drag always releases
  } finally {
    await app.close();
  }
});
