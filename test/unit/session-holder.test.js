'use strict';

// Opening a session that something else is already holding.
//
// A held session is one whose process is still alive, which is a different
// question from whether the agent is mid-turn: an agent that has finished its
// turn reports state "done" and keeps its pid, and owns the transcript until
// that process exits. Liveness therefore comes from the process, not the state
// word. The fixture rows are the shape `claude agents --json` returns.
//
// The refusal is matched too, because the probe and the spawn are two moments
// and an agent can claim a session between them.

const test = require('node:test');
const assert = require('node:assert/strict');

const { isLive } = require('../../src/lib/agent-state');

// ─── the fixture ───────────────────────────────────────────────────────────

// Verbatim shapes from `claude agents --json --all` on a machine with work in
// flight. The two that matter: an idle-but-alive background agent, which
// reports "done" and holds its session anyway, and an interactive chat, which
// is held the same way and has no id to attach to.
const ROWS = [
  { pid: 8027, id: 'a1b2c3d4', cwd: '/w', kind: 'background', sessionId: 'a1b2c3d4-0000-4000-8000-000000000001', name: 'Redesign', status: 'idle', state: 'done' },
  { pid: 8036, id: '7a184a44', cwd: '/w', kind: 'background', sessionId: '7a184a44-1eda-446c-9eff-71b37a7e5675', name: '7a184a44', status: 'idle', state: 'blocked' },
  { id: 'e401487f', cwd: '/w', kind: 'background', sessionId: 'e401487f-02f4-4ff6-bddc-2dec9dd4be89', name: 'Finished', state: 'done' },
  { id: 'b1424986', cwd: '/w', kind: 'background', sessionId: 'b1424986-1160-4e29-85fe-29b96e61c8a2', name: 'Broke', state: 'failed' },
  { pid: 10539, cwd: '/w', kind: 'interactive', sessionId: '5ad4cded-cc2c-438d-b87a-994877305fb5', status: 'idle' },
];

// The predicate under test, mirroring sessionHolder in main.js. The pid check
// is injected so the test does not depend on which numbers happen to be running
// on the machine it runs on.
function holderOf(rows, sessionId, alive) {
  for (const r of rows) {
    if (!r || String(r.sessionId || '') !== sessionId) continue;
    if (!alive(r.pid)) continue;
    const background = r.kind === 'background';
    return { kind: background ? 'background' : 'interactive', id: background ? String(r.id || '') : '' };
  }
  return null;
}

function planFor(rows, sessionId, alive) {
  const holder = holderOf(rows, sessionId, alive);
  const fork = `claude --resume ${sessionId} --fork-session`;
  if (holder && holder.kind === 'background') {
    return { mode: 'attach', command: `claude attach ${holder.id}`, forkCommand: fork };
  }
  if (holder) return { mode: 'fork', command: fork };
  return { mode: 'resume', command: `claude --resume ${sessionId}` };
}

// Every pid in the fixture is a live one, which is what the live probe found:
// rows carrying a pid were all running, rows without one were all gone.
const ALIVE = (pid) => Number.isInteger(Number(pid)) && Number(pid) > 0;

// ─── which sessions are spoken for ─────────────────────────────────────────

test('a background agent that has finished its turn still holds its session', () => {
  const row = ROWS[0];
  // The state word says done; the CLI refuses to resume it anyway.
  assert.equal(row.state, 'done');
  assert.equal(isLive(row.state), false,
    'the state word alone reports this session as free, which is why it cannot be the test');
  assert.equal(planFor(ROWS, row.sessionId, ALIVE).mode, 'attach',
    'the session the user clicked was still offered a resume the CLI refuses');
});

test('a held session opens by attaching to the agent that owns it', () => {
  const plan = planFor(ROWS, 'a1b2c3d4-0000-4000-8000-000000000001', ALIVE);
  assert.equal(plan.command, 'claude attach a1b2c3d4');
  assert.equal(plan.forkCommand,
    'claude --resume a1b2c3d4-0000-4000-8000-000000000001 --fork-session');
});

test('an agent waiting on a person is held too', () => {
  assert.equal(planFor(ROWS, '7a184a44-1eda-446c-9eff-71b37a7e5675', ALIVE).mode, 'attach');
});

test('an agent whose process is gone resumes from its transcript', () => {
  const plan = planFor(ROWS, 'e401487f-02f4-4ff6-bddc-2dec9dd4be89', ALIVE);
  assert.equal(plan.mode, 'resume');
  assert.equal(plan.command, 'claude --resume e401487f-02f4-4ff6-bddc-2dec9dd4be89');
});

test('a failed agent with no process left resumes rather than attaches', () => {
  assert.equal(planFor(ROWS, 'b1424986-1160-4e29-85fe-29b96e61c8a2', ALIVE).mode, 'resume');
});

test('a chat open in another window is opened as a copy, because there is no id to attach to', () => {
  const plan = planFor(ROWS, '5ad4cded-cc2c-438d-b87a-994877305fb5', ALIVE);
  assert.equal(plan.mode, 'fork');
  assert.equal(plan.command, 'claude --resume 5ad4cded-cc2c-438d-b87a-994877305fb5 --fork-session');
});

