'use strict';

// Launches Husk on a synthetic home holding a heavy session history and
// reports the main process event loop stalls during the first seconds.
//
//   node scripts/measure-boot.js [--count 2500] [--seconds 15] [--home DIR]
//
// Runs twice on the same home: cold (no session cache) then warm.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { _electron: electron } = require('@playwright/test');
const { seedClaude, seedCopilot } = require('../test/helpers/session-fixture');

const ROOT = path.resolve(__dirname, '..');
const PROBE = path.join(__dirname, 'lib', 'boot-probe.js');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
}

function makeHome(count) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-boot-'));
  const cfgDir = path.join(home, '.config', 'husk');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(path.join(home, 'work', 'p0'), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, agentCwd: path.join(home, 'work', 'p0'), resumeLastOnLaunch: false,
  }));
  seedClaude(home, { count });
  seedCopilot(home);
  return home;
}

async function run(home, seconds, label) {
  const t0 = Date.now();
  const reportFile = path.join(home, 'boot-' + label + '.json');
  const app = await electron.launch({
    args: ['-r', PROBE, path.join(ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: ROOT,
    env: {
      ...process.env, HOME: home, USERPROFILE: home, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1',
      HUSK_BOOT_RESULT: reportFile, HUSK_BOOT_SECONDS: String(seconds),
      ...(process.env.HUSK_BOOT_PROFILE ? { HUSK_BOOT_PROFILE: `${process.env.HUSK_BOOT_PROFILE}.${label}` } : {}),
    },
    timeout: 60_000,
  });
  try {
    const win = await app.firstWindow({ timeout: 60_000 });
    await win.waitForLoadState('domcontentloaded');
    const windowMs = Date.now() - t0;
    const listed = await win.evaluate(async () => {
      const t = performance.now();
      const [r] = await Promise.all([window.husk.sessions.list({}), window.husk.agents.detect()]);
      const all = await window.husk.sessions.list({ agent: 'claude', selectedOnly: true, limit: 20000 });
      return { ms: Math.round(performance.now() - t), count: (r.sessions || []).length, claude: all.sessions.length, olderUnread: all.olderUnread };
    });
    const deadline = Date.now() + (seconds + 15) * 1000;
    while (!fs.existsSync(reportFile)) {
      if (Date.now() > deadline) throw new Error('main process did not finish the startup probe');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const { mark, blocks } = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    const top = blocks.slice().sort((a, b) => b.ms - a.ms).slice(0, 5);
    const report = {
      label, windowMs, sessionsListMs: listed.ms, sessions: listed.count, claudeAll: listed.claude, olderUnread: listed.olderUnread,
      maxAfterWindowMs: Math.max(0, ...blocks.filter((b) => b.at - b.ms > mark).map((b) => b.ms)),
      maxBlockMs: top.length ? top[0].ms : 0,
      blocksOver100: blocks.filter((b) => b.ms > 100).length,
      totalBlockedMs: blocks.reduce((n, b) => n + b.ms, 0),
      top,
    };
    console.log(JSON.stringify(report));
    return report;
  } finally {
    await app.close();
  }
}

async function main() {
  const count = Number(arg('count', 2500));
  const seconds = Number(arg('seconds', 15));
  const given = arg('home', '');
  const home = given || makeHome(count);
  const cold = await run(home, seconds, 'cold');
  const warm = await run(home, seconds, 'warm');
  if (!given) fs.rmSync(home, { recursive: true, force: true });
  return { cold, warm };
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { main, run, makeHome };
