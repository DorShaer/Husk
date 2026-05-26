'use strict';

// Tests for src/lib/repo-mcp.js — scanner, env-example parser, spec
// builder, snippet renderers. Each fs-touching test mints a private
// tmpdir; no test ever touches the real home directory.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseEnvExample,
  scanRepoForMcpServers,
  describeServer,
  buildServerSpec,
  renderCodexSnippet,
  renderAiderSnippet,
} = require('../../src/lib/repo-mcp');

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-repomcp-')); });
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

function mkServer(name, opts = {}) {
  const dir = path.join(tmp, 'mcp-servers', name);
  fs.mkdirSync(dir, { recursive: true });
  if (opts.pkg !== null) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(opts.pkg || {
      name, main: 'dist/index.js', scripts: { build: 'tsc', start: 'node dist/index.js' },
    }, null, 2));
  }
  if (opts.distMain) {
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'index.js'), opts.distMain);
  }
  if (opts.env) fs.writeFileSync(path.join(dir, '.env.example'), opts.env);
  return dir;
}

// ─── parseEnvExample ───────────────────────────────────────────────────────

test('parseEnvExample: returns KEY/hint pairs in file order', () => {
  const text = 'TOKEN=your bot token\nCHANNEL=channel id\n';
  const out = parseEnvExample(text);
  assert.deepEqual(out, [
    { key: 'TOKEN', hint: 'your bot token' },
    { key: 'CHANNEL', hint: 'channel id' },
  ]);
});

test('parseEnvExample: skips comments and blank lines', () => {
  const text = [
    '# a comment',
    '',
    'TOKEN=abc',
    '   ',
    '# trailing comment',
    'OTHER=xyz',
  ].join('\n');
  assert.deepEqual(parseEnvExample(text), [
    { key: 'TOKEN', hint: 'abc' },
    { key: 'OTHER', hint: 'xyz' },
  ]);
});

test('parseEnvExample: strips matched outer quotes from the hint', () => {
  assert.deepEqual(parseEnvExample('TOKEN="quoted hint"\nOTHER=\'single\'\n'), [
    { key: 'TOKEN', hint: 'quoted hint' },
    { key: 'OTHER', hint: 'single' },
  ]);
});

test('parseEnvExample: ignores lines without =', () => {
  assert.deepEqual(parseEnvExample('JUST_A_KEY\nOTHER=ok\n'), [
    { key: 'OTHER', hint: 'ok' },
  ]);
});

test('parseEnvExample: rejects keys with invalid characters', () => {
  // Spaces and lowercase-start are tolerated by some tools but we follow
  // the strict dotenv convention to avoid emitting weird env names.
  assert.deepEqual(parseEnvExample('bad key=v\n9LEADING=v\nOK_KEY=v\n'), [
    { key: 'OK_KEY', hint: 'v' },
  ]);
});

test('parseEnvExample: empty / non-string input returns []', () => {
  assert.deepEqual(parseEnvExample(''), []);
  assert.deepEqual(parseEnvExample(undefined), []);
  assert.deepEqual(parseEnvExample(null), []);
});

// ─── scanRepoForMcpServers ─────────────────────────────────────────────────

test('scanRepoForMcpServers: returns empty + hasServersDir=false when no mcp-servers dir', () => {
  const res = scanRepoForMcpServers(tmp);
  assert.equal(res.ok, true);
  assert.equal(res.hasServersDir, false);
  assert.deepEqual(res.servers, []);
});

test('scanRepoForMcpServers: lists each subdir as a server, alphabetically', () => {
  mkServer('zeta');
  mkServer('alpha');
  mkServer('mu');
  const res = scanRepoForMcpServers(tmp);
  assert.equal(res.hasServersDir, true);
  assert.deepEqual(res.servers.map((s) => s.name), ['alpha', 'mu', 'zeta']);
});

test('scanRepoForMcpServers: server without package.json gets installable=false', () => {
  // mkServer creates package.json by default; skip it for this case.
  fs.mkdirSync(path.join(tmp, 'mcp-servers', 'naked'), { recursive: true });
  const res = scanRepoForMcpServers(tmp);
  assert.equal(res.servers[0].pkgFound, false);
  assert.equal(res.servers[0].installable, false);
});

