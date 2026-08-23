'use strict';

// Agents that run inside a chat rather than as sessions of their own: the ones
// a Task call spawns and the fleets a workflow fans out. The CLI's agent
// inventory cannot see them, so the fleet is read off the chat's own directory,
// and these checks pin what a person acts on: the count in the corner, the rows
// in the center, and the controls that make sense for an agent nothing can hold.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const sanitize = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const CHAT = 'b10721ca-79fd-4173-a984-c6c6bae362d4';
const RUN = 'wf_132126fa';

function writeAgent(dir, id, meta, prompt) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `agent-${id}.jsonl`), `${JSON.stringify({
    type: 'user', isSidechain: true, agentId: id, sessionId: CHAT,
    message: { role: 'user', content: prompt },
  })}\n`);
  fs.writeFileSync(path.join(dir, `agent-${id}.meta.json`), JSON.stringify(meta));
}

// A chat mid-turn: one task agent answered, one still out, and a workflow run
// with one agent back and one still working.
function makeHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-agent-inprocess-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, agentCommand: 'claude',
  }));
  const cwd = path.join(homeDir, 'code', 'husk');
  fs.mkdirSync(cwd, { recursive: true });

  const proj = path.join(homeDir, '.claude', 'projects', sanitize(cwd));
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, `${CHAT}.jsonl`), [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Redesign the sessions page.' }, cwd, session_id: CHAT }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_done' }] } }),
    '',
  ].join('\n'));

  const sub = path.join(proj, CHAT, 'subagents');
  writeAgent(sub, 'task-live', { agentType: 'general-purpose', description: 'Map every sessions page surface', toolUseId: 'toolu_live' }, 'Map every sessions page surface.');
  writeAgent(sub, 'task-done', { agentType: 'general-purpose', description: 'Read the design tokens', toolUseId: 'toolu_done' }, 'Read the design tokens.');

  const run = path.join(sub, 'workflows', RUN);
  writeAgent(run, 'w1', { agentType: 'workflow-subagent', spawnDepth: 1 }, 'Ground the design in the reference grammar.');
  writeAgent(run, 'w2', { agentType: 'workflow-subagent', spawnDepth: 1 }, 'Audit the current page for defects.');
  fs.writeFileSync(path.join(run, 'journal.jsonl'), [
    JSON.stringify({ type: 'started', agentId: 'w1' }),
    JSON.stringify({ type: 'started', agentId: 'w2' }),
    JSON.stringify({ type: 'result', agentId: 'w1', result: 'grammar extracted' }),
    '',
  ].join('\n'));
  const scripts = path.join(proj, CHAT, 'workflows', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, `sessions-page-redesign-${RUN}.js`), '');

  // The chat is the only thing the CLI reports, and it is running: this test
  // exists because everything under it is invisible to that inventory.
  const agentsFile = path.join(homeDir, 'agents.json');
  fs.writeFileSync(agentsFile, JSON.stringify([{
    kind: 'interactive', pid: process.pid, sessionId: CHAT,
    name: 'Redesign the sessions page', cwd, status: 'busy', startedAt: Date.now() - 600_000,
  }]));
  return { homeDir, cwd, agentsFile };
}

// A chat that fanned one skill out across a dozen slices: the shape a real
// hunt takes, and the one the graph has to keep readable.
const FANOUT = ['graphql', 'idor', 'ssrf', 'xss', 'rce', 'ssti', 'auth bypass', 'cloud misconfig'];

function makeFanoutHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-agent-fanout-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, agentCommand: 'claude',
  }));
  const cwd = path.join(homeDir, 'code', 'husk');
  fs.mkdirSync(cwd, { recursive: true });
  const proj = path.join(homeDir, '.claude', 'projects', sanitize(cwd));
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, `${CHAT}.jsonl`), `${JSON.stringify({
    type: 'user', message: { role: 'user', content: 'Hunt the target across every slice.' }, cwd, session_id: CHAT,
  })}\n`);
  const sub = path.join(proj, CHAT, 'subagents');
  FANOUT.forEach((slice, i) => writeAgent(sub, `hunt-${i}`, {
    agentType: 'general-purpose', description: `${slice} hunt on brokencrystals`, toolUseId: `toolu_${i}`,
  }, `Run the ${slice} slice.`));
  const agentsFile = path.join(homeDir, 'agents.json');
  fs.writeFileSync(agentsFile, JSON.stringify([{
    kind: 'interactive', pid: process.pid, sessionId: CHAT,
    name: 'brokencrystals hunt', cwd, status: 'busy', startedAt: Date.now() - 600_000,
  }]));
  return { homeDir, cwd, agentsFile };
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

