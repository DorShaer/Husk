#!/usr/bin/env node
'use strict';

// Screenshot harness for the Sessions page.
//
//   node test/tools/sessions-shots.js <outDir> [--theme midnight] [--tag before]
//
// Seeds a believable set of claude transcripts plus a background-agent fleet in
// a throwaway HOME, launches the real app, opens the Sessions page and captures
// its canonical states.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { _electron: electron } = require('playwright');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const argv = process.argv.slice(2);
const OUT_DIR = path.resolve(argv[0] && !argv[0].startsWith('--') ? argv[0] : '.sessions-workspace/latest');
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
};
const THEME = flag('theme', 'midnight');
const TAG = flag('tag', '');
const SCENE = flag('scene', 'all');

const sanitize = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const sid = (n) => `c0ffee00-0000-4dc7-abb3-${String(n).padStart(12, '0')}`;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// A believable week: two live threads with agents under them, a handful from
// today, a few from the last few days, some from two projects.
function seedSessions(now) {
  return [
    { n: 1, title: 'Rebuild the sessions page as a command center', ago: 4 * MIN, size: 412_003, proj: 'husk', phase: 'execute', progress: '6/9', agents: [
      { n: 101, name: 'Extract the reference list grammar', state: 'working', ago: 3 * MIN, detail: 'Reading the reference screenshots', tokens: 48_231 },
      { n: 102, name: 'Audit every session field the list can show', state: 'blocked', ago: 9 * MIN, needs: 'Approval to delete the old row markup', detail: 'Waiting on a decision', tokens: 21_004 },
      { n: 103, name: 'Screenshot both themes', state: 'done', ago: 22 * MIN, detail: 'Captured 8 states', tokens: 9_140 },
    ] },
    { n: 2, title: 'Release workflow keeps publishing empty artifacts', ago: 26 * MIN, size: 188_440, proj: 'husk', phase: 'observe', progress: '2/7', agents: [
      { n: 104, name: 'Diff the last three release runs', state: 'working', ago: 20 * MIN, detail: 'Comparing artifact manifests', tokens: 33_770 },
    ] },
    { n: 3, title: 'Why does the terminal drop the first keystroke after resume', ago: 1 * HOUR + 40 * MIN, size: 96_120, proj: 'husk' },
    { n: 4, title: 'Add an install-path regression gate to CI', ago: 3 * HOUR, size: 260_777, proj: 'husk', phase: 'complete', progress: '9/9' },
    { n: 5, title: 'Port the fuzzy matcher to the prompts page', ago: 5 * HOUR + 12 * MIN, size: 44_310, proj: 'husk' },
    { n: 6, title: 'Sweep the renderer for hardcoded vendor names', ago: 9 * HOUR, size: 731_004, proj: 'husk' },
    { n: 7, title: 'Explain the auth object interpolation syntax', ago: 1 * DAY + 2 * HOUR, size: 18_900, proj: 'notes' },
    { n: 8, title: 'Draft the OpenSearch query for engine stdout', ago: 1 * DAY + 6 * HOUR, size: 63_220, proj: 'notes' },
    { n: 9, title: 'Migrate the theme tokens to color-mix', ago: 2 * DAY + 3 * HOUR, size: 155_600, proj: 'husk' },
    { n: 10, title: 'Investigate the worktree retention registry', ago: 3 * DAY, size: 302_118, proj: 'husk', phase: 'think' },
    { n: 11, title: 'Compare download counts against updater polls', ago: 5 * DAY, size: 27_400, proj: 'notes' },
    { n: 12, title: 'Trim the startup path so first paint lands sooner', ago: 9 * DAY, size: 89_003, proj: 'husk' },
    { n: 13, title: 'Rewrite the onboarding copy for a first run', ago: 14 * DAY, size: 51_770, proj: 'husk' },
    { n: 14, title: 'Map the agent spawn lineage from the transcripts', ago: 21 * DAY, size: 210_540, proj: 'husk' },
  ].map((s) => ({ ...s, at: now - s.ago }));
}

