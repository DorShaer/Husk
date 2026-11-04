'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// node-pty ships no Linux prebuild, so pty.node is compiled on the release
// runner and inherits that runner's glibc. ubuntu-latest tracks a moving glibc
// and silently raised the requirement to GLIBC_2.42 in 2.13.1, which would not
// load on Ubuntu 24.04 (glibc 2.39). Pinning an older image keeps the floor
// fixed. This guards against a revert back to ubuntu-latest.
test('release build matrix pins the Linux runner, not ubuntu-latest', () => {
  const yml = fs.readFileSync(
    path.join(__dirname, '..', '..', '.github', 'workflows', 'release.yml'),
    'utf8',
  );
  const m = yml.match(/os:\s*\[([^\]]*)\]/);
  assert.ok(m, 'build matrix "os: [...]" not found in release.yml');
  const list = m[1];
  assert.ok(/ubuntu-\d\d\.\d\d/.test(list), `Linux build must pin a dated ubuntu image, got: ${list}`);
  assert.ok(!/ubuntu-latest/.test(list), `Linux build must not use ubuntu-latest, got: ${list}`);
});
