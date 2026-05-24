'use strict';

const claudeAdapter = require('./claude');
const copilotAdapter = require('./copilot');
const { makeStub } = require('./stub');
const { agentKey } = require('./common');

const ADAPTERS = {
  claude: claudeAdapter,
  copilot: copilotAdapter,
  codex: makeStub('codex'),
  aider: makeStub('aider'),
  gemini: makeStub('gemini'),
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
