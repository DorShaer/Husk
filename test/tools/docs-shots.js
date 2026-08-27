#!/usr/bin/env node
'use strict';

// Screenshot harness for the product images in docs/images.
//
//   node test/tools/docs-shots.js [outDir]
//
// Seeds a throwaway HOME with a demo workspace (agents, skills, MCP servers,
// prompts, projects, workflows) and captures every page the README shows. The
// profile is synthetic on purpose: nothing on the maintainer's machine, no
// personal directories, no account details, nothing to redact afterwards.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { _electron: electron } = require('playwright');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.resolve(process.argv[2] || path.join(REPO_ROOT, 'docs', 'images'));

const sanitize = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const sid = (n) => `d0cd0c00-0000-4dc7-abb3-${String(n).padStart(12, '0')}`;
const MIN = 60_000;
const HOUR = 60 * MIN;

const AGENTS = [
  ['Architect', 'Maps system tradeoffs and keeps implementation plans coherent.',
    'You are an architect. Explain tradeoffs, sequence work, and keep designs practical.'],
  ['Automation Builder', 'Creates repeatable workflows for routine engineering tasks.',
    'You turn a repeated task into a workflow with clear steps and checks.'],
  ['Docs Writer', 'Writes clear guides, release notes, and README updates for developers.',
    'You write documentation a developer can follow on the first read.'],
  ['Feature Planner', 'Turns rough ideas into small, testable product slices.',
    'You break an idea into slices that can each ship on their own.'],
  ['QA Tester', 'Plans validations and verifies user flows end to end.',
    'You plan the checks that prove a change works, then run them.'],
];

const SKILLS = [
  ['code-review', 'Reviews a diff for correctness, edge cases and clarity before it merges.'],
  ['release-notes', 'Drafts release notes from the commit log in a house format.'],
  ['api-design', 'Designs REST and GraphQL surfaces with versioning and pagination in mind.'],
  ['test-planning', 'Turns a feature description into the checks that prove it works.'],
  ['sql-tuning', 'Reads a slow query plan and proposes the index that fixes it.'],
  ['incident-review', 'Runs a blameless postmortem and writes the follow-up actions.'],
  ['dependency-audit', 'Checks a lockfile for advisories and stale transitive pins.'],
  ['ui-copy', 'Writes interface copy that says what a control does in a few words.'],
];

const PROMPTS = [
  ['explain-this-repo', 'Summarize the architecture of the repository in the current folder.'],
  ['write-tests', 'Write tests for the file I am looking at, covering the edge cases.'],
  ['review-my-diff', 'Review the working tree diff and list only real defects.'],
  ['draft-release-notes', 'Draft release notes from the commits since the last tag.'],
  ['debug-this-failure', 'Reproduce the failure, find the root cause, then propose the fix.'],
];

const MCP_SERVERS = {
  filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/srv/projects'] },
  github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'set-in-your-environment' } },
  postgres: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/app'] },
  playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
  memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
};

function workflowGraph(steps, agentCommand) {
  const nodes = steps.map((s, i) => ({
    id: `n${i + 1}`,
    name: s[0],
    agentCommand,
    prompt: s[1],
    passContext: 'full',
    x: 120 + (i % 2) * 320,
    y: 90 + i * 190,
  }));
  const edges = nodes.slice(1).map((n, i) => ({
    id: `e${i + 1}`, from: nodes[i].id, to: n.id, condition: { type: 'always', value: '' },
  }));
  return { nodes, edges };
}

const WORKFLOWS = [
  ['Release check', 'Run the suite, read the diff, and draft the notes for the next tag.', [
    ['Run the tests', 'Run the test suite and report failures with the exact output.'],
    ['Read the diff', 'Summarize what changed since the last tag, grouped by area.'],
    ['Draft the notes', 'Write release notes for the changes you just summarized.'],
  ]],
  ['Bug triage', 'Reproduce a report, find the cause, and propose the smallest fix.', [
    ['Reproduce', 'Reproduce the reported failure and capture the exact error.'],
    ['Find the cause', 'Trace the failure to the line that produces it.'],
    ['Propose a fix', 'Propose the smallest change that fixes the cause.'],
  ]],
  ['Docs refresh', 'Find what the docs promise, check it against the code, and fix the drift.', [
    ['Collect claims', 'List every claim the docs make about behavior.'],
    ['Check the code', 'Check each claim against what the code actually does.'],
    ['Rewrite', 'Rewrite the sections that no longer match.'],
  ]],
];

