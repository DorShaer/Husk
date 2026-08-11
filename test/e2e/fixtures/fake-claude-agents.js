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
