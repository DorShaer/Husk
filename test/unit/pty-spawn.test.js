'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveWindowsExe, buildSpawnSpec, withCopilotContextDir } = require('../../src/lib/pty-spawn');
const { shJoin } = require('../../src/lib/shell-quote');

// ─── resolveWindowsExe ───────────────────────────────────────────────────────

function tempBin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-rwe-'));
  return dir;
}

test('resolveWindowsExe: finds an .EXE via PATHEXT', () => {
  const dir = tempBin();
  fs.writeFileSync(path.join(dir, 'claude.EXE'), '');
  const got = resolveWindowsExe('claude', { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' });
  assert.equal(got, path.join(dir, 'claude.EXE'));
});

test('resolveWindowsExe: finds a .CMD shim via PATHEXT', () => {
  const dir = tempBin();
  fs.writeFileSync(path.join(dir, 'claude.CMD'), '');
  const got = resolveWindowsExe('claude', { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' });
  assert.equal(got, path.join(dir, 'claude.CMD'));
});

test('resolveWindowsExe: respects PATHEXT order', () => {
  const dir = tempBin();
  fs.writeFileSync(path.join(dir, 'claude.EXE'), '');
  fs.writeFileSync(path.join(dir, 'claude.CMD'), '');
  const got = resolveWindowsExe('claude', { PATH: dir, PATHEXT: '.CMD;.EXE' });
  assert.equal(got, path.join(dir, 'claude.CMD'));
});

test('resolveWindowsExe: when exe already has an extension, only that file is tried', () => {
  const dir = tempBin();
  fs.writeFileSync(path.join(dir, 'claude.EXE'), '');
  const hit = resolveWindowsExe('claude.EXE', { PATH: dir, PATHEXT: '.COM;.EXE' });
  assert.equal(hit, path.join(dir, 'claude.EXE'));
  const miss = resolveWindowsExe('claude.bat', { PATH: dir, PATHEXT: '.COM;.EXE' });
  assert.equal(miss, null);
});

test('resolveWindowsExe: returns null when not found', () => {
  const dir = tempBin();
  assert.equal(resolveWindowsExe('nope', { PATH: dir, PATHEXT: '.EXE' }), null);
});

test('resolveWindowsExe: returns null when PATH is empty', () => {
  assert.equal(resolveWindowsExe('claude', { PATH: '', PATHEXT: '.EXE' }), null);
});

test('resolveWindowsExe: refuses an exe containing a path separator', () => {
  const dir = tempBin();
  fs.writeFileSync(path.join(dir, 'claude.EXE'), '');
  assert.equal(resolveWindowsExe('sub\\claude', { PATH: dir, PATHEXT: '.EXE' }), null);
  assert.equal(resolveWindowsExe('sub/claude', { PATH: dir, PATHEXT: '.EXE' }), null);
});

test('resolveWindowsExe: absolute path is accepted when the file exists', () => {
  const dir = tempBin();
  const f = path.join(dir, 'tool.exe');
  fs.writeFileSync(f, '');
  assert.equal(resolveWindowsExe(f, {}), f);
});

test('resolveWindowsExe: absolute path is rejected when the file does not exist', () => {
  assert.equal(resolveWindowsExe('/no/such/file.exe', {}), null);
});

test('resolveWindowsExe: walks multiple directories in PATH', () => {
  const dir1 = tempBin();
  const dir2 = tempBin();
  fs.writeFileSync(path.join(dir2, 'claude.EXE'), '');
  const env = { PATH: [dir1, dir2].join(';'), PATHEXT: '.EXE' };
  assert.equal(resolveWindowsExe('claude', env), path.join(dir2, 'claude.EXE'));
});

// ─── buildSpawnSpec ──────────────────────────────────────────────────────────

test('buildSpawnSpec: darwin uses direct exe+argv, no shell parser', () => {
  const spec = buildSpawnSpec({
    platform: 'darwin',
    agentExe: 'claude',
    agentArgs: ['--resume', 'abc'],
    rawCmd: 'claude --resume abc',
    env: {},
    shell: '/bin/zsh',
    shJoin,
    scriptExists: false,
  });
  assert.equal(spec.exe, 'claude');
  assert.deepEqual(spec.argv, ['--resume', 'abc']);
});

test('buildSpawnSpec: darwin with metacharacters in exe stays one argv[0]', () => {
  const spec = buildSpawnSpec({
    platform: 'darwin',
    agentExe: 'a;b',
    agentArgs: ['x'],
    rawCmd: 'a;b x',
    env: {},
    shell: '/bin/zsh',
    shJoin,
    scriptExists: false,
  });
  assert.equal(spec.exe, 'a;b');
  assert.deepEqual(spec.argv, ['x']);
});

test('buildSpawnSpec: linux wraps with /usr/bin/script when available', () => {
  const spec = buildSpawnSpec({
    platform: 'linux',
    agentExe: 'claude',
    agentArgs: ['--resume', 'abc'],
    rawCmd: 'claude --resume abc',
    env: {},
    shell: '/bin/bash',
    shJoin,
    scriptExists: true,
  });
  assert.equal(spec.exe, '/usr/bin/script');
  assert.deepEqual(spec.argv, ['-q', '-c', "'claude' '--resume' 'abc'", '/dev/null']);
});

test('buildSpawnSpec: linux falls back to /bin/sh when script is absent', () => {
  const spec = buildSpawnSpec({
    platform: 'linux',
    agentExe: 'claude',
    agentArgs: ['--resume', 'abc'],
    rawCmd: 'claude --resume abc',
    env: {},
    shell: '/bin/bash',
    shJoin,
    scriptExists: false,
  });
  assert.equal(spec.exe, '/bin/sh');
  assert.deepEqual(spec.argv, ['-c', "'claude' '--resume' 'abc'"]);
});

test('buildSpawnSpec: linux argv-inside-string is shell-escaped against injection', () => {
  const spec = buildSpawnSpec({
    platform: 'linux',
    agentExe: 'a;b',
    agentArgs: ['x'],
    rawCmd: 'a;b x',
    env: {},
    shell: '/bin/bash',
    shJoin,
    scriptExists: true,
  });
  // The exe must be quoted inside the -c string so /bin/sh treats it as
  // one program name, not two commands separated by ';'.
  const cmdStr = spec.argv[2];
  assert.equal(cmdStr.startsWith("'a;b'"), true, cmdStr);
});

test('buildSpawnSpec: win32 runs a .cmd shim through cmd.exe (avoids error 193)', () => {
  const dir = tempBin();
  fs.writeFileSync(path.join(dir, 'claude.CMD'), '');
  const spec = buildSpawnSpec({
    platform: 'win32',
    agentExe: 'claude',
    agentArgs: ['--help'],
    rawCmd: 'claude --help',
    env: { PATH: dir, PATHEXT: '.EXE;.CMD', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    shell: 'cmd.exe',
    shJoin,
  });
  // A .cmd is not a PE binary; CreateProcess (pty.spawn) cannot launch it
  // directly, so it must be invoked via the command interpreter.
  assert.equal(spec.exe, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(spec.argv, ['/c', path.join(dir, 'claude.CMD'), '--help']);
});

test('buildSpawnSpec: win32 upgrades an extension-less npm shim to its .cmd sibling', () => {
  const dir = tempBin();
  // The npm install shape: an extension-less POSIX shim plus a .cmd.
  fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(dir, 'claude.cmd'), '');
  const spec = buildSpawnSpec({
    platform: 'win32',
    agentExe: path.join(dir, 'claude'), // absolute, extension-less (the 193 case)
    agentArgs: ['--session-id', 'abc'],
    rawCmd: 'claude --session-id abc',
    env: { PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'cmd.exe' },
    shell: 'cmd.exe',
    shJoin,
  });
  assert.equal(spec.exe, 'cmd.exe');
  assert.deepEqual(spec.argv, ['/c', path.join(dir, 'claude.cmd'), '--session-id', 'abc']);
});

test('buildSpawnSpec: win32 spawns a real .exe directly', () => {
  const dir = tempBin();
  fs.writeFileSync(path.join(dir, 'claude.EXE'), '');
  const spec = buildSpawnSpec({
    platform: 'win32',
    agentExe: 'claude',
    agentArgs: ['--help'],
    rawCmd: 'claude --help',
    env: { PATH: dir, PATHEXT: '.EXE;.CMD', ComSpec: 'cmd.exe' },
    shell: 'cmd.exe',
    shJoin,
  });
  assert.equal(spec.exe, path.join(dir, 'claude.EXE'));
  assert.deepEqual(spec.argv, ['--help']);
});

test('buildSpawnSpec: win32 falls back to cmd.exe /c when exe is not resolvable', () => {
  const dir = tempBin();
  const spec = buildSpawnSpec({
    platform: 'win32',
    agentExe: 'ghost',
    agentArgs: ['--help'],
    rawCmd: 'ghost --help',
    env: { PATH: dir, PATHEXT: '.EXE', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    shell: 'cmd.exe',
    shJoin,
  });
  assert.equal(spec.exe, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(spec.argv, ['/c', 'ghost --help']);
});

// ─── withCopilotContextDir ──────────────────────────────────────────────────

test('withCopilotContextDir: adds the Husk context tray for copilot', () => {
  const args = withCopilotContextDir({
    agentExe: '/home/user/.local/bin/copilot',
    agentArgs: ['--model', 'gpt-5.5'],
    contextDir: '/home/user/.claude/MEMORY/CONTEXT',
  });
  assert.deepEqual(args, ['--model', 'gpt-5.5', '--add-dir', '/home/user/.claude/MEMORY/CONTEXT']);
});

test('withCopilotContextDir: does not duplicate an existing context dir', () => {
  const args = withCopilotContextDir({
    agentExe: 'copilot',
    agentArgs: ['--add-dir', '/tmp/context'],
    contextDir: '/tmp/context',
  });
  assert.deepEqual(args, ['--add-dir', '/tmp/context']);
});

test('withCopilotContextDir: leaves non-copilot agents unchanged', () => {
  const args = withCopilotContextDir({
    agentExe: 'claude',
    agentArgs: ['--foo'],
    contextDir: '/tmp/context',
  });
  assert.deepEqual(args, ['--foo']);
});

test('buildSpawnSpec: empty rawCmd drops into the platform shell', () => {
  const mac = buildSpawnSpec({
    platform: 'darwin', agentExe: '', agentArgs: [], rawCmd: '',
    env: {}, shell: '/bin/zsh', shJoin,
  });
  assert.equal(mac.exe, '/bin/zsh');
  assert.deepEqual(mac.argv, ['-i']);

  const win = buildSpawnSpec({
    platform: 'win32', agentExe: '', agentArgs: [], rawCmd: '',
    env: {}, shell: 'cmd.exe', shJoin,
  });
  assert.equal(win.exe, 'cmd.exe');
  assert.deepEqual(win.argv, []);
});
