'use strict';

// The spawn graph: the agent center drawn along the axis the list cannot show,
// which agent started which. Branches grow from the chat to each agent, and each
// agent carries a heartbeat of its real tool calls. These checks pin the lineage
// read off the transcripts, the layout that follows from it, the heartbeat and
// its source, an agent arriving mid-watch, the camera, and selection shared with
// the list. Each state is photographed for visual review.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SHOT_DIR = path.join(REPO_ROOT, 'test-results', 'agent-canvas');

const sanitize = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const sid = (n) => `c0ffee00-0000-4dc7-abb3-${String(n).padStart(12, '0')}`;
const CHAT_SID = sid(900);

// The chat every agent descends from. The CLI lists chats and agents together,
// telling them apart by kind, so the fixture does too.
const chatRow = (cwd) => ({
  kind: 'interactive', pid: 4242, sessionId: CHAT_SID,
  name: 'Ship the release pipeline', cwd, status: 'busy',
  startedAt: Date.now() - 95 * 60_000,
});

// A fleet with real depth: one root that spawned two children and a grandchild
// still waiting on a human, and a second finished root with one child.
function makeFleet(now, cwd) {
  const mk = (id, n, name, state, startedMin, parent, pid) => ({
    kind: 'background', id, sessionId: sid(n), name, cwd,
    state, status: state, startedAt: now - startedMin * 60_000,
    parent: parent ? sid(parent) : '', ...(pid ? { pid } : {}),
  });
  return [
    mk('root-a', 1, 'Harden the release workflow', 'working', 52, 900, 5001),
    mk('kid-a1', 2, 'Split publish into its own job', 'working', 34, 1, 5002),
    mk('kid-a11', 3, 'Pin every third party action', 'blocked', 21, 2, 5003),
    mk('kid-a2', 4, 'Audit the lockfile', 'done', 40, 1),
    mk('root-b', 5, 'Rebuild the sessions page', 'done', 190, 900),
    mk('kid-b1', 6, 'Write the roster spec', 'done', 174, 5),
    mk('kid-b2', 7, 'Screenshot both themes', 'done', 168, 5),
  ];
}

// The parent is read off the head of the child's own transcript, where the
// forked file still names the session that wrote the first line.
function writeTranscript(homeDir, cwd, a) {
  const dir = path.join(homeDir, '.claude', 'projects', sanitize(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const t = (m) => new Date(Date.now() - m * 60_000).toISOString();
  const lines = [
    { type: 'user', message: { role: 'user', content: `${a.name}. Work autonomously.` }, timestamp: t(45), cwd, session_id: a.parent || a.sessionId },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Reading the workflow files first.' }] }, timestamp: t(40) },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: `${cwd}/.github/workflows/release.yml` } }] }, timestamp: t(12) },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Dry run passes. I need permission to push.' }] }, timestamp: t(2) },
  ];
  fs.writeFileSync(path.join(dir, `${a.sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function writeJob(homeDir, shortId, job) {
  const dir = path.join(homeDir, '.claude', 'jobs', shortId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ updatedAt: Date.now(), ...job }));
}

// A transcript with one tool call per entry of `minutes` (minutes ago), each
// named `${tool} step N`, so the heartbeat has known calls to draw.
function writeToolTranscript(homeDir, cwd, a, minutes, tool) {
  const dir = path.join(homeDir, '.claude', 'projects', sanitize(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const t = (m) => new Date(Date.now() - m * 60_000).toISOString();
  const lines = [{ type: 'user', message: { role: 'user', content: `${a.name}.` }, timestamp: t(50), cwd, session_id: a.parent || a.sessionId }];
  minutes.forEach((m, i) => lines.push({
    type: 'assistant', timestamp: t(m),
    message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id: `t${i}`, name: tool, input: { pattern: `step ${i + 1}` } }] },
  }));
  fs.writeFileSync(path.join(dir, `${a.sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

// The list the fake CLI answers with. `parent` is a fixture-only field, so it is
// dropped before writing: the app must recover lineage from the transcripts.
function publish(agentsFile, fleet, cwd) {
  const rows = fleet.map(({ parent, ...r }) => r);                                    // eslint-disable-line no-unused-vars
  if (cwd) rows.push(chatRow(cwd));
  fs.writeFileSync(agentsFile, JSON.stringify(rows));
}

function makeHome({ theme = 'midnight' } = {}) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-agent-canvas-'));
  const cfgDir = path.join(homeDir, '.config', 'husk');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, agentCommand: 'claude', resumeLastOnLaunch: false, theme,
  }));
  const cwd = path.join(homeDir, 'code', 'husk');
  fs.mkdirSync(cwd, { recursive: true });

  const fleet = makeFleet(Date.now(), cwd);
  for (const a of fleet) writeTranscript(homeDir, cwd, a);
  writeJob(homeDir, 'root-a', { state: 'working', detail: 'Editing .github/workflows/release.yml', intent: 'Harden the release workflow end to end.', tokens: 48231 });
  writeJob(homeDir, 'kid-a1', { state: 'working', detail: 'Rewriting the publish job', tokens: 22110 });
  writeJob(homeDir, 'kid-a11', { state: 'blocked', needs: 'Permission to push the branch', detail: 'Waiting for approval', tokens: 9040 });

  const agentsFile = path.join(homeDir, 'agents.json');
  publish(agentsFile, fleet, cwd);
  return { homeDir, agentsFile, cwd, fleet };
}

