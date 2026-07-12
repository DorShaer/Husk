'use strict';

// Performance / memory profiling harness. Separate from the functional e2e
// suite: these tests are slow (minutes, deliberate churn loops) and report
// metrics rather than feature behavior. Run with: npm run test:perf

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'perf',
  testMatch: '*.spec.js',
  timeout: 420_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
});
