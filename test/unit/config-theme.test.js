'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// main.js is an Electron entrypoint and cannot be required directly, so lift the
// real DEFAULT_CONFIG and loadConfig out of the source and run them against a
// stubbed fs. This exercises the shipped code rather than a copy of it.
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main.js'), 'utf8');

function extract(re, label) {
  const m = SRC.match(re);
  assert.ok(m, `could not find ${label} in src/main.js`);
  return m[0];
}

const DEFAULT_CONFIG_SRC = extract(/const DEFAULT_CONFIG = \{[\s\S]*?\n\};/, 'DEFAULT_CONFIG');
const PRE_EXISTING_SRC = extract(/const PRE_EXISTING_THEME = '[^']*';/, 'PRE_EXISTING_THEME');
const LOAD_CONFIG_SRC = extract(/function loadConfig\(\) \{[\s\S]*?\n\}/, 'loadConfig');

// Build a loadConfig bound to a fake config file whose contents each case controls.
function loadConfigWith(storedJson) {
  const fakeFs = {
    existsSync: () => storedJson !== null,
    readFileSync: () => storedJson,
  };
  const ctx = {
    fs: fakeFs,
    CONFIG_PATH: '/fake/config.json',
    HOME: '/home/test',
    DEFAULT_PROFILES: [],
    JSON,
    Object,
  };
  vm.createContext(ctx);
  vm.runInContext(
    `${DEFAULT_CONFIG_SRC}\n${PRE_EXISTING_SRC}\n${LOAD_CONFIG_SRC}\nvar __result = loadConfig();`,
    ctx
  );
  return ctx.__result;
}

test('a first install defaults to the light theme', () => {
  // No config file on disk is the only signal that this machine has never run Husk.
  const cfg = loadConfigWith(null);
  assert.equal(cfg.theme, 'light');
});

test('an update never changes the theme of an install that has one saved', () => {
  for (const theme of ['midnight', 'dark', 'nord', 'dracula', 'light']) {
    const cfg = loadConfigWith(JSON.stringify({ firstRunDone: true, theme }));
    assert.equal(cfg.theme, theme, `${theme} must survive an update`);
  }
});

test('an existing config with no theme key keeps the theme it was already showing', () => {
  // A config written before `theme` was stored predates the light default. Such an
  // install has been showing midnight, so an update must leave it on midnight
  // rather than letting the new-install default reach it.
  const cfg = loadConfigWith(JSON.stringify({ firstRunDone: true, agentCommand: 'claude' }));
  assert.equal(cfg.theme, 'midnight');
});

test('an existing config keeps an explicitly chosen theme that matches no default', () => {
  const cfg = loadConfigWith(JSON.stringify({ firstRunDone: true, theme: 'gruvbox' }));
  assert.equal(cfg.theme, 'gruvbox');
});

test('a corrupt config falls back to the first-install defaults', () => {
  const cfg = loadConfigWith('{ not json');
  assert.equal(cfg.theme, 'light');
});