// A transcript the lister will accept: a human turn, an assistant turn, an
// ai-title entry, padded to the requested size so the meta line reads real.
// startedAgo controls how far before the last activity the session opened, which
// is what a PRD is matched against.
function writeSession(homeDir, cwd, s) {
  const dir = path.join(homeDir, '.claude', 'projects', sanitize(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const iso = (ms) => new Date(ms).toISOString();
  const opened = s.at - (s.startedAgo || 40 * MIN);
  const first = { type: 'user', message: { role: 'user', content: s.title }, timestamp: iso(opened), cwd, promptSource: 'typed', origin: { kind: 'human' } };
  // An agent's transcript records the chat that spawned it, which is where the
  // lineage in the list comes from.
  if (s.parent) first.session_id = s.parent;
  const lines = [
    first,
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Reading the relevant files first.' }] }, timestamp: iso(opened + MIN) },
    { type: 'system', subtype: 'ai-title', title: s.title, timestamp: iso(opened + 2 * MIN) },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Done. Verified against the suite.' }] }, timestamp: iso(s.at) },
  ];
  const last = lines.pop();
  // A believable exchange, so the transcript pane shows what a real one shows:
  // turns the user typed, tool calls, and prose back.
  const turns = [
    ['user', 'Can you check why the last release shipped with no assets attached'],
    ['tool', 'Bash', 'gh run list --workflow release.yml --limit 5'],
    ['assistant', 'The last three runs all succeeded, so the upload step is the suspect rather than the build.'],
    ['tool', 'Read', '.github/workflows/release.yml'],
    ['assistant', 'The upload step is guarded by hashFiles on RUNNER_TEMP, which hashFiles cannot see. The guard is always false, so the step is skipped while the job still reports green.'],
    ['user', 'Fix it and add a check that would have caught this'],
    ['tool', 'Edit', '.github/workflows/release.yml'],
    ['assistant', 'Guard replaced with an explicit file test. Added a step that fails the job when the release has zero assets attached.'],
    ['tool', 'Bash', 'gh workflow run release.yml --ref refs/tags/v2.11.0'],
  ];
  const turnAt = (i, n) => opened + 3 * MIN + Math.round(((s.at - opened - 3 * MIN) * i) / Math.max(1, n));
  const buildTurn = (t, at) => {
    if (t[0] === 'user') return { type: 'user', message: { role: 'user', content: t[1] }, timestamp: iso(at), cwd, promptSource: 'typed', origin: { kind: 'human' } };
    if (t[0] === 'tool') {
      return { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', name: t[1], input: { command: t[2], file_path: t[2] } }] }, timestamp: iso(at) };
    }
    return { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: t[1] }] }, timestamp: iso(at) };
  };
  // Grow to the target size with real turns so the size column varies and the
  // transcript tail reads like a conversation, then spread their timestamps
  // across the session's own lifetime so no turn is stamped in the future.
  const head = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  let count = 0;
  let measured = head.length;
  while (measured < s.size) {
    measured += JSON.stringify(buildTurn(turns[count % turns.length], opened)).length + 1;
    count += 1;
  }
  let body = head;
  for (let i = 0; i < count; i++) body += JSON.stringify(buildTurn(turns[i % turns.length], turnAt(i, count))) + '\n';
  body += JSON.stringify(last) + '\n';
  const file = path.join(dir, `${sid(s.n)}.jsonl`);
  fs.writeFileSync(file, body);
  fs.utimesSync(file, new Date(s.at), new Date(s.at));
}

// A PRD gives the row its phase and progress, matched by start time.
function writePrd(homeDir, s) {
  if (!s.phase) return;
  const slug = `task-${s.n}`;
  const dir = path.join(homeDir, '.claude', 'MEMORY', 'WORK', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'PRD.md'),
    `---\ntask: ${s.title}\nphase: ${s.phase}\nprogress: ${s.progress || ''}\nstarted: ${new Date(s.at - 40 * MIN).toISOString()}\n---\n\n# ${s.title}\n\nOne paragraph of body so the detail pane has something to render.\n`);
}

