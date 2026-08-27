#!/usr/bin/env node
'use strict';

// Screenshot harness for the 2.12.0 What's new slides.
//
//   node test/tools/wn-2120-shots.js [outDir]
//
// Reuses the synthetic demo profile from docs-shots.js (throwaway HOME, demo
// projects, seeded sessions and workflows, a stand-in agent on PATH) and adds
// what the 2.12.0 pages read: session folders, schedules, and fixture rows for
// the GitHub and Artifacts pages, which would otherwise call out of the box.
// Nothing here comes from the maintainer's machine.
//
//   wn-2120-split       two chats side by side on the chat page
//   wn-2120-palette     the command palette reaching across the workspace
//   wn-2120-source      the source control page on a dirty repository
//   wn-2120-github      pull requests listed for the active project
//   wn-2120-schedule    workflows on a recurrence
//   wn-2120-artifacts   the ledger of what runs left behind

const path = require('path');
const fs = require('fs');
const os = require('os');

// The demo home sits at a fixed, readable path: the schedule and artifacts
// pages print a folder in full, and a random temp suffix reads as noise on a
// slide. Only the home is pinned; every other temp dir is minted as usual.
const DEMO_HOME = path.join(os.tmpdir(), 'demo');
const realMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = (prefix, ...rest) => {
  if (!String(prefix).endsWith('husk-docs-')) return realMkdtemp(prefix, ...rest);
  fs.rmSync(DEMO_HOME, { recursive: true, force: true });
  fs.mkdirSync(DEMO_HOME, { recursive: true });
  return DEMO_HOME;
};

const { makeHome, launch, sid, HOUR } = require('./docs-shots');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.resolve(process.argv[2] || path.join(REPO_ROOT, '.polish-workspace', 'wn-2120'));

function patchConfig(env) {
  const file = path.join(env.homeDir, '.config', 'husk', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const api = path.join(env.homeDir, 'code', 'orders-api');
  Object.assign(cfg, {
    statusCollapsed: true,
    theme: 'light',
    // The seeded transcripts are claude's; the roster reads the active tool's
    // history, so the demo opens on claude rather than the workflow shim.
    agentCommand: 'claude',
    sessionFolders: [{ id: 'sf-1', name: 'In review' }, { id: 'sf-2', name: 'Shipped' }],
    sessionFolderOf: { [sid(1)]: 'sf-1', [sid(2)]: 'sf-1', [sid(3)]: 'sf-2' },
    schedules: [
      { id: 'sc-1', name: 'Nightly release check', kind: 'daily', target: 'workflow', targetId: 'wf-demo-1', cwd: env.demo, at: '02:00', days: [], enabled: true, lastRunAt: new Date(Date.now() - 9 * HOUR).toISOString() },
      { id: 'sc-2', name: 'Docs refresh on Mondays', kind: 'weekly', target: 'workflow', targetId: 'wf-demo-3', cwd: env.demo, at: '09:00', days: [1], enabled: true, lastRunAt: '' },
      { id: 'sc-3', name: 'Bug triage sweep', kind: 'every', target: 'workflow', targetId: 'wf-demo-2', cwd: api, everyMinutes: 240, enabled: false, lastRunAt: new Date(Date.now() - 30 * HOUR).toISOString() },
    ],
  });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));

  // Trust the demo projects so the chat pane does not carry the trust banner.
  const claudeJsonPath = path.join(env.homeDir, '.claude.json');
  let j = {};
  try { j = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')) || {}; } catch (_) {}
  j.projects = j.projects || {};
  for (const dir of [env.demo, api, path.join(env.homeDir, 'code', 'marketing-site')]) {
    j.projects[dir] = { ...(j.projects[dir] || {}), hasTrustDialogAccepted: true };
  }
  fs.writeFileSync(claudeJsonPath, JSON.stringify(j, null, 2));
}

