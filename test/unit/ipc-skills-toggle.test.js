'use strict';

// Contract checks for the skills:toggle IPC handler. We do not boot
// Electron here; we verify the handler source uses resolveInside for
// every join under HUSK_PROMPTS_DIR and the claude skills dir, and we
// exercise resolveInside on the shapes the handler accepts.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveInside } = require('../../src/lib/path-confine');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

test('resolveInside: a parent-relative item name throws', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-skt-'));
  assert.throws(() => resolveInside(tmp, '../sibling'));
});

test('resolveInside: an absolute item name throws', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-skt-'));
  assert.throws(() => resolveInside(tmp, '/abs/path'));
});

test('resolveInside: a normal item name resolves under root', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-skt-'));
  assert.equal(resolveInside(tmp, 'my-prompt.md'), path.join(tmp, 'my-prompt.md'));
});

test('skills:toggle handler joins both roots via resolveInside', () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, 'src', 'main.js'), 'utf8');
  const m = text.match(/ipcMain\.handle\('skills:toggle'[\s\S]*?\n\}\);/);
  assert.ok(m, 'skills:toggle handler not found');
  const handler = m[0];

  const husk = handler.match(/resolveInside\(HUSK_PROMPTS_DIR/g) || [];
  assert.ok(husk.length >= 2, 'expected resolveInside(HUSK_PROMPTS_DIR, ...) for both oldPath and newPath');

  const claude = handler.match(/resolveInside\(skillsDir/g) || [];
  assert.ok(claude.length >= 2, 'expected resolveInside(skillsDir, ...) for both oldPath and newPath');

  const rawHusk = /path\.join\(HUSK_PROMPTS_DIR,\s*(itemId|newName)\)/.test(handler);
  assert.equal(rawHusk, false, 'skills:toggle still path.joins HUSK_PROMPTS_DIR with itemId/newName');

  const rawClaude = /path\.join\(skillsDir,\s*(itemId|newDirName)\)/.test(handler);
  assert.equal(rawClaude, false, 'skills:toggle still path.joins skillsDir with itemId/newDirName');
});