function makeHome({ scene }) {
  const now = Date.now();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-sessions-'));
  const cfgDir = path.join(homeDir, '.config', 'husk');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true,
    agentCommand: scene === 'unsupported' ? 'aider' : 'claude',
    theme: THEME,
  }));
  const cwd = path.join(homeDir, 'code', 'husk');
  fs.mkdirSync(cwd, { recursive: true });
  const notesCwd = path.join(homeDir, 'code', 'notes');
  fs.mkdirSync(notesCwd, { recursive: true });

  const agents = [];
  if (scene === 'allcold') {
    for (let i = 0; i < 4; i++) {
      writeSession(homeDir, cwd, { n: 2000 + i, title: `An old thread number ${i}`, at: now - (40 + i) * DAY, size: 6_000 });
    }
  } else if (scene === 'stress') {
    // Every row the renderer will ever hold, spread over enough projects that
    // the grouping and the reconciler both do real work.
    for (let i = 0; i < 320; i++) {
      const proj = `proj${i % 12}`;
      const dir = path.join(homeDir, 'code', proj);
      fs.mkdirSync(dir, { recursive: true });
      writeSession(homeDir, dir, {
        n: 1000 + i,
        title: `Investigate the failing integration case number ${i} in the pipeline`,
        at: now - (i * 11 * MIN),
        size: 6_000,
      });
    }
  } else if (scene !== 'empty') {
    for (const s of seedSessions(now)) {
      const dir = s.proj === 'notes' ? notesCwd : cwd;
      writeSession(homeDir, dir, s);
      writePrd(homeDir, s);
      for (const a of s.agents || []) {
        // The agent's own transcript, so its row resolves a title and the
        // parent link is recoverable. It opens two minutes before its last
        // activity so no PRD start lands inside the match window and overwrites
        // the agent's own title with its parent's task.
        writeSession(homeDir, dir, {
          n: a.n, title: a.name, at: now - a.ago, size: 12_000,
          startedAgo: 2 * MIN, parent: sid(s.n),
        });
        const shortId = `bg-${a.n}`;
        agents.push({
          kind: 'background', id: shortId, sessionId: sid(a.n),
          name: a.name, cwd: dir, state: a.state, status: a.state,
          startedAt: now - a.ago,
        });
        const jobDir = path.join(homeDir, '.claude', 'jobs', shortId);
        fs.mkdirSync(jobDir, { recursive: true });
        fs.writeFileSync(path.join(jobDir, 'state.json'), JSON.stringify({
          state: a.state,
          detail: a.detail || '',
          needs: a.needs || '',
          tokens: a.tokens || 0,
          updatedAt: now - a.ago,
        }));
      }
    }
  }
  const agentsFile = path.join(homeDir, 'agents.json');
  fs.writeFileSync(agentsFile, JSON.stringify(agents));
  return { homeDir, agentsFile, cwd };
}

function launch(env) {
  const fixtureBin = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-fake-bin-'));
  const shim = path.join(fixtureBin, 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(REPO_ROOT, 'test', 'e2e', 'fixtures', 'fake-claude-agents.js')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: env.homeDir,
      USERPROFILE: env.homeDir,
      PATH: `${fixtureBin}:${process.env.PATH}`,
      FAKE_AGENTS_FILE: env.agentsFile,
      ELECTRON_DISABLE_SANDBOX: '1',
      HUSK_E2E: '1',
    },
    timeout: 40_000,
  });
}

const CONSOLE_ERRORS = [];

async function openSessions(app, { width = 1600, height = 1000 } = {}) {
  const win = await app.firstWindow({ timeout: 30_000 });
  win.on('console', (m) => { if (m.type() === 'error') CONSOLE_ERRORS.push(m.text()); });
  win.on('pageerror', (e) => CONSOLE_ERRORS.push(`pageerror: ${e.message}`));
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, ...size });
  }, { width, height });
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => typeof setPage === 'function', null, { timeout: 20_000 });
  await win.evaluate(() => setPage('sessions'));
  await win.waitForTimeout(1500);
  return win;
}

