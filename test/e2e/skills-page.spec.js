'use strict';

// The library is a sortable table of folded sections, one per source folder,
// filtered three ways at once. These check that a section is named only where
// it earns a name, that the name cell drops the prefix its section repeats
// without losing it for search, that the facet, state and text filters compose
// instead of overriding each other, that sorting orders rows inside their own
// section, that folding survives a repaint, and that the switch is the page's
// only control over a skill.

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

async function openSkills(app, { expand = true } = {}) {
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => typeof setPage === 'function', null, { timeout: 20_000 });
  await win.evaluate(() => setPage('skills'));                // eslint-disable-line no-undef
  await win.waitForSelector('.sk-group-head', { timeout: 15_000 });
  // Sections land folded, so anything asserting on rows opens them first.
  if (expand) {
    await expandAll(win);
    await win.waitForSelector('.sk-row', { timeout: 15_000 });
  }
  return win;
}

async function expandAll(win) {
  for (let i = 0; i < 12; i += 1) {
    const folded = win.locator('.sk-group.is-folded .sk-group-head');
    if (await folded.count() === 0) return;
    await folded.first().click();
    await win.waitForTimeout(140);
  }
}

const col = (win, cls) => win.evaluate(
  (c) => [...document.querySelectorAll(`.sk-row ${c}`)].map((n) => n.textContent.trim()), cls,
);
const rowNames = (win) => win.evaluate(
  () => [...document.querySelectorAll('.sk-row')].map((r) => r.querySelector('.sk-row-label').textContent),
);

const rowFor = (win, name) => win.locator(`.sk-row[data-name="${name}"]`);
const stateOf = (win, name) => win.evaluate(
  (n) => document.querySelector(`.sk-row[data-name="${n}"] .sk-row-state`)?.textContent.trim(), name,
);

test('a section is named only once enough entries share its folder', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app);
    const families = new Set(await win.evaluate(
      () => [...document.querySelectorAll('.sk-group-name')].map((n) => n.textContent),
    ));
    // Five entries share "zed", so it is named. Two share "rare", so they fall
    // back to the library rather than becoming a family of their own.
    expect(families).toContain('zed');
    expect(families).toContain('Library');
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

test('Husk prompts stay on their own page', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app);
    // A prompt is not a skill: nothing auto-loads it, so listing it here would
    // make one row mean two different things.
    expect(await rowNames(win)).not.toContain('explain-this');
    const sources = await win.evaluate(
      () => [...new Set([...document.querySelectorAll('.sk-row')].map((r) => r.dataset.source))],
    );
    expect(sources).toEqual(['claude']);
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

test('the state filter isolates disabled entries', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app);
    await win.locator('[data-state="off"]').click();
    await win.waitForTimeout(250);
    expect(await rowNames(win)).toEqual(['retired']);
    expect(await col(win, '.sk-row-state')).toEqual(['Disabled']);
  } finally { await app.close(); }
});

test('every facet filters, including the standing Library group', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app);
    const keys = await win.evaluate(
      () => [...document.querySelectorAll('.sk-facet')].map((f) => f.dataset.family),
    );
    // Library carries a synthetic key, so it is the one that can fail to
    // survive the trip through the data attribute and silently fall back to
    // All. Each facet is checked, not a representative one.
    expect(keys).toEqual(expect.arrayContaining(['all', '__library', 'zed']));
    for (const key of keys) {
      await win.locator(`.sk-facet[data-family="${key}"]`).click();
      await win.waitForTimeout(200);
      const active = await win.evaluate(
        () => document.querySelector('.sk-facet.is-active')?.dataset.family,
      );
      expect(active).toBe(key);
      const shown = await win.evaluate(
        () => [...document.querySelectorAll('.sk-group-name')].map((n) => n.textContent),
      );
      expect(shown.length).toBe(key === 'all' ? 2 : 1);
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

test('a column header sorts within a section and flips on a second click', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app);
    // Scoped to one section, because rows are ordered inside their own folder
    // rather than across the whole library.
    await win.locator('.sk-facet[data-family="zed"]').click();
    await win.waitForTimeout(220);
    const ascending = await rowNames(win);
    expect(ascending).toEqual([...ascending].sort((a, b) => a.localeCompare(b)));

    await win.locator('.sk-th[data-sort="name"]').click();
    await win.waitForTimeout(220);
    expect(await rowNames(win)).toEqual([...ascending].reverse());
    expect(await win.locator('.sk-th[data-sort="name"].is-desc').count()).toBe(1);

    // Taking over another column starts it ascending rather than inheriting
    // the previous column's direction.
    await win.locator('.sk-facet[data-family="__library"]').click();
    await win.locator('.sk-th[data-sort="state"]').click();
    await win.waitForTimeout(220);
    expect(await win.locator('.sk-th[data-sort="state"].is-sorted').count()).toBe(1);
    expect(await win.locator('.sk-th[data-sort="name"].is-sorted').count()).toBe(0);
    // Order applies inside the section, so the disabled entry sinks to the
    // bottom of the one section that holds it.
    const states = await win.evaluate(
      () => [...document.querySelectorAll('.sk-group[data-family="__library"] .sk-row-state')]
        .map((n) => n.textContent.trim()),
    );
    expect(states[states.length - 1]).toBe('Disabled');
  } finally { await app.close(); }
});

