#!/usr/bin/env node
'use strict';

// Screenshot harness for the 2.11.0 What's new slides.
//
//   node test/tools/wn-2110-shots.js [outDir]
//
// Seeds a believable workspace in a throwaway HOME — a project, a saved
// workflow with a month of run history, a fleet of background agents, an MCP
// server repository — launches the real app in the light theme and captures
// the six surfaces the slides describe:
//
//   wn-2110-export     the Export sheet over the workflows grid
//   wn-2110-install    the Install sheet, a fetched file read and held
//   wn-2110-receipts   the receipts record behind an installed workflow
//   wn-2110-agents     the background-agent board, graph view
//   wn-2110-mcp        MCP install-from-repo with a URL fetched
//   wn-2110-kiro       Kiro selected on the Chat page
//
// Every surface renders real data through the real pipeline: the workflow is
// exported by workflows:export, the install sheet reads the produced file, the
// receipts figures are aggregated from the seeded run history by the same code
// a user's runs go through.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { _electron: electron } = require('playwright');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.resolve(process.argv[2] || '.polish-workspace/wn-2110');

const WorkflowGraph = require(path.join(REPO_ROOT, 'src', 'lib', 'workflow-graph.js'));
const WorkflowArtifact = require(path.join(REPO_ROOT, 'src', 'lib', 'workflow-artifact.js'));

const sanitizePath = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const sid = (n) => `c0ffee00-0000-4dc7-abb3-${String(n).padStart(12, '0')}`;
const CHAT_SID = sid(900);

// ── The workflow and its history ────────────────────────────────────────────

function makeWorkflow() {
  const node = (id, name, agentCommand, prompt, x, y) => ({
    id, name, agentCommand, prompt, model: null, branchMode: 'parallel', passContext: 'full', x, y,
  });
  const edge = (id, from, to) => ({ id, from, to, condition: { type: 'always', value: '' } });
  const graph = WorkflowGraph.sanitizeGraph({
    nodes: [
      node('n-triage', 'Triage', 'claude', 'Read the bug report and the failing test. Name the module at fault and the smallest change that fixes it.', 40, 160),
      node('n-patch', 'Patch', 'claude', 'Apply the fix Triage described. Touch nothing else.', 300, 160),
      node('n-tests', 'Review: tests', 'codex', 'Run the test suite. Quote the literal output; do not summarise it.', 560, 60),
      node('n-sec', 'Review: security', 'copilot', 'Read the diff for injection, path traversal and secrets. Report findings or state there are none.', 560, 260),
      node('n-verify', 'Verify', 'claude', 'Both reviews are attached. Confirm the fix held and write the one-paragraph summary a reviewer reads first.', 820, 160),
    ],
    edges: [
      edge('e1', 'n-triage', 'n-patch'),
      edge('e2', 'n-patch', 'n-tests'),
      edge('e3', 'n-patch', 'n-sec'),
      edge('e4', 'n-tests', 'n-verify'),
      edge('e5', 'n-sec', 'n-verify'),
    ],
  });
  return {
    id: 'wf-1754000000000-tri1',
    name: 'Triage, patch, verify',
    description: 'Fan a bug out to triage and a patch, review the result twice in parallel, and gate the summary on both.',
    graph,
    trigger: 'manual',
    origin: 'local',
    createdAt: '2026-07-14T09:12:00.000Z',
    updatedAt: '2026-08-02T16:40:00.000Z',
  };
}

// A month of believable runs: mostly clean, two failures, one stopped by hand.
function makeRuns(workflow, graphHash) {
  const rows = [];
  const stepNames = workflow.graph.nodes.map((n) => ({ nodeId: n.id, name: n.name }));
  const base = Date.parse('2026-08-11T10:30:00Z');
  for (let i = 0; i < 31; i += 1) {
    // Newest first, spread over ~26 days, durations clustered around 5 minutes.
    const startedMs = base - i * 20 * 3600_000 - (i % 5) * 1700_000;
    const ms = 218_000 + ((i * 7919) % 260_000);
    const status = i === 7 || i === 19 ? 'failed' : i === 26 ? 'stopped' : 'done';
    const steps = stepNames.map((s, idx) => ({
      nodeId: s.nodeId,
      name: s.name,
      status: status === 'failed' && idx === 2 ? 'failed' : 'done',
      ms: Math.floor(ms / 5),
      timedOut: false,
    }));
    rows.push({
      id: `run-${startedMs}`,
      workflowId: workflow.id,
      graphHash,
      environment: {
        agentResolved: 'claude',
        agentVersion: '',
        os: 'linux',
        huskVersion: '2.11.0',
        workspace: { vcs: 'git', trackedFiles: '100-1k', languages: [] },
      },
      auditSessionId: null,
      workflowName: workflow.name,
      status,
      startedAt: new Date(startedMs).toISOString(),
      finishedAt: new Date(startedMs + ms).toISOString(),
      ms,
      steps,
      edgesTaken: workflow.graph.edges.map((e) => ({ from: e.from, to: e.to })),
      failedStep: status === 'failed' ? 'Review: tests' : '',
    });
  }
  return rows;
}

