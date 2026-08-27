'use strict';

// The Artifacts page, in the real window.
//
// The merge itself is unit tested in artifact-ledger.test.js. What has to be
// checked here is that a page reading two stores shows both, that a figure
// nobody measured never renders as a number, and that the step scrollback is
// reachable.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function launch() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-'));
  const cfgDir = path.join(homeDir, '.config', 'husk');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ firstRunDone: true, skipWelcome: true }, null, 2));
  return electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
}

async function ready(app) {
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  return win;
}

// Shapes as the two stores actually write them.
const WF = [
  {
    id: 'run-2', workflowId: 'w1', workflowName: 'Guarded release', status: 'done',
    startedAt: '2026-08-23T09:00:00Z', finishedAt: '2026-08-23T09:04:20Z', ms: 260000,
    environment: { agentResolved: 'claude' }, failedStep: '',
    steps: [
      { nodeId: 'n0', name: 'Plan', status: 'done', ms: 42000, usage: { input_tokens: 100, output_tokens: 20 }, entries: [{ kind: 'out', text: 'PLANNED THE WORK' }], truncated: false },
      { nodeId: 'n1', name: 'Verify', status: 'done', ms: 60000, usage: null, entries: [], truncated: false },
    ],
  },
  {
    id: 'run-1', workflowId: 'w2', workflowName: 'Docs sweep', status: 'failed',
    startedAt: '2026-08-22T14:00:00Z', finishedAt: '2026-08-22T14:01:10Z', ms: 70000,
    environment: { agentResolved: 'copilot' }, failedStep: 'Check links',
    steps: [{ nodeId: 'n0', name: 'Check links', status: 'failed', ms: 40000, timedOut: true, usage: null, entries: [], truncated: false }],
  },
];
const AP = [{
  sessionId: 'auto-a', capturedAt: '2026-08-24T11:00:00Z', endedAt: '2026-08-24T11:38:00Z',
  workspaceRoot: '/home/user/code/husk', goal: 'Add a registry reader', status: 'done',
  fileCount: 7, dollars: 1.84, tokens: 412000, agent: 'claude',
}];

async function show(win, wf = WF, ap = AP) {
  await win.locator('.rail-item[data-page="artifacts"]').click();
  await expect(win.locator('.page-artifacts')).toBeVisible();
  await expect.poll(() => win.evaluate(() => window.Af.state.status), { timeout: 20_000 }).not.toBe('loading');
  await win.evaluate(([w, a]) => {
    const s = window.Af.state;
    s.rows = window.husk.artifacts.build(w, a);
    s.status = 'ready';
    s.query = ''; s.source = ''; s.outcome = '';
    s.selected = s.rows.length ? s.rows[0].key : '';
    window.Af.paint();
  }, [wf, ap]);
}

const rows = (win) => win.evaluate(() => [...document.querySelectorAll('#af-list .af-row')].map((r) => ({
  key: r.dataset.key,
  title: r.querySelector('.af-row-title').textContent,
  meta: r.querySelector('.af-row-meta').textContent,
  current: r.classList.contains('is-current'),
})));

test('both stores land in one list, newest first', async () => {
  const app = await launch();
  const win = await ready(app);
  await show(win);
  const list = await rows(win);
  expect(list.map((r) => r.key)).toEqual(['autopilot:auto-a', 'workflow:run-2', 'workflow:run-1']);
  expect(list[0].meta).toContain('autopilot');
  expect(list[1].meta).toContain('workflow');
  await app.close();
});

test('a run that reported no usage shows no token figure at all', async () => {
  const app = await launch();
  const win = await ready(app);
  await show(win);
  const list = await rows(win);
  // The failed run reported nothing, so its row carries no "tok" fact.
  const failed = list.find((r) => r.title === 'Docs sweep');
  expect(failed.meta).not.toContain('tok');
  // The one that did carries it.
  expect(list.find((r) => r.title === 'Guarded release').meta).toContain('tok');
  await app.close();
});

