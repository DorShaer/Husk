'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseLooseMcpJson, shapeEntry, sanitizeId } = require('../../src/lib/mcp-json');

// ─── parseLooseMcpJson ─────────────────────────────────────────────────────

test('parses a standard { mcpServers: { ... } } wrapper', () => {
  const text = JSON.stringify({ mcpServers: { 'a': { command: 'node', args: ['x.js'] } } });
  const res = parseLooseMcpJson(text);
  assert.equal(res.ok, true);
  assert.equal(res.entries.length, 1);
  assert.equal(res.entries[0].id, 'a');
  assert.equal(res.entries[0].entry.command, 'node');
});

test('parses VS Code style { servers: { ... } } wrapper', () => {
  const text = JSON.stringify({ servers: { 'svc': { type: 'http', url: 'https://example.com/mcp' } } });
  const res = parseLooseMcpJson(text);
  assert.equal(res.ok, true);
  assert.equal(res.entries[0].id, 'svc');
  assert.equal(res.entries[0].entry.url, 'https://example.com/mcp');
});

test('parses single-server wrapper without mcpServers key', () => {
  const text = '{ "my-server": { "command": "node", "args": ["a.js"] } }';
  const res = parseLooseMcpJson(text);
  assert.equal(res.ok, true);
  assert.equal(res.entries.length, 1);
  assert.equal(res.entries[0].id, 'my-server');
});

test('parses a multi-server wrapper and returns ALL entries', () => {
  const text = JSON.stringify({
    'one': { command: 'node', args: ['1.js'] },
    'two': { command: 'node', args: ['2.js'] },
    'three': { type: 'http', url: 'https://example.com/mcp' },
  });
  const res = parseLooseMcpJson(text);
  assert.equal(res.ok, true);
  assert.equal(res.entries.length, 3);
  assert.deepEqual(res.entries.map((e) => e.id).sort(), ['one', 'three', 'two']);
});

test('parses multi-server inside mcpServers wrapper', () => {
  const text = JSON.stringify({
    mcpServers: {
      'a': { command: 'node', args: ['a'] },
      'b': { command: 'node', args: ['b'] },
    },
  });
  const res = parseLooseMcpJson(text);
  assert.equal(res.entries.length, 2);
});

test('parses bare entry (just the inner object) with id=""', () => {
  const text = '{ "command": "node", "args": ["x.js"] }';
  const res = parseLooseMcpJson(text);
  assert.equal(res.ok, true);
  assert.equal(res.entries.length, 1);
  assert.equal(res.entries[0].id, '');
  assert.equal(res.entries[0].entry.command, 'node');
});

test('parses an indented snippet copied from the middle of a JSON file', () => {
  // Exactly the shape the user described: mid-JSON copy, leading and
  // trailing commas, indented.
  const text = `
      "my-server": {
        "command": "node",
        "args": ["/abs/path.js"]
      },
  `;
  const res = parseLooseMcpJson(text);
  assert.equal(res.ok, true);
  assert.equal(res.entries[0].id, 'my-server');
  assert.equal(res.entries[0].entry.command, 'node');
});

test('parses an entry with a trailing comma inside an otherwise valid object', () => {
  const text = '{ "a": { "command": "node", "args": ["x"], } }';
  const res = parseLooseMcpJson(text);
  assert.equal(res.ok, true);
  assert.equal(res.entries[0].id, 'a');
});

test('parses two entries pasted as siblings, comma-joined', () => {
  const text = `
    "one": { "command": "node", "args": ["1"] },
    "two": { "command": "node", "args": ["2"] }
  `;
  const res = parseLooseMcpJson(text);
  assert.equal(res.ok, true);
  assert.equal(res.entries.length, 2);
});

test('parses JSON array of bare entries', () => {
  const text = JSON.stringify([
    { command: 'node', args: ['a'] },
    { command: 'node', args: ['b'] },
  ]);
  const res = parseLooseMcpJson(text);
  assert.equal(res.ok, true);
  assert.equal(res.entries.length, 2);
  assert.equal(res.entries[0].id, '');
});

test('empty input returns ok:false', () => {
  assert.equal(parseLooseMcpJson('').ok, false);
  assert.equal(parseLooseMcpJson('   ').ok, false);
  assert.equal(parseLooseMcpJson(null).ok, false);
});

test('truly malformed input returns ok:false with an error message', () => {
  const res = parseLooseMcpJson('not json at all { } ] [');
  assert.equal(res.ok, false);
  assert.ok(res.error);
});

test('top-level object with no MCP-shaped values returns ok:false', () => {
  const res = parseLooseMcpJson(JSON.stringify({ a: 1, b: 'two' }));
  assert.equal(res.ok, false);
});

// ─── shapeEntry ────────────────────────────────────────────────────────────

test('shapeEntry: stdio entry produces the canonical payload', () => {
  const res = shapeEntry('my-svr', { command: 'node', args: ['x.js'], env: { K: 'v' } });
  assert.equal(res.ok, true);
  assert.equal(res.payload.id, 'my-svr');
  assert.equal(res.payload.transport, 'stdio');
  assert.equal(res.payload.command, 'node');
  assert.deepEqual(res.payload.args, ['x.js']);
  assert.deepEqual(res.payload.env, { K: 'v' });
});

test('shapeEntry: http entry produces the canonical payload', () => {
  const res = shapeEntry('h', { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } });
  assert.equal(res.ok, true);
  assert.equal(res.payload.transport, 'http');
  assert.equal(res.payload.url, 'https://example.com/mcp');
  assert.deepEqual(res.payload.headers, { Authorization: 'Bearer x' });
});

test('shapeEntry: sse type is preserved', () => {
  const res = shapeEntry('s', { type: 'sse', url: 'https://example.com/sse' });
  assert.equal(res.payload.transport, 'sse');
});

test('shapeEntry: stdio entry without command is rejected', () => {
  const res = shapeEntry('x', { args: ['a'] });
  assert.equal(res.ok, false);
});

test('shapeEntry: remote entry without url is rejected', () => {
  const res = shapeEntry('x', { type: 'http' });
  assert.equal(res.ok, false);
});

test('shapeEntry: env / headers / args are omitted from payload when empty', () => {
  const res = shapeEntry('quiet', { command: 'node', args: [] });
  assert.equal(res.payload.env, undefined);
  assert.deepEqual(res.payload.args, []);
});

test('shapeEntry: args entries are coerced to strings', () => {
  const res = shapeEntry('x', { command: 'node', args: ['x', 42, true] });
  assert.deepEqual(res.payload.args, ['x', '42', 'true']);
});

// ─── sanitizeId ────────────────────────────────────────────────────────────

test('sanitizeId: keeps allowed characters, replaces others with -', () => {
  assert.equal(sanitizeId('my server!'), 'my-server');
  assert.equal(sanitizeId('   abc 123 ___ '), 'abc-123-___');
  assert.equal(sanitizeId('a/b/c'), 'a-b-c');
});

test('sanitizeId: empty / null becomes empty string', () => {
  assert.equal(sanitizeId(''), '');
  assert.equal(sanitizeId(null), '');
  assert.equal(sanitizeId(undefined), '');
});