// ── The agent fleet (the board's graph view) ────────────────────────────────

const chatRow = (cwd) => ({
  kind: 'interactive', pid: 4242, sessionId: CHAT_SID,
  name: 'Ship the release pipeline', cwd, status: 'busy',
  startedAt: Date.now() - 95 * 60_000,
});

function makeFleet(now, cwd) {
  const mk = (id, n, name, state, startedMin, parent, pid) => ({
    kind: 'background', id, sessionId: sid(n), name, cwd,
    state, status: state, startedAt: now - startedMin * 60_000,
    parent: parent ? sid(parent) : '', ...(pid ? { pid } : {}),
  });
  return [
    mk('root-a', 1, 'Harden the release workflow', 'working', 52, 900, 5001),
    mk('kid-a1', 2, 'Split publish into its own job', 'working', 34, 1, 5002),
    mk('kid-a11', 3, 'Pin every third-party action', 'blocked', 21, 2, 5003),
    mk('kid-a2', 4, 'Audit the lockfile', 'done', 40, 1),
    mk('root-b', 5, 'Rebuild the sessions page', 'done', 190, 900),
    mk('kid-b1', 6, 'Write the roster spec', 'done', 174, 5),
    mk('kid-b2', 7, 'Screenshot both themes', 'done', 168, 5),
  ];
}

function writeTranscript(homeDir, cwd, a) {
  const dir = path.join(homeDir, '.claude', 'projects', sanitizePath(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const t = (m) => new Date(Date.now() - m * 60_000).toISOString();
  const A = (min, content) => ({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content }, timestamp: t(min) });
  const lines = [
    { type: 'user', message: { role: 'user', content: `${a.name}. Work autonomously.` }, timestamp: t(45), cwd, session_id: a.parent || a.sessionId },
    A(40, [{ type: 'text', text: 'Reading the workflow files first.' }]),
    A(12, [{ type: 'tool_use', name: 'Edit', input: { file_path: `${cwd}/.github/workflows/release.yml` } }]),
    A(2, [{ type: 'text', text: 'Dry run passes. I need permission to push.' }]),
  ];
  fs.writeFileSync(path.join(dir, `${a.sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function writeJob(homeDir, shortId, job) {
  const dir = path.join(homeDir, '.claude', 'jobs', shortId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ updatedAt: Date.now(), ...job }));
}

// ── The MCP server repository ───────────────────────────────────────────────

function makeMcpRepo(homeDir) {
  const repo = path.join(homeDir, 'repos', 'acme-mcp-servers');
  const servers = [
    ['github', 'GitHub issues, pull requests and checks for the acme org.'],
    ['postgres', 'Read-only SQL over the staging database, with schema browsing.'],
    ['sentry', 'Recent errors and release health, grouped the way on-call reads them.'],
  ];
  for (const [name, description] of servers) {
    const dir = path.join(repo, 'mcp-servers', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: `@acme/mcp-${name}`, version: '1.4.2', description,
      main: 'dist/index.js', scripts: { build: 'tsc -p .' },
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n\n${description}\n`);
  }
  return repo;
}

// ── HOME assembly ───────────────────────────────────────────────────────────

function makeHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-wn2110-'));
  const cfgDir = path.join(homeDir, '.config', 'husk');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, agentCommand: 'claude',
    theme: 'light', lastSeenVersion: '2.11.0', statusCollapsed: true,
  }));

  // The project: a real work tree, so an install may bind to it.
  const cwd = path.join(homeDir, 'code', 'acme-api');
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'server.js'), "'use strict';\nmodule.exports = () => 'ok';\n");
  fs.writeFileSync(path.join(cwd, 'README.md'), '# acme-api\n');
  const git = (args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  git(['init', '-q']);
  git(['-c', 'user.email=shots@husk', '-c', 'user.name=Shots', 'add', '-A']);
  git(['-c', 'user.email=shots@husk', '-c', 'user.name=Shots', 'commit', '-qm', 'seed']);

  // The workflow and the month of runs behind its receipts.
  const workflow = makeWorkflow();
  const hash = WorkflowArtifact.graphHash(workflow.graph);
  if (!hash.ok) throw new Error(`graphHash refused the seeded graph: ${hash.error}`);
  fs.writeFileSync(path.join(cfgDir, 'workflows.json'), JSON.stringify([workflow]));
  fs.writeFileSync(path.join(cfgDir, 'workflow-runs.json'), JSON.stringify(makeRuns(workflow, hash.hash)));

  // The agent fleet.
  const fleet = makeFleet(Date.now(), cwd);
  for (const a of fleet) writeTranscript(homeDir, cwd, a);
  writeJob(homeDir, 'root-a', { state: 'working', detail: 'Editing .github/workflows/release.yml', intent: 'Harden the release workflow end to end so a bad tag can never publish.', tokens: 48231 });
  writeJob(homeDir, 'kid-a1', { state: 'working', detail: 'Rewriting the publish job', tokens: 22110 });
  writeJob(homeDir, 'kid-a11', { state: 'blocked', needs: 'Permission to push the branch', detail: 'Waiting for approval to push', tokens: 9040 });
  const agentsFile = path.join(homeDir, 'agents.json');
  const clean = fleet.map(({ parent, ...r }) => ({ ...r }));
  clean.push(chatRow(cwd));
  fs.writeFileSync(agentsFile, JSON.stringify(clean));

  const mcpRepo = makeMcpRepo(homeDir);
  return { homeDir, cwd, agentsFile, mcpRepo, workflowId: workflow.id };
}