// A test that fails mid-flight must not leave its app running: on a starved
// CI runner one leaked window's animations and polls slow every later test
// into their own timeouts. Every launch is recorded and swept after each test.
const launched = [];
function launch(env) {
  const fixtureBin = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-fake-bin-'));
  const shim = path.join(fixtureBin, 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(__dirname, 'fixtures', 'fake-claude-agents.js')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  const app = electron.launch({
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
    timeout: 30_000,
  });
  launched.push(app);
  return app;
}

test.afterEach(async () => {
  for (const p of launched.splice(0)) {
    const app = await Promise.resolve(p).catch(() => null);
    if (app) await app.close().catch(() => {});
  }
});

async function openCenter(app, { width = 1512, height = 950 } = {}) {
  const win = await app.firstWindow({ timeout: 30_000 });
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, ...size });
  }, { width, height });
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => typeof openAgentMap === 'function', null, { timeout: 20_000 });
  await win.evaluate(() => openAgentMap());               // eslint-disable-line no-undef
  // The center opens on live work; these checks are about the whole fleet.
  await win.click('[data-am-filter="all"]');
  await win.waitForSelector('.am-node', { timeout: 20_000 });
  return win;
}

async function shoot(win, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  // Frozen animations: the running nodes ping forever, and a capture taken
  // mid-cycle under software rendering comes back as an unpainted frame.
  await win.screenshot({ path: path.join(SHOT_DIR, name), animations: 'disabled' });
}

// Where each card sits, keyed by agent, so layout can be compared across polls.
const places = (win) => win.$$eval('.am-node', (els) => Object.fromEntries(
  els.map((e) => [e.dataset.amId, e.style.transform]),
));

// The positions the graph computed, which is the thing under test.
const placesOf = (win) => win.evaluate(() => Object.fromEntries(
  agentMap.layout.map((n) => [n.a.id, { x: n.x, y: n.y, depth: n.depth, kids: n.kids }]),   // eslint-disable-line no-undef
));

test('the graph draws the fleet as a spawn tree, live where the work is', async () => {
  const env = makeHome();
  const app = await launch(env);
  const win = await openCenter(app);

  // The graph is what the center opens on.
  await expect(win.locator('[data-am-view="canvas"]')).toHaveClass(/is-active/);
  await expect(win.locator('#am-canvas-pane')).toBeVisible();
  await expect(win.locator('#am-list-pane')).toBeHidden();

  // Seven agents plus the chat that started them, and one edge per parent/child
  // pair: five between agents, two from the chat down to the two it started.
  expect(await win.locator('.am-node').count()).toBe(8);
  await expect(win.locator('.am-node.is-chat')).toHaveCount(1);
  await expect(win.locator('.am-node.is-chat .am-node-label')).toHaveText('Ship the release pipeline');
  expect(await win.locator('.am-edge').count()).toBe(7);

  // Geometry is asserted against the layout the graph computed. A computed
  // transform is read mid-transition and reports where a row is passing
  // through, not where the layout put it.
  const at = await placesOf(win);
  const chat = at[`chat:${CHAT_SID}`];

  // The chat sits left of everything it started, every agent has a row of its
  // own in reading order, and a generation indents under the one above it.
  for (const [id, p] of Object.entries(at)) if (id !== `chat:${CHAT_SID}`) expect(p.x).toBeGreaterThan(chat.x);
  expect(at['root-a'].x).toBe(at['root-b'].x);
  expect(at['kid-a1'].x).toBeGreaterThan(at['root-a'].x);
  expect(at['kid-a11'].x).toBeGreaterThan(at['kid-a1'].x);
  expect(at['kid-a1'].y).toBeGreaterThan(at['root-a'].y);
  expect(at['kid-a11'].y).toBeGreaterThan(at['kid-a1'].y);
  const ys = Object.entries(at).filter(([id]) => id !== `chat:${CHAT_SID}`).map(([, p]) => p.y);
  expect(new Set(ys).size).toBe(ys.length);

  // A branch is live while work runs at or under its tip: root-a, its working
  // child, and the grandchild waiting on a human. The finished ones are not.
  const live = await win.$$eval('.am-edge.is-live', (els) => els.length);
  expect(live).toBe(3);
  // Packets travel only the branches of agents working right now.
  await expect(win.locator('.am-flow')).toHaveCount(2);

  // State language matches the list. The counts are about agents, so the chat
  // holding them is excluded.
  await expect(win.locator('.am-node:not(.is-holder).is-blocked')).toHaveCount(1);
  await expect(win.locator('.am-node:not(.is-holder).is-running')).toHaveCount(2);
  await expect(win.locator('.am-node:not(.is-holder).is-done')).toHaveCount(4);
  // A chat with work still in it is itself live.
  await expect(win.locator('.am-node.is-chat')).toHaveClass(/is-live/);

  // The source says how much of its fleet is live and how many agents ran under it.
  await expect(win.locator('.am-node.is-chat .am-node-live')).toHaveText('3 live');
  await expect(win.locator('.am-node.is-chat .am-node-count')).toContainText('7 agents');

  // A row names its CLI and the model its transcript reports, then its clock.
  await expect(win.locator('.am-node[data-am-id="root-a"] .am-node-time')).toContainText('claude · opus 5 ·');
  // The one waiting on a human flatlines into a way to answer it.
  await expect(win.locator('.am-node[data-am-id="kid-a11"] .am-node-act')).toBeVisible();
  await expect(win.locator('.am-node[data-am-id="kid-a11"] .am-node-time')).toContainText('Waiting on you');

  await win.waitForTimeout(700);
  await shoot(win, 'graph-dark.png');

  // Layout is a pure function of the fleet: a poll with nothing changed leaves
  // every card exactly where it was.
  const before = await places(win);
  await win.waitForTimeout(2600);
  expect(await places(win)).toEqual(before);

  await app.close();
});

