#!/usr/bin/env node
'use strict';

// One-off: seed a very large workflow and capture how the feature holds up.
//
//   node test/tools/wfx-big-shots.js [outDir]
//
// A 26-step release train: intake fans out to a five-way analysis, implement
// splits into three parallel tracks of two, an eight-way review wall, then a
// gate, staging, canary and ship, with a rollback branch. Shots: the editor
// canvas framed on the whole graph, the grid card's thumbnail, the export
// sheet's preview.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { _electron: electron } = require('playwright');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.resolve(process.argv[2] || '.polish-workspace/wfx-big');

const WorkflowGraph = require(path.join(REPO_ROOT, 'src', 'lib', 'workflow-graph.js'));

function makeBigWorkflow() {
  const nodes = [];
  const edges = [];
  let e = 0;
  const agentFor = (i) => ['claude', 'copilot', 'codex'][i % 3];
  const add = (id, name, agent, x, y, prompt) => {
    nodes.push({
      id, name, agentCommand: agent, prompt: prompt || `${name}. Work from the attached context and report plainly.`,
      model: null, branchMode: 'parallel', passContext: 'full', x, y,
    });
  };
  const link = (from, to) => { edges.push({ id: `e${e += 1}`, from, to, condition: { type: 'always', value: '' } }); };

  const COL = 260, ROW = 120;

  // Stage 0: intake.
  add('intake', 'Intake', 'claude', 0, ROW * 3.5);

  // Stage 1: five-way analysis fan.
  const analysis = ['Scope the change', 'Map the blast radius', 'Read the incident history', 'Price the migration', 'Draft the test plan'];
  analysis.forEach((name, i) => {
    const id = `an-${i}`;
    add(id, name, agentFor(i), COL, ROW * (1 + i));
    link('intake', id);
  });

  // Stage 2: synthesis joins the fan.
  add('synth', 'Synthesize the plan', 'claude', COL * 2, ROW * 3.5);
  analysis.forEach((_, i) => link(`an-${i}`, 'synth'));

  // Stage 3: three implementation tracks, two steps each.
  const tracks = ['API', 'Worker', 'Console'];
  tracks.forEach((t, i) => {
    const a = `im-${i}a`; const b = `im-${i}b`;
    add(a, `Implement: ${t}`, agentFor(i), COL * 3, ROW * (1.5 + i * 2));
    add(b, `Tests: ${t}`, agentFor(i + 1), COL * 4, ROW * (1.5 + i * 2));
    link('synth', a); link(a, b);
  });

  // Stage 4: the review wall — eight reviewers in parallel.
  const wall = ['Correctness', 'Security', 'Performance', 'Migrations', 'API shape', 'Docs', 'Accessibility', 'Licensing'];
  wall.forEach((name, i) => {
    const id = `rv-${i}`;
    add(id, `Review: ${name}`, agentFor(i), COL * 5, ROW * (i * 0.95));
    tracks.forEach((_, ti) => link(`im-${ti}b`, id));
  });

  // Stage 5: the gate reads every review.
  add('gate', 'Gate on the reviews', 'claude', COL * 6, ROW * 3.3,
    'Every review is attached. Quote each verdict literally. Answer SHIP or HOLD and nothing else.');
  wall.forEach((_, i) => link(`rv-${i}`, 'gate'));

  // Stage 6: staging, canary, ship — and the rollback branch off canary.
  add('staging', 'Deploy to staging', 'copilot', COL * 7, ROW * 2.3);
  add('canary', 'Canary: 5% for an hour', 'codex', COL * 8, ROW * 2.3);
  add('ship', 'Ship to everyone', 'claude', COL * 9, ROW * 1.6);
  add('rollback', 'Roll back and file the report', 'claude', COL * 9, ROW * 3.2);
  edges.push({ id: `e${e += 1}`, from: 'gate', to: 'staging', condition: { type: 'contains', value: 'SHIP' } });
  link('staging', 'canary');
  edges.push({ id: `e${e += 1}`, from: 'canary', to: 'ship', condition: { type: 'contains', value: 'healthy' } });
  edges.push({ id: `e${e += 1}`, from: 'canary', to: 'rollback', condition: { type: 'otherwise', value: '' } });

  const graph = WorkflowGraph.sanitizeGraph({ nodes, edges });
  if (graph.nodes.length !== nodes.length) throw new Error('sanitizer dropped nodes');
  if (graph.edges.length !== edges.length) throw new Error('sanitizer dropped edges');
  return {
    id: 'wf-1754000000001-big1',
    name: 'Release train',
    description: 'Intake fans out five ways, three implementation tracks, an eight-review wall, then a gate, staging, canary and ship with a rollback branch. 26 steps.',
    graph,
    trigger: 'manual',
    origin: 'local',
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-11T12:00:00.000Z',
  };
}

function makeHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-wfxbig-'));
  const cfgDir = path.join(homeDir, '.config', 'husk');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, agentCommand: 'claude',
    theme: 'light', lastSeenVersion: '2.11.0', statusCollapsed: true,
  }));
  const cwd = path.join(homeDir, 'code', 'acme-api');
  fs.mkdirSync(cwd, { recursive: true });
  const workflow = makeBigWorkflow();
  fs.writeFileSync(path.join(cfgDir, 'workflows.json'), JSON.stringify([workflow]));
  return { homeDir, cwd, workflowId: workflow.id };
}

function launch(env) {
  const fixtureBin = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-fake-bin-'));
  for (const name of ['claude', 'codex', 'copilot']) {
    const shim = path.join(fixtureBin, name);
    fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(REPO_ROOT, 'test', 'e2e', 'fixtures', 'fake-claude-agents.js')}" "$@"\n`);
    fs.chmodSync(shim, 0o755);
  }
  return electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: env.cwd,
    env: {
      ...process.env, HOME: env.homeDir, USERPROFILE: env.homeDir,
      PATH: `${fixtureBin}:${process.env.PATH}`,
      ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1',
    },
    timeout: 40_000,
  });
}

async function shoot(win, name) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const m = await win.evaluate(() => {
    const k = window.devicePixelRatio || 1;
    return { w: Math.round(window.innerWidth * k), h: Math.round(window.innerHeight * k) };
  });
  const out = path.join(OUT_DIR, `${name}.png`);
  const tmp = path.join(OUT_DIR, `.full-${name}.png`);
  await win.screenshot({ path: tmp, animations: 'disabled' });
  execFileSync('convert', [tmp, '-crop', `${m.w}x${m.h}+0+0`, '+repage', out]);
  fs.unlinkSync(tmp);
  process.stdout.write(`  shot ${name}.png\n`);
}

async function main() {
  const env = makeHome();
  const app = await launch(env);
  try {
    const win = await app.firstWindow({ timeout: 30_000 });
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => typeof setPage === 'function', null, { timeout: 20_000 });
    await win.waitForTimeout(1800);

    // The grid: the card thumbnail of a 28-step graph.
    await win.evaluate(() => setPage('workflows'));
    await win.waitForTimeout(900);
    await shoot(win, 'big-grid');

    // The editor canvas, framed on the whole train, guide out of the way.
    await win.evaluate((id) => openWorkflowBuilder(id), env.workflowId);
    await win.waitForTimeout(1200);
    await win.evaluate(() => {
      const el = document.getElementById('wf-legend');
      if (el && !el.classList.contains('collapsed')) document.getElementById('wf-legend-toggle').click();
    });
    await win.waitForTimeout(500);
    await shoot(win, 'big-editor');

    // The export sheet's preview of the same graph.
    await win.evaluate(() => wfShowView('grid'));
    await win.waitForTimeout(500);
    await win.evaluate((id) => {
      const w = workflowsCache.find((x) => x.id === id);
      window.WfxPublish.open(w, {});
    }, env.workflowId);
    await win.waitForTimeout(900);
    await shoot(win, 'big-export');
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(env.homeDir, { recursive: true, force: true });
  }
  process.stdout.write(`done: ${OUT_DIR}\n`);
}

main().catch((err) => { console.error(err); process.exit(1); });
