'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');

test('real backend spawns mixed team vendors and keeps queued and integration routes after settings change', async () => {
  test.setTimeout(120_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-routing-e2e-'));
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'project');
  const bin = path.join(home, '.local/bin');
  const releases = path.join(dir, 'releases');
  const log = path.join(dir, 'calls.jsonl');
  for (const d of [bin, project, releases, path.join(home, '.config/husk')]) fs.mkdirSync(d, { recursive: true });
  for (const args of [['init', '-q'], ['config', 'user.email', 'e2e@husk.test'], ['config', 'user.name', 'husk-e2e']]) execFileSync('git', args, { cwd: project });
  fs.writeFileSync(path.join(project, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', '.'], { cwd: project });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: project });
  const fixture = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), vendor = path.basename(process.argv[1]);
if (args.includes('--version') || args.includes('--help')) { console.log('fixture 1.0'); process.exit(0); }
const planner = args.some(a => a.includes('You are an orchestrator planning'));
if (!planner && !process.stdin.isTTY) process.exit(0);
fs.appendFileSync(process.env.HUSK_ROUTING_LOG, JSON.stringify({vendor,args,cwd:process.cwd(),pid:process.pid,planner,anthropicKey:process.env.ANTHROPIC_API_KEY,anthropicUrl:process.env.ANTHROPIC_BASE_URL})+'\\n');
if (planner) {
 console.log(JSON.stringify({agents:[{role:'simple',tier:'cheap',vendor:'claude',subgoal:'format simple.txt'},{role:'complex',tier:'smart',vendor:'codex',subgoal:'debug complex.txt'}]}));
 process.exit(0);
}
fs.writeFileSync(path.join(process.cwd(), vendor+'-'+process.pid+'.txt'), 'fixture change\\n');
process.stdin.resume();
setInterval(() => {
 if (fs.existsSync(path.join(process.env.HUSK_ROUTING_RELEASES, String(process.pid)))) process.exit(0);
 console.log('fixture heartbeat');
}, 100);
`;
  for (const vendor of ['claude', 'codex']) fs.writeFileSync(path.join(bin, vendor), fixture, { mode: 0o755 });
  const routing = { cheap: { vendor: 'codex', model: 'simple-pin' }, smart: { vendor: 'claude', model: 'complex-pin' }, planner: { vendor: 'claude', model: 'planner-pin' }, integrator: { vendor: 'codex', model: 'integrator-pin' } };
  fs.writeFileSync(path.join(home, '.config/husk/config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, lastSeenVersion: require('../../package.json').version,
    paiEnabled: false, voice: { enabled: false }, agentCommand: 'codex', chatAppearance: 'native',
    agentVendor: 'openai', agentBaseUrl: 'http://127.0.0.1:1/v1', agentApiKey: 'fixture-openai-key',
    projects: [{ id: 'p', name: 'fixture', path: project }], activeProjectId: 'p',
    taskRouting: routing, autopilotMaxConcurrent: 2,
  }));
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const release = (call) => fs.writeFileSync(path.join(releases, String(call.pid)), 'go');
  let app;
  try {
    app = await electron.launch({ args: [path.join(ROOT, 'src/main.js'), '--no-sandbox'], cwd: ROOT,
      env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}:${process.env.PATH}`, HUSK_E2E: '1', ELECTRON_DISABLE_SANDBOX: '1', HUSK_ROUTING_LOG: log, HUSK_ROUTING_RELEASES: releases }, timeout: 30_000 });
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => !!window.husk);
    const solo = await win.evaluate(() => window.husk.autopilot.start({ goal: 'format README.md', snapshot: false, caps: { minutes: 30, tokens: 0, dollars: 0 } }));
    expect(solo.ok, JSON.stringify(solo)).toBe(true);
    await expect.poll(() => calls().filter((c) => !c.planner).length).toBe(1);
    const soloCall = calls().find((c) => !c.planner);
    expect(soloCall.vendor).toBe('codex');
    expect(soloCall.args).toContain('simple-pin');
    const team = await win.evaluate(() => window.husk.autopilot.startCollab({ goal: 'format and debug the fixture', snapshot: true, caps: { minutes: 30, tokens: 0, dollars: 0 } }));
    expect(team.ok, JSON.stringify(team)).toBe(true);
    expect(team.started.filter((a) => a.queued)).toHaveLength(1);
    expect(team.agents.map((a) => a.vendor)).toEqual(['codex', 'claude']);
    const planner = calls().find((c) => c.planner);
    expect(planner.vendor).toBe('claude');
    expect(planner.args).toContain('planner-pin');
    await win.evaluate(async () => {
      const cfg = await window.husk.config.get();
      await window.husk.config.set({ ...cfg, agentCommand: 'claude', taskRouting: {
        cheap: { vendor: 'claude', model: 'changed' }, smart: { vendor: 'codex', model: 'changed' },
        planner: { vendor: 'codex', model: 'changed' }, integrator: { vendor: 'claude', model: 'changed' },
      } });
    });
    release(soloCall);
    await expect.poll(() => calls().filter((c) => !c.planner).length, { timeout: 30_000 }).toBe(3);
    const workers = calls().filter((c) => !c.planner && c.pid !== soloCall.pid);
    expect(workers.map((c) => c.vendor)).toEqual(['codex', 'claude']);
    expect(workers[0].args).toContain('simple-pin');
    expect(workers[1].args).toContain('complex-pin');
    workers.forEach(release);
    await expect.poll(() => calls().filter((c) => !c.planner).length, { timeout: 30_000 }).toBe(4);
    const integration = calls().filter((c) => !c.planner).at(-1);
    expect(integration.vendor).toBe('codex');
    expect(integration.args).toContain('integrator-pin');
    expect(integration.args).not.toContain('changed');
    // Each job's receipt records the vendor and model it ran on, and Artifacts shows them per job.
    const history = await win.evaluate(() => window.husk.autopilot.history({}));
    const teamRun = history.runs.find((r) => r.memberCount === 3);
    expect(teamRun, JSON.stringify(history.runs)).toBeTruthy();
    const jobs = await win.evaluate((runs) => window.husk.artifacts.build([], runs), history.runs)
      .then((rows) => rows.find((r) => r.jobs.length === 3).jobs);
    expect(jobs.map((j) => `${j.agent}:${j.model}`).sort()).toEqual(['claude:complex-pin', 'codex:integrator-pin', 'codex:simple-pin']);
    expect(history.runs.find((r) => r.memberCount === 1).model).toBe('simple-pin');
    expect(calls().every((c) => c.anthropicKey !== 'fixture-openai-key' && c.anthropicUrl !== 'http://127.0.0.1:1/v1')).toBe(true);
    release(integration);
  } finally {
    if (app) await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