test('an agent spawned while you watch draws itself in', async () => {
  const env = makeHome();
  const app = await launch(env);
  const win = await openCenter(app);
  expect(await win.locator('.am-node').count()).toBe(8);

  // A new sub-agent appears under the one that is running.
  const grown = env.fleet.concat([{
    kind: 'background', id: 'kid-a12', sessionId: sid(8),
    name: 'Verify the pinned digests', cwd: env.cwd,
    state: 'working', status: 'working', startedAt: Date.now(), pid: 5009,
    parent: sid(2),
  }]);
  writeTranscript(env.homeDir, env.cwd, grown[grown.length - 1]);
  publish(env.agentsFile, grown, env.cwd);

  const fresh = win.locator('.am-node[data-am-id="kid-a12"]');
  await expect(fresh).toBeVisible({ timeout: 15_000 });
  // It arrives animated rather than simply being there, and hangs off the agent
  // that started it.
  await expect(fresh).toHaveClass(/is-enter/);
  await shoot(win, 'graph-spawned.png');
  expect(await win.locator('.am-node').count()).toBe(9);
  expect(await win.locator('.am-edge').count()).toBe(8);

  // The newcomer joins its parent's generation, on a row of its own under the
  // sibling that started before it.
  const place = await placesOf(win);
  expect(place['kid-a12'].x).toBe(place['kid-a11'].x);
  expect(place['kid-a12'].y).toBeGreaterThan(place['kid-a11'].y);

  // An agent that leaves the fleet leaves the picture, along with its edge.
  publish(env.agentsFile, grown.filter((a) => a.id !== 'kid-a12' && a.id !== 'kid-b2'), env.cwd);
  await expect(win.locator('.am-node')).toHaveCount(7, { timeout: 15_000 });
  await expect(win.locator('.am-node[data-am-id="kid-a12"]')).toHaveCount(0);
  expect(await win.locator('.am-edge').count()).toBe(6);

  // Arrows walk the tree in reading order, a parent then what it started, and
  // Enter opens whatever they land on.
  await win.locator('#am-cv-nodes').focus();
  const order = await win.evaluate(() => agentMap.view);   // eslint-disable-line no-undef
  // A parent, then everything it started, oldest first. The chat that holds
  // them is scenery and stays out of the walk.
  expect(order).toEqual(['root-b', 'kid-b1', 'root-a', 'kid-a2', 'kid-a1', 'kid-a11']);
  await win.keyboard.press('ArrowUp');
  await expect(win.locator('.am-node.is-selected')).toHaveAttribute('data-am-id', 'kid-a1');
  await win.keyboard.press('ArrowDown');
  await expect(win.locator('.am-node.is-selected')).toHaveAttribute('data-am-id', 'kid-a11');
  await expect(win.locator('#am-d-name')).not.toBeEmpty();
  await win.keyboard.press('Enter');
  await expect(win.locator('#agent-map')).toBeHidden({ timeout: 10_000 });

  await app.close();
});

// The heartbeat is drawn from the tool calls in each agent's own transcript.
// Where there are none it says so instead of drawing a shape.
test('every heartbeat is real tool calls, and an empty one says so', async () => {
  const env = makeHome();
  const now = Date.now();
  const mk = (id, n, name, state, startedMin, extra = {}) => ({
    kind: 'background', id, sessionId: sid(n), name, cwd: env.cwd, state, status: state,
    startedAt: now - startedMin * 60_000, parent: CHAT_SID, ...extra,
  });
  const busy = mk('busy', 60, 'Crawl the staging site', 'working', 50, { pid: 7001 });
  const fresh = mk('fresh', 61, 'Map the routes', 'working', 1, { pid: 7002 });
  const silent = mk('silent', 62, 'Read the logs', 'working', 3, { pid: 7003 });
  const broke = mk('broke', 63, 'Replay the login', 'failed', 30);
  const asks = mk('asks', 64, 'Push the fix', 'blocked', 20, { pid: 7004 });
  const calls = [44, 40, 33, 33, 30, 21, 12, 7, 5, 2];
  writeToolTranscript(env.homeDir, env.cwd, busy, calls, 'Grep');
  writeToolTranscript(env.homeDir, env.cwd, fresh, [], '');
  writeToolTranscript(env.homeDir, env.cwd, broke, [26, 25], 'Bash');
  writeToolTranscript(env.homeDir, env.cwd, asks, [18, 14], 'Edit');
  // `silent` leaves no transcript at all.
  writeJob(env.homeDir, 'broke', { state: 'failed', detail: 'tool error' });
  const fleet = [busy, fresh, silent, broke, asks];
  publish(env.agentsFile, fleet, env.cwd);

  const app = await launch(env);
  const win = await openCenter(app);
  await expect(win.locator('.am-node:not(.is-root)')).toHaveCount(5, { timeout: 20_000 });

  // The source of the line: every tool call in the transcript, by its time.
  const pulse = await win.evaluate(() => agentMap.rows.find((a) => a.id === 'busy').pulse);   // eslint-disable-line no-undef
  expect(pulse.calls.length).toBe(calls.length);
  expect(pulse.model).toBe('claude-opus-5');
  const row = (id) => win.locator(`.am-node[data-am-id="${id}"]`);
  await expect(row('busy').locator('.am-hb-ln')).toHaveCount(1);
  await expect(row('busy').locator('.am-hb-tip')).toHaveCount(1);
  // What it is doing now is its newest activity row.
  await expect(row('busy').locator('.am-node-now')).toHaveText('Grep step 10');

  // No calls yet, and no transcript at all, are both a flat baseline in words.
  await expect(row('fresh').locator('.am-hb.is-empty')).toHaveCount(1);
  await expect(row('fresh').locator('.am-hb-ln')).toHaveCount(0);
  await expect(row('fresh').locator('.am-node-now')).toHaveText('no activity yet');
  await expect(row('silent').locator('.am-hb.is-empty')).toHaveCount(1);
  // Listed as working but silent for minutes: open and quiet, and still.
  await expect(row('silent').locator('.am-node-now')).toHaveText(/^quiet for \d+m$/);
  await expect(row('silent')).toHaveClass(/is-idle/);
  await expect(row('silent').locator('.am-hb-ping')).toHaveCount(0);

  // A failure spikes where its work stopped and says why.
  await expect(row('broke').locator('.am-hb-x')).toHaveCount(1);
  await expect(row('broke').locator('.am-node-now')).toHaveText('Exited: tool error');
  // Waiting on a human says what it waits for in place of a line, then Respond.
  await expect(row('asks').locator('.am-hb')).toBeHidden();
  await expect(row('asks').locator('.am-node-now')).toHaveText('Wants to edit step 2');
  await expect(row('asks').locator('.am-node-act')).toBeVisible();

  // The canvas has one shape and no shape control.
  await expect(win.locator('#am-cv-topo')).toHaveCount(0);
  await win.waitForTimeout(700);
  await shoot(win, 'graph-heartbeat.png');

  await row('asks').locator('.am-node-act').click();
  await expect(win.locator('#agent-map')).toBeHidden({ timeout: 10_000 });
  await app.close();
});

