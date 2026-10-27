'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createFramer, encodeLine } = require('../../src/lib/jsonrpc-stdio');

test('framer parses one line per message and tolerates split chunks', () => {
  const got = [];
  const f = createFramer((m) => got.push(m));
  f.push('{"a":1}\n{"b"');
  f.push(':2}\n');
  f.push(Buffer.from('{"c":3}\n{"d":4}\n'));
  assert.deepEqual(got, [{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }]);
});

test('framer skips blank lines and reports malformed lines without throwing', () => {
  const got = [];
  const bad = [];
  const f = createFramer((m) => got.push(m), (raw) => bad.push(raw));
  f.push('\n\n{"ok":true}\nnot json here\n   \n');
  assert.deepEqual(got, [{ ok: true }]);
  assert.deepEqual(bad, ['not json here']);
});

test('flush parses a trailing line without a newline', () => {
  const got = [];
  const f = createFramer((m) => got.push(m));
  f.push('{"tail":1}');
  assert.deepEqual(got, []);
  f.flush();
  assert.deepEqual(got, [{ tail: 1 }]);
  f.flush();
  assert.deepEqual(got, [{ tail: 1 }]);
});

test('encodeLine terminates with a newline', () => {
  assert.equal(encodeLine({ x: 1 }), '{"x":1}\n');
});
