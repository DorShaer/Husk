const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Stands in for claude: speaks the same stream-json the run engine parses, so
// the test drives the real code path (tool events, text, result) with no network.
const FAKE_AGENT = [
  '#!/usr/bin/env bash',
  `echo '{"type":"system","subtype":"init","model":"fake-1"}'`,
  'sleep 0.8',
  `echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"src/main.js"}}]}}'`,
  'sleep 1.2',
  `echo '{"type":"assistant","message":{"content":[{"type":"text","text":"hello from the fake agent"}]}}'`,
  `echo '{"type":"result","subtype":"success","duration_ms":900,"result":"hello from the fake agent"}'`,
  '',
].join('\n');

function setup() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-wf-'));
  const binDir = path.join(homeDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(binDir, 'claude'), FAKE_AGENT, { mode: 0o755 });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'),
    JSON.stringify({ firstRunDone: true, theme: 'light', skipWelcome: true }));
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'workflows.json'), JSON.stringify([{
    id: 'wf-test',
    name: 'Test flow',
    trigger: 'manual',
    graph: {
      nodes: [
        { id: 'n1', name: 'Scan', prompt: 'scan the repo', x: 60, y: 80, passContext: 'full' },
        { id: 'n2', name: 'Fix', prompt: 'fix it', x: 380, y: 80, passContext: 'full' },
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2', condition: { type: 'always' } }],
    },
  }]));
  return { homeDir, binDir };
}

function launch({ homeDir, binDir }) {
  return electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      ELECTRON_DISABLE_SANDBOX: '1',
      HUSK_E2E: '1',
      PATH: `${binDir}:${process.env.PATH}`,
    },
    timeout: 30_000,
  });
}

async function openRun(win) {
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => typeof setPage === 'function', null, { timeout: 20000 });
  await win.evaluate(() => setPage('workflows'));
  await win.waitForSelector('#wf-grid .wf-run-btn', { timeout: 15000 });
  await win.click('#wf-grid .wf-run-btn');
}

test('the run plays out on the graph and each node has its own terminal', async () => {
  test.setTimeout(120000);
  const app = await launch(setup());
  try {
    const win = await app.firstWindow({ timeout: 30_000 });
    await openRun(win);

    await win.waitForSelector('#wf-run-canvas .wf-rn-node', { timeout: 15000 });
    expect(await win.locator('#wf-run-canvas .wf-rn-node').count()).toBe(2);

    await win.waitForFunction(() => document.querySelector('#wf-run-canvas .wf-rn-node.is-running'), null, { timeout: 20000 });

    await win.click('#wf-run-canvas .wf-rn-node.is-running');
    await win.waitForSelector('#wf-term:not([hidden])', { timeout: 10000 });
    await win.waitForFunction(() => {
      const t = document.querySelector('#wf-term-body .xterm-rows');
      return t && /Read/.test(t.innerText || '');
    }, null, { timeout: 30000 });
    const rows = await win.evaluate(() => document.querySelector('#wf-term-body .xterm-rows').innerText);

    // No line printed twice: the replayed buffer and the live stream must not overlap.
    const readyLines = (rows.match(/Agent ready/g) || []).length;
    expect(readyLines).toBe(1);
    expect(rows).toMatch(/Read/);   // the tool call is surfaced live

    // Closing the terminal must NOT stop the run.
    const pre = await win.evaluate(() => ({
      hidden: document.getElementById('wf-term').hidden,
      cur: wfRunCurrentNode, run: activeRunId,
    }));
    await win.click('#wf-term-close');
    await win.waitForTimeout(400);
    const post = await win.evaluate(() => ({
      hidden: document.getElementById('wf-term').hidden,
      run: activeRunId,
    }));
    expect(pre.run).toBeTruthy();      // the run really was in flight when we closed
    expect(post.hidden).toBe(true);    // the terminal actually closed
    expect(post.run).toBe(pre.run);    // ...and closing it did NOT stop the run

    await win.waitForFunction(() => document.querySelector('#wf-run-canvas .connection.is-taken'), null, { timeout: 40000 });

    await win.waitForFunction(() => {
      const b = document.getElementById('wf-run-status-badge');
      return b && /Completed/i.test(b.textContent || '');
    }, null, { timeout: 60000 });
    const states = await win.evaluate(() => Object.entries(wfNodeStatus));
    expect(states.filter(([, s]) => s === 'done').length).toBe(2);

    // A finished node still opens: the buffer outlives the run.
    await win.click('#wf-run-canvas .wf-rn-node');
    await win.waitForSelector('#wf-term:not([hidden])', { timeout: 8000 });
    // The buffer comes back from the main process, so wait for it to land rather
    // than reading the terminal the instant it opens.
    await win.waitForFunction(() => {
      const t = document.querySelector('#wf-term-body .xterm-rows');
      return t && /hello from the fake agent/.test(t.innerText || '');
    }, null, { timeout: 15000 });
  } finally {
    await app.close();
  }
});

