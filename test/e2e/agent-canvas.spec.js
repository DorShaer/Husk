'use strict';

// The spawn graph: the agent center drawn along the axis the list cannot show,
// which agent started which. These checks pin the lineage read off the
// transcripts, the layout that follows from it, the live current on branches
// with work under them, an agent arriving mid-watch, the camera, and selection
// shared with the list. Each state is photographed for visual review.

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
    firstRunDone: true, skipWelcome: true, agentCommand: 'claude', theme,
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

function launch(env) {
  const fixtureBin = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-fake-bin-'));
  const shim = path.join(fixtureBin, 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(__dirname, 'fixtures', 'fake-claude-agents.js')}" "$@"\n`);
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
    timeout: 30_000,
  });
}

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
  // transform is read mid-transition and reports where a card is passing
  // through, not where the tree put it.
  const at = await placesOf(win);
  const chat = at[`chat:${CHAT_SID}`];

  // Generations read as rows: the chat is above everything it started, a
  // grandchild sits below its parent, and the two it started share a row.
  expect(chat.y).toBeLessThan(at['root-a'].y);
  expect(at['kid-a1'].y).toBeGreaterThan(at['root-a'].y);
  expect(at['kid-a11'].y).toBeGreaterThan(at['kid-a1'].y);
  expect(at['root-b'].y).toBe(at['root-a'].y);

  // A parent is centred over the span of its children, the chat included.
  expect(at['root-a'].x).toBe((at['kid-a1'].x + at['kid-a2'].x) / 2);
  expect(chat.x).toBe((at['root-b'].x + at['root-a'].x) / 2);

  // Cards never land on each other. An only child sits under its parent by
  // design, so the test is that no two cards share a position outright.
  const cells = Object.values(at).map((p) => `${p.x}:${p.y}`);
  expect(new Set(cells).size).toBe(cells.length);

  // The current runs only along branches with work under them, and it runs the
  // whole way: the chat down to root-a, root-a to its working child, and that
  // child to the grandchild still waiting on a human. The finished branch under
  // the same chat carries nothing.
  const live = await win.$$eval('.am-edge.is-live', (els) => els.length);
  expect(live).toBe(3);

  // State language matches the list: amber for waiting, green for running. The
  // counts are about agents, so the chat holding them is excluded.
  await expect(win.locator('.am-node:not(.is-holder).is-blocked')).toHaveCount(1);
  await expect(win.locator('.am-node:not(.is-holder).is-running')).toHaveCount(2);
  await expect(win.locator('.am-node:not(.is-holder).is-done')).toHaveCount(4);
  // A chat with work still in it is itself live.
  await expect(win.locator('.am-node.is-chat')).toHaveClass(/is-running/);

  // A parent says how many agents it put into the world, counting the whole
  // subtree rather than only its own children.
  await expect(win.locator('.am-node[data-am-id="root-a"] .am-node-kids')).toHaveText('3');
  await expect(win.locator('.am-node[data-am-id="kid-a2"] .am-node-kids')).toBeHidden();

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

  // The newcomer joins its parent's generation, beside the sibling it was
  // spawned next to rather than on a row of its own.
  const place = await placesOf(win);
  expect(place['kid-a12'].y).toBe(place['kid-a11'].y);
  expect(place['kid-a12'].x).toBeGreaterThan(place['kid-a11'].x);

  // An agent that leaves the fleet leaves the picture, along with its edge.
  publish(env.agentsFile, grown.filter((a) => a.id !== 'kid-a12' && a.id !== 'kid-b2'), env.cwd);
  await expect(win.locator('.am-node')).toHaveCount(7, { timeout: 15_000 });
  await expect(win.locator('.am-node[data-am-id="kid-a12"]')).toHaveCount(0);
  expect(await win.locator('.am-edge').count()).toBe(6);

  // Arrows walk the tree in reading order, a parent then what it started, and
  // Enter opens whatever they land on.
  await win.locator('#am-cv-nodes').focus();
  const order = await win.evaluate(() => agentMap.view);   // eslint-disable-line no-undef
  // A parent, then its branches in full, then its leaves. The chat that holds
  // them is scenery and stays out of the walk.
  expect(order).toEqual(['root-b', 'kid-b1', 'root-a', 'kid-a1', 'kid-a11', 'kid-a2']);
  await win.keyboard.press('ArrowUp');
  await expect(win.locator('.am-node.is-selected')).toHaveAttribute('data-am-id', 'kid-a1');
  await win.keyboard.press('ArrowDown');
  await expect(win.locator('.am-node.is-selected')).toHaveAttribute('data-am-id', 'kid-a11');
  await expect(win.locator('#am-d-name')).not.toBeEmpty();
  await win.keyboard.press('Enter');
  await expect(win.locator('#agent-map')).toBeHidden({ timeout: 10_000 });

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

  // A plain wheel zooms, both ways.
  const box = await win.locator('#am-canvas-pane').boundingBox();
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await win.mouse.wheel(0, -400);
  await win.waitForTimeout(120);
  const zoomedIn = await zoomOf();
  expect(parseInt(zoomedIn, 10)).toBeGreaterThan(parseInt(start, 10));
  await win.mouse.wheel(0, 800);
  await win.waitForTimeout(120);
  expect(parseInt(await zoomOf(), 10)).toBeLessThan(parseInt(zoomedIn, 10));

  // Full screen grows the card toward the window and keeps the detail pane.
  const cardW = async () => (await win.locator('#agent-map .am-card').boundingBox()).width;
  const small = await cardW();
  await win.click('#am-cv-expand');
  await win.waitForTimeout(700);
  const full = await cardW();
  expect(full).toBeGreaterThan(small + 100);
  await expect(win.locator('#am-detail-pane')).toBeVisible();
  await win.click('#am-cv-expand');
  await win.waitForTimeout(700);
  expect(await cardW()).toBeCloseTo(small, 0);

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
// another. A single row would be thousands of pixels wide, so they block up.
test('agents that started nothing wrap into a block instead of one long row', async () => {
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
  // A block deeper than one row is drawn as one region on a single stem: a
  // line to each member would have to cross the row above it.
  expect(await win.locator('.am-edge').count()).toBe(1);
  await expect(win.locator('.am-block')).toHaveCount(1);

  const place = Object.values(await placesOf(win));
  const rows = new Set(place.map((p) => p.y));
  const cols = new Set(place.map((p) => p.x));
  expect(rows.size).toBeGreaterThan(1);
  expect(cols.size).toBeLessThan(18);
  // The block stays closer to the pane's own shape than to a line.
  const w = Math.max(...place.map((p) => p.x)) - Math.min(...place.map((p) => p.x));
  const h = Math.max(...place.map((p) => p.y)) - Math.min(...place.map((p) => p.y));
  expect(w / Math.max(1, h)).toBeLessThan(4);

  await win.waitForTimeout(900);
  await shoot(win, 'graph-no-lineage.png');

  // Full screen spends the extra room on the graph itself rather than on empty
  // margin, so the framing gets bigger and not merely wider.
  const zoom = () => win.locator('#am-cv-zoom').textContent().then((t) => parseInt(t, 10));
  const before = await zoom();
  await win.click('#am-cv-expand');
  await win.waitForTimeout(1000);
  expect(await zoom()).toBeGreaterThan(before);
  await shoot(win, 'graph-no-lineage-full.png');

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
  await shoot(win, 'graph-light.png');
  await app.close();
});