// A stand-in agent CLI. It prints one plausible exchange and then waits, so the
// chat page has a session to show without any real transcript behind it.
const AGENT_SHIM = `#!/bin/sh
case "$1" in
  --version|-v|version) echo "agent 1.4.2"; exit 0 ;;
  -p|--print|--message)
    printf '  reading the repository\\n'
    sleep 1
    printf '  ran the checks for this step\\n'
    sleep 2
    printf '  step complete\\n'
    exit 0 ;;
esac
printf '\\033[38;5;245m  agent 1.4.2  ·  demo-app  ·  type a message\\033[0m\\r\\n\\r\\n'
printf '\\033[38;5;250m› summarize what this service does and where it starts\\033[0m\\r\\n\\r\\n'
sleep 0.4
printf '\\033[36m  ⏵ read  README.md\\033[0m\\r\\n'
printf '\\033[36m  ⏵ read  src/server.js\\033[0m\\r\\n'
printf '\\033[36m  ⏵ read  src/routes/orders.js\\033[0m\\r\\n\\r\\n'
printf '  This is a small order service. src/server.js boots an HTTP listener,\\r\\n'
printf '  mounts the routes under src/routes, and opens one pool against the\\r\\n'
printf '  database named in config/default.json.\\r\\n\\r\\n'
printf '  Requests enter at src/routes/orders.js, which validates the payload\\r\\n'
printf '  and hands it to the service layer. Nothing else writes to the store.\\r\\n\\r\\n'
printf '\\033[38;5;250m› add a page size to the orders list and keep the default at 25\\033[0m\\r\\n\\r\\n'
sleep 0.3
printf '\\033[36m  ⏵ edit  src/routes/orders.js\\033[0m\\r\\n'
printf '\\033[36m  ⏵ edit  src/services/orders.js\\033[0m\\r\\n'
printf '\\033[36m  ⏵ run   npm test -- orders\\033[0m\\r\\n\\r\\n'
printf '  The list route now reads page and pageSize from the query, clamps the\\r\\n'
printf '  size to 100, and falls back to 25 when the caller sends neither. The\\r\\n'
printf '  service passes both through to the query rather than slicing in memory.\\r\\n\\r\\n'
printf '  Tests: 14 passed. The two that cover an out of range size now assert\\r\\n'
printf '  the clamp instead of the old error.\\r\\n\\r\\n'
printf '\\033[38;5;245m  Ask a follow-up, or drop a file into the window to share it.\\033[0m\\r\\n\\r\\n'
printf '› '
sleep 900
`;

