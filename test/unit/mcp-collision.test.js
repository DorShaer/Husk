'use strict';

// Installing an MCP server over an id that already exists.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-mcp-collision-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const SharedMcp = require('../../src/lib/mcp/shared');

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(home, rel), 'utf8'));
}

// The server already installed.
const TRUSTED = {
  id: 'filesystem',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/u/safe'],
  env: { TOKEN: 'user-secret' },
};

// A second snippet reusing the same name and pointing somewhere else.
const COLLIDING = {
  id: 'filesystem',
  transport: 'stdio',
  command: 'node',
  args: ['/tmp/other-server.js'],
  env: {},
};

test('installing over an existing id is refused, and the trusted server survives intact', () => {
  assert.equal(SharedMcp.add(TRUSTED).ok, true, 'the fixture server did not install');

  const r = SharedMcp.add(COLLIDING);

  assert.equal(r.ok, false, 'a colliding install reported success');
  assert.match(r.error, /already exists/, `unexpected error: ${r.error}`);

  // Every vendor config still holds the user's own server, byte for byte.
  for (const rel of ['.claude.json', '.copilot/mcp-config.json', '.gemini/settings.json']) {
    const server = readJson(rel).mcpServers.filesystem;
    assert.equal(server.command, 'npx', `${rel} was overwritten`);
    assert.deepEqual(server.args, TRUSTED.args, `${rel} lost its argument scoping`);
    assert.equal(server.env.TOKEN, 'user-secret', `${rel} lost its token`);
  }
});

test('a colliding entry in a pasted snippet is reported as an error, not as installed', () => {
  const r = SharedMcp.addMany([
    { id: 'filesystem', transport: 'stdio', command: 'node', args: ['/tmp/other-server.js'] },
    { id: 'brand-new', transport: 'stdio', command: 'npx', args: ['-y', 'thing'] },
  ]);

  assert.equal(r.results.filesystem.status, 'error', 'the collision was reported as installed');
  assert.match(r.results.filesystem.error, /already exists/);
  // A collision on one entry does not block an unrelated one.
  assert.equal(r.results['brand-new'].status, 'installed');
  assert.equal(r.installed, 1, 'the installed count included the refused entry');
  assert.equal(readJson('.claude.json').mcpServers.filesystem.command, 'npx',
    'the trusted server was replaced through addMany');
});

test('editing an existing server still works, because an edit names what it is editing', () => {
  const r = SharedMcp.update('filesystem', {
    id: 'filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/u/other'],
    env: { TOKEN: 'user-secret' },
  });
  assert.equal(r.ok, true, `a legitimate edit was refused: ${r.error}`);
  assert.deepEqual(readJson('.claude.json').mcpServers.filesystem.args,
    ['-y', '@modelcontextprotocol/server-filesystem', '/home/u/other']);
});

test('renaming onto an id that already exists is still refused', () => {
  assert.equal(SharedMcp.add({ id: 'other', transport: 'stdio', command: 'npx', args: ['x'] }).ok, true);
  const r = SharedMcp.update('other', { id: 'filesystem', transport: 'stdio', command: 'npx', args: ['x'] });
  assert.equal(r.ok, false, 'a rename collided onto a trusted server');
});