test('the source is drawn whole, on a field that is not empty', async () => {
  const env = makeHome();
  const app = await launch(env);
  const win = await openCenter(app);

  // The plate under a name is a backdrop for words, so it never paints over the
  // tile it belongs to. A plate that covers the source slices it in half.
  // Cards arrive with an entrance that scales them, so a hit test taken while
  // one is still running reads a disc that is not yet where it will be. Under a
  // loaded machine that lands mid-animation, which is what made this flake.
  await win.waitForFunction(() => !document.querySelector('.am-node.is-enter'), null, { timeout: 10_000 });
  await win.waitForTimeout(120);
  const sliced = await win.evaluate(() => {
    const node = document.querySelector('.am-node.is-holder');
    const glyph = node.querySelector('.am-node-glyph');
    const plate = node.querySelector('.am-node-plate');
    const g = glyph.getBoundingClientRect();
    const p = plate.getBoundingClientRect();
    // The middle of the disc is the pixel that tells the truth: whatever is
    // painted there is what a reader sees when they look at the source.
    const hit = document.elementFromPoint(
      Math.round(g.left + g.width / 2), Math.round(g.top + g.height / 2),
    );
    return {
      clear: p.top >= g.bottom - 1,
      onGlyph: !!(hit && hit.closest('.am-node-glyph')),
      tag: hit ? String(hit.className) : '',
    };
  });
  expect(sliced.clear, 'the name plate overlaps the disc it hangs under').toBe(true);
  expect(sliced.onGlyph, `something paints over the source: hit ${sliced.tag}`).toBe(true);

  // One texture on the ground and one only. Layering a second and a third dot
  // lattice over the grid, each at its own pitch, is what made the field read as
  // pattern rather than as ground.
  const ground = await win.evaluate(() => {
    const dust = getComputedStyle(document.querySelector('#am-canvas-pane'), '::before');
    const cs = getComputedStyle(document.querySelector('#am-cv-grid'));
    return {
      dust: dust.backgroundImage,
      opacity: Number(cs.opacity),
      image: cs.backgroundImage,
      mask: cs.maskImage,
    };
  });
  expect(ground.dust, 'the field carries a second texture over the grid').toBe('none');
  // The grid is what makes it read as a canvas, so it is never switched off: a
  // grid the eye cannot find is the same as no grid.
  expect(ground.opacity).toBeGreaterThan(0.5);
  expect(ground.image).toContain('radial-gradient');
  // It runs flat to the edge rather than peaking over empty ground and dying at
  // the frame, which is a vignette drawn on the one part of the field with
  // nothing in it.
  expect(ground.mask, 'the grid is masked into a pool in the middle').toBe('none');

  await app.close();
});

