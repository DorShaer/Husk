'use strict';

// The library is a sortable table filtered three ways at once. These check that
// the family column is derived only where it earns a name, that the name cell
// drops the prefix that column repeats without losing it for search, that the
// facet, state and text filters compose instead of overriding each other, that
// sorting a column reorders the body, and that a row only offers an action
// when nothing else can reach the entry.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// A library shaped like a real one: a family big enough to earn a name, a
// prefix too rare to earn one, plain entries, a disabled entry and prompts.
const FAMILY = ['xss', 'sqli', 'ssrf', 'idor', 'rce'];
const PLAIN = ['Agents', 'Research', 'Interceptor'];

// Send launches the agent when no chat is open, so the fixture ships a stub on
// PATH. It records what actually reaches the agent's stdin, one character at a
// time so nothing sits in a buffer, which is the only way to prove what Husk
// put in the chat.
const STUB = [
  '#!/usr/bin/env bash',
  ': > "$HOME/agent-stdin.log"',
  'while IFS= read -r -N1 ch; do printf %s "$ch" >> "$HOME/agent-stdin.log"; done',
  '',
].join('\n');

function boot() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-skills-'));
  const binDir = path.join(homeDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'claude'), STUB, { mode: 0o755 });
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
  return { homeDir, binDir };
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
      PATH: `${env.binDir}:${process.env.PATH}`,
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

const col = (win, cls) => win.evaluate(
  (c) => [...document.querySelectorAll(`.sk-row ${c}`)].map((n) => n.textContent.trim()), cls,
);
const rowNames = (win) => win.evaluate(
  () => [...document.querySelectorAll('.sk-row')].map((r) => r.querySelector('.sk-row-name > span').textContent),
);

test('the family column names a group only once enough entries share it', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app);
    const families = new Set(await col(win, '.sk-row-family'));
    // Five entries share "zed", so it is named. Two share "rare", so they fall
    // back to the library rather than becoming a family of their own.
    expect(families).toContain('zed');
    expect(families).toContain('Library');
    expect(families).toContain('Husk prompts');
    expect(families).not.toContain('rare');
    expect(await rowNames(win)).toContain('rare-alpha');
  } finally { await app.close(); }
});

test('a row drops the prefix its family column already carries', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app);
    await win.locator('.sk-facet[data-family="zed"]').click();
    await win.waitForTimeout(200);
    expect((await rowNames(win)).sort()).toEqual(FAMILY.map((f) => `hunt-${f}`).sort());
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
    expect(await col(win, '.sk-row-state')).toEqual(['Off']);
    // Every other row hides its switch until hover; a disabled row cannot,
    // because that switch is the only way back.
    const opacity = await win.evaluate(
      () => getComputedStyle(document.querySelector('.sk-row .toggle')).opacity,
    );
    expect(Number(opacity)).toBeGreaterThan(0);
  } finally { await app.close(); }
});

test('every facet filters, including the two standing groups', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app);
    const keys = await win.evaluate(
      () => [...document.querySelectorAll('.sk-facet')].map((f) => f.dataset.family),
    );
    // The standing groups carry synthetic keys, so they are the ones that can
    // fail to survive the trip through the data attribute and silently fall
    // back to All. Each facet is checked, not a representative one.
    expect(keys).toEqual(expect.arrayContaining(['all', '__library', '__prompts', 'zed']));
    for (const key of keys) {
      await win.locator(`.sk-facet[data-family="${key}"]`).click();
      await win.waitForTimeout(200);
      const active = await win.evaluate(
        () => document.querySelector('.sk-facet.is-active')?.dataset.family,
      );
      expect(active).toBe(key);
      const families = new Set(await col(win, '.sk-row-family'));
      expect(families.size).toBe(key === 'all' ? 3 : 1);
    }
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
    expect(await win.locator('.sk-tbody .empty-state').count()).toBe(1);
    await win.locator('[data-state="all"]').click();
    await win.waitForTimeout(250);
    expect(await win.locator('.sk-row').count()).toBe(FAMILY.length);
  } finally { await app.close(); }
});

test('a column header sorts the body and flips on a second click', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app);
    const ascending = await rowNames(win);
    expect(ascending).toEqual([...ascending].sort((a, b) => a.localeCompare(b)));

    await win.locator('.sk-th[data-sort="name"]').click();
    await win.waitForTimeout(220);
    expect(await rowNames(win)).toEqual([...ascending].reverse());
    expect(await win.locator('.sk-th[data-sort="name"].is-desc').count()).toBe(1);

    // Taking over another column starts it ascending rather than inheriting
    // the previous column's direction.
    await win.locator('.sk-th[data-sort="state"]').click();
    await win.waitForTimeout(220);
    expect(await win.locator('.sk-th[data-sort="state"].is-sorted').count()).toBe(1);
    expect(await win.locator('.sk-th[data-sort="name"].is-sorted').count()).toBe(0);
    const states = await col(win, '.sk-row-state');
    expect(states[states.length - 1]).toBe('Off');
  } finally { await app.close(); }
});

