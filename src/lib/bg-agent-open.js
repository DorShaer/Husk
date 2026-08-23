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

function controlArgs(action, id) {
  const verb = CONTROLS[String(action || '')];
  if (!verb) return { ok: false, error: 'that is not something to do to an agent' };
  const shortId = String(id || '').trim();
  if (IN_PROCESS.test(shortId)) return { ok: false, error: IN_PROCESS_ERROR };
  if (!ID.test(shortId)) return { ok: false, error: 'that agent has no id to act on' };
  return { ok: true, args: [verb, shortId] };
}

module.exports = { openCommand, controlArgs };