// Dumps what the renderer resolved, so a missing row or chip can be traced to
// the data rather than guessed at from a screenshot.
async function probe(win) {
  const out = await win.evaluate(() => ({
    sessions: sx.cache.map((s) => ({ id: s.id.slice(-6), title: s.title, mtime: s.mtime })),   // eslint-disable-line no-undef
    agents: [...sx.agents.bySession.values()].map((a) => ({   // eslint-disable-line no-undef
      id: a.id, sid: a.sessionId.slice(-6), parent: (a.parentSessionId || '').slice(-6), state: a.state, running: a.running,
    })),
    byParent: [...sx.agents.byParent.entries()].map(([k, v]) => [k.slice(-6), v.length]),   // eslint-disable-line no-undef
    groups: [...document.querySelectorAll('.sx-group')].map((g) => g.querySelector('.sx-g-name').textContent),
    rows: [...document.querySelectorAll('.sx-row')].length,
    rowH: [...new Set([...document.querySelectorAll('.sx-row')].map((r) => Math.round(r.getBoundingClientRect().height)))],
    carets: [...document.querySelectorAll('.sx-kids-caret')].map((c) => {
      const r = c.getBoundingClientRect();
      const cs = getComputedStyle(c);
      return { hidden: c.hidden, w: Math.round(r.width), h: Math.round(r.height), display: cs.display, vis: cs.visibility };
    }),
    expanded: [...document.querySelectorAll('.sx-row[aria-expanded]')].length,
    detail: (document.querySelector('#sx-d-title') || {}).textContent || '',
    counts: (document.querySelector('#sx-count-n') || {}).textContent || '',
    sub: (document.querySelector('#sessions-sub') || {}).textContent || '',
    // Does the title ever run into the timestamp, and is it clipped on one line
    // when it was specified to wrap to two.
    geom: [...document.querySelectorAll('.sx-row')].slice(0, 8).map((r) => {
      const t = r.querySelector('.sx-title');
      const w = r.querySelector('.sx-time');
      if (!t || !w) return null;
      const tr = t.getBoundingClientRect();
      const wr = w.getBoundingClientRect();
      const cs = getComputedStyle(t);
      return {
        text: t.textContent.slice(0, 28),
        gap: Math.round(wr.left - tr.right),
        titleW: Math.round(tr.width),
        titleH: Math.round(tr.height),
        lineH: Math.round(parseFloat(cs.lineHeight) || 0),
        clamp: cs.webkitLineClamp || '',
        overflow: cs.textOverflow,
        clipped: t.scrollWidth > Math.ceil(tr.width) + 1,
      };
    }).filter(Boolean),
    rosterW: Math.round((document.querySelector('.sx-roster') || document.body).getBoundingClientRect().width),
    detailW: Math.round((document.querySelector('.sx-detail') || document.body).getBoundingClientRect().width),
    // How much of the detail pane the content actually reaches, so its width is
    // judged on ink rather than on the track it was given.
    detailInk: (() => {
      const pane = document.querySelector('#sx-d-full');
      if (!pane) return null;
      const pr = pane.getBoundingClientRect();
      let right = pr.left;
      for (const el of pane.querySelectorAll('*')) {
        if (!el.childNodes.length) continue;
        const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!hasText) continue;
        const r = el.getBoundingClientRect();
        if (r.width && r.right > right) right = r.right;
      }
      return { paneW: Math.round(pr.width), inkW: Math.round(right - pr.left) };
    })(),
  }));
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

