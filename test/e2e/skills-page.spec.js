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
  // Backdated well past the recency window: this stands for a library that has
  // been there a while, so only what a test installs itself counts as new.
  const SETTLED = Date.now() - 40 * 864e5;
  const mk = (name, description) => {
    const dir = path.join(skillsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    // A body, not just frontmatter: injecting strips the frontmatter, and a
    // skill with nothing under it is a no-op by design.
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nSteps for ${name}.\n`);
    fs.utimesSync(dir, new Date(SETTLED), new Date(SETTLED));
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
  // Below a 720px panel the rail lies down and the description column drops,
  // so the size is set here rather than inherited from the runner.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1500, height: 1000 });
  });
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
// Husk seeds its bundled skills into a fresh home on first launch, so those
// are legitimately new. Backdating them after the fact gives a settled library
// to test against.
async function settleLibrary(win, env) {
  const dir = path.join(env.homeDir, '.claude', 'skills');
  const when = new Date(Date.now() - 40 * 864e5);
  for (const d of fs.readdirSync(dir)) {
    try { fs.utimesSync(path.join(dir, d), when, when); } catch (_) { /* raced with a write */ }
  }
  await win.click('#btn-skills-refresh');
  await win.waitForTimeout(400);
}
const pickSource = async (win, key) => {
  await win.locator(`.sk-source[data-source-key="${key}"]`).click();
  await win.waitForTimeout(220);
};

test('a folder earns its own source only once enough skills share it', async () => {
  test.setTimeout(90_000);
  const env = boot();
  const app = await launch(env);
  try {
    const win = await openSkills(app);
    await settleLibrary(win, env);
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

test('the switch is the product switch, in both themes', async () => {
  test.setTimeout(120_000);
  for (const theme of ['midnight', 'light']) {
    const env = boot();
    fs.writeFileSync(path.join(env.homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
      firstRunDone: true, skipWelcome: true, agentCommand: 'claude', theme,
    }));
    const app = await launch(env);
    try {
      const win = await openSkills(app);
      // A stylesheet that stops parsing part way leaves a bare <button> here
      // and nothing else fails, so the switch is measured rather than assumed.
      const sw = await win.evaluate(() => {
        const el = document.querySelector('.sk-row .toggle');
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          w: Math.round(r.width), h: Math.round(r.height),
          appearance: cs.appearance, radius: cs.borderRadius,
          onInk: getComputedStyle(document.body).getPropertyValue('--switch-on').trim(),
          on: cs.backgroundColor,
        };
      });
      expect(sw.w).toBe(38);
      expect(sw.h).toBe(22);
      expect(sw.appearance).toBe('none');
      expect(sw.radius).toBe('999px');
      // On means the product's switch ink, not a colour this page invented.
      const probe = await win.evaluate((c) => {
        const d = document.createElement('div');
        d.style.color = c; document.body.appendChild(d);
        const rgb = getComputedStyle(d).color; d.remove(); return rgb;
      }, sw.onInk);
      expect(sw.on).toBe(probe);
    } finally { await app.close(); }
  }
});

test('the restart notice carries the restart it asks for', async () => {
  test.setTimeout(90_000);
  const app = await launch(boot());
  try {
    const win = await openSkills(app);
    await rowFor(win, 'Agents').locator('[data-toggle]').click();
    // The Skills page has no terminal, so a notice telling the reader to
    // restart has to bring the restart with it.
    const action = win.locator('.toast .toast-action', { hasText: 'Restart agent' });
    await expect(action.first()).toBeVisible({ timeout: 10_000 });
    await action.first().click();
    // It lands on the chat with a live session rather than leaving the reader
    // to find the way there.
    await expect.poll(
      () => win.evaluate(() => ({ page: currentPage, tabs: TABS.size })),  // eslint-disable-line no-undef
      { timeout: 15_000 },
    ).toEqual({ page: 'chat', tabs: 1 });
  } finally { await app.close(); }
});

test('recently added skills get their own view, newest first', async () => {
  test.setTimeout(90_000);
  const env = boot();
  const app = await launch(env);
  const skillsDir = path.join(env.homeDir, '.claude', 'skills');
  try {
    const win = await openSkills(app);
    await settleLibrary(win, env);

    const install = (name, at) => {
      const dir = path.join(skillsDir, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Freshly installed.\n---\n\nBody.\n`);
      fs.utimesSync(dir, new Date(at), new Date(at));
    };
    install('older-arrival', Date.now() - 3 * 864e5);
    install('newest-arrival', Date.now() - 60_000);
    await win.click('#btn-skills-refresh');
    await win.waitForTimeout(400);

    const recent = (await sources(win)).find((r) => r.key === '__recent');
    expect(recent, 'the rail offers a recently added view').toBeTruthy();
    expect(recent.n).toBe(2);

    await pickSource(win, '__recent');
    // Newest first, because that ordering is the whole point of the view.
    expect(await rowNames(win)).toEqual(['newest-arrival', 'older-arrival']);
    // The header counts the same set its switch would act on.
    await expect(win.locator('#sk-sub')).toHaveText('2 of 2 enabled');
  } finally { await app.close(); }
});

test('the recent view is absent when nothing is new', async () => {
  test.setTimeout(90_000);
  const env = boot();
  const app = await launch(env);
  try {
    const win = await openSkills(app);
    await settleLibrary(win, env);
    // A rail entry that leads to an empty pane is worse than no entry.
    expect((await sources(win)).map((r) => r.key)).not.toContain('__recent');
  } finally { await app.close(); }
});

test('a skill you already have can be imported from disk', async () => {
  test.setTimeout(90_000);
  const env = boot();
  const app = await launch(env);
  const skillsDir = path.join(env.homeDir, '.claude', 'skills');
  // A skill file sitting somewhere else on disk, as if handed over.
  const inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-inbox-'));
  const src = path.join(inbox, 'handover.md');
  fs.writeFileSync(src, '---\nname: handover\ndescription: Arrived from elsewhere.\n---\n\nBody.\n');
  try {
    const win = await openSkills(app);
    expect(await rowNames(win)).not.toContain('handover');
    // The picker is a native dialog. The contextBridge surface is frozen, so it
    // is stubbed in the main process, which keeps the real IPC path under test.
    await app.evaluate(async ({ dialog }, p) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
    }, src);
    await win.click('#btn-skills-import');
    await expect.poll(
      () => fs.existsSync(path.join(skillsDir, 'handover', 'SKILL.md')),
      { timeout: 10_000 },
    ).toBe(true);
    // It lands in the list, with its description read from the file it came
    // from rather than from the name.
    await expect.poll(() => rowNames(win), { timeout: 10_000 }).toContain('handover');
    await expect(rowFor(win, 'handover').locator('.sk-row-desc')).toHaveText('Arrived from elsewhere.');
    // And it counts as new, which is the whole reason the view exists.
    expect((await sources(win)).map((r) => r.key)).toContain('__recent');
  } finally { await app.close(); }
});
