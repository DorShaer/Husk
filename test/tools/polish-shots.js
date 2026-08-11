#!/usr/bin/env node
'use strict';

// Screenshot harness for the Agents command center polish work.
//
//   node test/tools/polish-shots.js <outDir> [--theme dark] [--scene all]
//
// Seeds a believable agent fleet in a throwaway HOME, launches the real app,
// opens the agent center and captures every canonical state as a PNG:
//
//   graph-live-sparse   one blocked agent under a project holder (the real-life case)
//   graph-all-fleet     the full 8-node spawn tree, All filter
//   graph-live-fleet    the live subset of the fleet
//   list-all-fleet      the list view of the same fleet
//   detail-crop-*       detail pane close-ups
//   canvas-crop         canvas close-up (sparse)
//   empty               no agents at all
//
// Scenes: sparse | fleet | empty | all (default all).

const path = require('path');
const os = require('os');
const fs = require('fs');
const { _electron: electron } = require('playwright');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const argv = process.argv.slice(2);
const OUT_DIR = path.resolve(argv[0] && !argv[0].startsWith('--') ? argv[0] : '.polish-workspace/latest');
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
};
const THEME = flag('theme', 'dark');
const SCENE = flag('scene', 'all');

const sanitize = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const sid = (n) => `c0ffee00-0000-4dc7-abb3-${String(n).padStart(12, '0')}`;
const CHAT_SID = sid(900);

// ── Fixture data ────────────────────────────────────────────────────────────

const chatRow = (cwd) => ({
  kind: 'interactive', pid: 4242, sessionId: CHAT_SID,
  name: 'Ship the release pipeline', cwd, status: 'busy',
  startedAt: Date.now() - 95 * 60_000,
});

// A believable evening of work: one live branch three deep, one finished branch.
function makeFleet(now, cwd) {
  const mk = (id, n, name, state, startedMin, parent, pid) => ({
    kind: 'background', id, sessionId: sid(n), name, cwd,
    state, status: state, startedAt: now - startedMin * 60_000,
    parent: parent ? sid(parent) : '', ...(pid ? { pid } : {}),
  });
  return [
    mk('root-a', 1, 'Harden the release workflow', 'working', 52, 900, 5001),
    mk('kid-a1', 2, 'Split publish into its own job', 'working', 34, 1, 5002),
    mk('kid-a11', 3, 'Pin every third-party action', 'blocked', 21, 2, 5003),
    mk('kid-a2', 4, 'Audit the lockfile', 'done', 40, 1),
    mk('root-b', 5, 'Rebuild the sessions page', 'done', 190, 900),
    mk('kid-b1', 6, 'Write the roster spec', 'done', 174, 5),
    mk('kid-b2', 7, 'Screenshot both themes', 'done', 168, 5),
  ];
}

// The real-life scene from the bug report: one agent waiting on a human under a
// project holder, a day of finished agents behind the Live filter.
function makeSparse(now, cwd) {
  const mk = (id, n, name, state, startedMin, parent) => ({
    kind: 'background', id, sessionId: sid(n), name, cwd,
    state, status: state, startedAt: now - startedMin * 60_000,
    parent: parent ? sid(parent) : '',
  });
  const rows = [mk('lone-a', 50, 'Redesign Husk Workflow Publish Flow', 'blocked', 21 * 60 + 54, 700)];
  for (let i = 0; i < 26; i++) {
    rows.push(mk(`old-${i}`, 100 + i, `Finished task ${i + 1}`, 'done', 26 * 60 + i * 9, 700));
  }
  return rows;
}

