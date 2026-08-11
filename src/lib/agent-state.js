'use strict';

// What an agent's reported state means. The CLI reports more states than an
// agent has visible conditions, so they are folded into the four a reader acts
// on: waiting on you, working, stopped after a failure, and finished.

const RUNNING = new Set(['working', 'running', 'starting', 'queued']);
const BLOCKED = new Set(['blocked']);
const FAILED = new Set(['failed']);

// Anything unrecognised counts as finished: a state not known to be live is
// not shown as live. `started` says whether the agent ever took a prompt; one
// that never did reads as finished rather than as a failure.
function agentState(state, { started = true } = {}) {
  const s = String(state == null ? '' : state).trim().toLowerCase();
  if (BLOCKED.has(s)) return 'blocked';
  if (RUNNING.has(s)) return 'running';
  if (FAILED.has(s)) return started ? 'failed' : 'done';
  return 'done';
}

// Live means the agent is still there to be reached: working, or waiting on a
// person. A failed agent has stopped.
function isLive(state) {
  const s = agentState(state);
  return s === 'running' || s === 'blocked';
}

module.exports = { agentState, isLive };
