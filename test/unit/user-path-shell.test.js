'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');

const { MARKER_START, MARKER_END, parseShellPathOutput } = require('../../src/lib/user-path');

// The existing tests drive getUserPath with an injected runShell, so they never
// execute the command against a real shell and cannot see how the shell parses
// it. These do: the end marker starts with underscores, which are valid in a
// variable name, so `$PATH__HUSK_PATH_END__` reads as one unset variable and the
// probe returns nothing. Only a real shell shows that.
const SHELLS = ['/bin/sh', '/bin/bash', '/bin/zsh', '/usr/bin/zsh'].filter((s) => {
  try { return fs.statSync(s).isFile(); } catch (_) { return false; }
});

// The command main.js and user-path.js send to the login shell.
const CMD = `echo "${MARKER_START}\${PATH}${MARKER_END}"`;

test('the probe command is built with braces around PATH', () => {
  // Without them the shell swallows the end marker into the variable name.
  assert.ok(CMD.includes('${PATH}'), 'the probe must brace PATH');
  assert.ok(!CMD.includes('$PATH' + MARKER_END), 'an unbraced $PATH glues the end marker into the variable name');
});

for (const shell of SHELLS) {
  test(`${shell} returns a parseable PATH between the markers`, () => {
    const res = spawnSync(shell, ['-c', CMD], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin' },
    });
    assert.equal(res.status, 0, `${shell} exited ${res.status}`);
    const parsed = parseShellPathOutput(res.stdout || '');
    assert.ok(parsed, `${shell} produced no parseable PATH: ${JSON.stringify((res.stdout || '').slice(0, 120))}`);
    assert.ok(parsed.includes('/bin'), `${shell} PATH looks wrong: ${parsed}`);
  });

  test(`${shell} would return nothing with an unbraced PATH (the original bug)`, () => {
    const broken = `echo "${MARKER_START}$PATH${MARKER_END}"`;
    const res = spawnSync(shell, ['-c', broken], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin' },
    });
    // The end marker is absorbed into the variable name, so nothing is parseable.
    assert.equal(parseShellPathOutput(res.stdout || ''), null,
      'an unbraced $PATH must not parse, or this test is not pinning the bug it claims to');
  });
}

test('at least one real shell was exercised', () => {
  assert.ok(SHELLS.length > 0, 'no shell found to test against');
});