// Rich transcript so the detail feed looks the way a real one does.
function writeTranscript(homeDir, cwd, a, { rich = false } = {}) {
  const dir = path.join(homeDir, '.claude', 'projects', sanitize(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const t = (m) => new Date(Date.now() - m * 60_000).toISOString();
  const A = (min, content) => ({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content }, timestamp: t(min) });
  const text = (s) => ({ type: 'text', text: s });
  const tool = (name, input) => ({ type: 'tool_use', name, input });
  let lines;
  if (rich) {
    lines = [
      { type: 'user', message: { role: 'user', content: `${a.name}. Spawn subagents where useful and work autonomously.` }, timestamp: t(75), cwd, session_id: a.parent || a.sessionId },
      A(71, [text('Reading the publish workflow and the failing run first.')]),
      A(68, [tool('Bash', { command: 'cd /home/user/code/husk && node -e \'const fs=require("fs"); const p="test/unit"; console.log(fs.readdirSync(p))\'' })]),
      A(61, [text('Adding the e2e case, then verifying against your actual fleet.')]),
      A(55, [tool('Bash', { command: 'cd /home/user/code/husk && cat >> test/e2e/agent-canvas.spec.js' })]),
      A(48, [tool('Bash', { command: 'cd /home/user/code/husk && timeout 600 npx playwright test test/e2e/agent-canvas.spec.js' })]),
      A(40, [text('List rows need the list view; the center opens on the graph. Fixing the test\u2019s own setup.')]),
      A(33, [tool('Edit', { file_path: `${cwd}/src/renderer/app.js` })]),
      A(26, [tool('Bash', { command: 'cd /home/user/code/husk && timeout 600 node --test test/unit/ 2>&1 | grep -E "^[^ ]"' })]),
      A(18, [tool('Bash', { command: 'cd /home/user/code/husk && timeout 900 npx playwright test test/e2e/agent-canvas.spec.js' })]),
      A(9, [tool('Bash', { command: 'cp ~/.config/husk/config.json /home/user/.claude/jobs/' })]),
      A(2, [text('Because I made that up. The CLI never said \u201cfailed\u201d in a way that meant it \u2014 I invented a Failed band on a raw state value without checking what it represents. The data says plainly what that agent is: ebd17fde state=blocked.')]),
    ];
  } else {
    lines = [
      { type: 'user', message: { role: 'user', content: `${a.name}. Work autonomously.` }, timestamp: t(45), cwd, session_id: a.parent || a.sessionId },
      A(40, [text('Reading the workflow files first.')]),
      A(12, [tool('Edit', { file_path: `${cwd}/.github/workflows/release.yml` })]),
      A(2, [text('Dry run passes. I need permission to push.')]),
    ];
  }
  fs.writeFileSync(path.join(dir, `${a.sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function writeJob(homeDir, shortId, job) {
  const dir = path.join(homeDir, '.claude', 'jobs', shortId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ updatedAt: Date.now(), ...job }));
}

function makeHome({ scene }) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-polish-'));
  const cfgDir = path.join(homeDir, '.config', 'husk');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, agentCommand: 'claude',
    theme: THEME === 'dark' ? 'dark' : THEME,
  }));
  const cwd = path.join(homeDir, 'code', 'husk');
  fs.mkdirSync(cwd, { recursive: true });

  let rows = [];
  if (scene === 'fleet') {
    rows = makeFleet(Date.now(), cwd);
    for (const a of rows) writeTranscript(homeDir, cwd, a, { rich: a.id === 'kid-a11' });
    writeJob(homeDir, 'root-a', { state: 'working', detail: 'Editing .github/workflows/release.yml', intent: 'Harden the release workflow end to end so a bad tag can never publish.', tokens: 48231 });
    writeJob(homeDir, 'kid-a1', { state: 'working', detail: 'Rewriting the publish job', tokens: 22110 });
    writeJob(homeDir, 'kid-a11', { state: 'blocked', needs: 'Permission to push the branch', detail: 'Waiting for approval to push', tokens: 9040 });
  } else if (scene === 'sparse') {
    rows = makeSparse(Date.now(), cwd);
    writeTranscript(homeDir, cwd, rows[0], { rich: true });
    writeJob(homeDir, 'lone-a', { state: 'blocked', needs: 'Review the redesign before it ships', detail: 'spawn subagents and agents I want to see how it looks', intent: 'spawn subagents and agents I want to see how it looks', tokens: 51204 });
  }

  const agentsFile = path.join(homeDir, 'agents.json');
  // eslint-disable-next-line no-unused-vars
  const clean = rows.map(({ parent, ...r }) => ({ ...r }));
  // Lineage must be recovered from transcripts for the fleet scene; the sparse
  // scene's parent chat is gone on purpose so the project holder appears.
  if (scene === 'fleet') clean.push(chatRow(cwd));
  fs.writeFileSync(agentsFile, JSON.stringify(clean));
  return { homeDir, agentsFile, cwd };
}

// ── App driving ─────────────────────────────────────────────────────────────

function launch(env) {
  const fixtureBin = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-fake-bin-'));
  const shim = path.join(fixtureBin, 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(REPO_ROOT, 'test', 'e2e', 'fixtures', 'fake-claude-agents.js')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: env.homeDir,
      USERPROFILE: env.homeDir,
      PATH: `${fixtureBin}:${process.env.PATH}`,
      FAKE_AGENTS_FILE: env.agentsFile,
      ELECTRON_DISABLE_SANDBOX: '1',
      HUSK_E2E: '1',
    },
    timeout: 40_000,
  });
}

async function openCenter(app, { width = 1600, height = 1000 } = {}) {
  const win = await app.firstWindow({ timeout: 30_000 });
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, ...size });
  }, { width, height });
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => typeof openAgentMap === 'function', null, { timeout: 20_000 });
  await win.evaluate(() => openAgentMap());
  await win.waitForTimeout(400);
  return win;
}

async function shoot(win, name, { element } = {}) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Fractional display scaling breaks both Playwright clip rects and element
  // captures here: capture pixels sit at rect * devicePixelRatio. The crop is
  // taken from the full frame at that empirically verified mapping.
  if (element) {
    const m = await win.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const k = window.devicePixelRatio || 1;
      return { x: r.x * k, y: r.y * k, w: r.width * k, h: r.height * k };
    }, element);
    if (!m) return;
    const full = await win.screenshot({ animations: 'disabled' });
    const tmp = path.join(OUT_DIR, `.full-${name}.png`);
    fs.writeFileSync(tmp, full);
    const { execFileSync } = require('child_process');
    const geo = `${Math.round(m.w)}x${Math.round(m.h)}+${Math.round(m.x)}+${Math.round(m.y)}`;
    execFileSync('convert', [tmp, '-crop', geo, '+repage', path.join(OUT_DIR, `${name}.png`)]);
    fs.unlinkSync(tmp);
  } else {
    await win.screenshot({ path: path.join(OUT_DIR, `${name}.png`), animations: 'disabled' });
  }
  process.stdout.write(`  shot ${name}.png\n`);
}

async function settle(win, ms = 700) { await win.waitForTimeout(ms); }

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (SCENE === 'all' || SCENE === 'sparse') {
    process.stdout.write('scene: sparse\n');
    const env = makeHome({ scene: 'sparse' });
    const app = await launch(env);
    try {
      const win = await openCenter(app);
      await win.waitForSelector('.am-node', { timeout: 20_000 });
      await settle(win, 1200);
      await shoot(win, 'graph-live-sparse');
      // Canvas close-up: the pane without the detail column.
      await shoot(win, 'canvas-crop', { element: '#am-canvas-pane' });
      await shoot(win, 'detail-crop-sparse', { element: '#am-detail-pane' });
    } finally { await app.close().catch(() => {}); }
  }

  if (SCENE === 'all' || SCENE === 'fleet') {
    process.stdout.write('scene: fleet\n');
    const env = makeHome({ scene: 'fleet' });
    const app = await launch(env);
    try {
      const win = await openCenter(app);
      await win.waitForSelector('.am-node', { timeout: 20_000 });
      await settle(win, 1200);
      await shoot(win, 'graph-live-fleet');
      await win.click('[data-am-filter="all"]');
      await settle(win, 900);
      await shoot(win, 'graph-all-fleet');
      // Select the blocked agent so the detail pane shows the urgent case.
      await win.evaluate(() => amSelect('kid-a11', { scroll: true }));   // eslint-disable-line no-undef
      await settle(win, 900);
      await shoot(win, 'graph-all-fleet-selected');
      await shoot(win, 'detail-crop-fleet', { element: '#am-detail-pane' });
      await win.click('[data-am-view="list"]');
      await settle(win, 600);
      await shoot(win, 'list-all-fleet');
    } finally { await app.close().catch(() => {}); }
  }

  if (SCENE === 'all' || SCENE === 'empty') {
    process.stdout.write('scene: empty\n');
    const env = makeHome({ scene: 'empty' });
    const app = await launch(env);
    try {
      const win = await openCenter(app);
      await settle(win, 1200);
      await shoot(win, 'empty');
    } finally { await app.close().catch(() => {}); }
  }

  process.stdout.write(`done -> ${OUT_DIR}\n`);
}

run().catch((err) => { console.error(err); process.exit(1); });
