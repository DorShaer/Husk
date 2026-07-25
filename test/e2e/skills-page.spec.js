'use strict';

// The library is two panes: sources on the left, their skills on the right.
// These check that a source earns its own entry only when enough skills share
// its folder, that a row drops the prefix the rail already carries without
// losing it for search, that the source, state and text filters compose
// instead of overriding each other, and that both switches, per skill and per
// source, land on disk.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// A library shaped like a real one: a family big enough to earn a name, a
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
    // A body, not just frontmatter: injecting strips the frontmatter, and a
    // skill with nothing under it is a no-op by design.
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nSteps for ${name}.\n`);
  };
  FAMILY.forEach((f) => mk(`zed-hunt-${f}`, `Hunting skill for ${f}.`));
  PLAIN.forEach((p) => mk(p, `The ${p} skill.`));
  // Two entries share this prefix, one short of a family of their own.
  mk('rare-alpha', 'A prefix too rare to group.');
  mk('rare-beta', 'A prefix too rare to group.');
  mk('_disabled_retired', 'A skill that is switched off.');
  fs.writeFileSync(path.join(promptsDir, 'explain-this.md'), '---\ndescription: Walks through code.\n---\n\nExplain the code.\n');
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

const rowNames = (win) => win.evaluate(
  () => [...document.querySelectorAll('.sk-row-label')].map((n) => n.textContent),
);
const sources = (win) => win.evaluate(
  () => [...document.querySelectorAll('.sk-source')].map((b) => ({
    key: b.dataset.sourceKey,
    name: b.querySelector('.sk-source-name').textContent,
    n: Number(b.querySelector('.sk-source-n').textContent),
  })),
);
const rowFor = (win, name) => win.locator(`.sk-row[data-name="${name}"]`);
const pickSource = async (win, key) => {
  await win.locator(`.sk-source[data-source-key="${key}"]`).click();
  await win.waitForTimeout(220);
};

test('a folder earns its own source only once enough skills share it', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app);
    const rail = await sources(win);
    const keys = rail.map((r) => r.key);
    // Five entries share "zed", so it gets its own source. Two share "rare",
    // so they stay under Library rather than becoming a source of their own.
    expect(keys).toEqual(['all', '__library', 'zed']);
    expect(rail.find((r) => r.key === 'zed').n).toBe(FAMILY.length);
    expect(rail.find((r) => r.key === 'all').n)
      .toBe(rail.filter((r) => r.key !== 'all').reduce((t, r) => t + r.n, 0));
    expect(await rowNames(win)).toContain('rare-alpha');
  } finally { await app.close(); }
});

test('a row drops the prefix the rail already carries', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app);
    await pickSource(win, 'zed');
    expect((await rowNames(win)).sort()).toEqual(FAMILY.map((f) => `hunt-${f}`).sort());
    expect(await win.locator('#sk-title').textContent()).toBe('zed');
    // The full name survives for the tooltip and for the row's own data.
    const full = await win.evaluate(() => document.querySelector('.sk-row').dataset.name);
    expect(full.startsWith('zed-hunt-')).toBe(true);
  } finally { await app.close(); }
});

test('Husk prompts stay on their own page', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app);
    // A prompt is not a skill: nothing auto-loads it, so listing it here would
    // make one row mean two different things.
    expect(await rowNames(win)).not.toContain('explain-this');
    const srcs = await win.evaluate(
      () => [...new Set([...document.querySelectorAll('.sk-row')].map((r) => r.dataset.source))],
    );
    expect(srcs).toEqual(['claude']);
  } finally { await app.close(); }
});

test('search matches the full name after the prefix is hidden', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app);
    await win.fill('#skills-search', 'zed-hunt-ssrf');
    await win.waitForTimeout(300);
    expect(await rowNames(win)).toEqual(['hunt-ssrf']);
  } finally { await app.close(); }
});

test('the state filter isolates disabled entries', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app);
    await win.locator('.sk-state-btn[data-state="off"]').click();
    await win.waitForTimeout(250);
    expect(await rowNames(win)).toEqual(['retired']);
  } finally { await app.close(); }
});

test('source and state filters compose rather than replace each other', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app);
    await pickSource(win, 'zed');
    await win.locator('.sk-state-btn[data-state="off"]').click();
    await win.waitForTimeout(250);
    // Nothing under zed is disabled, so the pair yields nothing rather than
    // the state filter winning and showing the retired entry.
    expect(await win.locator('.sk-row').count()).toBe(0);
    expect(await win.locator('.sk-empty').count()).toBe(1);
    await win.locator('.sk-state-btn[data-state="all"]').click();
    await win.waitForTimeout(250);
    expect(await win.locator('.sk-row').count()).toBe(FAMILY.length);
  } finally { await app.close(); }
});

test('a skill switch renames it on disk, and back', async () => {
  test.setTimeout(90_000);
  const env = boot();
  const app = await launch(env);
  const skillsDir = path.join(env.homeDir, '.claude', 'skills');
  try {
    const win = await openSkills(app);
    await rowFor(win, 'Agents').locator('[data-toggle]').click();
    await expect.poll(
      () => fs.existsSync(path.join(skillsDir, '_disabled_Agents')),
      { timeout: 10_000 },
    ).toBe(true);
    await expect(rowFor(win, 'Agents')).toHaveClass(/disabled/);

    // And back, which has to keep working once the row has been re-keyed to
    // the renamed directory.
    await rowFor(win, 'Agents').locator('[data-toggle]').click();
    await expect.poll(
      () => fs.existsSync(path.join(skillsDir, 'Agents')),
      { timeout: 10_000 },
    ).toBe(true);
    await expect(rowFor(win, 'Agents')).not.toHaveClass(/disabled/);
  } finally { await app.close(); }
});

test('the header switch flips the whole selected source in one go', async () => {
  test.setTimeout(120_000);
  const env = boot();
  const app = await launch(env);
  const skillsDir = path.join(env.homeDir, '.claude', 'skills');
  try {
    const win = await openSkills(app);
    await pickSource(win, 'zed');
    await expect(win.locator('#sk-sub')).toHaveText(`${FAMILY.length} of ${FAMILY.length} enabled`);
    await win.locator('#sk-bulk').click();
    await expect.poll(
      () => fs.readdirSync(skillsDir).filter((d) => d.startsWith('_disabled_zed-hunt-')).length,
      { timeout: 30_000 },
    ).toBe(FAMILY.length);
    await expect(win.locator('#sk-bulk-label')).toHaveText('All off');

    await win.locator('#sk-bulk').click();
    await expect.poll(
      () => fs.readdirSync(skillsDir).filter((d) => d.startsWith('zed-hunt-')).length,
      { timeout: 30_000 },
    ).toBe(FAMILY.length);
    await expect(win.locator('#sk-bulk-label')).toHaveText('All on');
  } finally { await app.close(); }
});

test('a partly enabled source reads as neither on nor off', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app);
    // Library holds the one disabled entry, so its switch sits mixed rather
    // than claiming the whole source is off.
    await pickSource(win, '__library');
    await expect(win.locator('#sk-bulk')).toHaveClass(/is-mixed/);
    await expect(win.locator('#sk-bulk-label')).toHaveText('Some on');
    await pickSource(win, 'zed');
    await expect(win.locator('#sk-bulk')).not.toHaveClass(/is-mixed/);
    await expect(win.locator('#sk-bulk-label')).toHaveText('All on');
  } finally { await app.close(); }
});

test('clicking a row opens its detail rather than toggling it', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app);
    await rowFor(win, 'Interceptor').locator('.sk-row-desc').click();
    await expect.poll(
      () => win.evaluate(() => document.querySelector('#detail-panel')?.hidden === false),
      { timeout: 10_000 },
    ).toBe(true);
    await expect(rowFor(win, 'Interceptor')).not.toHaveClass(/disabled/);
  } finally { await app.close(); }
});
