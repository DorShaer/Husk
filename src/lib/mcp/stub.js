'use strict';

// Stub adapter for agents Husk does not yet integrate with for MCP
// management (codex, aider, gemini, anything else on PATH). Returns
// an empty server list and refuses writes so the renderer can show
// a clear "not supported yet" empty state.
function makeStub(agentName) {
  return {
    agent: agentName,
    configPath: null,
    supportsWrite: false,
    supportsLiveStatus: false,
    list() {
      return { ok: true, servers: [], unsupported: true, agent: agentName };
    },
    health() {
      return Promise.resolve({ ok: true, status: {} });
    },
    add() {
      return { ok: false, error: `MCP management via Husk is not yet wired up for ${agentName}` };
    },
    remove() {
      return { ok: false, error: `MCP management via Husk is not yet wired up for ${agentName}` };
    },
    toggle() {
      return { ok: false, error: `MCP management via Husk is not yet wired up for ${agentName}` };
    },
  };
}

module.exports = { makeStub };