test('a run in flight is picked back up after a reload', async () => {
  test.setTimeout(120000);
  const app = await launch(setup());
  try {
    const win = await app.firstWindow({ timeout: 30_000 });
    await openRun(win);
    await win.waitForFunction(() => document.querySelector('#wf-run-canvas .wf-rn-node.is-running'), null, { timeout: 20000 });
    const runId = await win.evaluate(() => activeRunId);

    // Reload mid-run: the agent keeps working in the main process.
    await win.evaluate(() => reloadRendererPreservingPlace());
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => typeof setPage === 'function', null, { timeout: 20000 });
    await win.evaluate(() => setPage('workflows'));

    // Workflows must drop us back into the live run, not show a list.
    await win.waitForFunction(() => !document.getElementById('wf-run-view').hidden, null, { timeout: 20000 });
    const adopted = await win.evaluate(() => activeRunId);
    expect(adopted).toBe(runId);

    await win.waitForFunction(() => {
      const b = document.getElementById('wf-run-status-badge');
      return b && /Completed/i.test(b.textContent || '');
    }, null, { timeout: 60000 });
  } finally {
    await app.close();
  }
});

test('a finished run is remembered, and the card reads it back', async () => {
  test.setTimeout(120000);
  const env = setup();
  const runsFile = path.join(env.homeDir, '.config', 'husk', 'workflow-runs.json');
  expect(fs.existsSync(runsFile)).toBe(false);   // nothing remembered yet

  const app = await launch(env);
  try {
    const win = await app.firstWindow({ timeout: 30_000 });
    await openRun(win);
    await win.waitForFunction(() => {
      const b = document.getElementById('wf-run-status-badge');
      return b && /Completed/i.test(b.textContent || '');
    }, null, { timeout: 90000 });

    // The run is on disk, with per-step outcomes.
    await new Promise((r) => setTimeout(r, 500));
    expect(fs.existsSync(runsFile)).toBe(true);
    const runs = JSON.parse(fs.readFileSync(runsFile, 'utf8'));
    expect(runs.length).toBe(1);
    expect(runs[0].workflowId).toBe('wf-test');
    expect(runs[0].status).toBe('done');
    expect(runs[0].steps.filter((s) => s.status === 'done').length).toBe(2);
    expect(runs[0].ms).toBeGreaterThan(0);

    // ...and the list reads it back: the card knows it passed.
    await win.evaluate(() => { activeRunId = null; });
    await win.evaluate(() => setPage('chat'));
    await win.evaluate(() => setPage('workflows'));
    await win.waitForSelector('#wf-grid .wf-card', { timeout: 15000 });
    const card = await win.evaluate(() => {
      const c = document.querySelector('#wf-grid .wf-card');
      return {
        pill: (c.querySelector('.wf-lr') || {}).textContent || '',
        dots: c.querySelectorAll('.wf-dot.is-done').length,
        miniNodes: c.querySelectorAll('.wf-mini-node').length,
        stats: (document.getElementById('wf-stats') || {}).textContent || '',
      };
    });
    expect(card.pill).toMatch(/Passed/);
    expect(card.dots).toBe(1);
    expect(card.miniNodes).toBe(2);        // the flow's shape, drawn on the card
    expect(card.stats).toMatch(/1 run this week/);
  } finally {
    await app.close();
  }
});

test('the last run can be reopened, and its terminals still read back', async () => {
  test.setTimeout(120000);
  const env = setup();
  const app = await launch(env);
  try {
    const win = await app.firstWindow({ timeout: 30_000 });
    await openRun(win);
    await win.waitForFunction(() => {
      const b = document.getElementById('wf-run-status-badge');
      return b && /Completed/i.test(b.textContent || '');
    }, null, { timeout: 90000 });
    await new Promise((r) => setTimeout(r, 600));

    // Back to the list, then open the last run from the card.
    await win.evaluate(() => { activeRunId = null; });
    await win.evaluate(() => setPage('chat'));
    await win.evaluate(() => setPage('workflows'));
    await win.waitForSelector('#wf-grid [data-open-run]', { timeout: 15000 });
    await win.click('#wf-grid [data-open-run]');

    // The graph comes back as it ended, and Run again is offered.
    await win.waitForSelector('#wf-run-canvas .wf-rn-node.is-done', { timeout: 15000 });
    const replay = await win.evaluate(() => ({
      done: document.querySelectorAll('#wf-run-canvas .wf-rn-node.is-done').length,
      again: !document.getElementById('btn-run-again').hidden,
      stop: !document.getElementById('btn-stop-wf').hidden,
      badge: document.getElementById('wf-run-status-badge').textContent,
      active: activeRunId,
    }));
    expect(replay.done).toBe(2);
    expect(replay.again).toBe(true);
    expect(replay.stop).toBe(false);      // a finished run cannot be stopped
    expect(replay.active).toBe(null);     // it is a replay, not a live run
    expect(replay.badge).toMatch(/Completed/);

    // Its terminal still reads back, from the stored scrollback.
    await win.click('#wf-run-canvas .wf-rn-node');
    await win.waitForSelector('#wf-term:not([hidden])', { timeout: 8000 });
    await win.waitForFunction(() => {
      const t = document.querySelector('#wf-term-body .xterm-rows');
      return t && /hello from the fake agent/.test(t.innerText || '');
    }, null, { timeout: 15000 });
  } finally {
    await app.close();
  }
});