// ── App driving ─────────────────────────────────────────────────────────────

function launch(env) {
  const fixtureBin = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-fake-bin-'));
  // Every agent the workflow names sits on PATH, so the install sheet's
  // against-this-machine checks read as they do on a machine that has them.
  for (const name of ['claude', 'codex', 'copilot']) {
    const shim = path.join(fixtureBin, name);
    fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(REPO_ROOT, 'test', 'e2e', 'fixtures', 'fake-claude-agents.js')}" "$@"\n`);
    fs.chmodSync(shim, 0o755);
  }
  const kiroShim = path.join(fixtureBin, 'kiro-cli');
  fs.writeFileSync(kiroShim, `#!/bin/sh
if [ "$1" = "chat" ]; then shift; fi
if [ "$1" = "--list-models" ]; then
  printf '[]\\n'
  exit 0
fi
printf 'Kiro Chat ready inside Husk\\n'
sleep 8
`);
  fs.chmodSync(kiroShim, 0o755);
  return electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: env.cwd,
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

async function shoot(win, name) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Fractional display scaling: the native surface is larger than the painted
  // DOM. Capture the full frame, then crop to viewport * devicePixelRatio,
  // the empirically verified mapping polish-shots.js uses.
  const m = await win.evaluate(() => {
    const k = window.devicePixelRatio || 1;
    return { w: Math.round(window.innerWidth * k), h: Math.round(window.innerHeight * k) };
  });
  const out = path.join(OUT_DIR, `${name}.png`);
  const tmp = path.join(OUT_DIR, `.full-${name}.png`);
  await win.screenshot({ path: tmp, animations: 'disabled' });
  execFileSync('convert', [tmp, '-crop', `${m.w}x${m.h}+0+0`, '+repage', out]);
  fs.unlinkSync(tmp);
  process.stdout.write(`  shot ${name}.png (${m.w}x${m.h})\n`);
}

