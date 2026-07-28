const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path'); const os = require('os'); const fs = require('fs');
const REPO_ROOT = path.resolve(__dirname, '..', '..');
function boot(env) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-u-'));
  const cfgDir = path.join(homeDir, '.config', 'husk');
  fs.mkdirSync(cfgDir, { recursive: true }); fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ firstRunDone: true, theme: 'light', skipWelcome: true, agentCommand: 'claude' }));
  return electron.launch({ args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'], cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1', ...env }, timeout: 30_000 });
}
async function readCard(win) {
  // inject a fake in-flight run with representative cache-heavy token tiers
  await win.evaluate(() => {
    activeRuns.clear();
    activeRuns.set('r1', { runId: 'r1', startedAt: Date.now() - 300000, caps: { minutes: 0, tokens: 0, dollars: 0 },
      budget: { totalTokens: 1900000, inputTokens: 2900, outputTokens: 181000, cacheCreateTokens: 1700000, cacheReadTokens: 16000000, dollars: 20.12, tokensExact: true } });
    autopilotState.caps = { minutes: 0, tokens: 0, dollars: 0 };
    renderUsageStripLive();
  });
  await win.waitForTimeout(300);
  return win.evaluate(() => {
    const t = (id) => { const e = document.getElementById(id); return e ? e.textContent : '(null:'+id+')'; };
    const lbl = document.querySelector('[data-key="tokens"] .aut-huge-label');
    return {
      tokens: t('aut-page-val-tokens'),
      tokensLabel: lbl ? lbl.textContent : '(null:tokensLabel)',
      dollars: t('aut-page-val-dollars'),
      dollarsLabel: t('aut-page-lbl-dollars'),
      dollarsTitle: (document.getElementById('aut-page-val-dollars') || {title:''}).title.slice(0, 80),
    };
  });
}
test('plan user: dollar is API-equivalent, tokens = the quantity the cap measures', async () => {
  test.setTimeout(60000);
  const app = await boot({ ANTHROPIC_API_KEY: '' });  // no key -> plan
  try {
    const win = await app.firstWindow({ timeout: 30_000 });
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => typeof setPage === 'function', null, { timeout: 20000 });
    await win.evaluate(() => setPage('autopilot'));
    await win.waitForTimeout(600);
    const c = await readCard(win);
    console.log('  PLAN:', JSON.stringify(c));
    expect(c.tokensLabel).toBe('Tokens generated');
    // The headline is the quantity the cap ring measures: input + output +
    // cache writes. The 16M of cache reads is the prefix re-sent each request
    // and is reported under the split, not here.
    expect(c.tokens).toMatch(/1\.9M/);
    expect(c.dollarsLabel).toBe('API-equivalent');
    expect(c.dollarsTitle).toMatch(/plan|not per-token|flat monthly/i);
  } finally { await app.close(); }
});
test('api user: dollar is real estimated spend', async () => {
  test.setTimeout(60000);
  const app = await boot({ ANTHROPIC_API_KEY: 'sk-ant-test123' });  // key -> metered
  try {
    const win = await app.firstWindow({ timeout: 30_000 });
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => typeof setPage === 'function', null, { timeout: 20000 });
    await win.evaluate(() => setPage('autopilot'));
    await win.waitForTimeout(600);
    const c = await readCard(win);
    console.log('  API:', JSON.stringify(c));
    expect(c.dollarsLabel).toBe('Est. spend');
    expect(c.dollarsTitle).toMatch(/list prices|estimate|transcript/i);
  } finally { await app.close(); }
});
