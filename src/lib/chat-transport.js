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

module.exports = { transportFor, acpArgs, userFlags };
