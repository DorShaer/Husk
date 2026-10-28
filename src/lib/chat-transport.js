'use strict';

// Which headless protocol a given agent CLI speaks, for Husk's Chat mode.
// Verified against each CLI's --help on 2026-10-26:
//   copilot  --acp          Start as Agent Client Protocol server
//   gemini   --acp          Starts the agent in ACP mode
//   kiro-cli acp            Start Agent Client Protocol (ACP) agent
//   claude   -p --input-format stream-json --output-format stream-json
//   aider    (no machine protocol; Terminal mode only)
//   codex    app-server / codex-acp (not wired yet; Terminal mode only)

const { agentBaseName } = require('./agent-oneshot');

const ACP_ARGS = {
  copilot: ['--acp'],
  gemini: ['--acp'],
  'kiro-cli': ['acp'],
};

// transportFor returns 'acp', 'claude', or null when the CLI has no headless
// protocol Husk can drive. The command may carry the user's own flags.
function transportFor(agentCommand) {
  const base = agentBaseName(agentCommand);
  if (base === 'claude') return 'claude';
  if (Object.prototype.hasOwnProperty.call(ACP_ARGS, base)) return 'acp';
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

module.exports = { transportFor, acpArgs, userFlags, commandSessionId, SESSION_ID };
