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
const electron = require('electron');
const execFileAsync = require('node:util').promisify(require('node:child_process').execFile);
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
  await execFileAsync(electron, [PROBE, '--no-sandbox'], {
    cwd: ROOT,
    env: {
      ...process.env, HOME: home, USERPROFILE: home, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1',
      HUSK_BOOT_RESULT: reportFile, HUSK_BOOT_SECONDS: String(seconds),
      ...(process.env.HUSK_BOOT_PROFILE ? { HUSK_BOOT_PROFILE: `${process.env.HUSK_BOOT_PROFILE}.${label}` } : {}),
    },
    timeout: (seconds + 90) * 1000, killSignal: 'SIGKILL',
  });
  const { mark, blocks, listed, windowAt, startupMarks, slowRequires } = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const windowMs = windowAt - t0;
  const top = blocks.slice().sort((a, b) => b.ms - a.ms).slice(0, 5);
  const report = {
    label, windowMs, sessionsListMs: listed.ms, sessions: listed.count, claudeAll: listed.claude, olderUnread: listed.olderUnread,
    startupMarks,
    slowRequires: slowRequires.sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 15),
    maxAfterWindowMs: Math.max(0, ...blocks.filter((b) => b.at - b.ms > mark).map((b) => b.ms)),
    maxBlockMs: top.length ? top[0].ms : 0,
    blocksOver100: blocks.filter((b) => b.ms > 100).length,
    totalBlockedMs: blocks.reduce((n, b) => n + b.ms, 0),
    top,
  };
  console.log(JSON.stringify(report));
  return report;

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
