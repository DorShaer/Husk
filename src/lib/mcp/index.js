'use strict';

const claudeAdapter = require('./claude');
const copilotAdapter = require('./copilot');
const geminiAdapter = require('./gemini');
const { makeStub } = require('./stub');
const { agentKey } = require('./common');

// codex and aider have no safe programmatic MCP-config path: codex uses a
// shared ~/.codex/config.toml (no safe merge without a TOML writer) and
// aider takes MCP via a CLI flag, so both are handled by the paste-a-snippet
// install flow (see repo-mcp.js) rather than a read/write adapter.
const ADAPTERS = {
  claude: claudeAdapter,
  copilot: copilotAdapter,
  gemini: geminiAdapter,
  codex: makeStub('codex'),
  aider: makeStub('aider'),
};

// getAdapter(agentCommand) returns the right MCP adapter for the
// configured agent. Unknown agents fall through to a generic stub
// that surfaces "not supported" rather than silently misreading
// claude's config.
function getAdapter(agentCommand) {
  const key = agentKey(agentCommand);
  return ADAPTERS[key] || makeStub(key);
}

module.exports = { getAdapter, ADAPTERS };
