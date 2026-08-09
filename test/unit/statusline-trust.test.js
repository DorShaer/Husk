'use strict';

// Which statusline script the app may run, pinned by path and content.

const test = require('node:test');
const assert = require('node:assert/strict');

const { decide, REFUSE_CHANGED, REFUSE_APPEARED, REFUSE_MALFORMED } = require('../../src/lib/statusline-trust');

const LIFEOS = '/home/u/.claude/LIFEOS/LIFEOS_StatusLine.sh';
const PAI = '/home/u/.claude/PAI/statusline-command.sh';
const ROOT = '/home/u/.claude/statusline-command.sh';
const CANDIDATES = [LIFEOS, PAI, ROOT];

// A disk, as a map of path to digest. Absent means not a regular file.
function disk(map) {
  return (p) => (Object.prototype.hasOwnProperty.call(map, p) ? map[p] : null);
}

// ─── the machines that already work ────────────────────────────────────────

test('a machine with a script and no pin runs it and records what it ran', () => {
  const v = decide(CANDIDATES, null, disk({ [ROOT]: 'aaa' }));
  assert.equal(v.run, ROOT, 'an existing install stopped working');
  assert.deepEqual(v.pin, { path: ROOT, sha256: 'aaa' });
  assert.equal(v.reason, null);
});

test('a pinned script that has not changed keeps running, and re-pins nothing', () => {
  const v = decide(CANDIDATES, { path: ROOT, sha256: 'aaa' }, disk({ [ROOT]: 'aaa' }));
  assert.equal(v.run, ROOT);
  assert.equal(v.pin, null, 'an unchanged file rewrote the pin every tick');
});

test('the newest layout wins when more than one candidate exists', () => {
  const v = decide(CANDIDATES, null, disk({ [LIFEOS]: 'aaa', [PAI]: 'bbb', [ROOT]: 'ccc' }));
  assert.equal(v.run, LIFEOS);
});

// ─── what must not run ─────────────────────────────────────────────────────

test('a script written onto a machine that had none is refused', () => {
  // Husk looked once and recorded that there was nothing.
  const first = decide(CANDIDATES, null, disk({}));
  assert.equal(first.run, null);
  assert.deepEqual(first.pin, { path: null, sha256: null }, 'absence was not recorded');

  // A script then arrives at the path Husk will execute but never creates.
  const after = decide(CANDIDATES, first.pin, disk({ [ROOT]: 'bbb' }));
  assert.equal(after.run, null, 'a script that appeared out of nowhere was executed');
  assert.equal(after.reason, REFUSE_APPEARED);
  assert.equal(after.pin, null, 'the appearance re-pinned itself as trusted');
});

test('rewriting a trusted script is refused', () => {
  const v = decide(CANDIDATES, { path: ROOT, sha256: 'good' }, disk({ [ROOT]: 'changed' }));
  assert.equal(v.run, null, 'a rewritten script was executed');
  assert.equal(v.reason, REFUSE_CHANGED);
  assert.equal(v.pin, null, 'the changed file promoted itself to trusted');
});

test('shadowing the pinned script with a higher-priority path is refused', () => {
  // The pin names the root-level file, and a second script arrives at the
  // LIFEOS path, which the candidate order prefers. Preference must not
  // outrank identity.
  const v = decide(CANDIDATES, { path: ROOT, sha256: 'good' }, disk({ [LIFEOS]: 'ccc', [ROOT]: 'good' }));
  assert.equal(v.run, null, 'a higher-priority path outranked the pin');
  assert.equal(v.reason, REFUSE_CHANGED);
});

test('reusing the pinned digest at a different path is refused', () => {
  // Same bytes, different location: identity is path AND content, not either.
  const v = decide(CANDIDATES, { path: ROOT, sha256: 'good' }, disk({ [PAI]: 'good' }));
  assert.equal(v.run, null, 'the digest alone was accepted as identity');
  assert.equal(v.reason, REFUSE_CHANGED);
});

test('a refusal never leaves a pin behind, so it cannot launder itself over time', () => {
  let pin = { path: null, sha256: null };
  for (let i = 0; i < 5; i++) {
    const v = decide(CANDIDATES, pin, disk({ [ROOT]: 'bbb' }));
    assert.equal(v.run, null, 'repetition eventually got the file executed');
    if (v.pin) pin = v.pin;
  }
  assert.deepEqual(pin, { path: null, sha256: null }, 'the pin drifted under repetition');
});

// ─── unreadable and malformed ──────────────────────────────────────────────

test('a path that cannot be read is not executed', () => {
  const v = decide(CANDIDATES, null, () => { throw new Error('EACCES'); });
  assert.equal(v.run, null);
});

test('a directory or symlink in place of the script is skipped, not run', () => {
  // The digest reader returns null for anything that is not a regular file,
  // which is what makes a symlink swap a non-event here.
  const v = decide(CANDIDATES, null, disk({ [ROOT]: null }));
  assert.equal(v.run, null);
});

test('a pin that cannot be understood refuses rather than re-trusting the disk', () => {
  // A record Husk cannot read is a third state, and reading it as "never
  // looked" would re-pin to whatever is on disk now, which may be the reason
  // the record is broken.
  for (const bad of ['nonsense', 42, [], true, { path: 5 }, { path: ROOT, sha256: 7 }]) {
    const v = decide(CANDIDATES, bad, disk({ [ROOT]: 'aaa' }));
    assert.equal(v.run, null, `pin ${JSON.stringify(bad)} let a script run`);
    assert.equal(v.reason, REFUSE_MALFORMED, `pin ${JSON.stringify(bad)} took the wrong branch`);
    assert.equal(v.pin, null, `pin ${JSON.stringify(bad)} was overwritten by the disk`);
  }
});

test('the two shapes a real pin takes are both understood', () => {
  const absence = decide(CANDIDATES, { path: null, sha256: null }, disk({}));
  assert.equal(absence.reason, null, 'a recorded absence read as malformed');
  const present = decide(CANDIDATES, { path: ROOT, sha256: 'aaa' }, disk({ [ROOT]: 'aaa' }));
  assert.equal(present.run, ROOT, 'a recorded script read as malformed');
});

test('no candidates at all is not an error', () => {
  const v = decide([], null, disk({}));
  assert.equal(v.run, null);
  assert.deepEqual(v.pin, { path: null, sha256: null });
});
