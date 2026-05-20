'use strict';

const fs = require('fs');
const path = require('path');

// resolveWindowsExe walks env.PATH and applies env.PATHEXT to find the
// real path to a program name, the way cmd.exe would. Returns the
// absolute path on hit, null when no candidate exists. Pure: no spawn.
//
// Why this exists: Win32 CreateProcess does not honor PATHEXT. A bare
// pty.spawn('claude') fails when claude is installed as a .cmd or .bat
// shim (the npm shim shape). Resolving the path ourselves lets us call
// pty.spawn(resolvedPath, argv) directly without a cmd.exe wrapper.
function resolveWindowsExe(exe, env) {
  if (typeof exe !== 'string' || !exe) return null;
  const e = env || {};
  if (path.isAbsolute(exe)) {
    return safeExists(exe) ? exe : null;
  }
  if (exe.indexOf(path.sep) !== -1 || exe.indexOf('/') !== -1) {
    return null;
  }
  const pathDirs = (e.PATH || '').split(';').filter(Boolean);
  const exts = (e.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const hasExt = /\.[^.\\/]+$/.test(exe);
  for (const dir of pathDirs) {
    if (hasExt) {
      const direct = path.join(dir, exe);
      if (safeExists(direct)) return direct;
      continue;
    }
    for (const ext of exts) {
      const candidate = path.join(dir, exe + ext);
      if (safeExists(candidate)) return candidate;
    }
  }
  return null;
}

function safeExists(p) {
  // resolveWindowsExe probes candidate file paths built from PATH+PATHEXT
  // entries to find the real location of a program. This is a read-only
  // existence + isFile check; no contents are opened or written.
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (!fs.existsSync(p)) return false;
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

// buildSpawnSpec(platform, agentExe, agentArgs, rawCmd, env, opts) returns
// the {exe, argv} pair pty.spawn should use. shell is the platform's
// fallback interactive shell, only used when rawCmd is empty.
//
// Platform shapes:
//   darwin   pty.spawn(agentExe, agentArgs)   no shell parser involved
//   linux    pty.spawn('/usr/bin/script',
//              ['-q', '-c', shJoin(agentExe, agentArgs), '/dev/null'])
//            falls through to pty.spawn('/bin/sh', ['-c', shJoin(...)])
//            when /usr/bin/script is unavailable. The script wrapper is
//            retained because `claude --resume <id>` exits 129 without
//            its setsid + TIOCSCTTY setup on Linux; the inner string is
//            shell-escaped by shJoin from src/lib/shell-quote.js.
//   win32    pty.spawn(resolved-via-PATHEXT, agentArgs) when resolvable;
//            falls back to pty.spawn('cmd.exe', ['/c', rawCmd]) when the
//            exe cannot be resolved (preserves the legacy behavior).
function buildSpawnSpec(opts) {
  const platform = opts.platform;
  const agentExe = opts.agentExe;
  const agentArgs = opts.agentArgs || [];
  const rawCmd = (opts.rawCmd || '').trim();
  const env = opts.env || {};
  const shell = opts.shell;
  const shJoin = opts.shJoin;
  const scriptExists = typeof opts.scriptExists === 'boolean' ? opts.scriptExists : false;

  if (!rawCmd) {
    if (platform === 'win32') return { exe: shell, argv: [] };
    return { exe: shell, argv: ['-i'] };
  }

  if (platform === 'win32') {
    const resolved = resolveWindowsExe(agentExe, env);
    if (resolved) return { exe: resolved, argv: agentArgs };
    const cmdExe = env.ComSpec || 'cmd.exe';
    return { exe: cmdExe, argv: ['/c', rawCmd] };
  }

  if (platform === 'darwin') {
    return { exe: agentExe, argv: agentArgs };
  }

  const cmdStr = shJoin(agentExe, agentArgs);
  if (scriptExists) {
    return { exe: '/usr/bin/script', argv: ['-q', '-c', cmdStr, '/dev/null'] };
  }
  return { exe: '/bin/sh', argv: ['-c', cmdStr] };
}

module.exports = { resolveWindowsExe, buildSpawnSpec };