test('the switch enables and disables a skill on disk', async () => {
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
    expect(await stateOf(win, 'Agents')).toBe('Disabled');

    // And back, which is the path that has to keep working once the row has
    // been re-keyed to the renamed directory.
    await rowFor(win, 'Agents').locator('[data-toggle]').click();
    await expect.poll(
      () => fs.existsSync(path.join(skillsDir, 'Agents')),
      { timeout: 10_000 },
    ).toBe(true);
    expect(await stateOf(win, 'Agents')).toBe('Enabled');
  } finally { await app.close(); }
});

test('the switch is the row\'s only control, and it needs no hover', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app);
    const shape = await win.evaluate(() => {
      const rows = [...document.querySelectorAll('.sk-row')];
      return {
        rows: rows.length,
        withSwitch: rows.filter((r) => r.querySelector('[data-toggle]')).length,
        hiddenSwitch: rows.filter(
          (r) => Number(getComputedStyle(r.querySelector('[data-toggle]')).opacity) === 0,
        ).length,
        extraButtons: rows.filter((r) => r.querySelectorAll('button').length > 1).length,
      };
    });
    expect(shape.withSwitch).toBe(shape.rows);
    expect(shape.hiddenSwitch).toBe(0);
    expect(shape.extraButtons).toBe(0);
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
    expect(await stateOf(win, 'Interceptor')).toBe('Enabled');
  } finally { await app.close(); }
});

test('sections land folded and remember what the user opened', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app, { expand: false });
    // The page opens as a short list of named sources, not every skill.
    expect(await win.locator('.sk-row').count()).toBe(0);
    const bands = await win.evaluate(
      () => [...document.querySelectorAll('.sk-group-name')].map((n) => n.textContent),
    );
    expect(bands).toEqual(expect.arrayContaining(['Library', 'zed']));
    // Column headings label nothing while everything is shut.
    expect(await win.locator('.sk-table.is-folded-shut').count()).toBe(1);

    await win.locator('.sk-group[data-family="zed"] .sk-group-head').click();
    await win.waitForTimeout(200);
    expect(await win.locator('.sk-row').count()).toBe(FAMILY.length);
    expect(await win.locator('.sk-table.is-folded-shut').count()).toBe(0);

    // The choice survives a repaint driven by something else entirely.
    await win.locator('[data-state="all"]').click();
    await win.waitForTimeout(200);
    expect(await win.locator('.sk-row').count()).toBe(FAMILY.length);
  } finally { await app.close(); }
});

test('a search opens the sections that match it', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app, { expand: false });
    expect(await win.locator('.sk-row').count()).toBe(0);
    await win.fill('#skills-search', 'ssrf');
    await win.waitForTimeout(300);
    // Having said what they want, the user should not have to open it as well.
    expect(await rowNames(win)).toEqual(['hunt-ssrf']);
  } finally { await app.close(); }
});

test('a section switch flips everything under it in one go', async () => {
  test.setTimeout(120_000);
  const env = boot();
  const app = await launch(env);
  const skillsDir = path.join(env.homeDir, '.claude', 'skills');
  try {
    const win = await openSkills(app, { expand: false });
    const band = win.locator('.sk-group[data-family="zed"]');
    await expect(band.locator('.sk-group-live')).toHaveText(`${FAMILY.length} of ${FAMILY.length} enabled`);
    await band.locator('[data-bulk]').click();
    await expect.poll(
      () => fs.readdirSync(skillsDir).filter((d) => d.startsWith('_disabled_zed-hunt-')).length,
      { timeout: 30_000 },
    ).toBe(FAMILY.length);
    await expect(band.locator('.sk-group-live')).toHaveText(`0 of ${FAMILY.length} enabled`);

    // And back, which has to keep working now every member has been renamed.
    await band.locator('[data-bulk]').click();
    await expect.poll(
      () => fs.readdirSync(skillsDir).filter((d) => d.startsWith('zed-hunt-')).length,
      { timeout: 30_000 },
    ).toBe(FAMILY.length);
    await expect(band.locator('.sk-group-live')).toHaveText(`${FAMILY.length} of ${FAMILY.length} enabled`);
  } finally { await app.close(); }
});

test('a partly enabled section shows neither on nor off', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app, { expand: false });
    // Library holds the one disabled entry, so its section switch sits mixed
    // rather than claiming the whole folder is off.
    const library = win.locator('.sk-group[data-family="__library"] [data-bulk]');
    await expect(library).toHaveClass(/is-mixed/);
    await expect(win.locator('.sk-group[data-family="zed"] [data-bulk]')).not.toHaveClass(/is-mixed/);
    const knob = await win.evaluate(() => {
      const el = document.querySelector('.sk-group[data-family="__library"] [data-bulk]');
      return getComputedStyle(el, '::before').transform;
    });
    // Parked mid-track, not at either end.
    expect(knob).toContain('8');
  } finally { await app.close(); }
});
