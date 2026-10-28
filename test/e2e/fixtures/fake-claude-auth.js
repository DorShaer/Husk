#!/usr/bin/env node
'use strict';

// A stand-in for the claude CLI for the sign-in e2e spec. Records every argv
// to CAPTURE, answers the chat handshake with an init line and stays alive,
// signs in or out at once with exit 0, and reports a fixed account.

const fs = require('fs');
const args = process.argv.slice(2);
try { fs.appendFileSync(process.env.CAPTURE, JSON.stringify({ argv: args }) + '\n'); } catch (_) {}

if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: true, email: 'tester@example.com', subscriptionType: 'max', orgName: 'Example' }));
  process.exit(0);
}
if (args[0] === 'auth') {
  process.stdout.write(args[1] === 'logout' ? 'Logged out\n' : 'Logged in as tester@example.com\n');
  process.exit(0);
}
if (args.includes('--input-format')) {
  const i = args.indexOf('--session-id');
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: i >= 0 ? args[i + 1] : 'fake-session', model: 'claude-test', slash_commands: ['login', 'logout', 'model'] }) + '\n');
  process.stdin.resume();
  setInterval(() => {}, 1 << 30);
} else {
  // version and status probes
  process.stdout.write('{}');
  process.exit(0);
}