test('running from the builder saves first, then runs', async () => {
  test.setTimeout(120000);
  const app = await launch(setup());
  try {
    const win = await app.firstWindow({ timeout: 30_000 });
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => typeof setPage === 'function', null, { timeout: 20000 });
    await win.evaluate(() => setPage('workflows'));
    await win.waitForSelector('#wf-grid .wf-card', { timeout: 15000 });
    await win.click('#wf-grid .wf-edit-btn');
    await win.waitForSelector('#wf-builder-view:not([hidden])', { timeout: 10000 });
    // The builder builds its canvas on a timeout, so wait for the graph to exist
    // rather than racing it.
    await win.waitForSelector('#wf-canvas .drawflow-node', { timeout: 10000 });
    await win.click('#btn-run-from-builder');
    // Straight into the run view, on the graph. A run that is already finished
    // is still a run that happened, so accept either state rather than racing it.
    await win.waitForSelector('#wf-run-view:not([hidden])', { timeout: 10000 });
    await win.waitForFunction(() => {
      const live = document.querySelector('#wf-run-canvas .wf-rn-node.is-running');
      const badge = document.getElementById('wf-run-status-badge');
      return live || (badge && /Completed|Failed/i.test(badge.textContent || ''));
    }, null, { timeout: 30000 });
    const state = await win.evaluate(() => ({
      nodes: document.querySelectorAll('#wf-run-canvas .wf-rn-node').length,
      builderClosed: document.getElementById('wf-builder-view').hidden,
    }));
    expect(state.nodes).toBe(2);        // the saved graph, running
    expect(state.builderClosed).toBe(true);
  } finally {
    await app.close();
  }
});

test('editing a flow keeps its step ids, so run history stays attached', async () => {
  test.setTimeout(120000);
  const env = setup();
  const wfFile = path.join(env.homeDir, '.config', 'husk', 'workflows.json');
  const before = JSON.parse(fs.readFileSync(wfFile, 'utf8'))[0].graph.nodes.map((n) => n.id);

  const app = await launch(env);
  try {
    const win = await app.firstWindow({ timeout: 30_000 });
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => typeof setPage === 'function', null, { timeout: 20000 });
    await win.evaluate(() => setPage('workflows'));
    await win.waitForSelector('#wf-grid .wf-card', { timeout: 15000 });

    // Open it in the builder and save it untouched.
    await win.click('#wf-grid .wf-edit-btn');
    await win.waitForSelector('#wf-canvas .drawflow-node', { timeout: 10000 });
    await win.click('#btn-save-workflow');
    await win.waitForSelector('#wf-list-view:not([hidden])', { timeout: 10000 });

    const after = JSON.parse(fs.readFileSync(wfFile, 'utf8'))[0].graph.nodes.map((n) => n.id);
    // Drawflow numbers its own nodes 1..n. If those leak into the saved graph the
    // ids change on every save and old runs point at the wrong steps.
    expect(after.sort()).toEqual(before.sort());
    expect(after.some((id) => /^\d+$/.test(id))).toBe(false);
  } finally {
    await app.close();
  }
});

test('a second run is refused while one is in flight', async () => {
  test.setTimeout(120000);
  const app = await launch(setup());
  try {
    const win = await app.firstWindow({ timeout: 30_000 });
    await openRun(win);
    await win.waitForFunction(() => document.querySelector('#wf-run-canvas .wf-rn-node.is-running'), null, { timeout: 20000 });
    const first = await win.evaluate(() => activeRunId);

    // Ask the main process directly: it must refuse, not start a second agent.
    const second = await win.evaluate(() => window.husk.workflows.run('wf-test'));
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already running/i);
    expect(await win.evaluate(() => activeRunId)).toBe(first);

    // ...and the flow it refused for is still the one running.
    expect(second.runId).toBe(first);
  } finally {
    await app.close();
  }
});

test('a running workflow cannot be deleted out from under itself', async () => {
  test.setTimeout(120000);
  const app = await launch(setup());
  try {
    const win = await app.firstWindow({ timeout: 30_000 });
    await openRun(win);
    await win.waitForFunction(() => document.querySelector('#wf-run-canvas .wf-rn-node.is-running'), null, { timeout: 20000 });
    const res = await win.evaluate(() => window.husk.workflows.delete('wf-test'));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/running/i);
    const still = await win.evaluate(() => window.husk.workflows.list());
    expect(still.length).toBe(1);
  } finally {
    await app.close();
  }
});