test('a session nothing has ever listed resumes', () => {
  assert.equal(planFor(ROWS, 'ffffffff-0000-0000-0000-000000000000', ALIVE).mode, 'resume');
});

test('a pid that has since exited frees its session', () => {
  // The same row, read a moment after the agent stopped.
  const plan = planFor(ROWS, 'a1b2c3d4-0000-4000-8000-000000000001', () => false);
  assert.equal(plan.mode, 'resume', 'a dead process kept holding its session');
});

// ─── recognising the refusal ───────────────────────────────────────────────

// Verbatim from the CLI.
const HELD_REFUSAL = 'Error: Session a1b2c3d4-0000-4000-8000-000000000001 is currently '
  + 'running as a background agent (bg). Use `claude agents` to find and attach to it, '
  + 'or add --fork-session to branch off a copy.';

const MISSING_REFUSAL = 'No conversation found with session ID: 1234abcd';

function stripTerminalControls(s) {
  return String(s || '')
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '');
}

function resumeRejectedOutput(text) {
  const t = stripTerminalControls(text);
  return /No session, task, or name matched/i.test(t)
    || /No conversation found with session ID/i.test(t)
    || /No conversation found/i.test(t);
}

function resumeHeldByAgentOutput(text) {
  const t = stripTerminalControls(text);
  return /is currently running as a background agent/i.test(t)
    || (/--fork-session/.test(t) && /background agent/i.test(t));
}

test('the held refusal is recognised', () => {
  assert.equal(resumeHeldByAgentOutput(HELD_REFUSAL), true);
});

test('the held refusal is not a missing session, which has a different fix', () => {
  // Reading it as one closed the tab and told the user the session was not
  // resumable yet. The session is fine; something else is reading it.
  assert.equal(resumeRejectedOutput(HELD_REFUSAL), false);
  assert.equal(resumeHeldByAgentOutput(MISSING_REFUSAL), false);
  assert.equal(resumeRejectedOutput(MISSING_REFUSAL), true);
});

test('the refusal is still recognised through terminal colour', () => {
  const painted = `\x1b[31m${HELD_REFUSAL}\x1b[0m`;
  assert.equal(resumeHeldByAgentOutput(painted), true);
});

test('ordinary agent output naming a background agent is not read as a refusal', () => {
  const chatter = 'I will spawn a background agent to review the diff, then report back.';
  assert.equal(resumeHeldByAgentOutput(chatter), false);
});

// ─── one session, one tab ──────────────────────────────────────────────────

// One transcript gets one tab. A second tab on the same transcript is a second
// reader, which the CLI refuses for the same reason a held session cannot be
// resumed. The rule is identity, so it turns on which ids count as one. This
// mirrors tabForSession in app.js.
function tabForSession(tabs, sessionId) {
  const id = String(sessionId || '');
  if (!id) return null;
  for (const t of tabs) {
    if (t.agentId === id && !t.agentIdProvisional) return t;
  }
  return null;
}

test('a session already on screen is found by its tab', () => {
  const tabs = [{ id: 't1', agentId: null }, { id: 't2', agentId: 'abc-123' }];
  assert.equal(tabForSession(tabs, 'abc-123').id, 't2');
});

test('a session nothing has open is not found', () => {
  const tabs = [{ id: 't1', agentId: 'other' }];
  assert.equal(tabForSession(tabs, 'abc-123'), null);
});

test('a provisional id is not identity, because the resolver revises it', () => {
  // A fresh chat is guessed into a session before the CLI has settled which one
  // it became. Focusing on a guess sends the user to a different conversation.
  const tabs = [{ id: 't1', agentId: 'abc-123', agentIdProvisional: true }];
  assert.equal(tabForSession(tabs, 'abc-123'), null);
});

test('a tab with no session yet is never matched, including by an empty id', () => {
  const tabs = [{ id: 't1', agentId: null }, { id: 't2', agentId: '' }];
  assert.equal(tabForSession(tabs, ''), null, 'an unlinked tab answered for a blank session');
  assert.equal(tabForSession(tabs, null), null);
});

test('a copy is a different conversation and does not answer for its parent', () => {
  // The fork starts from the parent's history and diverges at once. Linking it
  // to the parent id would make the next click on the original focus the copy,
  // and a rename of either follow the other.
  const parent = 'abc-123';
  const tabs = [{ id: 't1', agentId: parent }, { id: 't2', agentId: null }];
  assert.equal(tabForSession(tabs, parent).id, 't1',
    'the copy claimed the id of the session it was made from');
});

// A dead tab still holds its scrollback and carries Restart, so it keeps its
// session and liveness is not part of the match.
test('a tab whose agent has exited still holds its session', () => {
  const tabs = [{ id: 't1', agentId: 'abc-123', exited: true }];
  assert.equal(tabForSession(tabs, 'abc-123').id, 't1');
});
