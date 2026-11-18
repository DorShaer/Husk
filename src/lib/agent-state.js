'use strict';

// What an agent's reported state means. The CLI reports more states than an
// agent has visible conditions, so they are folded into the five a reader acts
// on: waiting on you, working, open but quiet, stopped after a failure, and
// finished.

const RUNNING = new Set(['working', 'running', 'starting', 'queued']);
const BLOCKED = new Set(['blocked']);
const FAILED = new Set(['failed']);
// Husk's own word for work in flight that has gone quiet; the CLI's "idle" means its turn is over.
const IDLE = new Set(['quiet']);
// Husk's own word for a waiting agent whose work is over: it sits at its prompt, nothing is asked.
const READY = new Set(['ready']);

// How long work in flight may go without writing before it reads as quiet. An
// agent writes its transcript on every model reply and every tool result, a few
// seconds apart while it works; a long thinking turn stays well inside this.
const ACTIVE_MS = 90 * 1000;

// Anything unrecognised counts as finished: a state not known to be live is
// not shown as live. `started` says whether the agent ever took a prompt; one
// that never did reads as finished rather than as a failure.
function agentState(state, { started = true } = {}) {
  const s = String(state == null ? '' : state).trim().toLowerCase();
  if (BLOCKED.has(s)) return 'blocked';
  if (RUNNING.has(s)) return 'running';
  if (IDLE.has(s)) return 'idle';
  if (READY.has(s)) return 'ready';
  if (FAILED.has(s)) return started ? 'failed' : 'done';
  return 'done';
}

// Live means the agent is still there to be reached: working, or waiting on a
// person. A failed agent has stopped.
function isLive(state) {
  const s = agentState(state);
  return s === 'running' || s === 'blocked' || s === 'idle';
}

// A working state with nothing written for ACTIVE_MS is still open but not
// moving, so it reads as quiet. Every other state passes through.
function settle(state, lastAt, now = Date.now()) {
  return agentState(state) === 'running' && now - (Number(lastAt) || 0) >= ACTIVE_MS ? 'quiet' : state;
}

// The CLI's own "needs" text for an agent at its prompt with nothing asked.
const PROMPT_NEEDS = /^\(?(?:idle\W{1,8}send|send) a prompt to start\)?$/i;
// The same state in Husk's words, as displayNeeds hands it on.
const IDLE_TEXT = 'Idle. Send a prompt to start.';

// What a "blocked" agent is waiting for. The CLI reports blocked for every agent
// waiting on a person, including one that finished and sits at its prompt, so
// the reason is read from what it asked: a question, a tool call still waiting
// for approval, or a request in its own words. Anything else is ready.
function waitingOn({ needs = '', ask = '', pending = null, said = '' } = {}) {
  if (pending && pending.question) return { kind: 'question', text: pending.question };
  if (ask) return { kind: 'question', text: String(ask) };
  if (pending && pending.tool) return { kind: 'permission', tool: String(pending.tool), text: String(pending.text || '') };
  const n = String(needs || '').trim();
  if (n && n !== IDLE_TEXT && !PROMPT_NEEDS.test(n)) return { kind: 'reply', text: n };
  return { kind: 'ready', text: String(said || '') };
}

// The CLI's idle text is shown in Husk's own words, so its punctuation never
// reaches the interface.
function displayNeeds(needs) {
  const n = String(needs || '').trim();
  return PROMPT_NEEDS.test(n) ? IDLE_TEXT : n;
}

module.exports = { agentState, isLive, settle, waitingOn, displayNeeds, ACTIVE_MS };