const pr = (over) => ({
  number: 1, title: '', state: 'OPEN', isDraft: false, author: 'mara',
  head: 'feat/x', base: 'main', createdAt: '2026-08-20T09:00:00Z', updatedAt: '2026-08-26T16:00:00Z',
  additions: 0, deletions: 0, changedFiles: 0, labels: [], reviewDecision: '', mergeable: 'MERGEABLE',
  url: 'https://github.com/acme/demo-app/pull/1',
  checks: { total: 0, passed: 0, failed: 0, pending: 0, state: 'none' },
  ...over,
});
const PRS = [
  pr({ number: 142, title: 'Add a page size to the orders list', author: 'mara', head: 'feat/orders-page-size', additions: 184, deletions: 22, changedFiles: 6, labels: [{ name: 'feature', color: '0e8a16' }], reviewDecision: 'APPROVED', checks: { total: 5, passed: 5, failed: 0, pending: 0, state: 'passing' }, url: 'https://github.com/acme/demo-app/pull/142' }),
  pr({ number: 141, title: 'Retry the checkout once on a timeout', author: 'jonas', head: 'fix/checkout-retry', additions: 41, deletions: 9, changedFiles: 3, labels: [{ name: 'bug', color: 'd73a4a' }], reviewDecision: 'CHANGES_REQUESTED', checks: { total: 5, passed: 3, failed: 1, pending: 1, state: 'failing' }, updatedAt: '2026-08-26T11:20:00Z', url: 'https://github.com/acme/demo-app/pull/141' }),
  pr({ number: 139, title: 'Move the rate limiter in front of auth', author: 'mara', head: 'chore/rate-limit-order', additions: 66, deletions: 58, changedFiles: 4, labels: [{ name: 'infra', color: '1d76db' }], checks: { total: 5, passed: 5, failed: 0, pending: 0, state: 'passing' }, updatedAt: '2026-08-25T08:05:00Z', url: 'https://github.com/acme/demo-app/pull/139' }),
  pr({ number: 137, title: 'Draft: split the orders service into a package', author: 'priya', head: 'wip/orders-package', isDraft: true, additions: 402, deletions: 311, changedFiles: 19, labels: [], updatedAt: '2026-08-24T18:40:00Z', url: 'https://github.com/acme/demo-app/pull/137' }),
  pr({ number: 133, title: 'Document the pagination defaults', author: 'jonas', head: 'docs/pagination', additions: 28, deletions: 4, changedFiles: 2, labels: [{ name: 'docs', color: '0075ca' }], reviewDecision: 'APPROVED', checks: { total: 2, passed: 2, failed: 0, pending: 0, state: 'passing' }, updatedAt: '2026-08-23T13:00:00Z', url: 'https://github.com/acme/demo-app/pull/133' }),
];

const WF_RUNS = [
  {
    id: 'run-3', workflowId: 'wf-demo-1', workflowName: 'Release check', status: 'done',
    startedAt: '2026-08-26T09:00:00Z', finishedAt: '2026-08-26T09:04:20Z', ms: 260000,
    environment: { agentResolved: 'claude' }, failedStep: '',
    steps: [
      { nodeId: 'n1', name: 'Run the tests', status: 'done', ms: 96000, usage: { input_tokens: 41200, output_tokens: 2100 }, entries: [{ kind: 'out', text: '14 passed' }], truncated: false },
      { nodeId: 'n2', name: 'Read the diff', status: 'done', ms: 84000, usage: { input_tokens: 38800, output_tokens: 1900 }, entries: [], truncated: false },
      { nodeId: 'n3', name: 'Draft the notes', status: 'done', ms: 80000, usage: { input_tokens: 22100, output_tokens: 3400 }, entries: [], truncated: false },
    ],
  },
  {
    id: 'run-2', workflowId: 'wf-demo-2', workflowName: 'Bug triage', status: 'failed',
    startedAt: '2026-08-25T14:00:00Z', finishedAt: '2026-08-25T14:03:10Z', ms: 190000,
    environment: { agentResolved: 'codex' }, failedStep: 'Find the cause',
    steps: [
      { nodeId: 'n1', name: 'Reproduce', status: 'done', ms: 70000, usage: { input_tokens: 18000, output_tokens: 900 }, entries: [], truncated: false },
      { nodeId: 'n2', name: 'Find the cause', status: 'failed', ms: 120000, timedOut: true, usage: null, entries: [], truncated: false },
    ],
  },
  {
    id: 'run-1', workflowId: 'wf-demo-3', workflowName: 'Docs refresh', status: 'done',
    startedAt: '2026-08-24T08:30:00Z', finishedAt: '2026-08-24T08:36:00Z', ms: 330000,
    environment: { agentResolved: 'claude' }, failedStep: '',
    steps: [
      { nodeId: 'n1', name: 'Collect claims', status: 'done', ms: 100000, usage: { input_tokens: 30000, output_tokens: 1200 }, entries: [], truncated: false },
      { nodeId: 'n2', name: 'Check the code', status: 'done', ms: 130000, usage: { input_tokens: 52000, output_tokens: 1600 }, entries: [], truncated: false },
      { nodeId: 'n3', name: 'Rewrite', status: 'done', ms: 100000, usage: { input_tokens: 21000, output_tokens: 4100 }, entries: [], truncated: false },
    ],
  },
];
const apRuns = (env) => [
  { sessionId: 'auto-b', capturedAt: '2026-08-26T11:00:00Z', endedAt: '2026-08-26T11:38:00Z', workspaceRoot: env.demo, goal: 'Add pagination to the orders endpoint', status: 'done', fileCount: 7, dollars: 1.84, tokens: 412000, agent: 'claude' },
  { sessionId: 'auto-a', capturedAt: '2026-08-23T15:10:00Z', endedAt: '2026-08-23T15:52:00Z', workspaceRoot: path.join(env.homeDir, 'code', 'orders-api'), goal: 'Move the rate limiter in front of the auth check', status: 'stopped', fileCount: 3, dollars: 0.92, tokens: 205000, agent: 'codex' },
];