async function shoot(win, name) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${TAG ? TAG + '-' : ''}${name}.png`);
  await win.screenshot({ path: file, animations: 'disabled' });
  process.stdout.write(`  shot ${path.basename(file)}\n`);
}

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (SCENE === 'all' || SCENE === 'full') {
    process.stdout.write('scene: full\n');
    const env = makeHome({ scene: 'full' });
    const app = await launch(env);
    try {
      const win = await openSessions(app);
      if (argv.includes('--probe')) await probe(win);
      await shoot(win, `sessions-${THEME}`);
      // Expanded agents under the first chat that has them.
      const chip = await win.$('.sx-row[aria-expanded="false"] .sx-kids-caret');
      if (chip) { await chip.click({ force: true }); await win.waitForTimeout(600); await shoot(win, `sessions-agents-${THEME}`); }
      // Filtered.
      const search = await win.$('#sx-q');
      if (search) { await search.fill('release'); await win.waitForTimeout(500); await shoot(win, `sessions-filter-${THEME}`); await search.fill(''); await win.waitForTimeout(400); }
      // Select mode.
      // Older drawer, keyboard walk and group collapse, before select mode
      // rearranges the list.
      const older = await win.$('#sx-older');
      if (older) {
        await older.click();
        await win.waitForTimeout(400);
        const openedRows = await win.evaluate(() => document.querySelectorAll('.sx-row:not(.is-skel)').length);
        process.stdout.write(`  older open -> ${openedRows} rows\n`);
        await shoot(win, `sessions-older-${THEME}`);
        await older.click();
        await win.waitForTimeout(300);
      }
      await win.evaluate(() => document.getElementById('sx-list').focus());
      for (let i = 0; i < 4; i++) { await win.keyboard.press('ArrowDown'); await win.waitForTimeout(60); }
      await win.keyboard.press('Enter');
      await win.waitForTimeout(400);
      const afterKeys = await win.evaluate(() => ({
        cursor: sx.cursorKey,                                        // eslint-disable-line no-undef
        detail: (document.querySelector('#sx-d-title') || {}).textContent || '',
        activeDesc: document.getElementById('sx-list').getAttribute('aria-activedescendant'),
      }));
      process.stdout.write(`  keyboard -> cursor ${afterKeys.cursor}, pane "${afterKeys.detail}", activedescendant ${afterKeys.activeDesc}\n`);
      await shoot(win, `sessions-keyboard-${THEME}`);

      const kebab = await win.$('#sx-menu-btn');
      if (kebab) {
        await kebab.click();
        await win.waitForTimeout(300);
        const item = await win.$('#sx-menu [data-act="select"]');
        if (item) await item.click();
        await win.waitForTimeout(400);
        // Pick two rows so the bar shows a live count.
        for (const r of (await win.$$('.sx-row:not(.is-child)')).slice(0, 2)) await r.click();
        await win.waitForTimeout(400);
        await shoot(win, `sessions-select-${THEME}`);
      }
    } finally { await app.close().catch(() => {}); }
  }

  if (SCENE === 'all' || SCENE === 'allcold') {
    process.stdout.write('scene: allcold\n');
    const env = makeHome({ scene: 'allcold' });
    const app = await launch(env);
    try {
      const win = await openSessions(app);
      const before = await win.evaluate(() => ({ open: sx.olderOpen, rows: document.querySelectorAll('.sx-row').length })); // eslint-disable-line no-undef
      await win.click('#sx-older');
      await win.waitForTimeout(350);
      const after = await win.evaluate(() => ({ open: sx.olderOpen, rows: document.querySelectorAll('.sx-row').length })); // eslint-disable-line no-undef
      process.stdout.write(`  allcold before -> ${JSON.stringify(before)}\n`);
      process.stdout.write(`  allcold after  -> ${JSON.stringify(after)}\n`);
    } finally { await app.close().catch(() => {}); }
  }

  if (SCENE === 'all' || SCENE === 'narrow') {
    process.stdout.write('scene: narrow\n');
    const env = makeHome({ scene: 'full' });
    const app = await launch(env);
    try {
      const win = await openSessions(app, { width: 900, height: 900 });
      const before = await win.evaluate(() => ({
        detail: document.querySelector('#sx').dataset.detail,
        display: getComputedStyle(document.querySelector('#sx-detail')).display,
      }));
      await win.click('.sx-row');
      await win.waitForTimeout(400);
      const after = await win.evaluate(() => ({
        detail: document.querySelector('#sx').dataset.detail,
        display: getComputedStyle(document.querySelector('#sx-detail')).display,
        back: (() => {
          const b = document.querySelector('#sx-d-back');
          const r = b.getBoundingClientRect();
          return { attrHidden: b.hidden, display: getComputedStyle(b).display, w: Math.round(r.width), h: Math.round(r.height) };
        })(),
      }));
      process.stdout.write(`  narrow before -> ${JSON.stringify(before)}\n`);
      process.stdout.write(`  narrow after  -> ${JSON.stringify(after)}\n`);
      await shoot(win, `sessions-narrow-${THEME}`);
    } finally { await app.close().catch(() => {}); }
  }

  if (SCENE === 'stress') {
    process.stdout.write('scene: stress\n');
    const env = makeHome({ scene: 'stress' });
    const app = await launch(env);
    try {
      const win = await openSessions(app);
      const perf = await win.evaluate(() => {
        const t0 = performance.now();
        for (let i = 0; i < 10; i++) sxPaint();   // eslint-disable-line no-undef
        const repaint = (performance.now() - t0) / 10;
        // Split the paint so the cost lands on a phase rather than a total.
        const bench = (fn, n) => { const a = performance.now(); for (let i = 0; i < n; i++) fn(); return (performance.now() - a) / n; };
        const viewMs = bench(() => sxView(), 10);         // eslint-disable-line no-undef
        const chipsMs = bench(() => sxChipsPaint(), 10);  // eslint-disable-line no-undef
        const v = sxView();                               // eslint-disable-line no-undef
        const keysMs = bench(() => sxKeys(v), 10);        // eslint-disable-line no-undef
        const k = sxKeys(v);                              // eslint-disable-line no-undef
        const reconcileMs = bench(() => sxReconcile(k), 10); // eslint-disable-line no-undef
        const oneSignalMs = bench(() => SV().signal(sx.cache[0], sx.agents), 50); // eslint-disable-line no-undef
        const t1 = performance.now();
        sx.query = 'integration';                 // eslint-disable-line no-undef
        sxPaint();                                // eslint-disable-line no-undef
        const search = performance.now() - t1;
        sx.query = '';                            // eslint-disable-line no-undef
        sxPaint();                                // eslint-disable-line no-undef
        return {
          sessions: sx.cache.length,              // eslint-disable-line no-undef
          domRows: document.querySelectorAll('.sx-row').length,
          nodes: sx.nodes.size,                   // eslint-disable-line no-undef
          steadyRepaintMs: Math.round(repaint * 100) / 100,
          viewMs: Math.round(viewMs * 100) / 100,
          chipsMs: Math.round(chipsMs * 100) / 100,
          keysMs: Math.round(keysMs * 100) / 100,
          reconcileMs: Math.round(reconcileMs * 100) / 100,
          oneBridgeSignalMs: Math.round(oneSignalMs * 1000) / 1000,
          searchRepaintMs: Math.round(search * 100) / 100,
        };
      });
      process.stdout.write(`  perf -> ${JSON.stringify(perf)}\n`);
      await shoot(win, `sessions-stress-${THEME}`);
    } finally { await app.close().catch(() => {}); }
  }

  if (SCENE === 'all' || SCENE === 'unsupported') {
    process.stdout.write('scene: unsupported\n');
    const env = makeHome({ scene: 'unsupported' });
    const app = await launch(env);
    try {
      const win = await openSessions(app);
      // Select mode must not survive a tool that has no session history, which
      // is where the old page stranded its header buttons.
      const stranded = await win.evaluate(() => ({
        picking: sx.picking,   // eslint-disable-line no-undef
        selbar: !document.querySelector('#sx-selbar').hidden,
        chips: [...document.querySelectorAll('#sx-chips .chip')].filter((c) => !c.hidden).length,
        chipRowH: Math.round(document.querySelector('#sx-chips').getBoundingClientRect().height),
      }));
      process.stdout.write(`  unsupported -> ${JSON.stringify(stranded)}\n`);
      await shoot(win, `sessions-unsupported-${THEME}`);
    } finally { await app.close().catch(() => {}); }
  }

  if (SCENE === 'all' || SCENE === 'empty') {
    process.stdout.write('scene: empty\n');
    const env = makeHome({ scene: 'empty' });
    const app = await launch(env);
    try {
      const win = await openSessions(app);
      await shoot(win, `sessions-empty-${THEME}`);
    } finally { await app.close().catch(() => {}); }
  }

  if (CONSOLE_ERRORS.length) {
    process.stdout.write(`\nconsole errors (${CONSOLE_ERRORS.length}):\n`);
    for (const e of CONSOLE_ERRORS.slice(0, 20)) process.stdout.write(`  ${e}\n`);
  } else {
    process.stdout.write('\nno console errors\n');
  }
  process.stdout.write(`done -> ${OUT_DIR}\n`);
}

run().catch((err) => { console.error(err); process.exit(1); });
