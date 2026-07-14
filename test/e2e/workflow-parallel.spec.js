const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path'); const os = require('os'); const fs = require('fs');
const REPO_ROOT = path.resolve(__dirname, '..', '..');
// Stub: logs "START <arg-hash> <epoch_ms>" and "END ..." so overlap = parallel.
// It sleeps 1.2s so two concurrent steps must overlap in wall-clock.
const STUB = [
  '#!/usr/bin/env bash',
  'ts() { date +%s%3N; }',
  'IS_STEP=0; for a in "$@"; do [ "$a" = "--append-system-prompt" ] && IS_STEP=1; done',
  '[ "$IS_STEP" = 1 ] && echo "START $(ts)" >> "$HUSK_LOG"',
  `echo '{"type":"system","subtype":"init","model":"x"}'`,
  '[ "$IS_STEP" = 1 ] && sleep 1.2',
  `echo '{"type":"assistant","message":{"content":[{"type":"text","text":"yes done"}]}}'`,
  '[ "$IS_STEP" = 1 ] && echo "END $(ts)" >> "$HUSK_LOG"',
  `echo '{"type":"result","subtype":"success","result":"yes done"}'`,
  '',
].join('\n');

function boot(graph) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-par-'));
  const binDir = path.join(homeDir, 'bin'); fs.mkdirSync(binDir, { recursive: true });
  const cfgDir = path.join(homeDir, '.config', 'husk');
  fs.mkdirSync(cfgDir, { recursive: true }); fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(binDir, 'claude'), STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ firstRunDone: true, theme: 'light', skipWelcome: true, agentCommand: 'claude' }));
  fs.writeFileSync(path.join(cfgDir, 'workflows.json'), JSON.stringify([{ id: 'wf-1', name: 'g', trigger: 'manual', graph }]));
  return { homeDir, binDir, cfgDir, log: path.join(homeDir, 'run.log') };
}
function launch(env) {
  return electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'], cwd: REPO_ROOT,
    env: { ...process.env, HOME: env.homeDir, USERPROFILE: env.homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1',
           HUSK_LOG: env.log, PATH: `${env.binDir}:${process.env.PATH}` }, timeout: 30_000 });
}
async function runToEnd(win, timeout = 90000) {
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => typeof setPage === 'function', null, { timeout: 20000 });
  await win.evaluate(() => setPage('workflows'));
  await win.waitForSelector('#wf-grid .wf-run-btn', { timeout: 15000 });
  await win.click('#wf-grid .wf-run-btn');
  await win.waitForFunction(() => { const b = document.getElementById('wf-run-status-badge'); return b && /(Completed|Failed)/i.test(b.textContent || ''); }, null, { timeout });
}

