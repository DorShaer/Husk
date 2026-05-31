'use strict';

// Husk delivers its session directives (Husk identity + the speech-balloon
// recap line) through each CLI's own instruction channel:
//   codex -> AGENTS.md in the project (codex auto-reads it)
//   aider -> a Husk-owned file passed via --read
// codex/aider are not installed here, so this verifies the WIRING with fake
// executables: Husk writes the right file and passes the right flag. The
// actual loading by real codex/aider is confirmed by their documented
// mechanisms (AGENTS.md auto-read; --read read-only context).

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FAKE_CLI = path.join(__dirname, 'fixtures', 'fake-cli.js');

// Build an isolated env with a fake CLI named `cliName` on disk, a project dir,
// and a capture file. Returns the paths the test asserts against.
function makeEnv(cliName) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `husk-e2e-${cliName}-`));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(path.join(home, '.config', 'husk'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const exe = path.join(bin, cliName);
  fs.writeFileSync(exe, `#!/bin/sh\nexec node ${JSON.stringify(FAKE_CLI)} "$@"\n`);
  fs.chmodSync(exe, 0o755);
  const capture = path.join(root, 'capture.json');
  fs.writeFileSync(path.join(home, '.config', 'husk', 'config.json'), JSON.stringify({
    agentCommand: exe,
    agentCwd: project,
    paiEnabled: false,
    voice: { enabled: false },
    firstRunDone: true,
    skipWelcome: true,
  }));
  return { home, project, capture, exe };
}

async function spawnAgent(env) {
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: env.home,
      USERPROFILE: env.home,
      ELECTRON_DISABLE_SANDBOX: '1',
      HUSK_E2E: '1',
      CAPTURE: env.capture,
    },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => {
    try { return typeof cfg !== 'undefined' && cfg && cfg.agentCommand; } catch (_) { return false; } // eslint-disable-line no-undef
  }, null, { timeout: 15_000 });
  await win.evaluate(() => window.husk.pty.start({ cols: 100, rows: 30 }));
  await win.waitForTimeout(1500); // let the pty spawn and the fixture capture
  await app.close();
}

test('codex gets Husk directives via AGENTS.md in the project', async () => {
  const env = makeEnv('codex');
  await spawnAgent(env);

  const agentsMd = path.join(env.project, 'AGENTS.md');
  expect(fs.existsSync(agentsMd)).toBe(true);
  const text = fs.readFileSync(agentsMd, 'utf8');
  expect(text).toContain('HUSK-SESSION');         // managed block markers
  expect(text).toContain('Husk');                  // identity
  expect(text).toContain('\u{1F5E3}');             // speech-balloon recap line
});

test('aider gets Husk directives via a --read file', async () => {
  const env = makeEnv('aider');
  await spawnAgent(env);

  // The fake aider recorded its argv: Husk must have passed --read <file>.
  expect(fs.existsSync(env.capture)).toBe(true);
  const cap = JSON.parse(fs.readFileSync(env.capture, 'utf8'));
  expect(cap.argv).toContain('--read');
  expect(cap.argv).toContain('.husk-aider.md');

  const readFile = path.join(env.project, '.husk-aider.md');
  expect(fs.existsSync(readFile)).toBe(true);
  const text = fs.readFileSync(readFile, 'utf8');
  expect(text).toContain('Husk');
  expect(text).toContain('\u{1F5E3}');
});
