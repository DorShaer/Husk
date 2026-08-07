const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path'); const os = require('os'); const fs = require('fs');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// The whole loop, against a real main process: author a workflow, export it to
// a file, read that file back as if it came from somebody else, preflight it,
// install it, refuse to run it before consent, consent, run it, and then check
// that the run left evidence a receipt can be built from.
//
// Every other test in this feature exercises one seam. This one exists because
// the seams all passed while the product did not work: a file that exports and
// re-imports and installs and runs still ships receipts of [] if nothing on the
// run path records what happened, and no unit test notices, because there is no
// unit that spans the gap.

const STUB = [
  '#!/usr/bin/env bash',
  `echo '{"type":"system","subtype":"init","model":"claude-test"}'`,
  `echo '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}'`,
  `echo '{"type":"result","subtype":"success","result":"done","usage":{"input_tokens":120,"output_tokens":45}}'`,
  '',
].join('\n');

const GRAPH = {
  nodes: [
    { id: 'n0', name: 'Reproduce', agentCommand: 'claude', prompt: 'reproduce the failure', x: 40, y: 60, branchMode: 'parallel', passContext: 'full' },
    { id: 'n1', name: 'Patch', agentCommand: 'claude', prompt: 'write the smallest patch', x: 300, y: 60, branchMode: 'parallel', passContext: 'full' },
  ],
  edges: [{ id: 'e0', from: 'n0', to: 'n1', condition: { type: 'always', value: '' } }],
};

function boot() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-art-'));
  const binDir = path.join(homeDir, 'bin');
  const cfgDir = path.join(homeDir, '.config', 'husk');
  const proj = path.join(homeDir, 'proj');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'package.json'), '{"name":"proj"}');
  // A real repository, not a directory with an empty .git in it. The receipt
  // records the workspace shape by asking git, so a fake .git tests a path no
  // user is ever on and hides the one they are.
  const git = (args) => require('child_process').execFileSync('git', args, { cwd: proj, stdio: 'ignore' });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['add', 'package.json']);
  git(['commit', '-qm', 'init']);
  fs.writeFileSync(path.join(binDir, 'claude'), STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    firstRunDone: true, theme: 'light', skipWelcome: true, agentCommand: 'claude',
  }));
  fs.writeFileSync(path.join(cfgDir, 'workflows.json'), JSON.stringify([
    { id: 'wf-src', name: 'Triage and patch', trigger: 'manual', graph: GRAPH },
  ]));
  return { homeDir, binDir, cfgDir, proj };
}

function launch(env) {
  return electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: env.homeDir, USERPROFILE: env.homeDir,
      ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1',
      PATH: `${env.binDir}:${process.env.PATH}`,
    },
    timeout: 30_000,
  });
}