test('the camera frames the fleet and the graph shares its selection', async () => {
  const env = makeHome();
  const app = await launch(env);
  const win = await openCenter(app);

  // Opening frames the whole tree without an interaction.
  await win.waitForFunction(() => {
    const s = document.querySelector('#am-cv-stage');
    return s && /matrix|translate/.test(s.style.transform || '');
  }, null, { timeout: 10_000 });

  const zoomOf = () => win.locator('#am-cv-zoom').textContent();
  const start = await zoomOf();
  await win.click('#am-cv-in');
  expect(await zoomOf()).not.toBe(start);

  // Fit brings the framing back to where it opened.
  await win.click('#am-cv-fit');

  await win.waitForTimeout(450);
  expect(await zoomOf()).toBe(start);

  // A bare wheel is a two finger scroll, so it pans and leaves the scale alone.
  const box = await win.locator('#am-canvas-pane').boundingBox();
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const camOf = () => win.evaluate(() => `${Math.round(agentMap.cam.x)}:${Math.round(agentMap.cam.y)}`);   // eslint-disable-line no-undef
  const beforeWheel = await camOf();
  await win.mouse.wheel(0, 220);
  await win.waitForTimeout(120);
  expect(await camOf(), 'a bare wheel did not pan the field').not.toBe(beforeWheel);
  expect(await zoomOf(), 'a bare wheel changed the scale').toBe(start);

  // A pinch arrives as a wheel with a modifier held, and that is what zooms.
  await win.click('#am-cv-fit');
  await win.waitForTimeout(450);
  await win.keyboard.down('Control');
  await win.mouse.wheel(0, -400);
  await win.waitForTimeout(120);
  const zoomedIn = await zoomOf();
  expect(parseInt(zoomedIn, 10)).toBeGreaterThan(parseInt(start, 10));
  await win.mouse.wheel(0, 800);
  await win.waitForTimeout(120);
  expect(parseInt(await zoomOf(), 10)).toBeLessThan(parseInt(zoomedIn, 10));
  await win.keyboard.up('Control');

  // Full screen grows the card toward the window and keeps the detail pane.
  // Polled rather than paused: the width rides a CSS transition, and a starved
  // renderer can hold a frame past any fixed wait.
  const cardW = async () => (await win.locator('#agent-map .am-card').boundingBox()).width;
  const small = await cardW();
  await win.click('#am-cv-expand');
  // How far it grows depends on how much window the card left unused.
  await expect.poll(cardW, { timeout: 15_000 }).toBeGreaterThan(small + 10);
  await expect(win.locator('#am-detail-pane')).toBeVisible();
  await win.click('#am-cv-expand');
  await expect.poll(async () => Math.abs((await cardW()) - small), { timeout: 15_000 }).toBeLessThan(1);

  await win.click('#am-cv-fit');
  await win.waitForTimeout(450);

  // Panning moves the stage and keeps the selection.
  const pane = await win.locator('#am-canvas-pane').boundingBox();
  const beforePan = await win.locator('#am-cv-stage').getAttribute('style');
  await win.mouse.move(pane.x + 90, pane.y + pane.height - 60);
  await win.mouse.down();
  await win.mouse.move(pane.x + 190, pane.y + pane.height - 30, { steps: 8 });
  await win.mouse.up();
  const panned = await win.locator('#am-cv-stage').getAttribute('style');
  expect(panned).not.toBe(beforePan);

  // A poll must not take the camera back: where the user left the view is where
  // the view stays.
  await win.waitForTimeout(2600);
  expect(await win.locator('#am-cv-stage').getAttribute('style')).toBe(panned);

  // A node fills the same detail pane the list feeds.
  await win.click('.am-node[data-am-id="kid-a11"]');
  await expect(win.locator('.am-node.is-selected')).toHaveCount(1);
  await expect(win.locator('#am-d-name')).toHaveText('Pin every third party action');
  await expect(win.locator('#am-d-state')).toHaveText('Needs you');
  await win.waitForSelector('#am-d-feed li.k-tool', { timeout: 10_000 });
  await shoot(win, 'graph-selected.png');

  // The selection is the center's, not one view's.
  await win.click('[data-am-view="list"]');
  await expect(win.locator('.am-row.is-selected .am-row-name')).toHaveText('Pin every third party action');
  await win.click('[data-am-view="canvas"]');
  await expect(win.locator('.am-node.is-selected')).toHaveAttribute('data-am-id', 'kid-a11');

  // Search narrows the graph the way it narrows the list.
  await win.fill('#am-search-input', 'lockfile');
  await expect(win.locator('.am-node')).toHaveCount(2);
  await win.fill('#am-search-input', 'zzz-nothing');
  await expect(win.locator('#am-blank-t')).toHaveText('No matches');
  await win.fill('#am-search-input', '');
  await expect(win.locator('.am-node')).toHaveCount(8);

  // Filtering to one band leaves that band standing on its own.
  await win.click('[data-am-filter="running"]');
  await expect(win.locator('.am-node')).toHaveCount(3);
  await win.click('[data-am-filter="all"]');

  // Whichever view was left up is the one the center opens on next time.
  await win.click('[data-am-view="list"]');
  await win.keyboard.press('Escape');
  await expect(win.locator('#agent-map')).toBeHidden();
  await win.evaluate(() => openAgentMap());              // eslint-disable-line no-undef
  await win.waitForSelector('.am-row', { timeout: 15_000 });
  await expect(win.locator('[data-am-view="list"]')).toHaveClass(/is-active/);
  await expect(win.locator('#am-canvas-pane')).toBeHidden();

  await app.close();
});

// Opening the center is a question about now, not about history. Live leads,
// and a machine whose agents have all finished says so rather than showing a
// field of ticks.
test('the center opens on live work, with everything else one click away', async () => {
  const env = makeHome();
  const app = await launch(env);
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => typeof openAgentMap === 'function', null, { timeout: 20_000 });
  await win.evaluate(() => openAgentMap());              // eslint-disable-line no-undef

  await expect(win.locator('[data-am-filter="live"]')).toHaveClass(/is-active/);
  // Two running and one waiting on a human, out of seven.
  await expect(win.locator('.am-node')).toHaveCount(4, { timeout: 20_000 });
  await expect(win.locator('#am-n-live')).toHaveText('3');
  await expect(win.locator('#am-n-all')).toHaveText('7');

  await win.click('[data-am-filter="all"]');
  await expect(win.locator('.am-node')).toHaveCount(8);

  // Reopening returns to live rather than remembering the wider view.
  await win.keyboard.press('Escape');
  await win.evaluate(() => openAgentMap());              // eslint-disable-line no-undef
  await expect(win.locator('[data-am-filter="live"]')).toHaveClass(/is-active/);
  await expect(win.locator('.am-node')).toHaveCount(4, { timeout: 20_000 });

  // A fleet that has all finished gets a worded state and a way through to it.
  publish(env.agentsFile, env.fleet.map((a) => ({ ...a, state: 'done', status: 'done' })), env.cwd);
  await expect(win.locator('#am-blank-t')).toHaveText('Nothing running right now', { timeout: 15_000 });
  await expect(win.locator('#am-blank-act')).toHaveText('Show all 7 agents');
  await win.waitForTimeout(600);
  await shoot(win, 'graph-live-empty.png');
  await win.click('#am-blank-act');
  await expect(win.locator('.am-node')).toHaveCount(8);

  // Opened when nothing is live, the center starts on the whole fleet: the
  // graph of what ran, not an empty page with a button behind it.
  await win.keyboard.press('Escape');
  await win.evaluate(() => openAgentMap());              // eslint-disable-line no-undef
  await expect(win.locator('[data-am-filter="all"]')).toHaveClass(/is-active/, { timeout: 15_000 });
  await expect(win.locator('#am-canvas-pane')).toBeVisible();
  await expect(win.locator('.am-node')).toHaveCount(8);

  await app.close();
});

