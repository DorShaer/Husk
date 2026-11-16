#!/usr/bin/env node
'use strict';

// A terminal-only CLI that takes a while to reach its prompt and drops
// anything typed before then, the way a CLI flushes its input on start. What
// arrives after the prompt is appended to HUSK_FAKE_TERM_LOG.

const fs = require('node:fs');

const log = process.env.HUSK_FAKE_TERM_LOG;
const delay = Number(process.env.HUSK_FAKE_TERM_DELAY_MS) || 2500;
let ready = false;
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', (d) => { if (ready && log) fs.appendFileSync(log, d); });
setTimeout(() => { ready = true; process.stdout.write('fake> '); }, delay);
