'use strict';

// How to reach one background agent. A live agent is owned by its worker, so it
// is attached by id; a finished one resumes from the transcript it left behind.

// Agent ids are bare word characters; session ids are hex with dashes.
const ID = /^[A-Za-z0-9][A-Za-z0-9-]{2,}$/;
const SESSION = /^[0-9a-fA-F-]{16,}$/;
// An agent running inside a chat, which the CLI has no command for: it is a
// turn in its parent's conversation rather than a session anything can hold.
const IN_PROCESS = /^sa-/;
const IN_PROCESS_ERROR = 'that agent runs inside its chat, so open the chat instead';

function openCommand({ id = '', sessionId = '', attach = false, transcript = '', cwd = '' } = {}) {
  const shortId = String(id || '').trim();
  const session = String(sessionId || '').trim();
  if (!shortId && !session) return { ok: false, error: 'no agent selected' };
  if (IN_PROCESS.test(shortId)) return { ok: false, error: IN_PROCESS_ERROR };

  if (attach) {
    if (!ID.test(shortId)) return { ok: false, error: 'that agent has no id to attach to' };
    return { ok: true, mode: 'attach', command: `claude attach ${shortId}` };
  }

  if (!SESSION.test(session)) return { ok: false, error: 'that agent has no session to resume' };
  if (!transcript) return { ok: false, error: 'that agent finished without leaving a transcript' };
  return { ok: true, mode: 'resume', command: `claude --resume ${session}`, cwd: String(cwd || '') };
}

// Ending a background agent. Stopping halts the worker and keeps the
// conversation, so the agent can be attached again later. Removing discards the
// job and its worktree and cannot be undone.
const CONTROLS = { stop: 'stop', remove: 'rm' };

// Text the CLI printed when it refused, made fit for a toast: no escape codes,
// no dash punctuation, one line, a capital to start.
function cleanCliMessage(raw) {
  return String(raw || '')
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\s*[\u2014\u2013]\s*/g, ': ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[a-z]/, (c) => c.toUpperCase());
}

// The CLI cannot stop an agent whose worker is no longer there to answer: a
// session that was left waiting on the user weeks ago and whose process has
// since gone still lists as live, and `stop` reports that it could not confirm
// the stop and suggests trying again. Trying again never helps that agent, so
// the failure is marked stale and the caller can offer to remove it instead.
const STALE = /couldn.t confirm .* was stopped|background service may be restarting/i;

function controlFailure(action, id, raw) {
  const text = cleanCliMessage(raw);
  const shortId = String(id || '').trim();
  if (action === 'stop' && STALE.test(text)) {
    return {
      ok: false,
      stale: true,
      error: `Could not confirm ${shortId || 'the agent'} stopped. Its worker may already be gone.`,
    };
  }
  return { ok: false, stale: false, error: text || (action === 'remove' ? 'The agent could not be deleted.' : 'The agent did not stop.') };
}

function controlArgs(action, id) {
  const verb = CONTROLS[String(action || '')];
  if (!verb) return { ok: false, error: 'that is not something to do to an agent' };
  const shortId = String(id || '').trim();
  if (IN_PROCESS.test(shortId)) return { ok: false, error: IN_PROCESS_ERROR };
  if (!ID.test(shortId)) return { ok: false, error: 'that agent has no id to act on' };
  return { ok: true, args: [verb, shortId] };
}

module.exports = { openCommand, controlArgs, controlFailure, cleanCliMessage };
