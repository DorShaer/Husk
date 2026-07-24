'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const { deriveCopilotSessionTitleFromEventsText } = require('../../src/lib/copilot-session-title');

// main.js is an Electron entrypoint and cannot be required, so lift the copilot
// readers out of the source and run them against session dirs on disk.
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main.js'), 'utf8');

function grab(re, name) {
  const m = SRC.match(re);
  assert.ok(m, `could not find ${name} in src/main.js`);
  return m[0];
}

const CODE = [
  'const copilotWorkspaceCache = new Map(); const copilotTitleCache = new Map(); const COPILOT_CACHE_MAX = 300;',
  grab(/function readCopilotWorkspace\(dir\) \{[\s\S]*?\n\}/, 'readCopilotWorkspace'),
  grab(/function readCopilotSessionTitle\(dir\) \{[\s\S]*?\n\}/, 'readCopilotSessionTitle'),
  grab(/function isAutopilotCopilotText\(text\) \{[\s\S]*?\n\}/, 'isAutopilotCopilotText'),
  grab(/function containsAutopilotCopilotText\(text\) \{[\s\S]*?\n\}/, 'containsAutopilotCopilotText'),
  grab(/function isAutopilotCopilotSession\(ws, eventTitle\) \{[\s\S]*?\n\}/, 'isAutopilotCopilotSession'),
  grab(/function listCopilotSessions\(opts = \{\}\) \{[\s\S]*?\n\}/, 'listCopilotSessions'),
].join('\n');

const HUSK = '/home/user/code/husk';

// Build a throwaway <COPILOT_HOME>/session-state tree in the shape the CLI
// actually writes: workspace.yaml lands the moment the CLI launches, and
// events.jsonl only appears once the conversation has a turn in it.
function makeCopilotHome(specs) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-copilot-'));
  for (const s of specs) {
    const dir = path.join(home, 'session-state', s.id);
    fs.mkdirSync(dir, { recursive: true });
    const yaml = [
      `id: ${s.id}`,
      `cwd: ${s.cwd || HUSK}`,
      `name: ${s.name || 'null'}`,
      `created_at: ${s.created || '2026-07-25T10:00:00.000Z'}`,
      `updated_at: ${s.updated || s.created || '2026-07-25T10:00:00.000Z'}`,
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'workspace.yaml'), yaml + '\n');
    if (s.userMessage) {
      const line = JSON.stringify({ type: 'user', message: { content: s.userMessage } });
      fs.writeFileSync(path.join(dir, 'events.jsonl'), line + '\n');
    }
  }
  return home;
}

function load(home) {
  const ctx = {
    fs, path, JSON, Map, Buffer, Date, Number, String, Array, Object, Math,
    COPILOT_DIR: home,
    deriveCopilotSessionTitleFromEventsText,
    isAutopilotWorkspacePath: () => false,
  };
  vm.createContext(ctx);
  vm.runInContext(`${CODE}\nthis.listCopilotSessions = listCopilotSessions;`, ctx);
  return ctx;
}

test('a chat opened and closed without a turn is not history', () => {
  const home = makeCopilotHome([
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', userMessage: 'Look at the Autopilot code' },
    { id: 'bbbbbbbb-0000-4000-8000-000000000002' },
    { id: 'cccccccc-0000-4000-8000-000000000003' },
  ]);
  const { listCopilotSessions } = load(home);
  const listed = listCopilotSessions();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, 'aaaaaaaa-0000-4000-8000-000000000001');
  fs.rmSync(home, { recursive: true, force: true });
});

test('includeEmpty returns the eventless dirs so a live tab can bind to one', () => {
  const home = makeCopilotHome([
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', userMessage: 'Look at the Autopilot code' },
    { id: 'bbbbbbbb-0000-4000-8000-000000000002' },
  ]);
  const { listCopilotSessions } = load(home);
  const listed = listCopilotSessions({ includeEmpty: true });
  assert.equal(listed.length, 2);
  const empty = listed.find((s) => s.id === 'bbbbbbbb-0000-4000-8000-000000000002');
  assert.equal(empty.hasContent, false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a session the CLI has already named counts as history without events yet', () => {
  const home = makeCopilotHome([
    { id: 'dddddddd-0000-4000-8000-000000000004', name: 'Fix Chat Click Issue' },
  ]);
  const { listCopilotSessions } = load(home);
  const listed = listCopilotSessions();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].title, 'Fix Chat Click Issue');
  assert.equal(listed[0].named, true);
  fs.rmSync(home, { recursive: true, force: true });
});

test('an empty session-state tree yields no sessions rather than throwing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-copilot-'));
  const { listCopilotSessions } = load(home);
  assert.equal(listCopilotSessions().length, 0);
  fs.rmSync(home, { recursive: true, force: true });
});