// A connector has to meet the circles it joins: one that stops short of them
// reads as floating rather than as a line between two agents. The endpoints are
// read off the path data rather than the painted geometry, which is mid-morph
// whenever the layout has just changed.
async function edgeEndpoints(win) {
  return win.evaluate(() => {
    const at = new Map(agentMap.layout.map((n) => [n.a.id, n]));   // eslint-disable-line no-undef
    const m = agentMap.card;                                        // eslint-disable-line no-undef
    const out = [];
    for (const [key, path] of agentMap.edgeEls) {                   // eslint-disable-line no-undef
      const d = path.getAttribute('d') || '';
      const head = d.match(/^M(-?[\d.]+),(-?[\d.]+)/);
      const tail = d.match(/L(-?[\d.]+),(-?[\d.]+)\s*$/);
      if (!head || !tail) { out.push({ key, unreadable: d }); continue; }
      const [pid, cid] = key.split('>');
      const p = at.get(pid);
      const c = at.get(cid);
      if (!p) { out.push({ key, orphan: true }); continue; }
      const wantStart = [p.x + 132 / 2, p.y + (p.a.kind ? m.glyphLg : m.glyph)];
      const got = {
        key,
        start: [Number(head[1]), Number(head[2])],
        end: [Number(tail[1]), Number(tail[2])],
        wantStart,
        wantEnd: c ? [c.x + 132 / 2, c.y] : null,
      };
      out.push(got);
    }
    return out;
  });
}

