'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseShellPathOutput,
  getUserPath,
  MARKER_START,
  MARKER_END,
} = require('../../src/lib/user-path');

function wrap(p) {
  return `${MARKER_START}${p}${MARKER_END}\n`;
}

// ─── parseShellPathOutput ────────────────────────────────────────────────────

test('parseShellPathOutput: extracts PATH between markers', () => {
  assert.equal(
    parseShellPathOutput(wrap('/usr/local/bin:/usr/bin:/bin')),
    '/usr/local/bin:/usr/bin:/bin',
  );
});

test('parseShellPathOutput: ignores chatter before the markers', () => {
  const out = `Welcome to zsh\nLoading completions...\n${wrap('/opt/homebrew/bin:/usr/bin')}`;
  assert.equal(parseShellPathOutput(out), '/opt/homebrew/bin:/usr/bin');
});

test('parseShellPathOutput: ignores chatter after the markers', () => {
  const out = `${wrap('/usr/local/bin:/usr/bin')}some leftover output\n`;
  assert.equal(parseShellPathOutput(out), '/usr/local/bin:/usr/bin');
});

test('parseShellPathOutput: trims whitespace inside the marker block', () => {
  const out = `${MARKER_START}   /usr/bin:/bin   ${MARKER_END}`;
  assert.equal(parseShellPathOutput(out), '/usr/bin:/bin');
});

test('parseShellPathOutput: returns null when both markers are missing', () => {
  assert.equal(parseShellPathOutput('/usr/bin:/bin'), null);
});

test('parseShellPathOutput: returns null when only the start marker is present', () => {
  assert.equal(parseShellPathOutput(`${MARKER_START}/usr/bin:/bin`), null);
});

test('parseShellPathOutput: returns null when only the end marker is present', () => {
  assert.equal(parseShellPathOutput(`/usr/bin:/bin${MARKER_END}`), null);
});

test('parseShellPathOutput: returns null when extracted value has no separator', () => {
  assert.equal(parseShellPathOutput(wrap('justonebinary')), null);
});

test('parseShellPathOutput: returns null on empty extracted value', () => {
  assert.equal(parseShellPathOutput(`${MARKER_START}${MARKER_END}`), null);
});

test('parseShellPathOutput: returns null for non-string input', () => {
  assert.equal(parseShellPathOutput(null), null);
  assert.equal(parseShellPathOutput(undefined), null);
  assert.equal(parseShellPathOutput(42), null);
  assert.equal(parseShellPathOutput(''), null);
});

test('parseShellPathOutput: when both markers appear multiple times, uses the last pair', () => {
  const out = `${wrap('/stale/path:/old')}${wrap('/real/path:/cur')}`;
  assert.equal(parseShellPathOutput(out), '/real/path:/cur');
});

// ─── getUserPath ─────────────────────────────────────────────────────────────

test('getUserPath: skips augmentation on win32', () => {
  const got = getUserPath({
    platform: 'win32',
    env: { SHELL: '/bin/zsh' },
    runShell: () => { throw new Error('should not be called'); },
  });
  assert.equal(got, null);
});

test('getUserPath: skips augmentation on an unknown platform', () => {
  const got = getUserPath({
    platform: 'freebsd',
    env: { SHELL: '/bin/sh' },
    runShell: () => { throw new Error('should not be called'); },
  });
  assert.equal(got, null);
});

test('getUserPath: uses $SHELL when present', () => {
  let calledShell = null;
  const runShell = (shell) => {
    calledShell = shell;
    return { stdout: wrap('/usr/local/bin:/usr/bin') };
  };
  getUserPath({ platform: 'darwin', env: { SHELL: '/bin/bash' }, runShell });
  assert.equal(calledShell, '/bin/bash');
});

test('getUserPath: falls back to /bin/zsh when $SHELL is absent', () => {
  let calledShell = null;
  const runShell = (shell) => {
    calledShell = shell;
    return { stdout: wrap('/usr/bin:/bin') };
  };
  getUserPath({ platform: 'darwin', env: {}, runShell });
  assert.equal(calledShell, '/bin/zsh');
});

test('getUserPath: invokes login + interactive + command shell flags', () => {
  let calledArgs = null;
  const runShell = (_shell, args) => {
    calledArgs = args;
    return { stdout: wrap('/x:/y') };
  };
  getUserPath({ platform: 'darwin', env: { SHELL: '/bin/zsh' }, runShell });
  assert.equal(calledArgs[0], '-ilc');
  assert.match(calledArgs[1], new RegExp(MARKER_START));
  assert.match(calledArgs[1], new RegExp(MARKER_END));
});

test('getUserPath: returns the parsed PATH on success', () => {
  const runShell = () => ({ stdout: wrap('/home/me/bin:/usr/bin') });
  assert.equal(getUserPath({ platform: 'darwin', env: {}, runShell }), '/home/me/bin:/usr/bin');
});

test('getUserPath: returns null when runShell throws', () => {
  const runShell = () => { throw new Error('spawn failed'); };
  assert.equal(getUserPath({ platform: 'darwin', env: {}, runShell }), null);
});

test('getUserPath: returns null when stdout has no markers', () => {
  const runShell = () => ({ stdout: '/usr/bin:/bin\n' });
  assert.equal(getUserPath({ platform: 'darwin', env: {}, runShell }), null);
});

test('getUserPath: returns null when runShell yields no stdout', () => {
  assert.equal(
    getUserPath({ platform: 'darwin', env: {}, runShell: () => ({}) }),
    null,
  );
});

test('getUserPath: works on linux too', () => {
  const runShell = () => ({ stdout: wrap('/home/me/bin:/usr/bin') });
  assert.equal(getUserPath({ platform: 'linux', env: {}, runShell }), '/home/me/bin:/usr/bin');
});

test('getUserPath: the shell command does not interpolate any env value', () => {
  let captured = null;
  const runShell = (_shell, args) => {
    captured = args[args.length - 1];
    return { stdout: wrap('/u/b') };
  };
  getUserPath({
    platform: 'darwin',
    env: { SHELL: '/bin/zsh', FOO: 'bar;evil', PATH: 'unused' },
    runShell,
  });
  const expected = `echo "${MARKER_START}$PATH${MARKER_END}"`;
  assert.equal(captured, expected);
});
