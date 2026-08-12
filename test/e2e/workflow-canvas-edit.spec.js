'use strict';

// Editing the graph itself: removing connections, removing steps, and the
// legend that documents both. Before this, a connection could only be removed
// by deleting one of the steps it joined, because Drawflow's right-click
// popover is suppressed and its key handler is bound to a container that never
// receives keys. Each case the legend claims is pinned here.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-canvas-'));
  fs.mkdirSync(path.join(dir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.config', 'husk', 'config.json'),
    JSON.stringify({ firstRunDone: true, skipWelcome: true }),
  );
  return dir;
}

async function openBuilder(homeDir) {
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => typeof setPage === 'function', null, { timeout: 20_000 });
  await win.evaluate(() => setPage('workflows'));
  await win.waitForTimeout(500);
  await win.evaluate(() => openWorkflowBuilder(null));
  await win.waitForTimeout(800);
  return { app, win };
}

// Two steps joined by one connection, replacing whatever was on the canvas.
const seed = () => {
  wfEditor.clear();
  wfAddCanvasNode({ name: 'A' }, 60, 100);
  wfAddCanvasNode({ name: 'B' }, 420, 100);
  const ids = Object.keys(wfEditor.drawflow.drawflow.Home.data);
  wfEditor.addConnection(ids[0], ids[1], 'output_1', 'input_1');
};

const counts = () => ({
  nodes: document.querySelectorAll('#wf-canvas .drawflow-node').length,
  conns: document.querySelectorAll('#wf-canvas .connection').length,
});

const connPoint = () => {
  const p = document.querySelector('#wf-canvas .connection .main-path');
  if (!p) return null;
  const r = p.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
};

test('double-clicking a connection removes it', async () => {
  test.setTimeout(90_000);
  const { app, win } = await openBuilder(makeHome());
  try {
    await win.evaluate(seed);
    await win.waitForTimeout(300);
    expect(await win.evaluate(counts)).toEqual({ nodes: 2, conns: 1 });

    const pt = await win.evaluate(connPoint);
    await win.mouse.dblclick(pt.x, pt.y);
    await win.waitForTimeout(300);

    // The line goes, both steps stay.
    expect(await win.evaluate(counts)).toEqual({ nodes: 2, conns: 0 });
  } finally {
    await app.close();
  }
});

test('selecting a connection and pressing Delete removes it', async () => {
  test.setTimeout(90_000);
  const { app, win } = await openBuilder(makeHome());
  try {
    await win.evaluate(seed);
    await win.waitForTimeout(300);
    const pt = await win.evaluate(connPoint);
    await win.mouse.click(pt.x, pt.y);
    await win.waitForTimeout(250);
    expect(await win.evaluate(() => !!wfEditor.connection_selected)).toBe(true);

    // Opening the builder focuses the name field; touching the canvas has to
    // hand the keyboard back or Delete is swallowed by that input.
    expect(await win.evaluate(() => document.activeElement.tagName)).not.toBe('INPUT');

    await win.keyboard.press('Delete');
    await win.waitForTimeout(300);
    expect(await win.evaluate(counts)).toEqual({ nodes: 2, conns: 0 });
  } finally {
    await app.close();
  }
});

test('Backspace while writing a prompt never touches the graph', async () => {
  test.setTimeout(90_000);
  const { app, win } = await openBuilder(makeHome());
  try {
    await win.evaluate(seed);
    await win.waitForTimeout(300);
    await win.evaluate(() => {
      const n = document.querySelector('#wf-canvas .drawflow-node');
      showNodePanel(n.id.slice(5));
    });
    await win.waitForSelector('#wf-node-panel:not([hidden])');
    await win.click('#wf-np-prompt');
    await win.keyboard.type('abc');
    await win.keyboard.press('Backspace');
    await win.waitForTimeout(250);

    expect(await win.evaluate(() => document.getElementById('wf-np-prompt').value)).toBe('ab');
    expect(await win.evaluate(counts)).toEqual({ nodes: 2, conns: 1 });
  } finally {
    await app.close();
  }
});

test('removing a step takes its connections with it', async () => {
  test.setTimeout(90_000);
  const { app, win } = await openBuilder(makeHome());
  try {
    await win.evaluate(seed);
    await win.waitForTimeout(300);
    await win.evaluate(() => {
      const n = document.querySelector('#wf-canvas .drawflow-node');
      showNodePanel(n.id.slice(5));
    });
    await win.waitForSelector('#wf-node-panel:not([hidden])');
    await win.click('#wf-np-delete');
    await win.waitForTimeout(300);

    // One step left and no line pointing at nothing, which is what the legend
    // promises.
    expect(await win.evaluate(counts)).toEqual({ nodes: 1, conns: 0 });
  } finally {
    await app.close();
  }
});

