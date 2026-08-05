'use strict';

// Editing a prompt. The page could create, run and delete but never change one.
// Editing happens in the reader pane rather than a dialog, so these cover both
// the write path (body on disk, rename moving the file, collision refused,
// disabled staying disabled) and the pane's own edit mode.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function makeEnv(prompts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-prompts-'));
  const home = path.join(root, 'home');
  const dir = path.join(home, '.config', 'husk', 'prompts');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, paiEnabled: false, voice: { enabled: false }, agentCommand: 'claude',
  }));
  for (const [file, body] of Object.entries(prompts)) fs.writeFileSync(path.join(dir, file), body);
  return { root, home, dir };
}

function md(name, description, body) {
  return `---\nname: ${name}\ndescription: "${description}"\n---\n\n${body}\n`;
}

async function openPrompts(env) {
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: env.home, USERPROFILE: env.home, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  await win.waitForTimeout(1800);
  await win.evaluate(() => document.querySelector('.rail-item[data-page="prompts"]').click());
  await win.waitForSelector('.pr-item', { timeout: 10_000 });
  return { app, win };
}

// Husk seeds a starter library on first run, so a test has to pick its own
// prompt rather than trusting whichever one sorts first.
async function select(win, mdPath) {
  await win.evaluate((p) => {
    const row = document.querySelector(`.pr-item[data-md="${p}"]`);
    if (row) row.click();
  }, mdPath);
  await win.waitForTimeout(400);
}

test('editing a prompt writes the new body to its file', async () => {
  const env = makeEnv({ 'triage.md': md('triage', 'Original description', 'Original body text.') });
  const target = path.join(env.dir, 'triage.md');
  const { app, win } = await openPrompts(env);

  await select(win, target);
  await win.click('.pr-edit');
  await win.waitForSelector('.pr-body-edit', { timeout: 10_000 });

  // No dialog opens: the reader itself becomes editable, prefilled from disk
  // with the frontmatter split back out into its own fields.
  await expect(win.locator('#new-prompt-modal')).toBeHidden();
  await expect(win.locator('.pr-detail')).toHaveClass(/is-editing/);
  await expect(win.locator('.pr-eyebrow')).toContainText('Editing');
  expect(await win.inputValue('#pr-edit-name')).toBe('triage');
  expect(await win.inputValue('#pr-edit-desc')).toBe('Original description');
  expect((await win.inputValue('.pr-body-edit')).trim()).toBe('Original body text.');

  await win.fill('.pr-body-edit', 'Rewritten body.');
  await win.fill('#pr-edit-desc', 'Updated description');
  await win.click('.pr-save');
  await win.waitForSelector('.pr-body-edit', { state: 'detached', timeout: 10_000 });
  await win.waitForTimeout(600);

  const written = fs.readFileSync(target, 'utf8');
  expect(written).toContain('description: "Updated description"');
  expect(written).toContain('Rewritten body.');
  expect(written).not.toContain('Original body text.');

  // The pane reflects the edit without needing a manual refresh.
  await expect(win.locator('.pr-detail-desc')).toHaveText('Updated description');
  await expect(win.locator('.pr-body')).toContainText('Rewritten body.');

  await app.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});

test('renaming a prompt moves its file and keeps it selected', async () => {
  const env = makeEnv({ 'triage.md': md('triage', 'Desc', 'Body.') });
  const { app, win } = await openPrompts(env);

  await select(win, path.join(env.dir, 'triage.md'));
  await win.click('.pr-edit');
  await win.waitForSelector('.pr-body-edit', { timeout: 10_000 });
  await win.fill('#pr-edit-name', 'triage-v2');
  await win.click('.pr-save');
  await win.waitForSelector('.pr-body-edit', { state: 'detached', timeout: 10_000 });
  await win.waitForTimeout(600);

  expect(fs.existsSync(path.join(env.dir, 'triage-v2.md'))).toBe(true);
  expect(fs.existsSync(path.join(env.dir, 'triage.md'))).toBe(false);
  expect(fs.readFileSync(path.join(env.dir, 'triage-v2.md'), 'utf8')).toContain('name: triage-v2');
  // The selection follows the rename rather than snapping to another prompt.
  await expect(win.locator('.pr-detail-title')).toHaveText('triage-v2');

  await app.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});

