#!/usr/bin/env node
'use strict';

// A stand-in for the claude CLI used by the agent-center e2e spec. It answers
// `agents --json` from a fixture file and stays alive when spawned as a chat,
// so the app under test never reaches the real CLI.

const fs = require('fs');

const args = process.argv.slice(2);

// Every invocation is recorded so a spec can assert what the app asked for.
if (process.env.FAKE_AGENTS_ARGV) {
  try { fs.appendFileSync(process.env.FAKE_AGENTS_ARGV, args.join(' ') + '\n'); } catch (_) {}
}

// Chat view runs the CLI in stream-json mode; the stream fake answers that.
if (args.includes('--input-format')) {
  require('./fake-claude-stream.js');
  return;
}

if (args[0] === 'agents' && args.includes('--json')) {
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(process.env.FAKE_AGENTS_FILE, 'utf8')); } catch (_) {}
  // Without --all the real CLI answers with the sessions it still considers
  // current and leaves out the finished ones. A caller that omits the flag has
  // to see the smaller set here too, or it looks consistent when it is not.
  if (!args.includes('--all')) {
    rows = rows.filter((r) => r && r.kind !== 'background' ? true : !['done', 'stopped'].includes(String(r.state || '')));
  }
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}

// Any other flagged invocation is a background poll (status, usage, models).
// Exit at once: a lingering child would hold the app's stdio open and hang the
// test harness at close.
// Ending a session answers and exits, the way the real one does.
if (args[0] === 'stop' || args[0] === 'rm') {
  // With FAKE_STALE_STOP set, a stop answers the way the real CLI does for an
  // agent whose worker is gone: it cannot confirm the stop and exits 1, with
  // the dash the real message carries.
  if (args[0] === 'stop' && process.env.FAKE_STALE_STOP) {
    process.stderr.write(`couldn't confirm ${args[1] || ''} was stopped \u2014 the background service may be restarting. Try again in a moment.\n`);
    process.exit(1);
  }
  // With FAKE_STOP_LISTS set, a stopped agent lists as stopped from then on, the way the real one does.
  if (args[0] === 'stop' && process.env.FAKE_STOP_LISTS) {
    try {
      const rows = JSON.parse(fs.readFileSync(process.env.FAKE_AGENTS_FILE, 'utf8'));
      for (const r of rows) if (r && r.id === args[1]) { r.state = 'stopped'; delete r.pid; delete r.status; }
      fs.writeFileSync(process.env.FAKE_AGENTS_FILE, JSON.stringify(rows));
    } catch (_) {}
  }
  process.stdout.write((args[0] === 'stop' ? 'stopped ' : 'removed ') + (args[1] || '') + '\n');
  process.exit(0);
}

if (args.length && args[0] !== 'agents' && args[0] !== 'attach' && !args.includes('--resume')) {
  process.stdout.write('{}');
  process.exit(0);
}

// Interactive modes (the main chat tab, `attach`, `--resume`): print a
// line and wait so the PTY has something to hold on to.
process.stdout.write('fake claude ready\n');
process.stdin.resume();
setInterval(() => {}, 1 << 30);