test('a workflow exports, re-imports, installs, gates, runs, and leaves evidence', async () => {
  test.setTimeout(180000);
  const env = boot();
  const app = await launch(env);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => window.husk && window.husk.workflows, null, { timeout: 20000 });

  const target = path.join(env.homeDir, 'shared.husk.json');

  // 1. Export. targetPath skips the native dialog, which cannot be driven here.
  const exported = await win.evaluate((p) => window.husk.workflows.export({ workflowId: 'wf-src', targetPath: p }), target);
  expect(exported.ok, `export refused: ${JSON.stringify(exported)}`).toBe(true);
  expect(fs.existsSync(target)).toBe(true);

  // 2. Read it back the way an importer would.
  const read = await win.evaluate((p) => window.husk.workflows.artifactRead({ source: 'file', path: p }), target);
  expect(read.ok, `artifactRead refused: ${JSON.stringify(read)}`).toBe(true);
  expect(read.artifact.graph.nodes.length).toBe(2);

  // The fingerprint has to survive the round trip, or every receipt that names
  // it is orphaned the moment it lands on another machine.
  expect(read.artifact.graphHash).toBe(exported.artifact.graphHash);

  // 3. Preflight against this machine. The stub claude is on PATH.
  const pf = await win.evaluate(([a, cwd]) => window.husk.workflows.preflight({ artifact: a, cwd }), [read.artifact, env.proj]);
  expect(pf.ok, `preflight refused: ${JSON.stringify(pf)}`).toBe(true);
  expect(pf.blocking, `preflight blocked: ${JSON.stringify(pf.checks)}`).toBe(0);

  // 4. Install.
  const inst = await win.evaluate(([a, cwd]) => window.husk.workflows.install({ artifact: a, cwd }), [read.artifact, env.proj]);
  expect(inst.ok, `install refused: ${JSON.stringify(inst)}`).toBe(true);
  const newId = inst.workflow.id;
  expect(inst.sidecar.origin).toBe('imported');
  expect(inst.sidecar.consentedAt).toBe(null);

  // 5. The gate holds against the UI being skipped entirely.
  const blocked = await win.evaluate((id) => window.husk.workflows.run(id), newId);
  expect(blocked.ok).toBe(false);
  expect(blocked.code).toBe('consent-required');

  // 6. Consent, then run to completion.
  const consented = await win.evaluate((id) => window.husk.workflows.consent(id), newId);
  expect(consented.ok, `consent refused: ${JSON.stringify(consented)}`).toBe(true);

  const started = await win.evaluate((id) => window.husk.workflows.run(id), newId);
  expect(started.ok, `run refused: ${JSON.stringify(started)}`).toBe(true);

  await win.waitForFunction(async () => {
    const r = await window.husk.workflows.activeRun();
    return !r || !r.run || r.run.status !== 'running';
  }, null, { timeout: 120000 });

  // 7. The run must be recorded, and recorded against the fingerprint it ran on.
  // Without this a receipt can never be built, which is the entire product.
  const runs = await win.evaluate((id) => window.husk.workflows.runs(id), newId);
  const rows = Array.isArray(runs) ? runs : (runs && runs.runs) || [];
  expect(rows.length, `no run history recorded: ${JSON.stringify(runs)}`).toBeGreaterThan(0);

  const mine = rows.filter((r) => r && r.workflowId === newId);
  expect(mine.length, 'run history has no row for this workflow').toBeGreaterThan(0);
  expect(mine[0].graphHash, 'a recorded run carries no fingerprint, so no receipt can ever name it').toBe(read.artifact.graphHash);

  // 8. Publishing it back out must now carry a receipt rather than an empty list.
  await win.evaluate((id) => { window.__wfId = id; }, newId);
  const rp = await win.evaluate((p) => window.husk.workflows.export({ workflowId: window.__wfId, targetPath: p }),
    path.join(env.homeDir, 'republished.husk.json'));
  expect(rp.ok, `republish refused: ${JSON.stringify(rp)}`).toBe(true);
  expect(Array.isArray(rp.artifact.receipts)).toBe(true);
  expect(rp.artifact.receipts.length, 'a workflow with a completed run still publishes zero receipts').toBeGreaterThan(0);
  expect(rp.artifact.receipts[0].graphHash).toBe(read.artifact.graphHash);
  expect(rp.artifact.receipts[0].runs).toBeGreaterThan(0);

  await app.close();
});

// The loop above drives IPC directly, which proves the machinery and proves
// nothing about whether a person can reach it. This one only clicks.
test('a person can reach install, consent and the receipts strip by clicking', async () => {
  test.setTimeout(180000);
  const env = boot();
  const app = await launch(env);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => typeof setPage === 'function', null, { timeout: 20000 });

  await win.evaluate(() => setPage('workflows'));

  // The Install control is minted at runtime, so its absence is a wiring bug
  // rather than a missing line of markup, and only a real page visit finds it.
  await win.waitForSelector('#btn-wfx-install', { timeout: 10000 });
  await win.click('#btn-wfx-install');
  await win.waitForSelector('#wfx-install-modal:not([hidden])', { timeout: 10000 });

  // Escape has to close it like every other dialog in the app. Asserted on the
  // property rather than with waitForSelector, whose default state is
  // "visible": waiting for a hidden element to become visible cannot ever pass,
  // which reads as a broken dialog when the dialog is working.
  await win.keyboard.press('Escape');
  await win.waitForFunction(
    () => document.getElementById('wfx-install-modal').hidden === true,
    null,
    { timeout: 10000 },
  );

  // Every card carries the strip, including one that has never run and has no
  // artifact, because a block that appears only sometimes moves the grid.
  await win.waitForSelector('#wf-grid .wf-card', { timeout: 10000 });
  const strips = await win.evaluate(() => ({
    cards: document.querySelectorAll('#wf-grid .wf-card[data-id]').length,
    strips: document.querySelectorAll('#wf-grid .wf-card[data-id] .wfx-rcp').length,
  }));
  expect(strips.cards).toBeGreaterThan(0);
  expect(strips.strips, 'a workflow card renders no receipts strip, so the evidence never reaches the page').toBeGreaterThan(0);

  await app.close();
});