test('the detail says in words which half of the cost was never recorded', async () => {
  const app = await launch();
  const win = await ready(app);
  await show(win);

  await win.locator('#af-list .af-row[data-key="workflow:run-1"]').click();
  let text = await win.evaluate(() => document.getElementById('af-detail').textContent);
  expect(text).toContain('not recorded');
  expect(text).toContain('reported neither');

  await win.locator('#af-list .af-row[data-key="workflow:run-2"]').click();
  text = await win.evaluate(() => document.getElementById('af-detail').textContent);
  expect(text).toContain('120 tokens');
  expect(text).toContain('no cost figure was recorded');
  await app.close();
});

test('totals say how many runs each one was measured over', async () => {
  const app = await launch();
  const win = await ready(app);
  await show(win);
  const figures = await win.evaluate(() => [...document.querySelectorAll('#af-figures .af-figure')].map((f) => ({
    value: f.querySelector('.af-figure-value').textContent,
    label: f.querySelector('.af-figure-label').textContent,
    note: f.querySelector('.af-figure-note') ? f.querySelector('.af-figure-note').textContent : '',
  })));
  const byLabel = Object.fromEntries(figures.map((f) => [f.label, f]));
  expect(byLabel.runs.value).toBe('3');
  expect(byLabel.done.value).toBe('2');
  expect(byLabel.done.note).toContain('1 failed');
  // Only two of the three runs reported tokens, and the strip says so.
  expect(byLabel.tokens.note).toContain('over 2 of 3');
  expect(byLabel.cost.note).toContain('over 1 of 3');
  await app.close();
});

test('a step opens onto the scrollback that survived', async () => {
  const app = await launch();
  const win = await ready(app);
  await show(win);
  await win.locator('#af-list .af-row[data-key="workflow:run-2"]').click();
  await win.evaluate(() => document.querySelectorAll('#af-detail .af-step').forEach((d) => { d.open = true; }));

  const logs = await win.evaluate(() => [...document.querySelectorAll('#af-detail .af-log')].map((p) => p.textContent));
  expect(logs.join('')).toContain('PLANNED THE WORK');
  // The step with no surviving scrollback says so rather than opening onto nothing.
  const text = await win.evaluate(() => document.getElementById('af-detail').textContent);
  expect(text).toContain('no scrollback survived for this step');
  await app.close();
});

test('a step that hit its timeout is marked as such', async () => {
  const app = await launch();
  const win = await ready(app);
  await show(win);
  await win.locator('#af-list .af-row[data-key="workflow:run-1"]').click();
  const text = await win.evaluate(() => document.getElementById('af-detail').textContent);
  expect(text).toContain('timed out');
  expect(text).toContain('Check links');
  await app.close();
});

test('the source control narrows to one kind of run', async () => {
  const app = await launch();
  const win = await ready(app);
  await show(win);
  await win.locator('#af-src-workflow').click();
  expect((await rows(win)).length).toBe(2);
  await win.locator('#af-src-autopilot').click();
  expect((await rows(win)).length).toBe(1);
  await win.locator('#af-src-all').click();
  expect((await rows(win)).length).toBe(3);
  await app.close();
});

test('the outcome control and the search box compose', async () => {
  const app = await launch();
  const win = await ready(app);
  await show(win);
  await win.locator('#af-outcome').selectOption('failed');
  expect((await rows(win)).map((r) => r.title)).toEqual(['Docs sweep']);
  await win.locator('#af-search').fill('guarded');
  expect((await rows(win)).length).toBe(0);
  await win.locator('#af-outcome').selectOption('');
  expect((await rows(win)).map((r) => r.title)).toEqual(['Guarded release']);
  await app.close();
});

test('a selection that filtering removed moves onto a row still on screen', async () => {
  const app = await launch();
  const win = await ready(app);
  await show(win);
  expect(await win.evaluate(() => window.Af.state.selected)).toBe('autopilot:auto-a');
  await win.locator('#af-src-workflow').click();
  expect(await win.evaluate(() => window.Af.state.selected)).toBe('workflow:run-2');
  await app.close();
});

test('nothing on disk reads as nothing has run, not as an error', async () => {
  const app = await launch();
  const win = await ready(app);
  await show(win, [], []);
  await expect(win.locator('#af-panes')).toBeHidden();
  const text = await win.evaluate(() => document.getElementById('af-state').textContent);
  expect(text).toContain('Nothing has run yet');
  await app.close();
});