function seedSession(homeDir, cwd, n, title, ago) {
  const dir = path.join(homeDir, '.claude', 'projects', sanitize(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const at = Date.now() - ago;
  const iso = (ms) => new Date(ms).toISOString();
  const lines = [
    { type: 'user', message: { role: 'user', content: title }, timestamp: iso(at - 20 * MIN), cwd, session_id: sid(n) },
    { type: 'system', subtype: 'ai-title', title, timestamp: iso(at - 19 * MIN) },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Reading the files that matter first.' }] }, timestamp: iso(at - 18 * MIN) },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done. The suite is green.' }] }, timestamp: iso(at) },
  ];
  const file = path.join(dir, `${sid(n)}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.utimesSync(file, new Date(at), new Date(at));
}

function makeHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-docs-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-docs-bin-'));
  const shim = path.join(bin, 'agent');
  fs.writeFileSync(shim, AGENT_SHIM);
  fs.chmodSync(shim, 0o755);
  // A workflow step takes an agent by name, resolved on PATH, and only one the
  // runner knows. The demo flows name that one; the chat page keeps its own.
  const stepShim = path.join(bin, 'claude');
  fs.writeFileSync(stepShim, AGENT_SHIM);
  fs.chmodSync(stepShim, 0o755);
  const code = path.join(homeDir, 'code');
  const demo = path.join(code, 'demo-app');
  const site = path.join(code, 'marketing-site');
  const api = path.join(code, 'orders-api');
  for (const d of [demo, site, api]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(demo, 'README.md'), '# demo-app\n\nA small order service.\n');

  // Two of the folders are repositories, so the columns that report a branch
  // and a working tree have something true to say.
  for (const [repo, dirty] of [[demo, true], [api, false]]) {
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
    try {
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'demo@example.com');
      git('config', 'user.name', 'Demo');
      fs.writeFileSync(path.join(repo, 'index.js'), "console.log('ok');\n");
      git('add', '-A');
      git('commit', '-q', '-m', 'initial commit');
      if (dirty) fs.writeFileSync(path.join(repo, 'index.js'), "console.log('ok');\nconsole.log('page size');\n");
    } catch (_) {}
  }

  // Agents live on the saved profiles; the built-ins come from the app itself.
  const profiles = AGENTS.map(([name, description, systemPrompt], i) => ({
    id: `p${i + 1}`, name, description, systemPrompt, active: i < 2,
  }));

  const cfgDir = path.join(homeDir, '.config', 'husk');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    firstRunDone: true,
    skipWelcome: true,
    // The release highlights are their own surface; a product capture opens on
    // the page it is meant to show.
    lastSeenVersion: require(path.join(REPO_ROOT, 'package.json')).version,
    theme: 'midnight',
    agentCommand: 'agent',
    profiles,
    projects: [
      { id: 'pr1', name: 'Demo App', path: demo, addedAt: Date.now() - 12 * HOUR, lastUsedAt: Date.now() - 4 * MIN },
      { id: 'pr2', name: 'Orders API', path: api, addedAt: Date.now() - 3 * 24 * HOUR, lastUsedAt: Date.now() - 6 * HOUR },
      { id: 'pr3', name: 'Marketing Site', path: site, addedAt: Date.now() - 9 * 24 * HOUR, lastUsedAt: Date.now() - 2 * 24 * HOUR },
    ],
    activeProjectId: 'pr1',
  }, null, 2));

  fs.writeFileSync(path.join(cfgDir, 'workflows.json'), JSON.stringify(
    WORKFLOWS.map(([name, description, steps], i) => ({
      id: `wf-demo-${i + 1}`,
      name,
      description,
      graph: workflowGraph(steps, 'claude'),
      trigger: 'manual',
      origin: 'local',
      createdAt: new Date(Date.now() - (i + 2) * 24 * HOUR).toISOString(),
      updatedAt: new Date(Date.now() - (i + 1) * HOUR).toISOString(),
    })), null, 2));

  const promptsDir = path.join(cfgDir, 'prompts');
  fs.mkdirSync(promptsDir, { recursive: true });
  for (const [name, description] of PROMPTS) {
    fs.writeFileSync(path.join(promptsDir, `${name}.md`),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}\n`);
  }

  const skillsDir = path.join(homeDir, '.claude', 'skills');
  for (const [name, description] of SKILLS) {
    const dir = path.join(skillsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${description}\n`);
  }

  fs.writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify({ mcpServers: MCP_SERVERS }, null, 2));

  seedSession(homeDir, demo, 1, 'Add pagination to the orders endpoint', 4 * MIN);
  seedSession(homeDir, demo, 2, 'Why does the checkout retry twice on a timeout', 3 * HOUR);
  seedSession(homeDir, api, 3, 'Move the rate limiter in front of the auth check', 26 * HOUR);

  return { homeDir, demo, bin };
}

function launch(env) {
  return electron.launch({
    args: [REPO_ROOT, '--no-sandbox'],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: env.homeDir,
      USERPROFILE: env.homeDir,
      // Neutral clock: the status panel falls back to the timezone when no city
      // resolves, and a demo capture must not carry a real one.
      TZ: 'UTC',
      PATH: `${env.bin}:${process.env.PATH}`,
      ELECTRON_DISABLE_SANDBOX: '1',
      HUSK_E2E: '1',
    },
    timeout: 40_000,
  });
}

const shots = [];

async function shoot(win, name, opts = {}) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, name);
  await win.screenshot({ path: file, animations: 'disabled', ...opts });
  shots.push(name);
  console.log(`  ${name}`);
}

async function main() {
  const env = makeHome();
  const app = await launch(env);
  const errors = [];
  try {
    const win = await app.firstWindow({ timeout: 30_000 });
    win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    win.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1640, height: 1020 });
    });
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => typeof setPage === 'function', null, { timeout: 20_000 });
    await win.waitForTimeout(7000);

    await shoot(win, 'husk-chat.png');

    for (const [page, name] of [
      ['agents', 'husk-agents.png'],
      ['workflows', 'husk-workflows.png'],
      ['projects', 'husk-projects.png'],
      ['prompts', 'husk-prompts.png'],
      ['skills', 'husk-skills.png'],
      ['mcp', 'husk-mcp.png'],
    ]) {
      try {
        await win.evaluate((p) => setPage(p), page);
        await win.waitForTimeout(1800);
        await shoot(win, name);
      } catch (err) { console.log(`  ${name} FAILED: ${err.message}`); }
    }

    await win.evaluate(() => openMcpCustomModal());
    await win.waitForTimeout(900);
    await shoot(win, 'husk-mcp-install.png');
    await win.keyboard.press('Escape');

    // The run shot has to be taken while the graph is live, so it is captured
    // a few seconds in rather than after the run settles.
    await win.evaluate(() => setPage('workflows'));
    await win.waitForTimeout(800);
    try {
      await win.evaluate(() => { runWorkflow('wf-demo-1'); });
      await win.waitForTimeout(7000);
      await shoot(win, 'husk-workflow-run.png');
    } catch (err) { console.log(`  husk-workflow-run.png FAILED: ${err.message}`); }

    console.log(`\n${shots.length} images written to ${OUT_DIR}`);
    if (errors.length) console.log(`console errors:\n${errors.slice(0, 8).join('\n')}`);
  } finally {
    await app.close();
  }
}

if (require.main === module) main();

module.exports = { makeHome, launch, AGENT_SHIM, sid, MIN, HOUR };