// An agent can arrive while the user is reading something else, and the way in
// is a chip in the topbar. It has to say so on its own.
test('the topbar chip calls attention when an agent arrives behind your back', async () => {
  const env = makeHome();
  const app = await launch(env);
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => typeof refreshTopbarAgents === 'function', null, { timeout: 20_000 });

  const chip = win.locator('#topbar-agents');
  await expect(chip).toBeVisible({ timeout: 20_000 });

  // Work in flight makes the chip itself pulse, not just the dot inside it.
  await expect(chip).toHaveClass(/is-running|is-blocked/);
  const beat = await chip.evaluate((e) => getComputedStyle(e).animationName);
  expect(['ta-alive', 'ta-wants-you']).toContain(beat);
  // A poll that only sees the agents already there is not an arrival.
  await win.evaluate(() => refreshTopbarAgents());        // eslint-disable-line no-undef
  await expect(chip).not.toHaveClass(/is-new/);

  publish(env.agentsFile, env.fleet.concat([{
    kind: 'background', id: 'late-arrival', sessionId: sid(9),
    name: 'Started while you were away', cwd: env.cwd,
    state: 'working', status: 'working', startedAt: Date.now(), pid: 5011, parent: '',
  }]), env.cwd);
  await win.evaluate(() => refreshTopbarAgents());        // eslint-disable-line no-undef
  await expect(chip).toHaveClass(/is-new/);

  // Looking at the fleet is what stands it down.
  await win.evaluate(() => openAgentMap());              // eslint-disable-line no-undef
  await expect(chip).not.toHaveClass(/is-new/);

  await app.close();
});

// The common case on a real machine: plenty of agents, none of them started by
// another. Each takes a row of its own, and a fleet too tall for the pane is
// shown at a readable scale and scrolled rather than shrunk to dots.
test('a wide flat fleet stacks into rows that never overlap', async () => {
  const env = makeHome();
  const now = Date.now();
  const flat = Array.from({ length: 18 }, (_, i) => ({
    kind: 'background', id: `solo-${i}`, sessionId: sid(40 + i),
    name: `Independent agent ${i + 1}`, cwd: env.cwd,
    state: i < 3 ? 'working' : 'done', status: i < 3 ? 'working' : 'done',
    startedAt: now - (i + 1) * 90_000, parent: '',
  }));
  for (const a of flat) writeTranscript(env.homeDir, env.cwd, a);
  publish(env.agentsFile, flat, env.cwd);

  const app = await launch(env);
  const win = await openCenter(app);
  await expect(win.locator('.am-node')).toHaveCount(19, { timeout: 20_000 });
  await expect(win.locator('.am-node.is-project')).toHaveCount(1);
  // One branch per agent, all from the one source.
  expect(await win.locator('.am-edge').count()).toBe(18);

  const place = Object.entries(await placesOf(win)).filter(([id]) => !id.startsWith('proj:')).map(([, p]) => p);
  const ys = place.map((p) => p.y).sort((a, b) => a - b);
  expect(new Set(ys).size).toBe(18);
  const gaps = ys.slice(1).map((y, i) => y - ys[i]);
  expect(Math.min(...gaps)).toBe(Math.max(...gaps));

  const zoom = () => win.locator('#am-cv-zoom').textContent().then((t) => parseInt(t, 10));
  expect(await zoom()).toBeGreaterThanOrEqual(90);
  // A bare wheel scrolls the fleet.
  const box = await win.locator('#am-canvas-pane').boundingBox();
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const camY = () => win.evaluate(() => Math.round(agentMap.cam.y));   // eslint-disable-line no-undef
  const top = await camY();
  await win.mouse.wheel(0, 300);
  await expect.poll(camY).toBeLessThan(top);

  await win.waitForTimeout(900);
  await shoot(win, 'graph-no-lineage.png');
  await app.close();
});