test('diamond: B and C run in parallel, D joins both', async () => {
  test.setTimeout(120000);
  const env = boot({
    nodes: [
      { id: 'A', name: 'A', prompt: 'p', x: 40, y: 150, agentCommand: 'claude' },
      { id: 'B', name: 'B', prompt: 'p', x: 300, y: 60, agentCommand: 'claude' },
      { id: 'C', name: 'C', prompt: 'p', x: 300, y: 260, agentCommand: 'claude' },
      { id: 'D', name: 'D', prompt: 'p', x: 560, y: 150, agentCommand: 'claude' }],
    edges: [{ id: 'e1', from: 'A', to: 'B' }, { id: 'e2', from: 'A', to: 'C' },
            { id: 'e3', from: 'B', to: 'D' }, { id: 'e4', from: 'C', to: 'D' }],
  });
  const app = await launch(env);
  try {
    const win = await app.firstWindow({ timeout: 30_000 });
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => typeof setPage === 'function', null, { timeout: 20000 });
    await win.evaluate(() => {
      window.__starts = {};
      window.husk.workflows.onNodeStart((d) => { window.__starts[d.nodeId] = (window.__starts[d.nodeId]||0)+1; });
    });
    await win.evaluate(() => setPage('workflows'));
    await win.waitForSelector('#wf-grid .wf-run-btn', { timeout: 15000 });
    await win.click('#wf-grid .wf-run-btn');
    await win.waitForFunction(() => { const b = document.getElementById('wf-run-status-badge'); return b && /(Completed|Failed)/i.test(b.textContent||''); }, null, { timeout: 90000 });
    const startCounts = await win.evaluate(() => window.__starts);
    console.log('  NODE:START counts:', JSON.stringify(startCounts));
    const states = await win.evaluate(() => Object.entries(wfNodeStatus));
    console.log('  STATES:', JSON.stringify(states));
    // Parse the log: 4 steps, and B/C overlap.
    const lines = fs.readFileSync(env.log, 'utf8').trim().split('\n');
    const events = [];
    let idx = 0; // START/END pairs in run order; map by order A,(B,C),D
    // We only have timestamps, not names. Detect overlap: any two START before their ENDs.
    const times = lines.map((l) => { const [k, t] = l.split(' '); return { k, t: +t }; });

    // find max concurrency
    const evs = [...times.filter(x=>x.k==='START').map(x=>({t:x.t,d:1})), ...times.filter(x=>x.k==='END').map(x=>({t:x.t,d:-1}))].sort((a,b)=>a.t-b.t||a.d-b.d);
    let cur=0,max=0; for (const e of evs){cur+=e.d;max=Math.max(max,cur);}
    console.log('  MAX CONCURRENCY:', max, '(expect >=2 for parallel B/C)');
    // Each node ran exactly once (no join double-fire), B and C overlapped, all done.
    expect(Object.keys(startCounts).sort()).toEqual(['A', 'B', 'C', 'D']);
    expect(Object.values(startCounts).every((c) => c === 1)).toBe(true);
    expect(max).toBeGreaterThanOrEqual(2);
    expect(states.filter(([, st]) => st === 'done').length).toBe(4);
  } finally { await app.close(); }
});

test('conditional: contains routes to one branch, otherwise is skipped', async () => {
  test.setTimeout(120000);
  const env = boot({
    nodes: [
      { id: 'A', name: 'A', prompt: 'p', x: 40, y: 150, agentCommand: 'claude' },
      { id: 'B', name: 'B-yes', prompt: 'p', x: 320, y: 60, agentCommand: 'claude' },
      { id: 'C', name: 'C-else', prompt: 'p', x: 320, y: 260, agentCommand: 'claude' }],
    edges: [{ id: 'e1', from: 'A', to: 'B', condition: { type: 'contains', value: 'yes' } },
            { id: 'e2', from: 'A', to: 'C', condition: { type: 'otherwise', value: '' } }],
  });
  const app = await launch(env);
  try {
    const win = await app.firstWindow({ timeout: 30_000 });
    win.on('pageerror', (e) => console.log('  PAGEERROR:', e.message.slice(0,140)));
    await runToEnd(win).catch((e) => console.log('  runToEnd failed:', e.message.slice(0,80)));
    const badge = await win.evaluate(() => (document.getElementById('wf-run-status-badge')||{}).textContent);
    console.log('  BADGE:', badge);
    const states = await win.evaluate(() => Object.fromEntries(Object.entries(wfNodeStatus)));
    console.log('  COND STATES:', JSON.stringify(states));
    const acts = await win.evaluate(async () => {
      const out = {};
      for (const id of ['A','B','C']) {
        const r = await window.husk.workflows.nodeLog(activeRunId || wfLastRunId, id);
        out[id] = (r && r.entries || []).filter(e => e.kind==='error').map(e => e.text).slice(0,2);
      }
      return out;
    });
    console.log('  COND ERRORS:', JSON.stringify(acts));
    // A outputs "yes done" -> B taken, C skipped
    expect(states.A).toBe('done');
    expect(states.B).toBe('done');
    expect(states.C).toBe('skipped');
  } finally { await app.close(); }
});