const shots = [];
async function shoot(win, name) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, name);
  // The window is sized by its frame; the capture keeps to the viewport.
  const [width, height] = await win.evaluate(() => [window.innerWidth, window.innerHeight]);
  await win.screenshot({ path: file, animations: 'disabled', clip: { x: 0, y: 0, width, height } });
  shots.push(name);
  console.log(`  ${name}`);
}

async function main() {
  const env = makeHome();
  fs.mkdtempSync = realMkdtemp;
  patchConfig(env);
  const app = await launch(env);
  const errors = [];
  try {
    const win = await app.firstWindow({ timeout: 30_000 });
    win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    win.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1640, height: 1020 });
    });
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => typeof setPage === 'function', null, { timeout: 20_000 });
    await win.waitForTimeout(7000);

    const step = async (name, fn) => {
      try { await fn(); await shoot(win, name); } catch (err) { console.log(`  ${name} FAILED: ${err.message}`); }
    };

    // Split: the second pane is a fresh chat, so both halves show the shim.
    await step('wn-2120-split.png', async () => {
      await win.click('#btn-split');
      await win.waitForFunction(() => document.querySelectorAll('.term-pane.show').length === 2, null, { timeout: 10_000 });
      await win.waitForTimeout(6000);
    });
    await win.evaluate(() => { if (typeof unsplit === 'function' && SPLIT) unsplit(SPLIT.a); });

    await step('wn-2120-palette.png', async () => {
      await win.evaluate(() => openPalette());
      await win.locator('#palette-input').fill('review');
      await win.waitForTimeout(900);
    });
    await win.keyboard.press('Escape');

    await step('wn-2120-source.png', async () => {
      await win.evaluate(() => setPage('source'));
      // The page opens on the first change; give the diff time to read from git
      // and click the file so a pane is showing rather than the empty state.
      await win.waitForSelector('#sc-file-list .sc-file, .sc-file', { timeout: 20_000 }).catch(() => {});
      await win.waitForTimeout(1200);
      const file = await win.$('.sc-file');
      if (file) await file.click();
      await win.waitForTimeout(1800);
    });

    await step('wn-2120-github.png', async () => {
      await win.evaluate(() => setPage('github'));
      await win.waitForFunction(() => window.Gh && window.Gh.state.status !== 'loading', null, { timeout: 20_000 });
      await win.evaluate((rows) => {
        const g = window.Gh;
        Object.assign(g.state, {
          kind: 'pulls', listState: 'open', query: '', label: '',
          rows, status: 'ready', error: null, selected: rows[0].number,
          repo: { nameWithOwner: 'acme/demo-app', url: 'https://github.com/acme/demo-app', defaultBranch: 'main', isPrivate: false, description: 'A small order service.' },
        });
        g.paint();
      }, PRS);
      await win.waitForTimeout(800);
    });

    await step('wn-2120-schedule.png', async () => {
      await win.evaluate(() => setPage('schedule'));
      await win.waitForTimeout(1500);
    });

    await step('wn-2120-artifacts.png', async () => {
      await win.evaluate(() => setPage('artifacts'));
      await win.waitForFunction(() => window.Af && window.Af.state.status !== 'loading', null, { timeout: 20_000 });
      await win.evaluate(([wf, ap]) => {
        const s = window.Af.state;
        s.rows = window.husk.artifacts.build(wf, ap);
        s.status = 'ready';
        s.query = ''; s.source = ''; s.outcome = '';
        s.selected = s.rows.length ? s.rows[0].key : '';
        window.Af.paint();
      }, [WF_RUNS, apRuns(env)]);
      await win.waitForTimeout(800);
    });

    console.log(`\n${shots.length} images written to ${OUT_DIR}`);
    if (errors.length) console.log(`console errors:\n${errors.slice(0, 8).join('\n')}`);
  } finally {
    // A pane still holds a PTY at this point; the close is given a moment and
    // the process ends either way.
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 8000))]);
    process.exit(0);
  }
}

main();