async function main() {
  const env = makeHome();
  const app = await launch(env);
  try {
    const win = await app.firstWindow({ timeout: 30_000 });
    // No resize: on this display a shrunk window letterboxes inside its old
    // compositor frame (fractional scaling), so the natural size is the one
    // that fills the capture — it is also what the 2.10.0 set was shot at.
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => typeof setPage === 'function', null, { timeout: 20_000 });
    await win.waitForTimeout(1800);

    // ── export ── the sheet over the workflows grid, receipts figures live.
    await win.evaluate(() => setPage('workflows'));
    await win.waitForTimeout(900);
    await win.evaluate((id) => {
      const w = workflowsCache.find((x) => x.id === id);
      window.WfxPublish.open(w, {});
    }, env.workflowId);
    await win.waitForTimeout(900);
    await shoot(win, 'wn-2110-export');

    // The file itself, produced by the real exporter.
    const exportedPath = path.join(env.homeDir, 'triage-patch-verify.workflow.json');
    const exp = await win.evaluate(async (p) => {
      const res = await window.husk.workflows.export({ workflowId: p.id, targetPath: p.target });
      return { ok: !!(res && res.ok), code: res && res.code, message: res && res.message };
    }, { id: env.workflowId, target: exportedPath });
    if (!exp.ok) throw new Error(`export refused: ${exp.code} ${exp.message}`);
    await win.evaluate(() => window.WfxPublish.close());
    await win.waitForTimeout(300);

    // ── install ── the sheet reads the exported file from its path row.
    await win.evaluate(() => wfxOpenInstallSheet());
    await win.waitForTimeout(300);
    await win.evaluate((p) => {
      const src = document.getElementById('wfx-in-src-file');
      if (src) src.click();
      const field = document.getElementById('wfx-in-path');
      field.value = p;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }, exportedPath);
    await win.evaluate(() => document.getElementById('wfx-in-fetch').closest('.ra-pathrow, body') && undefined);
    // The visible Fetch beside the path row is the adopted control; click
    // whichever fetch control is not hidden.
    await win.evaluate(() => {
      const candidates = [...document.querySelectorAll('#wfx-in-fetch, #wfx-install-modal button')]
        .filter((b) => !b.hidden && b.offsetParent && /^fetch$/i.test(b.textContent.trim()));
      (candidates[0] || document.getElementById('wfx-in-fetch')).click();
    });
    await win.waitForTimeout(1200);
    await shoot(win, 'wn-2110-install');
    await win.evaluate(() => window.WfxInstall.close());
    await win.waitForTimeout(300);

    // ── receipts ── install through the real gate, then open the record.
    const inst = await win.evaluate(async (p) => {
      const read = await window.husk.workflows.artifactRead({ source: 'file', path: p.file });
      if (!read || !read.ok) return { ok: false, code: read && read.code, message: read && read.message };
      const res = await window.husk.workflows.install({ artifact: read.artifact, cwd: p.cwd });
      if (!res || !res.ok) return { ok: false, code: res && res.code, message: res && res.message };
      return { ok: true, id: res.workflow.id };
    }, { file: exportedPath, cwd: env.cwd });
    if (!inst.ok) throw new Error(`install refused: ${inst.code} ${inst.message}`);
    await win.evaluate(() => renderWorkflows());
    await win.waitForTimeout(600);
    await win.evaluate((id) => wfOpenReceiptRecord(id), inst.id);
    await win.waitForTimeout(900);
    await shoot(win, 'wn-2110-receipts');
    await win.evaluate(() => { const m = document.getElementById('wfx-install-modal'); if (m) m.hidden = true; });
    await win.waitForTimeout(300);

    // ── agents ── the board, graph view, over the seeded fleet.
    await win.evaluate(() => openAgentMap());
    await win.waitForTimeout(1600);
    await shoot(win, 'wn-2110-agents');
    await win.evaluate(() => closeAgentMap());
    await win.waitForTimeout(300);

    // ── mcp ── install-from-repo with a URL in the row and the scan's answer.
    await win.evaluate(() => setPage('mcp'));
    await win.waitForTimeout(700);
    await win.evaluate(() => openRepoMcpModal());
    await win.waitForTimeout(300);
    await win.evaluate((p) => {
      setMcpRepoSource('github');
      const url = document.getElementById('rm-url');
      url.value = 'https://github.com/acme/acme-mcp-servers';
      return rmScanRoot(p);
    }, env.mcpRepo);
    await win.waitForTimeout(900);
    await shoot(win, 'wn-2110-mcp');

    // ── kiro ── Kiro selected on Chat, with the switcher open on Kiro.
    await win.evaluate(async () => {
      const modal = document.getElementById('repo-mcp-modal');
      if (modal) modal.hidden = true;
      if (typeof setPage === 'function') setPage('chat');
      cfg = await window.husk.config.set({ agentCommand: 'kiro-cli' });
      agentKindCache = 'generic';
      document.body.dataset.agentKind = 'generic';
      if (typeof updateAgentPill === 'function') updateAgentPill();
      if (typeof refreshAgentMenu === 'function') await refreshAgentMenu();
      if (typeof setChatSubBase === 'function') setChatSubBase({ tool: 'kiro-cli', dir: cfg.agentCwd || '~' });
      const banner = document.getElementById('trust-banner');
      if (banner) banner.hidden = true;
      if (typeof openNewChatTab === 'function') await openNewChatTab({ skipContext: true });
    });
    await win.waitForTimeout(1200);
    await win.evaluate(() => {
      const pill = document.getElementById('rail-agent-pill');
      if (pill) pill.click();
    });
    await win.waitForTimeout(700);
    await shoot(win, 'wn-2110-kiro');
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(env.homeDir, { recursive: true, force: true });
  }
  process.stdout.write(`done: ${OUT_DIR}\n`);
}

main().catch((err) => { console.error(err); process.exit(1); });