test('a connection dropped on empty canvas leaves nothing behind', async () => {
  test.setTimeout(90_000);
  const { app, win } = await openBuilder(makeHome());
  try {
    await win.evaluate(seed);
    await win.waitForTimeout(300);
    const before = await win.evaluate(counts);

    await win.locator('#wf-canvas .drawflow-node .output').first().hover();
    const pt = await win.evaluate(() => {
      const o = document.querySelector('#wf-canvas .drawflow-node .output');
      const r = o.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    // Straight down into open canvas, and over the legend, which sits bottom
    // left and must not intercept the release.
    await win.mouse.down();
    await win.mouse.move(pt.x + 30, pt.y + 240, { steps: 10 });
    await win.mouse.up();
    await win.waitForTimeout(300);

    expect(await win.evaluate(counts)).toEqual(before);
    // Drawflow abandons the half-drawn <svg> in place; it has no endpoint
    // classes, draws as a line joined to nothing, and cannot be selected or
    // removed by any means, so none may survive the release.
    const dangling = await win.evaluate(() => [...document.querySelectorAll('#wf-canvas svg.connection')]
      .filter((s) => {
        const c = [...s.classList];
        return !c.some((x) => x.startsWith('node_in_node-')) || !c.some((x) => x.startsWith('node_out_node-'));
      }).length);
    expect(dangling).toBe(0);
  } finally {
    await app.close();
  }
});

test('the canvas legend covers every case and remembers being dismissed', async () => {
  test.setTimeout(90_000);
  const { app, win } = await openBuilder(makeHome());
  try {
    const open = await win.evaluate(() => {
      const el = document.getElementById('wf-legend');
      const canvas = document.getElementById('wf-canvas').getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return {
        collapsed: el.classList.contains('is-collapsed'),
        groups: [...document.querySelectorAll('.wf-legend-title')].map((t) => t.textContent),
        rows: document.querySelectorAll('.wf-legend-row').length,
        label: document.getElementById('wf-legend-toggle-label').textContent,
        text: el.textContent.replace(/\s+/g, ' '),
        insideCanvas: r.left >= canvas.left - 1 && r.bottom <= canvas.bottom + 1 && r.top >= canvas.top - 1,
      };
    });

    expect(open.collapsed).toBe(false);            // open the first time, for discovery
    expect(open.groups).toEqual(['Steps', 'Connections', 'Canvas']);
    expect(open.rows).toBe(11);
    expect(open.insideCanvas).toBe(true);
    expect(open.label).toBe('Hide guide');
    // Every documented case, including the two that did not exist before.
    expect(open.text).toContain('double-click it');
    expect(open.text).toContain('Del');
    expect(open.text).toContain('nothing is kept');
    expect(open.text).toContain('never left pointing at nothing');
    // Tidying is discoverable from the guide, beside the button that does it.
    expect(open.text).toContain('Tidy up');
    expect(open.text).toContain('Arrange');

    await win.click('#wf-legend-toggle');
    await win.waitForTimeout(250);
    expect(await win.evaluate(() => ({
      collapsed: document.getElementById('wf-legend').classList.contains('is-collapsed'),
      label: document.getElementById('wf-legend-toggle-label').textContent,
      stored: localStorage.getItem('husk.wfLegendCollapsed'),
    }))).toEqual({ collapsed: true, label: 'How this works', stored: '1' });

    // Reopening the builder keeps it out of the way.
    await win.evaluate(() => wfShowView('list'));
    await win.waitForTimeout(200);
    await win.evaluate(() => openWorkflowBuilder(null));
    await win.waitForTimeout(600);
    expect(await win.evaluate(() => document.getElementById('wf-legend').classList.contains('is-collapsed'))).toBe(true);
  } finally {
    await app.close();
  }
});

test('a dense workflow card renders a signature instead of a tiny graph', async () => {
  test.setTimeout(90_000);
  const { app, win } = await openBuilder(makeHome());
  try {
    const graph = {
      nodes: Array.from({ length: 18 }, (_x, i) => ({
        id: `n${i}`,
        name: `Step ${i + 1}`,
        prompt: `Do step ${i + 1}`,
        x: i * 120,
        y: i % 2 ? 120 : 40,
        passContext: 'full',
      })),
      edges: Array.from({ length: 17 }, (_x, i) => ({
        id: `e${i}`,
        from: `n${i}`,
        to: `n${i + 1}`,
        condition: { type: 'always', value: '' },
      })),
    };
    const card = await win.evaluate(async (g) => {
      await window.husk.workflows.create({ name: 'Large flow', trigger: 'manual', graph: g });
      await renderWorkflows();
      const c = document.querySelector('#wf-grid .wf-card');
      return {
        signature: !!c.querySelector('.wf-signature'),
        hero: (c.querySelector('.wf-signature-hero strong') || {}).textContent || '',
        miniNodes: c.querySelectorAll('.wf-mini-node').length,
        tags: [...c.querySelectorAll('.wf-card-tags .wf-tag')].map((t) => t.textContent.trim()),
      };
    }, graph);

    expect(card.signature).toBe(true);
    expect(card.hero).toBe('18');
    expect(card.miniNodes).toBe(0);
    expect(card.tags).not.toContain('18 steps');
  } finally {
    await app.close();
  }
});
