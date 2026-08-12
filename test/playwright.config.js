'use strict';

const { defineConfig } = require('@playwright/test');

// Each spec gives its app a throwaway HOME so one test cannot read what another
// stored. Electron reads the XDG base directories first where they are set, so
// on a machine that sets them every test shares one config directory and one
// localStorage. Dropping them puts app data back under each test's own HOME.
for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) delete process.env[k];

module.exports = defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.js',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
});
