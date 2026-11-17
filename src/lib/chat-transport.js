'use strict';

// Which headless protocol a given agent CLI speaks, for Husk's Chat mode.
// Verified against each CLI's --help on 2026-10-26:
//   copilot  --acp          Start as Agent Client Protocol server
//   gemini   --acp          Starts the agent in ACP mode
//   kiro-cli acp            Start Agent Client Protocol (ACP) agent
//   claude   -p --input-format stream-json --output-format stream-json
//   aider    (no machine protocol; Terminal mode only)
//   codex    app-server      JSON-RPC on stdio (see codex-app-server.js)

const { agentBaseName } = require('./agent-oneshot');

const ACP_ARGS = {
  copilot: ['--acp'],
  gemini: ['--acp'],
  'kiro-cli': ['acp'],
};

// transportFor returns 'acp', 'claude', 'codex', or null when the CLI has no headless
// protocol Husk can drive. The command may carry the user's own flags.
function transportFor(agentCommand) {
  const base = agentBaseName(agentCommand);
  // A custom command is usually the real claude under an alias (claude-work,
  // claude-bright) so people can run more than one account. Treat any claude*
  // basename as the claude protocol, so those open in native chat instead of
  // falling back to the raw CLI terminal view.
  if (base === 'claude' || /^claude[-_]/.test(base)) return 'claude';
  if (Object.prototype.hasOwnProperty.call(ACP_ARGS, base)) return 'acp';
  if (base === 'codex') return 'codex';
  return null;
}

// acpArgs returns the argv that puts the CLI into ACP server mode, or null
// when it has none.
function acpArgs(agentCommand) {
  const base = agentBaseName(agentCommand);
  return Object.prototype.hasOwnProperty.call(ACP_ARGS, base) ? ACP_ARGS[base].slice() : null;
}

// userFlags returns the flags the user typed after the program name, minus
// any subcommand (a `kiro-cli chat` prefix is terminal-mode specific). These
// ride along into the protocol spawn so a pinned --model survives.
function userFlags(agentCommand) {
  const tokens = String(agentCommand || '').trim().split(/\s+/).filter(Boolean);
  tokens.shift();
  if (tokens.length && !String(tokens[0]).startsWith('-')) tokens.shift();
  return tokens;
}

// The claude session a command names, when it names one: `--resume <id>` or
// `--session-id <id>`, in either spelling. Null for a command that leaves the
// id to the CLI.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,}$/;
function commandSessionId(agentCommand) {
  const flags = userFlags(agentCommand);
  for (let i = 0; i < flags.length; i++) {
    const f = String(flags[i]);
    // Match the flag and its delimiter only; the value is sliced or taken from
    // the next argument. Keeping the value out of the pattern avoids a nested
    // quantifier the ReDoS linter flags, with identical behavior.
    const m = /^--(resume|session-id)(=|$)/.exec(f);
    if (!m) continue;
    const v = m[2] === '=' ? f.slice(m[0].length) : flags[i + 1];
    if (v && SESSION_ID.test(String(v))) return String(v);
  }
  return null;
}

// The version range each CLI's chat transport was tested on. For display and a
// one-time notice only: the handshake, not the version, decides whether chat runs.
const TESTED = {
  claude: { feature: 'stream-json chat', min: '2.1', max: '2.1' },
  copilot: { feature: 'ACP chat', min: '1.0', max: '1.0' },
  gemini: { feature: 'ACP chat', min: '0.68', max: '0.68' },
  'kiro-cli': { feature: 'ACP chat', min: '2.16', max: '2.16' },
  codex: { feature: 'app-server chat', min: '0.167', max: '0.169' },
};

// Compares a version to a bound on the bound's own precision, so 2.1.323 is within '2.1'.
function cmpTo(version, bound) {
  const v = String(version).split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(bound).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < b.length; i++) if ((v[i] || 0) !== b[i]) return (v[i] || 0) < b[i] ? -1 : 1;
  return 0;
}

// untestedVersion returns what is outside the tested range for this CLI and
// version, or null when it is inside, unknown or not a version.
function untestedVersion(agentCommand, version) {
  const t = transportFor(agentCommand);
  const key = t === 'claude' ? 'claude' : agentBaseName(agentCommand);
  const row = TESTED[key];
  const v = /\d+\.\d+\.\d+|\d+\.\d+/.exec(String(version || ''));
  if (!row || !v) return null;
  if (cmpTo(v[0], row.min) >= 0 && cmpTo(v[0], row.max) <= 0) return null;
  return { cli: key, version: v[0], feature: row.feature, min: row.min, max: row.max };
}

module.exports = { transportFor, acpArgs, userFlags, commandSessionId, SESSION_ID, TESTED, untestedVersion };
