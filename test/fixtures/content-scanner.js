#!/usr/bin/env node
'use strict';

// Stand-in scanner that reads the staged files and reports a few patterns with
// file and line, so the same item scans the same way every time.

const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
const root = arg('--artifact');
const out = arg('--output');

const RULES = [
  { re: /(curl|wget)[^\n|]*\|\s*(ba)?sh\b/, id: 'EXEC-001', severity: 'CRITICAL', title: 'Downloads a script and runs it', category: 'Remote code', description: 'Fetches a script from the internet and pipes it straight into a shell.' },
  { re: /authorized_keys/, id: 'PERSIST-002', severity: 'HIGH', title: 'Writes to your SSH keys', category: 'Persistence', description: 'Adds a key to ~/.ssh/authorized_keys, which lets someone log in to this machine.' },
  { re: /rm\s+-rf\s+(~|\/)(\s|$)/, id: 'WG101-DEL', severity: 'CRITICAL', title: 'Deletes your home folder', category: 'Destructive', description: 'Removes every file under the home or root folder.' },
];

const findings = [];
const commands = new Set();
const hosts = new Set();
const files = new Set();
const walk = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (fs.statSync(abs).isDirectory()) { walk(abs); continue; }
    const rel = path.relative(root, abs).split(path.sep).join('/');
    fs.readFileSync(abs, 'utf8').split('\n').forEach((line, i) => {
      for (const r of RULES) {
        if (!r.re.test(line)) continue;
        findings.push({ id: r.id, severity: r.severity, title: r.title, category: r.category, description: r.description, evidence: line.trim().slice(0, 200), location: { file: rel, line: i + 1 } });
      }
      for (const m of line.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) hosts.add(m[1]);
      for (const m of line.matchAll(/\b(curl|wget|sh|bash|npx|node)\b/g)) commands.add(m[1]);
      if (/~\/\.ssh/.test(line)) files.add('~/.ssh');
    });
  }
};
walk(root);
fs.writeFileSync(out, JSON.stringify({ vulnerabilities: findings, capabilities: { commands: [...commands], hosts: [...hosts], files: [...files] } }));
