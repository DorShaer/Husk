'use strict';

// Recap voice regression: the speech-balloon line streams in token by token
// (an agent emits "Ready", then "Ready to help with...", growing the same
// line). The voice must read the WHOLE line exactly ONCE, not the first word
// that happens to be in the buffer when a chunk arrives.
//
// This drives the real renderer detectAndSpeak with a chunked recap and a
// stubbed speak() that records what would be read aloud.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Boot with voice enabled so detectAndSpeak does not early-return on the gate.
function makeIsolatedHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-recap-'));
  const cfgDir = path.join(dir, '.config', 'husk');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(cfgDir, 'config.json'),
    JSON.stringify({ voice: { enabled: true, name: 'en_US-amy-medium', rate: 1.0 }, recap: true }),
  );
  return dir;
}

test('streaming recap is spoken once, in full (not the first word)', async () => {
  const homeDir = makeIsolatedHome();
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      ELECTRON_DISABLE_SANDBOX: '1',
      HUSK_E2E: '1',
    },
    timeout: 30_000,
  });

  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  // boot() loads cfg then stamps body.dataset.rail; wait for it so the voice
  // gate (cfg.voice.enabled) is populated before we drive detectAndSpeak.
  await win.waitForFunction(() => document.body && document.body.dataset.rail);

  const calls = await win.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const recorded = [];
    // Stub speak so nothing hits the TTS backend; record the text instead.
    // eslint-disable-next-line no-undef
    window.speak = (t) => { recorded.push(t); };
    // eslint-disable-next-line no-undef
    resetSpeechState();

    // The agent streams the speech-balloon line in growing fragments.
    const chunks = [
      '\n\u{1F5E3}\u{FE0F} Husk:',
      ' Ready',
      ' to help with security',
      ' questions or scan investigations\n',
    ];
    for (const c of chunks) {
      // eslint-disable-next-line no-undef
      detectAndSpeak(c);
      await sleep(120);
    }
    // Wait past the settle window so the held line flushes.
    await sleep(700);
    return recorded;
  });

  await app.close();

  expect(calls).toEqual(['Ready to help with security questions or scan investigations']);
});