test('agents running inside a chat are counted and listed like any other', async () => {
  const env = makeHome();
  const app = await launch(env);
  try {
    const win = await app.firstWindow({ timeout: 30_000 });
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => typeof openAgentMap === 'function', null, { timeout: 20_000 });

    // The corner counts the two that are still working, and nothing else.
    await win.waitForFunction(() => !document.querySelector('#topbar-agents').hidden, null, { timeout: 20_000 });
    await expect(win.locator('#topbar-agents-count')).toHaveText('2');

    await win.evaluate(() => openAgentMap());               // eslint-disable-line no-undef
    await win.waitForFunction(() => agentMap.rows.length > 0, null, { timeout: 20_000 }); // eslint-disable-line no-undef

    const rows = await win.evaluate(() => agentMap.rows.map((r) => ({ // eslint-disable-line no-undef
      id: r.id, name: r.name, running: r.running, runId: r.runId, kind: r.kind, parent: r.parentSessionId,
    })));
    expect(rows.length, 'the fleet lost an agent that runs inside the chat').toBe(4);
    expect(rows.every((r) => r.kind === 'subagent')).toBe(true);
    expect(rows.filter((r) => r.running).map((r) => r.id).sort()).toEqual(['sa-task-live', 'sa-w2']);

    // A workflow names neither its agents nor their work, so the run does.
    const w2 = rows.find((r) => r.id === 'sa-w2');
    expect(w2.runId).toBe(RUN);
    expect(w2.name).toMatch(/^sessions-page-redesign w2/);
    expect(w2.parent).toBe(CHAT);

    // Its conversation reads like any other agent's.
    await win.evaluate(() => amSelect('sa-w2'));            // eslint-disable-line no-undef
    await win.waitForFunction(() => agentMap.feed.entries.length > 0, null, { timeout: 20_000 }); // eslint-disable-line no-undef
    await expect(win.locator('#am-d-feed')).toContainText('Audit the current page for defects');

    // There is nothing to stop and no session to resume: the way in is the chat.
    await expect(win.locator('#am-d-end')).toBeHidden();
    await expect(win.locator('#am-d-open')).toHaveText('Open chat');
  } finally {
    await app.close();
  }
});

// An agent that runs inside a chat is an agent: it is drawn with the state it is
// in and the time it has been at it, never as the thing that holds a fleet.
test('the graph draws in-process agents as agents, not as what started them', async () => {
  const env = makeFanoutHome();
  const app = await launch(env);
  try {
    const win = await app.firstWindow({ timeout: 30_000 });
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => typeof openAgentMap === 'function', null, { timeout: 20_000 });
    await win.evaluate(() => openAgentMap());
    await win.waitForFunction(() => agentMap.rows.length === 8, null, { timeout: 20_000 }); // eslint-disable-line no-undef
    await win.evaluate(() => amSetView('canvas'));                                          // eslint-disable-line no-undef
    await expect(win.locator('.am-node')).toHaveCount(9, { timeout: 20_000 });

    const cards = await win.evaluate(() => Array.from(document.querySelectorAll('.am-node'))
      .filter((el) => !el.classList.contains('is-holder'))
      .map((el) => ({
        running: el.classList.contains('is-running'),
        label: el.querySelector('.am-node-label').textContent,
        time: el.querySelector('.am-node-time').textContent,
        mark: el.querySelector('.am-node-mark path').getAttribute('d'),
      })));
    expect(cards.length, 'the chat is the only holder in this graph').toBe(8);
    for (const c of cards) {
      expect(c.running, `${c.label} lost the state it is in`).toBe(true);
      expect(c.mark, `${c.label} drew no state mark`).toBeTruthy();
      expect(c.time, `${c.label} counts agents instead of its own elapsed time`).toMatch(/^\d+[smhd]/);
    }

    // The words every card in the fan-out shares are said once, on the block.
    await expect(win.locator('.am-block-cap')).toHaveText('hunt on brokencrystals');
    expect(cards.map((c) => c.label).sort()).toEqual([...FANOUT].sort());

    // And they are destinations: the arrows walk them like any other agent.
    const walk = await win.evaluate(() => agentMap.view.length);                            // eslint-disable-line no-undef
    expect(walk, 'in-process agents fell out of the keyboard walk').toBe(8);
  } finally {
    await app.close();
  }
});