// These drive the controls rather than measuring their styles, so a row whose
// handlers are not bound fails here. Each addresses its row by name: the filter
// matches descriptions too, so narrowing the table is not the same as isolating
// a single row.
const rowFor = (win, name) => win.locator(`.sk-row[data-name="${name}"]`);
const stateOf = (win, name) => win.evaluate(
  (n) => document.querySelector(`.sk-row[data-name="${n}"] .sk-row-state`)?.textContent.trim(), name,
);

test('the switch enables and disables a skill on disk', async () => {
  test.setTimeout(90_000);
  const env = boot();
  const app = await launch(env);
  const skillsDir = path.join(env.homeDir, '.claude', 'skills');
  try {
    const win = await openSkills(app);
    const row = rowFor(win, 'Agents');
    await row.hover();
    await row.locator('[data-toggle]').click();
    await expect.poll(
      () => fs.existsSync(path.join(skillsDir, '_disabled_Agents')),
      { timeout: 10_000 },
    ).toBe(true);
    expect(await stateOf(win, 'Agents')).toBe('Off');

    // And back, which is the path that has to keep working once the row has
    // been re-keyed to the renamed directory.
    await row.hover();
    await row.locator('[data-toggle]').click();
    await expect.poll(
      () => fs.existsSync(path.join(skillsDir, 'Agents')),
      { timeout: 10_000 },
    ).toBe(true);
    expect(await stateOf(win, 'Agents')).toBe('');
  } finally { await app.close(); }
});

test('an auto-loaded skill offers no action, because the agent invokes it', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app);
    const row = rowFor(win, 'Research');
    // Auto is the default, so the cell names nothing and the dot carries it.
    expect(await stateOf(win, 'Research')).toBe('');
    // Nothing to press. Availability is the switch; invoking is the agent's
    // call, and a button here would imply otherwise.
    expect(await row.locator('[data-use]').count()).toBe(0);
    expect(await row.locator('[data-toggle]').count()).toBe(1);
    // Every auto row agrees, so this is the rule and not one row's quirk, and
    // none of them spends a word restating the default.
    const strays = await win.evaluate(() => {
      const auto = [...document.querySelectorAll('.sk-row[data-reach="auto"]')];
      return {
        total: auto.length,
        withAction: auto.filter((r) => r.querySelector('[data-use]')).length,
        withWord: auto.filter((r) => r.querySelector('.sk-row-state').textContent.trim()).length,
      };
    });
    expect(strays.total).toBeGreaterThan(1);
    expect(strays.withAction).toBe(0);
    expect(strays.withWord).toBe(0);
    // The exceptions still say which they are.
    expect(await stateOf(win, 'explain-this')).toBe('Manual');
  } finally { await app.close(); }
});

test('Send puts a prompt body in the chat, because nothing else will', async () => {
  test.setTimeout(90_000);
  const env = boot();
  const app = await launch(env);
  const log = path.join(env.homeDir, 'agent-stdin.log');
  try {
    const win = await openSkills(app);
    const row = rowFor(win, 'explain-this');
    await expect(row.locator('[data-use]')).toHaveText('Send');
    expect(await stateOf(win, 'explain-this')).toBe('Manual');
    await row.hover();
    await row.locator('[data-use]').click();
    await expect.poll(
      () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''),
      { timeout: 15_000 },
    ).toContain('Explain the code.');
  } finally { await app.close(); }
});

test('a switched-off entry offers no action at all', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app);
    await win.locator('[data-state="off"]').click();
    await win.waitForTimeout(250);
    expect(await stateOf(win, 'retired')).toBe('Off');
    // Nothing can reach it, so the row does not pretend otherwise.
    expect(await rowFor(win, 'retired').locator('[data-use]').count()).toBe(0);
    expect(await rowFor(win, 'retired').locator('[data-toggle]').count()).toBe(1);
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
    // The row that was clicked is untouched; only the switch may change state.
    expect(await stateOf(win, 'Interceptor')).toBe('');
  } finally { await app.close(); }
});

test('the resting table keeps its per-row controls out of the way', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app);
    // A Manual row is the one that carries both controls, so it is the row
    // that can prove they stay hidden until the pointer arrives.
    const at = async () => win.evaluate(() => {
      const r = document.querySelector('.sk-row[data-reach="manual"]');
      return {
        use: getComputedStyle(r.querySelector('.sk-use')).opacity,
        toggle: getComputedStyle(r.querySelector('.toggle')).opacity,
      };
    });
    const resting = await at();
    expect(Number(resting.use)).toBe(0);
    expect(Number(resting.toggle)).toBe(0);
    await win.locator('.sk-row[data-reach="manual"]').first().hover();
    await win.waitForTimeout(260);
    const hovered = await at();
    expect(Number(hovered.use)).toBe(1);
    expect(Number(hovered.toggle)).toBe(1);
  } finally { await app.close(); }
});