test('renaming onto an existing prompt is refused and nothing moves', async () => {
  const env = makeEnv({
    'triage.md': md('triage', 'Desc', 'Body one.'),
    'review.md': md('review', 'Other', 'Body two.'),
  });
  const { app, win } = await openPrompts(env);

  await select(win, path.join(env.dir, 'triage.md'));
  await win.click('.pr-edit');
  await win.waitForSelector('.pr-body-edit', { timeout: 10_000 });
  await win.fill('#pr-edit-name', 'review');
  await win.click('.pr-save');
  await win.waitForTimeout(800);

  // The pane stays in edit mode on the refusal so the edit is not lost.
  await expect(win.locator('.pr-body-edit')).toBeVisible();
  expect(fs.existsSync(path.join(env.dir, 'triage.md'))).toBe(true);
  expect(fs.readFileSync(path.join(env.dir, 'review.md'), 'utf8')).toContain('Body two.');

  await app.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});

test('editing a disabled prompt leaves it disabled', async () => {
  const env = makeEnv({ 'triage.md.disabled': md('triage', 'Desc', 'Body.') });
  const { app, win } = await openPrompts(env);

  await select(win, path.join(env.dir, 'triage.md.disabled'));
  await win.click('.pr-edit');
  await win.waitForSelector('.pr-body-edit', { timeout: 10_000 });
  await win.fill('.pr-body-edit', 'Edited while off.');
  await win.click('.pr-save');
  await win.waitForSelector('.pr-body-edit', { state: 'detached', timeout: 10_000 });
  await win.waitForTimeout(600);

  // An edit is not a way to switch a prompt back on.
  expect(fs.existsSync(path.join(env.dir, 'triage.md.disabled'))).toBe(true);
  expect(fs.existsSync(path.join(env.dir, 'triage.md'))).toBe(false);
  expect(fs.readFileSync(path.join(env.dir, 'triage.md.disabled'), 'utf8')).toContain('Edited while off.');

  await app.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});

test('Escape leaves edit mode and the file is untouched', async () => {
  const env = makeEnv({ 'triage.md': md('triage', 'Desc', 'Body.') });
  const target = path.join(env.dir, 'triage.md');
  const { app, win } = await openPrompts(env);

  await select(win, target);
  await win.click('.pr-edit');
  await win.waitForSelector('.pr-body-edit', { timeout: 10_000 });
  await win.fill('.pr-body-edit', 'Typed but abandoned.');
  await win.press('.pr-body-edit', 'Escape');
  await win.waitForSelector('.pr-body-edit', { state: 'detached', timeout: 10_000 });

  // Back to reading, with the original still on disk and on screen.
  await expect(win.locator('.pr-detail')).not.toHaveClass(/is-editing/);
  expect(fs.readFileSync(target, 'utf8')).toContain('Body.');
  expect(fs.readFileSync(target, 'utf8')).not.toContain('abandoned');

  await app.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});

test('Ctrl+S saves without reaching for the pointer', async () => {
  const env = makeEnv({ 'triage.md': md('triage', 'Desc', 'Body.') });
  const target = path.join(env.dir, 'triage.md');
  const { app, win } = await openPrompts(env);

  await select(win, target);
  await win.click('.pr-edit');
  await win.waitForSelector('.pr-body-edit', { timeout: 10_000 });
  await win.fill('.pr-body-edit', 'Saved by keyboard.');
  await win.press('.pr-body-edit', 'Control+s');
  await win.waitForSelector('.pr-body-edit', { state: 'detached', timeout: 10_000 });
  await win.waitForTimeout(400);

  expect(fs.readFileSync(target, 'utf8')).toContain('Saved by keyboard.');

  await app.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});

test('New prompt still creates, and does not disturb the open prompt', async () => {
  const env = makeEnv({ 'triage.md': md('triage', 'Desc', 'Body.') });
  const { app, win } = await openPrompts(env);

  await select(win, path.join(env.dir, 'triage.md'));
  await win.click('#btn-prompts-new');
  await win.waitForSelector('#new-prompt-modal:not([hidden])', { timeout: 10_000 });
  await win.fill('#np-name', 'brand-new');
  await win.fill('#np-desc', 'A fresh one');
  await win.fill('#np-content', 'Fresh body.');
  await win.click('#np-create');
  await win.waitForSelector('#new-prompt-modal', { state: 'hidden', timeout: 10_000 });
  await win.waitForTimeout(600);

  expect(fs.existsSync(path.join(env.dir, 'brand-new.md'))).toBe(true);
  expect(fs.readFileSync(path.join(env.dir, 'triage.md'), 'utf8')).toContain('Body.');

  await app.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});
