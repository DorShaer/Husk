'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseAgentMd } = require('../../src/lib/agent-md');

test('parseAgentMd: full frontmatter extracts name and description', () => {
  const text = [
    '---',
    'name: example-agent',
    'description: Example role-specific debugging agent.',
    '---',
    '',
    'Body text here.',
    '',
  ].join('\n');
  const out = parseAgentMd(text);
  assert.equal(out.name, 'example-agent');
  assert.equal(out.description, 'Example role-specific debugging agent.');
  assert.equal(out.body, 'Body text here.');
});

test('parseAgentMd: double-quoted values are unquoted', () => {
  const text = '---\nname: "with spaces"\ndescription: "alpha: beta"\n---\nbody';
  const out = parseAgentMd(text);
  assert.equal(out.name, 'with spaces');
  assert.equal(out.description, 'alpha: beta');
});

test('parseAgentMd: single-quoted values are unquoted', () => {
  const text = "---\nname: 'hello'\ndescription: 'world'\n---\nbody";
  const out = parseAgentMd(text);
  assert.equal(out.name, 'hello');
  assert.equal(out.description, 'world');
});

test('parseAgentMd: no frontmatter returns null fields, full body', () => {
  const text = 'just body, no frontmatter';
  const out = parseAgentMd(text);
  assert.equal(out.name, null);
  assert.equal(out.description, null);
  assert.equal(out.body, 'just body, no frontmatter');
});

test('parseAgentMd: empty input returns null fields', () => {
  const out = parseAgentMd('');
  assert.equal(out.name, null);
  assert.equal(out.description, null);
  assert.equal(out.body, '');
});

test('parseAgentMd: missing name field is null', () => {
  const text = '---\ndescription: only a description\n---\nbody';
  const out = parseAgentMd(text);
  assert.equal(out.name, null);
  assert.equal(out.description, 'only a description');
});

test('parseAgentMd: CRLF line endings are accepted', () => {
  const text = '---\r\nname: crlf\r\ndescription: works\r\n---\r\nbody\r\n';
  const out = parseAgentMd(text);
  assert.equal(out.name, 'crlf');
  assert.equal(out.description, 'works');
  assert.equal(out.body, 'body');
});

test('parseAgentMd: non-string input does not throw', () => {
  const out = parseAgentMd(null);
  assert.equal(out.name, null);
  assert.equal(out.body, '');
});
