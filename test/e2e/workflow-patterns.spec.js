'use strict';

// The pattern gallery ships real graphs, not pictures. These check that every
// pattern survives the main-process sanitizer with its topology intact, and
// that the one pattern whose routing is decided by matching literal text
// actually takes the branch that text names.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Stub agent: every step reports a red suite, so the guarded-release flow must
// take its failure branch and skip the release-notes branch.
const STUB = [
  '#!/usr/bin/env bash',
  `echo '{"type":"system","subtype":"init","model":"x"}'`,
  `echo '{"type":"assistant","message":{"content":[{"type":"text","text":"done SUITE_RED"}]}}'`,
  `echo '{"type":"result","subtype":"success","result":"done SUITE_RED"}'`,
  '',
].join('\n');

function boot() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-wfpat-'));
  const binDir = path.join(homeDir, 'bin');
  const cfgDir = path.join(homeDir, '.config', 'husk');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(binDir, 'claude'), STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, agentCommand: 'claude',
  }));
  return { homeDir, binDir };
}

function launch(env) {
  return electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: env.homeDir,
      USERPROFILE: env.homeDir,
      ELECTRON_DISABLE_SANDBOX: '1',
      HUSK_E2E: '1',
      PATH: `${env.binDir}:${process.env.PATH}`,
    },
    timeout: 30_000,
  });
}

async function ready(app) {
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => typeof setPage === 'function' && typeof WF_PATTERNS !== 'undefined', null, { timeout: 20_000 });
  return win;
}

test('every shipped pattern round-trips through the sanitizer intact', async () => {
  test.setTimeout(90_000);
  const env = boot();
  const app = await launch(env);
  try {
    const win = await ready(app);
    const report = await win.evaluate(async () => {
      const out = [];
      for (const p of WF_PATTERNS) {                       // eslint-disable-line no-undef
        const spec = p.build();
        const saved = await window.husk.workflows.create({ ...spec, trigger: 'manual' });
        const wanted = spec.graph;
        const got = saved.graph;
        out.push({
          id: p.id,
          nodes: [wanted.nodes.length, got.nodes.length],
          edges: [wanted.edges.length, got.edges.length],
          emptyPrompts: got.nodes.filter((n) => !n.prompt.trim()).length,
          aiNodes: got.nodes.filter((n) => n.branchMode === 'ai').length,
          conditions: got.edges.map((e) => e.condition.type).sort(),
          orphanEdges: got.edges.filter((e) => !got.nodes.some((n) => n.id === e.from) || !got.nodes.some((n) => n.id === e.to)).length,
        });
      }
      return out;
    });

    for (const r of report) {
      expect(r.nodes[1], `${r.id} lost nodes`).toBe(r.nodes[0]);
      expect(r.edges[1], `${r.id} lost edges`).toBe(r.edges[0]);
      expect(r.orphanEdges, `${r.id} has dangling edges`).toBe(0);
      expect(r.emptyPrompts, `${r.id} has an unprompted step`).toBe(0);
    }
    // The two patterns whose whole point is a branch keep the branch machinery.
    const router = report.find((r) => r.id === 'router');
    expect(router.aiNodes).toBe(1);
    const evaluator = report.find((r) => r.id === 'evaluator');
    expect(evaluator.aiNodes).toBe(1);
    const guarded = report.find((r) => r.id === 'guarded');
    expect(guarded.conditions).toEqual(['always', 'always', 'contains', 'otherwise']);
  } finally {
    await app.close();
  }
});

test('guarded release routes on the literal test output', async () => {
  test.setTimeout(120_000);
  const env = boot();
  const app = await launch(env);
  try {
    const win = await ready(app);
    const names = await win.evaluate(async () => {
      const p = WF_PATTERNS.find((x) => x.id === 'guarded');   // eslint-disable-line no-undef
      const saved = await window.husk.workflows.create({ ...p.build(), trigger: 'manual' });
      const byId = {};
      saved.graph.nodes.forEach((n) => { byId[n.id] = n.name; });
      window.__names = byId;
      return byId;
    });
    expect(Object.values(names).sort()).toEqual(['Fix failures', 'Release notes', 'Report', 'Run tests']);

    await win.evaluate(() => setPage('workflows'));
    await win.waitForSelector('#wf-grid .wf-run-btn', { timeout: 15_000 });
    await win.click('#wf-grid .wf-run-btn');
    await win.waitForFunction(
      () => { const b = document.getElementById('wf-run-status-badge'); return b && /(Completed|Failed)/i.test(b.textContent || ''); },
      null, { timeout: 90_000 },
    );

    const states = await win.evaluate(() => Object.fromEntries(
      Object.entries(wfNodeStatus).map(([id, st]) => [window.__names[id] || id, st]),   // eslint-disable-line no-undef
    ));
    // The stub always says SUITE_RED, so the fix branch runs and the
    // release-notes branch is never reached.
    expect(states['Run tests']).toBe('done');
    expect(states['Fix failures']).toBe('done');
    expect(states['Release notes']).toBe('skipped');
    expect(states.Report).toBe('done');
  } finally {
    await app.close();
  }
});