// Booted light rather than switched light: boot re-applies the saved theme when
// its config load lands, so a switch made from the test races that repaint.
test('the graph holds in the light theme', async () => {
  const env = makeHome({ theme: 'light' });
  const app = await launch(env);
  const win = await openCenter(app);
  await win.waitForFunction(() => getComputedStyle(document.body).getPropertyValue('--text').trim() === '#0a0a0a',
    null, { timeout: 20_000, polling: 200 });
  await win.waitForTimeout(600);

  // A graph is a view of the work, not an instrument bolted into the window, so
  // the field is the page it sits on and goes to paper with it.
  const field = await win.evaluate(() => {
    const pane = document.querySelector('#am-canvas-pane');
    const cs = getComputedStyle(pane);
    // A token may resolve through color-mix, so it is read back through the
    // engine rather than parsed as a bare hex.
    const probe = document.createElement('i');
    document.body.appendChild(probe);
    const lum = (value) => {
      probe.style.color = value.trim();
      const m = getComputedStyle(probe).color.match(/[\d.]+/g).map(Number);
      const ch = m.slice(0, 3)
        .map((c) => (m[0] <= 1 && m[1] <= 1 && m[2] <= 1 && /srgb/.test(getComputedStyle(probe).color) ? c : c / 255))
        .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    };
    return {
      floorLum: lum(cs.getPropertyValue('--cv-floor')),
      inkLum: lum(cs.getPropertyValue('--cv-ink')),
      pageLum: lum(getComputedStyle(document.body).getPropertyValue('--bg')),
      states: ['run', 'wait', 'fail'].map((k) => cs.getPropertyValue(`--cv-${k}`).trim()),
      lit: [
        getComputedStyle(document.querySelector('.am-node.is-running .am-node-glyph')).filter,
        getComputedStyle(document.querySelector('.am-edge.is-live')).filter,
        getComputedStyle(document.querySelector('.am-flow')).filter,
      ].filter((f) => f !== 'none').join(' '),
    };
  });
  expect(field.pageLum, 'the page is on paper').toBeGreaterThan(0.6);
  expect(field.floorLum, 'the field went to paper with it').toBeGreaterThan(0.6);
  expect(field.inkLum, 'the ink on that field is dark').toBeLessThan(0.1);
  // The three states are measured against whatever ground the theme handed the
  // field, so no theme can resolve two of them to one colour.
  expect(new Set(field.states).size, 'two states resolved to one colour').toBe(3);
  // A live agent is marked by its packets and its heartbeat. A glow has no
  // reading on paper, so no state is allowed to depend on one.
  expect(field.lit, 'a state is drawn as light thrown onto the field').toBe('');

  await shoot(win, 'graph-light.png');
  await app.close();
});

// The three states are separated against the field the graph is drawn on. That
// field no longer moves with the theme, so the separation lands on the same
// three colours everywhere and a run reads as a run in every one of them.
test('every theme separates the three states on its own field', async () => {
  const readStates = async (theme) => {
    const app = await launch(makeHome({ theme }));
    const win = await openCenter(app);
    await win.waitForSelector('.am-node', { timeout: 20_000 });
    await win.waitForTimeout(400);
    const got = await win.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('#am-canvas-pane'));
      return ['run', 'wait', 'fail'].map((k) => cs.getPropertyValue(`--cv-${k}`).trim());
    });
    await app.close();
    return got;
  };
  const dark = await readStates('midnight');
  const light = await readStates('light');
  // Each theme separates against its own ground, so the two sets are not the
  // same colours. What holds across both is that each set is three.
  expect(new Set(dark).size, 'two states resolved to one colour on a dark field').toBe(3);
  expect(new Set(light).size, 'two states resolved to one colour on paper').toBe(3);
  expect(light, 'paper took the dark field\'s colours unchanged').not.toEqual(dark);
});

// A branch has to meet the tiles it joins: one that stops short of them reads
// as floating rather than as a line between two agents. The ribbon's own path
// data is read back: its first pair of points straddles where it leaves, and
// the pair at the turn straddles its tip.
async function edgeEndpoints(win) {
  return win.evaluate(() => {
    const B = window.HuskBranches;
    const at = new Map(agentMap.layout.map((n) => [n.a.id, n]));   // eslint-disable-line no-undef
    const out = [];
    for (const [key, path] of agentMap.edgeEls) {                   // eslint-disable-line no-undef
      const nums = (path.getAttribute('d') || '').match(/-?[\d.]+/g) || [];
      const pts = [];
      for (let i = 0; i + 1 < nums.length; i += 2) pts.push([Number(nums[i]), Number(nums[i + 1])]);
      const [pid, cid] = key.split('>');
      const p = at.get(pid);
      const c = at.get(cid);
      if (!p || !c || pts.length < 4) { out.push({ key, orphan: true }); continue; }
      const half = pts.length / 2;
      const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      out.push({
        key,
        start: mid(pts[0], pts[pts.length - 1]),
        end: mid(pts[half - 1], pts[half]),
        wantStart: p.root ? [B.G.STEM, p.cy] : [p.x + B.G.GLYPH / 2, p.y + B.G.GLYPH],
        wantEnd: [c.x, c.y + B.G.GLYPH / 2],
      });
    }
    return out;
  });
}

test('every branch meets the tile at each of its ends', async () => {
  const env = makeHome();
  const now = Date.now();
  const fleet = makeFleet(now, env.cwd);
  for (const a of fleet) writeTranscript(env.homeDir, env.cwd, a);
  publish(env.agentsFile, fleet, env.cwd);

  const app = await launch(env);
  const win = await openCenter(app);
  await expect(win.locator('.am-node')).toHaveCount(fleet.length + 1, { timeout: 20_000 });
  await win.waitForTimeout(700);

  const edges = await edgeEndpoints(win);
  expect(edges.length, 'the graph drew no edges to check').toBe(fleet.length);
  for (const e of edges) {
    expect(e.orphan, `edge ${e.key} had no ends in the layout`).toBeUndefined();
    expect(Math.abs(e.start[0] - e.wantStart[0]), `${e.key} leaves off its source`).toBeLessThan(1);
    expect(Math.abs(e.start[1] - e.wantStart[1]), `${e.key} leaves ${Math.round(e.start[1] - e.wantStart[1])}px off its source`).toBeLessThan(1);
    expect(Math.abs(e.end[0] - e.wantEnd[0]), `${e.key} stops short of the tile`).toBeLessThan(1);
    expect(Math.abs(e.end[1] - e.wantEnd[1]), `${e.key} arrives off the tile's middle`).toBeLessThan(1);
  }
  await shoot(win, 'graph-connected.png');
  await app.close();
});

