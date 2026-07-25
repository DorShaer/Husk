'use strict';

// The library is grouped by the family each name already carries, so these
// check that the grouping forms only where it earns a heading, that the row
// drops the prefix its heading repeats without losing it for search, and that
// the facet, state and text filters compose instead of overriding each other.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// A library shaped like a real one: a family big enough to earn a heading, a
// prefix too rare to earn one, plain entries, a disabled entry and prompts.
const FAMILY = ['xss', 'sqli', 'ssrf', 'idor', 'rce'];
const PLAIN = ['Agents', 'Research', 'Interceptor'];

function boot() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-skills-'));
  const cfgDir = path.join(homeDir, '.config', 'husk');
  const promptsDir = path.join(cfgDir, 'prompts');
  const skillsDir = path.join(homeDir, '.claude', 'skills');
  fs.mkdirSync(promptsDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, agentCommand: 'claude',
  }));
  const mk = (name, description) => {
    const dir = path.join(skillsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n`);
  };
  FAMILY.forEach((f) => mk(`zed-hunt-${f}`, `Hunting skill for ${f}.`));
  PLAIN.forEach((p) => mk(p, `The ${p} skill.`));
  // Two entries share this prefix, one short of a heading of their own.
  mk('rare-alpha', 'A prefix too rare to group.');
  mk('rare-beta', 'A prefix too rare to group.');
  mk('_disabled_retired', 'A skill that is switched off.');
  fs.writeFileSync(path.join(promptsDir, 'explain-this.md'), '---\ndescription: Walks through code.\n---\n');
  return { homeDir };
}

function launch(env) {
  return electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: env.homeDir,
      USERPROFILE: env.homeDir,
      ELECTRON_DISABLE_SANDBOX: '1',
      HUSK_E2E: '1',
    },
    timeout: 30_000,
  });
}

async function openSkills(app) {
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => typeof setPage === 'function', null, { timeout: 20_000 });
  await win.evaluate(() => setPage('skills'));                // eslint-disable-line no-undef
  await win.waitForSelector('.sk-row', { timeout: 15_000 });
  return win;
}

const groupNames = (win) => win.evaluate(
  () => [...document.querySelectorAll('.sk-group-name')].map((n) => n.textContent),
);
const rowNames = (win) => win.evaluate(
  () => [...document.querySelectorAll('.sk-row')].map((r) => r.querySelector('.sk-row-name > span').textContent),
);

test('a family earns a heading only once enough entries share it', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app);
    const groups = await groupNames(win);
    // Five entries share "zed", so it groups. Two share "rare", so they fall
    // back to the library rather than forming a heading of their own.
    expect(groups).toContain('zed');
    expect(groups).toContain('Library');
    expect(groups).toContain('Husk prompts');
    expect(groups).not.toContain('rare');
    const names = await rowNames(win);
    expect(names).toContain('rare-alpha');
  } finally { await app.close(); }
});

test('a grouped row drops the prefix its heading already carries', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app);
    await win.locator('.sk-facet[data-family="zed"]').click();
    await win.waitForTimeout(200);
    const names = await rowNames(win);
    expect(names.sort()).toEqual(FAMILY.map((f) => `hunt-${f}`).sort());
    // The full name survives for the tooltip and for the row's own data.
    const full = await win.evaluate(() => document.querySelector('.sk-row').dataset.name);
    expect(full.startsWith('zed-hunt-')).toBe(true);
  } finally { await app.close(); }
});

test('search still matches the full name after the prefix is hidden', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app);
    await win.fill('#skills-search', 'zed-hunt-ssrf');
    await win.waitForTimeout(300);
    expect(await rowNames(win)).toEqual(['hunt-ssrf']);
  } finally { await app.close(); }
});

test('the state filter isolates disabled entries and keeps their switch usable', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app);
    await win.locator('[data-state="off"]').click();
    await win.waitForTimeout(250);
    expect(await rowNames(win)).toEqual(['retired']);
    // Every other row hides its switch until hover; a disabled row cannot,
    // because that switch is the only way back.
    const opacity = await win.evaluate(
      () => getComputedStyle(document.querySelector('.sk-row .toggle')).opacity,
    );
    expect(Number(opacity)).toBeGreaterThan(0);
    expect(await win.locator('.sk-tag-off').count()).toBe(1);
  } finally { await app.close(); }
});

test('facet and state filters compose rather than replace each other', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app);
    await win.locator('.sk-facet[data-family="zed"]').click();
    await win.locator('[data-state="off"]').click();
    await win.waitForTimeout(250);
    // Nothing in the family is disabled, so the pair yields an empty result
    // instead of the state filter winning and showing the retired entry.
    expect(await win.locator('.sk-row').count()).toBe(0);
    expect(await win.locator('.skills-list .empty-state').count()).toBe(1);
    await win.locator('[data-state="all"]').click();
    await win.waitForTimeout(250);
    expect(await win.locator('.sk-row').count()).toBe(FAMILY.length);
  } finally { await app.close(); }
});

test('the resting list keeps its per-row controls out of the way', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app);
    const first = win.locator('.sk-row').first();
    const at = async () => win.evaluate(() => {
      const r = document.querySelector('.sk-row');
      return {
        use: getComputedStyle(r.querySelector('.sk-use')).opacity,
        toggle: getComputedStyle(r.querySelector('.toggle')).opacity,
      };
    });
    const resting = await at();
    expect(Number(resting.use)).toBe(0);
    expect(Number(resting.toggle)).toBe(0);
    await first.hover();
    await win.waitForTimeout(260);
    const hovered = await at();
    expect(Number(hovered.use)).toBe(1);
    expect(Number(hovered.toggle)).toBe(1);
  } finally { await app.close(); }
});
