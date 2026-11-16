'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const ACP = path.join(ROOT, 'test', 'e2e', 'fixtures', 'fake-acp-agent.js');
const CODEX = path.join(ROOT, 'test', 'e2e', 'fixtures', 'fake-codex-app-server.js');

function bin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-smoke-'));
  const shim = (name, body) => fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  shim('gemini', `exec "${process.execPath}" "${ACP}" "$@"`);
  shim('codex', `exec "${process.execPath}" "${CODEX}" "$@"`);
  shim('copilot', 'exec sleep 30');
  shim('kiro-cli', 'echo "error: unknown command acp" >&2; exit 1');
  return dir;
}

function run(dir, clis) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'handshake-smoke.js'), ...clis], {
    encoding: 'utf8', env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, HUSK_SMOKE_MS: '1500' },
  });
}

test('the handshake smoke passes CLIs that answer', { skip: process.platform === 'win32' }, () => {
  const r = run(bin(), ['gemini', 'codex']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PASS gemini/);
  assert.match(r.stdout, /PASS codex/);
});

test('the handshake smoke fails loudly on a silent or refusing CLI', { skip: process.platform === 'win32' }, () => {
  const r = run(bin(), ['copilot', 'kiro-cli', 'gemini']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL copilot: no answer within 1500ms/);
  assert.match(r.stdout, /FAIL kiro-cli: exited with 1 before answering\n {2}stderr: error: unknown command acp/);
  assert.match(r.stdout, /PASS gemini/);
  assert.match(r.stderr, /2 chat handshake\(s\) broken/);
});