test('scanRepoForMcpServers: server with malformed package.json reports pkgParseError', () => {
  const dir = path.join(tmp, 'mcp-servers', 'broken');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{ not valid json');
  const res = scanRepoForMcpServers(tmp);
  assert.equal(res.servers[0].pkgFound, true);
  assert.ok(res.servers[0].pkgParseError, 'parse error reported');
  assert.equal(res.servers[0].installable, false);
});

test('scanRepoForMcpServers: needsBuild=true when main is missing and build script exists', () => {
  mkServer('needs-build', { pkg: {
    name: 'needs-build', main: 'dist/index.js',
    scripts: { build: 'tsc' },
  } });
  const res = scanRepoForMcpServers(tmp);
  assert.equal(res.servers[0].needsBuild, true);
  assert.equal(res.servers[0].mainExists, false);
});

test('scanRepoForMcpServers: needsBuild=false when main is already present', () => {
  mkServer('prebuilt', {
    pkg: { name: 'prebuilt', main: 'dist/index.js', scripts: { build: 'tsc' } },
    distMain: '// built',
  });
  const res = scanRepoForMcpServers(tmp);
  assert.equal(res.servers[0].mainExists, true);
  assert.equal(res.servers[0].needsBuild, false);
});

test('scanRepoForMcpServers: surfaces description from package.json', () => {
  mkServer('described', { pkg: {
    name: 'described', main: 'dist/index.js', description: 'sends pings',
    scripts: { build: 'tsc' },
  } });
  const res = scanRepoForMcpServers(tmp);
  assert.equal(res.servers[0].description, 'sends pings');
});

test('scanRepoForMcpServers: returns absolute serversDir + relative dir for each', () => {
  mkServer('abc', { distMain: '//' });
  const res = scanRepoForMcpServers(tmp);
  assert.equal(path.isAbsolute(res.serversDir), true);
  assert.equal(path.isAbsolute(res.servers[0].dir), true);
});

test('scanRepoForMcpServers: rejects non-string repoRoot', () => {
  assert.equal(scanRepoForMcpServers(null).ok, false);
  assert.equal(scanRepoForMcpServers('').ok, false);
});

// ─── describeServer envVars wiring ─────────────────────────────────────────

test('describeServer: env-example keys land in envVars[]', () => {
  mkServer('with-env', {
    pkg: { name: 'with-env', main: 'dist/index.js', scripts: { build: 'tsc' } },
    distMain: '//',
    env: 'TOKEN=bot token\nCHANNEL_ID=where to post\n',
  });
  const summary = describeServer(path.join(tmp, 'mcp-servers'), 'with-env');
  assert.deepEqual(summary.envVars.map((e) => e.key), ['TOKEN', 'CHANNEL_ID']);
});

// ─── buildServerSpec ───────────────────────────────────────────────────────

test('ISC-10: buildServerSpec ALWAYS returns command + args separately (no joined string)', () => {
  // This is the regression guard for the joined-command bug. The spec
  // must never lose the structural split between command and args.
  mkServer('alpha', {
    pkg: { name: 'alpha', main: 'dist/index.js', scripts: { build: 'tsc' } },
    distMain: '//',
  });
  const scan = scanRepoForMcpServers(tmp);
  const out = buildServerSpec(scan.servers[0], {});
  assert.equal(out.ok, true);
  assert.equal(typeof out.spec.command, 'string');
  assert.ok(Array.isArray(out.spec.args), 'args must be an array');
  assert.ok(!out.spec.command.includes(' '), 'command must not contain spaces');
});

test('buildServerSpec: { command: "node", args: [<absolute main path>] } shape', () => {
  mkServer('alpha', {
    pkg: { name: 'alpha', main: 'dist/index.js', scripts: { build: 'tsc' } },
    distMain: '//',
  });
  const scan = scanRepoForMcpServers(tmp);
  const out = buildServerSpec(scan.servers[0], {});
  assert.equal(out.spec.command, 'node');
  assert.equal(out.spec.args.length, 1);
  assert.equal(path.isAbsolute(out.spec.args[0]), true);
  assert.equal(out.spec.args[0].endsWith(path.join('alpha', 'dist', 'index.js')), true);
});

test('buildServerSpec: falls back to start script when main is absent', () => {
  mkServer('starty', { pkg: {
    name: 'starty',
    scripts: { start: 'node lib/server.js' },
  } });
  const scan = scanRepoForMcpServers(tmp);
  const out = buildServerSpec(scan.servers[0], {});
  assert.equal(out.ok, true);
  assert.equal(out.spec.command, 'node');
  assert.equal(out.spec.args.length, 1);
  assert.equal(path.isAbsolute(out.spec.args[0]), true);
  assert.equal(out.spec.args[0].endsWith(path.join('starty', 'lib', 'server.js')), true);
});

test('buildServerSpec: refuses a server with no main and no start script', () => {
  mkServer('empty', { pkg: { name: 'empty', scripts: {} } });
  const scan = scanRepoForMcpServers(tmp);
  const out = buildServerSpec(scan.servers[0], {});
  assert.equal(out.ok, false);
});

test('buildServerSpec: pipes declared env-example keys when values are provided', () => {
  mkServer('envious', {
    pkg: { name: 'envious', main: 'dist/index.js', scripts: { build: 'tsc' } },
    distMain: '//',
    env: 'TOKEN=bot token\nCHANNEL_ID=where to post\n',
  });
  const scan = scanRepoForMcpServers(tmp);
  const out = buildServerSpec(scan.servers[0], { TOKEN: 'abc123', CHANNEL_ID: 'C0001' });
  assert.equal(out.ok, true);
  assert.deepEqual(out.spec.env, { TOKEN: 'abc123', CHANNEL_ID: 'C0001' });
});

test('buildServerSpec: ignores env values for keys the server did not declare', () => {
  mkServer('only-token', {
    pkg: { name: 'only-token', main: 'dist/index.js', scripts: { build: 'tsc' } },
    distMain: '//',
    env: 'TOKEN=bot token\n',
  });
  const scan = scanRepoForMcpServers(tmp);
  const out = buildServerSpec(scan.servers[0], { TOKEN: 'abc', NOT_DECLARED: 'leaks?' });
  assert.equal(out.spec.env.TOKEN, 'abc');
  assert.equal(out.spec.env.NOT_DECLARED, undefined);
});

test('buildServerSpec: trims whitespace and matched outer quotes from env values', () => {
  mkServer('q', {
    pkg: { name: 'q', main: 'dist/index.js', scripts: { build: 'tsc' } },
    distMain: '//',
    env: 'TOKEN=hint\n',
  });
  const scan = scanRepoForMcpServers(tmp);
  const out = buildServerSpec(scan.servers[0], { TOKEN: '  "abc"  ' });
  assert.equal(out.spec.env.TOKEN, 'abc');
});

test('buildServerSpec: omits env entirely when no values were supplied', () => {
  mkServer('quiet', {
    pkg: { name: 'quiet', main: 'dist/index.js', scripts: { build: 'tsc' } },
    distMain: '//',
  });
  const scan = scanRepoForMcpServers(tmp);
  const out = buildServerSpec(scan.servers[0], {});
  assert.equal(out.spec.env, undefined);
});

test('buildServerSpec: rejects non-object server input', () => {
  assert.equal(buildServerSpec(null, {}).ok, false);
  assert.equal(buildServerSpec(undefined, {}).ok, false);
});

// ─── renderCodexSnippet ────────────────────────────────────────────────────

test('renderCodexSnippet: emits a TOML [[mcp_servers]] block with name/command/args', () => {
  const out = renderCodexSnippet('my-server', {
    command: 'node', args: ['/abs/path/index.js'],
  });
  assert.match(out, /^\[\[mcp_servers\]\]/);
  assert.match(out, /name = "my-server"/);
  assert.match(out, /command = "node"/);
  assert.match(out, /args = \["\/abs\/path\/index\.js"\]/);
});

test('renderCodexSnippet: emits inline env table when env is non-empty', () => {
  const out = renderCodexSnippet('s', {
    command: 'node', args: ['x'], env: { TOKEN: 'abc', CHANNEL: 'C0001' },
  });
  assert.match(out, /env = \{ TOKEN = "abc", CHANNEL = "C0001" \}/);
});

test('renderCodexSnippet: escapes embedded double quotes and backslashes', () => {
  const out = renderCodexSnippet('s', {
    command: 'node', args: ['a"b', 'c\\d'],
  });
  assert.match(out, /"a\\"b"/);
  assert.match(out, /"c\\\\d"/);
});

// ─── renderAiderSnippet ────────────────────────────────────────────────────

test('renderAiderSnippet: emits a --mcp flag with JSON for the server entry', () => {
  const out = renderAiderSnippet('my-server', {
    command: 'node', args: ['/abs/path.js'],
  });
  assert.match(out, /^--mcp '/);
  // Extract the JSON, must parse and contain command + args
  const m = out.match(/'(\{.*\})'$/);
  assert.ok(m, 'JSON envelope present');
  const obj = JSON.parse(m[1]);
  assert.equal(obj['my-server'].command, 'node');
  assert.deepEqual(obj['my-server'].args, ['/abs/path.js']);
});

test('renderAiderSnippet: includes env object when env is non-empty', () => {
  const out = renderAiderSnippet('s', { command: 'node', args: [], env: { TOKEN: 'abc' } });
  const m = out.match(/'(\{.*\})'$/);
  const obj = JSON.parse(m[1]);
  assert.equal(obj.s.env.TOKEN, 'abc');
});

// ─── Anti-criteria sanity checks ───────────────────────────────────────────

test('ISC-A1: a freshly built spec is structurally always { command: string, args: array }', () => {
  // Loop a handful of shapes through the builder and confirm the
  // structural invariant holds every time. This is the regression
  // guard the user explicitly called out.
  const cases = [
    { pkg: { name: 'a', main: 'dist/i.js', scripts: { build: 'tsc' } }, distMain: '//' },
    { pkg: { name: 'b', scripts: { start: 'node main.js' } } },
    { pkg: { name: 'c', main: 'dist/i.js', scripts: { start: 'node dist/i.js' } }, distMain: '//' },
  ];
  for (const opts of cases) {
    const name = opts.pkg.name;
    mkServer(name, opts);
  }
  const scan = scanRepoForMcpServers(tmp);
  for (const summary of scan.servers) {
    const out = buildServerSpec(summary, {});
    assert.equal(out.ok, true, `spec built for ${summary.name}`);
    assert.equal(typeof out.spec.command, 'string');
    assert.ok(!out.spec.command.includes(' '));
    assert.ok(Array.isArray(out.spec.args));
  }
});
