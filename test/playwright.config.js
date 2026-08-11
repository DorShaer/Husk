'use strict';

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.js',
  // A two core runner starts Electron and paints several times slower than a
  // workstation does, so a test gets room for a slow launch and a slow wait.
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  // Electron launches contend for a shared runner's two cores, so a test that
  // lost that race gets one more go and is reported as flaky either way.
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
});
