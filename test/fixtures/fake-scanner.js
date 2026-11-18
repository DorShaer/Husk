#!/usr/bin/env node
'use strict';

// Stand-in for an external scanner. HUSK_FAKE_SCAN picks the canned report.
// It reads nothing from the artifact folder and executes nothing in it.

const fs = require('node:fs');

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
const mode = process.env.HUSK_FAKE_SCAN || 'clear';
const out = arg('--output');

if (process.env.HUSK_FAKE_SCAN_LOG) fs.appendFileSync(process.env.HUSK_FAKE_SCAN_LOG, JSON.stringify(argv) + '\n');

const finding = (id, severity) => ({
  id,
  title: 'Sample finding',
  severity,
  category: 'Sample category',
  description: 'A canned finding from the fake scanner.',
  evidence: 'Matched: sample evidence',
  location: { file: 'SKILL.md', line: 3 },
});

const reports = {
  clear: { vulnerabilities: null },
  review: { vulnerabilities: [finding('WG023-aaaa', 'HIGH')] },
  block: { vulnerabilities: [finding('WG101-bbbb', 'CRITICAL')], capabilities: { commands: ['curl'], hosts: ['example.invalid'], files: ['~/.ssh'] } },
  'explicit-clear': { verdict: 'clear', vulnerabilities: [finding('WG101-cccc', 'CRITICAL')] },
  'explicit-block': { verdict: 'block', vulnerabilities: [] },
  'bad-verdict': { verdict: 'fine', vulnerabilities: [] },
  'no-list': { summary: {} },
};

if (mode === 'timeout') {
  setTimeout(() => {}, 120000);
} else if (mode === 'garbage') {
  fs.writeFileSync(out, 'not json {');
} else if (mode === 'silent') {
  process.exit(0);
} else if (mode === 'crash') {
  process.kill(process.pid, 'SIGKILL');
} else if (mode === 'exit-code') {
  fs.writeFileSync(out, JSON.stringify(reports.review));
  process.exit(3);
} else {
  fs.writeFileSync(out, JSON.stringify(reports[mode] || reports.clear));
}
