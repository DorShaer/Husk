'use strict';

// Read the PATH the user's login shell would see, so that a GUI-launched
// Electron app inherits the same binary search list as a Terminal
// session. macOS in particular hands GUI-launched apps a minimal PATH
// (/usr/bin:/bin:/usr/sbin:/sbin) that misses npm-global, homebrew, and
// bun install directories where users keep their agent CLIs.

// The end marker begins with underscores, which are valid in a shell variable
// name. So the braces around ${PATH} in the echo below are load bearing: without
// them the shell reads $PATH__HUSK_PATH_END__ as one variable name, finds it
// unset, and prints nothing between the markers.
const MARKER_START = '__HUSK_PATH_START__';
const MARKER_END = '__HUSK_PATH_END__';

// Pure parser. Given the stdout of a marker-wrapped echo, return the
// PATH between the markers or null if either marker is missing or the
// extracted value does not look like a PATH (must contain a separator).
function parseShellPathOutput(stdout) {
  if (typeof stdout !== 'string' || !stdout) return null;
  const start = stdout.lastIndexOf(MARKER_START);
  const end = stdout.lastIndexOf(MARKER_END);
  if (start === -1 || end === -1 || end <= start) return null;
  const value = stdout.slice(start + MARKER_START.length, end).trim();
  if (!value || value.indexOf(':') === -1) return null;
  return value;
}

// Orchestrator. runShell is injected so tests can exercise the logic
// without spawning a real process. Returns the PATH string on success,
// null when augmentation is not applicable or fails. The shell command
// is a fixed string that never interpolates external input.
function getUserPath({ platform, env, runShell }) {
  if (platform !== 'darwin' && platform !== 'linux') return null;
  const e = env || {};
  const shell = (typeof e.SHELL === 'string' && e.SHELL) ? e.SHELL : '/bin/zsh';
  const cmd = `echo "${MARKER_START}\${PATH}${MARKER_END}"`;
  let result;
  try {
    result = runShell(shell, ['-ilc', cmd]);
  } catch (_) {
    return null;
  }
  if (!result || typeof result.stdout !== 'string') return null;
  return parseShellPathOutput(result.stdout);
}

module.exports = { parseShellPathOutput, getUserPath, MARKER_START, MARKER_END };
