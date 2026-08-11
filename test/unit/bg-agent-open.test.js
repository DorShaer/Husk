'use strict';

// Choosing how to reach one background agent.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { openCommand } = require('../../src/lib/bg-agent-open');

const SESSION = 'ebd17fde-fbb1-472a-81e3-ab77b47dde40';

// ─── reaching a live agent ─────────────────────────────────────────────────

test('a live agent is attached by id, which opens that session directly', () => {
  const r = openCommand({ id: 'ebd17fde', sessionId: SESSION, attach: true });
  assert.equal(r.ok, true, `attaching was refused: ${r.error}`);
  assert.equal(r.mode, 'attach');
  assert.equal(r.command, 'claude attach ebd17fde');
});

// The agent list is the only way in for a session that has not written a
// transcript yet, so attaching must not depend on one.
test('a live agent with no transcript is still reachable', () => {
  const r = openCommand({ id: 'ebd17fde', sessionId: SESSION, attach: true, transcript: '' });
  assert.equal(r.ok, true, 'an agent that has not written a transcript was unreachable');
  assert.equal(r.command, 'claude attach ebd17fde');
});

test('attaching carries no environment for the child to pick up', () => {
  const r = openCommand({ id: 'ebd17fde', attach: true });
  assert.equal(r.env, undefined, 'the attach path still hands the child an environment');
});

// ─── the shape of an id ────────────────────────────────────────────────────

test('only a bare word id is accepted', () => {
  for (const id of ['a b', 'a;b', 'a$(b)', 'a`b`', 'a|b', 'a&b', 'a>b', "a'b", 'a"b', '../x', 'a\nb']) {
    const r = openCommand({ id, sessionId: SESSION, attach: true });
    assert.equal(r.ok, false, `${JSON.stringify(id)} was accepted as an agent id`);
    assert.match(r.error, /no id to attach to/);
  }
});

test('an id too short to be an agent id is refused', () => {
  for (const id of ['', 'a', 'ab', '-abc']) {
    assert.equal(openCommand({ id, sessionId: '', attach: true }).ok, false,
      `${JSON.stringify(id)} was accepted as an agent id`);
  }
});

// ─── reaching a finished agent ─────────────────────────────────────────────

test('a finished agent resumes from the directory its transcript names', () => {
  const r = openCommand({
    id: 'ebd17fde', sessionId: SESSION, attach: false,
    transcript: '/home/u/.claude/projects/-home-u-proj/x.jsonl', cwd: '/home/u/proj',
  });
  assert.equal(r.ok, true, `resuming was refused: ${r.error}`);
  assert.equal(r.mode, 'resume');
  assert.equal(r.command, `claude --resume ${SESSION}`);
  assert.equal(r.cwd, '/home/u/proj', 'the resume lost the directory the session was recorded in');
});

test('a finished agent that left no transcript reports that, rather than opening onto nothing', () => {
  const r = openCommand({ id: 'ebd17fde', sessionId: SESSION, attach: false, transcript: '' });
  assert.equal(r.ok, false);
  assert.match(r.error, /without leaving a transcript/);
});

test('a malformed session id is refused', () => {
  for (const sessionId of ['', 'short', 'x'.repeat(15), 'zz-not-a-session']) {
    const r = openCommand({ id: 'ebd17fde', sessionId, attach: false, transcript: '/tmp/x.jsonl' });
    assert.equal(r.ok, false, `${JSON.stringify(sessionId)} was accepted as a session`);
  }
});

test('naming neither an agent nor a session selects nothing', () => {
  assert.equal(openCommand({}).ok, false);
  assert.match(openCommand({}).error, /no agent selected/);
});