test('every connector meets the circle at each of its ends', async () => {
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
  expect(edges.length, 'the graph drew no edges to check').toBeGreaterThan(0);
  for (const e of edges) {
    expect(e.unreadable, `edge ${e.key} had no readable path`).toBeUndefined();
    expect(e.orphan, `edge ${e.key} had no parent in the layout`).toBeUndefined();
    // Leaves the parent exactly on the rim of its circle.
    expect(Math.abs(e.start[0] - e.wantStart[0]), `${e.key} starts off the circle's centre line`).toBeLessThan(1);
    expect(Math.abs(e.start[1] - e.wantStart[1]), `${e.key} starts ${Math.round(e.start[1] - e.wantStart[1])}px off the circle`).toBeLessThan(1);
    if (e.wantEnd) {
      expect(Math.abs(e.end[0] - e.wantEnd[0]), `${e.key} arrives off the child's centre line`).toBeLessThan(1);
      expect(Math.abs(e.end[1] - e.wantEnd[1]), `${e.key} stops ${Math.round(e.end[1] - e.wantEnd[1])}px short of the child`).toBeLessThan(1);
    }
  }
  await shoot(win, 'graph-connected.png');
  await app.close();
});

// The line passes behind the name on its way down, so the name is painted over
// it and carries a halo. Without both, one of the two becomes unreadable.
test('names stay legible over the connector running behind them', async () => {
  const env = makeHome();
  const now = Date.now();
  const fleet = makeFleet(now, env.cwd);
  for (const a of fleet) writeTranscript(env.homeDir, env.cwd, a);
  publish(env.agentsFile, fleet, env.cwd);

  const app = await launch(env);
  const win = await openCenter(app);
  await expect(win.locator('.am-node')).toHaveCount(fleet.length + 1, { timeout: 20_000 });

  const paint = await win.evaluate(() => {
    const stage = document.querySelector('#am-cv-stage') || document.querySelector('#am-canvas-pane');
    const kids = Array.from(stage.querySelectorAll('#am-cv-edges, #am-cv-nodes'));
    const label = document.querySelector('.am-node-label');
    return {
      order: kids.map((k) => k.id),
      shadow: label ? getComputedStyle(label).textShadow : '',
      plated: !!(label && label.closest('.am-node-plate')),
    };
  });
  expect(paint.order, 'the names are not painted over the connectors').toEqual(['am-cv-edges', 'am-cv-nodes']);
  expect(paint.plated, 'the name is not grouped onto its own plate').toBe(true);
  expect(paint.shadow, 'the name carries no halo to lift it off the connector').not.toBe('none');

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
    expect(Math.abs(e.start[1] - e.wantStart[1]), `${e.key} does not meet the circle it leaves`).toBeLessThan(1);
    if (e.wantEnd) expect(Math.abs(e.end[1] - e.wantEnd[1]), `${e.key} does not reach the circle it joins`).toBeLessThan(1);
  }
  await shoot(win, 'graph-single-agent.png');
  await app.close();
});
