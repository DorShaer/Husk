'use strict';

// Exercises installer/lib/verify.sh by sourcing it in a real /bin/sh
// and checking its documented contract. Adds static assertions about
// the shape of install.sh and install.ps1 so they keep using the
// verified-download pattern.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const VERIFY_SH = path.join(REPO_ROOT, 'installer', 'lib', 'verify.sh');

function runBash(script) {
  return spawnSync('bash', ['-c', script], { encoding: 'utf8' });
}

function tempFileWith(contents) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'husk-vsh-')), 'data.bin');
  fs.writeFileSync(p, contents);
  return p;
}

test('verify_sha256: returns 0 on a matching hash', () => {
  const tmp = tempFileWith('hello husk');
  const expected = spawnSync('sha256sum', [tmp], { encoding: 'utf8' }).stdout.split(/\s+/)[0];
  const res = runBash(`. "${VERIFY_SH}"; verify_sha256 "${tmp}" "${expected}" && echo PASS || echo FAIL`);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /PASS/);
});

test('verify_sha256: returns non-zero on a mismatched hash', () => {
  const tmp = tempFileWith('hello husk');
  const bogus = '0'.repeat(64);
  const res = runBash(`. "${VERIFY_SH}"; verify_sha256 "${tmp}" "${bogus}" && echo PASS || echo FAIL`);
  assert.match(res.stdout, /FAIL/);
});

test('verify_sha256: refuses an unreadable file', () => {
  const res = runBash(`. "${VERIFY_SH}"; verify_sha256 /no/such/path "${'0'.repeat(64)}" && echo PASS || echo FAIL`);
  assert.match(res.stdout, /FAIL/);
});

test('verify_sha256: refuses missing arguments', () => {
  const res = runBash(`. "${VERIFY_SH}"; verify_sha256 && echo PASS || echo FAIL`);
  assert.match(res.stdout, /FAIL/);
});

test('verify_sha256: a one-byte change makes the hash mismatch', () => {
  const tmp = tempFileWith('hello husk');
  const expected = spawnSync('sha256sum', [tmp], { encoding: 'utf8' }).stdout.split(/\s+/)[0];
  fs.appendFileSync(tmp, 'X');
  const res = runBash(`. "${VERIFY_SH}"; verify_sha256 "${tmp}" "${expected}" && echo PASS || echo FAIL`);
  assert.match(res.stdout, /FAIL/);
});

// ─── Installer-script shape ─────────────────────────────────────────────

test('install.sh: bun installer is downloaded to a temp file before running', () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, 'install.sh'), 'utf8');
  assert.match(text, /download_and_verify[^\n]*BUN_INSTALLER_URL/);
  assert.match(text, /bash\s+"\$installer_tmp"/);
});

test('install.sh: sources installer/lib/verify.sh', () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, 'install.sh'), 'utf8');
  assert.match(text, /installer\/lib\/verify\.sh/);
});

test('install.sh: pins BUN_INSTALLER_SHA256 to a 64-hex value', () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, 'install.sh'), 'utf8');
  const m = text.match(/BUN_INSTALLER_SHA256="([0-9a-f]{64})"/);
  assert.ok(m, 'expected BUN_INSTALLER_SHA256="<64-hex>" in install.sh');
});

test('install.ps1: bun installer is downloaded to a temp file before running', () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, 'install.ps1'), 'utf8');
  assert.match(text, /Get-VerifiedDownload[^\n]*BunInstallerUrl/);
  assert.match(text, /-File\s+\$installerTmp/);
});

test('install.ps1: sources installer/lib/verify.ps1', () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, 'install.ps1'), 'utf8');
  assert.match(text, /installer\/lib\/verify\.ps1/);
});

test('install.ps1: pins BunInstallerSha256 to a 64-hex value', () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, 'install.ps1'), 'utf8');
  const m = text.match(/BunInstallerSha256\s*=\s*'([0-9a-f]{64})'/);
  assert.ok(m, "expected $Script:BunInstallerSha256 = '<64-hex>' in install.ps1");
});