// Branches end at the tile, left of every name, and drop down the gap left of a
// generation, so no line ever runs behind words.
test('no branch runs behind a name', async () => {
  const env = makeHome();
  const app = await launch(env);
  const win = await openCenter(app);
  await expect(win.locator('.am-node')).toHaveCount(8, { timeout: 20_000 });

  const crossings = await win.evaluate(() => {
    const B = window.HuskBranches;
    const rows = agentMap.layout.filter((n) => !n.root);   // eslint-disable-line no-undef
    const hits = [];
    for (const n of rows) {
      for (let i = 0; i <= 40; i += 1) {
        const [x, y] = B.edgePoint(n.edge, i / 40);
        for (const m of rows) {
          if (x > m.tx && x < m.tx + m.tw && y > m.y && y < m.y + 30) hits.push(`${n.a.id} under ${m.a.id}`);
        }
      }
    }
    return [...new Set(hits)];
  });
  expect(crossings).toEqual([]);

  const order = await win.evaluate(() => Array.from(document.querySelector('#am-cv-stage').children).map((k) => k.id));
  expect(order.indexOf('am-cv-edges'), 'the names are not painted over the branches').toBeLessThan(order.indexOf('am-cv-nodes'));
  await app.close();
});

test('a failed agent is not counted or drawn as a running one', async () => {
  const env = makeHome();
  const now = Date.now();
  // An agent the CLI reports as failed, with nothing working.
  const fleet = [
    { kind: 'background', id: 'gone', sessionId: sid(80), name: 'Spawn stale agents', cwd: env.cwd, state: 'failed', status: 'failed', startedAt: now - 8 * 60_000 },
    { kind: 'background', id: 'waiting', sessionId: sid(81), name: 'Review the diff', cwd: env.cwd, state: 'blocked', status: 'idle', startedAt: now - 3 * 60_000, pid: 5100 },
  ];
  for (const a of fleet) writeTranscript(env.homeDir, env.cwd, { ...a, parent: '' });
  publish(env.agentsFile, fleet, env.cwd);

  const app = await launch(env);
  const win = await openCenter(app);
  await expect(win.locator('.am-node')).toHaveCount(fleet.length + 1, { timeout: 20_000 });

  await expect(win.locator('.am-node.is-running')).toHaveCount(0);
  await expect(win.locator('.am-node.is-failed')).toHaveCount(1);
  await expect(win.locator('#am-sub')).not.toContainText('running');
  await expect(win.locator('#am-sub')).toContainText('1 failed');

  // And it is not offered as something to attach to.
  await win.evaluate(() => amSelect('gone'));                // eslint-disable-line no-undef
  await win.waitForTimeout(250);
  await expect(win.locator('#am-d-state')).toHaveText('Failed');

  await app.close();
});

test('an agent that never took a prompt is not called failed', async () => {
  const env = makeHome();
  const now = Date.now();
  // Two agents the CLI reports identically. Only one of them ever ran.
  const ran = { kind: 'background', id: 'ran', sessionId: sid(90), name: 'Rebuild the index', cwd: env.cwd, state: 'failed', status: 'failed', startedAt: now - 30 * 60_000 };
  const never = { kind: 'background', id: 'never', sessionId: sid(91), name: '', cwd: env.cwd, state: 'failed', status: 'failed', startedAt: now - 12 * 60_000 };
  writeTranscript(env.homeDir, env.cwd, { ...ran, parent: '' });     // the one that worked leaves a transcript
  publish(env.agentsFile, [ran, never], env.cwd);

  const app = await launch(env);
  const win = await openCenter(app);
  await win.click('[data-am-filter="all"]');
  await expect(win.locator('.am-node')).toHaveCount(3, { timeout: 20_000 });

  await win.evaluate(() => amSelect('never'));               // eslint-disable-line no-undef
  await win.waitForTimeout(250);
  await expect(win.locator('#am-d-state'), 'an agent that never started was called failed').toHaveText('Finished');

  await win.evaluate(() => amSelect('ran'));                 // eslint-disable-line no-undef
  await win.waitForTimeout(250);
  await expect(win.locator('#am-d-state'), 'an agent that ran and stopped lost its failure').toHaveText('Failed');

  await expect(win.locator('#am-sub')).toContainText('1 failed');
  await app.close();
});

// The smallest fleet is still a fleet: one agent under the project it runs in.
// Nothing about being small removes the line that says which is which.
test('a single agent is still joined to what it runs under', async () => {
  const env = makeHome();
  const now = Date.now();
  const solo = {
    kind: 'background', id: 'solo', sessionId: sid(95), name: '7a184a44', cwd: env.cwd,
    state: 'blocked', status: 'idle', startedAt: now - 22 * 60_000, pid: 6100,
  };
  writeTranscript(env.homeDir, env.cwd, { ...solo, parent: '' });
  publish(env.agentsFile, [solo], '');

  const app = await launch(env);
  const win = await openCenter(app);
  await expect(win.locator('.am-node')).toHaveCount(2, { timeout: 20_000 });
  await expect(win.locator('.am-node.is-project')).toHaveCount(1);
  await win.waitForTimeout(700);

  expect(await win.locator('.am-edge').count(), 'the lone agent was left unattached to its project').toBe(1);
  const edges = await edgeEndpoints(win);
  for (const e of edges) {
    expect(Math.abs(e.start[1] - e.wantStart[1]), `${e.key} does not leave its source`).toBeLessThan(1);
    expect(Math.abs(e.end[1] - e.wantEnd[1]), `${e.key} does not reach the tile it joins`).toBeLessThan(1);
  }
  await shoot(win, 'graph-single-agent.png');
  await app.close();
});
