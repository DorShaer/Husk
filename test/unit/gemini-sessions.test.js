'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

// main.js is an Electron entrypoint and cannot be required, so lift the gemini
// readers out of the source and run them against transcripts on disk.
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main.js'), 'utf8');

function grab(re, name) {
  const m = SRC.match(re);
  assert.ok(m, `could not find ${name} in src/main.js`);
  return m[0];
}

const CODE = [
  grab(/const TITLE_DIALECTS = Object\.freeze\(\{[\s\S]*?\n\}\);/, 'TITLE_DIALECTS'),
  'const titleScanCache = new Map(); const TITLE_CACHE_MAX = 300;',
  grab(/function latestTranscriptTitle\(fullPath, dialectName\) \{[\s\S]*?\n\}\n/, 'latestTranscriptTitle'),
  grab(/function readHead\(filePath, bytes\) \{[\s\S]*?\n\}/, 'readHead'),
  grab(/function geminiProjectRoot\(projectDir\) \{[\s\S]*?\n\}/, 'geminiProjectRoot'),
  grab(/function geminiFirstUserMessage\(fullPath\) \{[\s\S]*?\n\}/, 'geminiFirstUserMessage'),
  grab(/function listGeminiSessions\(\) \{[\s\S]*?\n\}/, 'listGeminiSessions'),
  grab(/function geminiResumeIndex\(sessionId, cwd\) \{[\s\S]*?\n\}/, 'geminiResumeIndex'),
].join('\n');

// Build a throwaway ~/.gemini tree in the shape the CLI actually writes.
function makeGeminiHome(projects) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-gemini-'));
  for (const [name, spec] of Object.entries(projects)) {
    const dir = path.join(home, '.gemini', 'tmp', name);
    fs.mkdirSync(path.join(dir, 'chats'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.project_root'), spec.cwd);
    for (const s of spec.sessions) {
      const lines = [JSON.stringify({ sessionId: s.id, startTime: s.startTime, kind: 'main' })];
      if (s.userMessage) {
        lines.push(JSON.stringify({ type: 'user', content: [{ text: s.userMessage }] }));
      }
      for (const sum of (s.summaries || [])) {
        lines.push(JSON.stringify({ $set: { summary: sum, memoryScratchpad: 'x' } }));
      }
      fs.writeFileSync(path.join(dir, 'chats', `session-${s.id.slice(0, 8)}.jsonl`), lines.join('\n') + '\n');
    }
  }
  return home;
}

function load(home) {
  const ctx = {
    fs, path, os, JSON, Map, Buffer, Date, Number, String, Array, Object,
    HOME: home,
    GEMINI_DIR: path.join(home, '.gemini'),
  };
  vm.createContext(ctx);
  vm.runInContext(`${CODE}\nthis.listGeminiSessions = listGeminiSessions; this.geminiResumeIndex = geminiResumeIndex;`, ctx);
  return ctx;
}

const HUSK = '/home/dor/Desktop/husk';

test('lists gemini sessions with the name the CLI generated', () => {
  const home = makeGeminiHome({
    husk: {
      cwd: HUSK,
      sessions: [{
        id: 'a369f359-000b-4721-8393-a9f9630b3c14',
        startTime: '2026-07-07T07:49:43.193Z',
        userMessage: 'Look at the Autopilot code',
        summaries: ['Redesign the Autopilot UI to look magnificent.'],
      }],
    },
  });
  const { listGeminiSessions } = load(home);
  const s = listGeminiSessions();
  assert.equal(s.length, 1);
  assert.equal(s[0].title, 'Redesign the Autopilot UI to look magnificent.');
  assert.equal(s[0].named, true);
  assert.equal(s[0].originalCwd, HUSK);
  fs.rmSync(home, { recursive: true, force: true });
});

test('keeps the newest summary when gemini refines the name', () => {
  const home = makeGeminiHome({
    husk: {
      cwd: HUSK,
      sessions: [{
        id: 'aaaaaaaa-0000-0000-0000-000000000001',
        startTime: '2026-07-07T07:49:43.193Z',
        userMessage: 'hello',
        summaries: ['First guess', 'A better name', 'The final name'],
      }],
    },
  });
  const { listGeminiSessions } = load(home);
  assert.equal(listGeminiSessions()[0].title, 'The final name');
  fs.rmSync(home, { recursive: true, force: true });
});

test('falls back to the first user turn before a name is earned', () => {
  const home = makeGeminiHome({
    husk: {
      cwd: HUSK,
      sessions: [{
        id: 'bbbbbbbb-0000-0000-0000-000000000002',
        startTime: '2026-07-07T07:49:43.193Z',
        userMessage: 'hi',
        summaries: [],
      }],
    },
  });
  const { listGeminiSessions } = load(home);
  const s = listGeminiSessions()[0];
  assert.equal(s.title, 'hi');
  // Not a generated name, so a tab must keep showing it has not earned one.
  assert.equal(s.named, false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('resume index matches gemini --list-sessions, which is oldest first', () => {
  const home = makeGeminiHome({
    husk: {
      cwd: HUSK,
      sessions: [
        { id: '30473900-0000-0000-0000-00000000000a', startTime: '2026-07-06T15:59:30.000Z', userMessage: 'hi', summaries: [] },
        { id: '1848f829-0000-0000-0000-00000000000b', startTime: '2026-07-06T16:37:59.000Z', userMessage: 'x', summaries: ['Initiate a conversation.'] },
        { id: 'a369f359-0000-0000-0000-00000000000c', startTime: '2026-07-07T07:49:43.000Z', userMessage: 'y', summaries: ['Redesign the Autopilot UI.'] },
      ],
    },
  });
  const { geminiResumeIndex } = load(home);
  assert.equal(geminiResumeIndex('30473900-0000-0000-0000-00000000000a', HUSK), 1);
  assert.equal(geminiResumeIndex('1848f829-0000-0000-0000-00000000000b', HUSK), 2);
  assert.equal(geminiResumeIndex('a369f359-0000-0000-0000-00000000000c', HUSK), 3);
  // An id that is no longer listed cannot be resumed, and must not resolve to
  // some other session's index.
  assert.equal(geminiResumeIndex('ffffffff-0000-0000-0000-00000000000f', HUSK), 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('sessions are scoped to the project they belong to', () => {
  const home = makeGeminiHome({
    husk: { cwd: HUSK, sessions: [{ id: 'cccccccc-0000-0000-0000-00000000000d', startTime: '2026-07-07T07:00:00.000Z', userMessage: 'in husk', summaries: ['Husk work'] }] },
    dor: { cwd: '/home/dor', sessions: [{ id: 'dddddddd-0000-0000-0000-00000000000e', startTime: '2026-07-07T08:00:00.000Z', userMessage: 'in home', summaries: ['Home work'] }] },
  });
  const { listGeminiSessions, geminiResumeIndex } = load(home);
  const all = listGeminiSessions();
  assert.equal(all.length, 2);
  // The index is per project, so the home session is #1 of its own project and
  // must not be numbered behind the husk one.
  assert.equal(geminiResumeIndex('dddddddd-0000-0000-0000-00000000000e', '/home/dor'), 1);
  assert.equal(geminiResumeIndex('cccccccc-0000-0000-0000-00000000000d', HUSK), 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('an empty gemini tree yields no sessions rather than throwing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-gemini-none-'));
  const { listGeminiSessions } = load(home);
  // Length, not deepEqual: the array is built inside the vm realm, so it is not
  // reference-equal to an Array from this one.
  assert.equal(listGeminiSessions().length, 0);
  fs.rmSync(home, { recursive: true, force: true });
});
