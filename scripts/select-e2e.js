#!/usr/bin/env node
'use strict';

// Run only the e2e specs the working change can reach.
//
//   node scripts/select-e2e.js                 uncommitted work vs HEAD
//   node scripts/select-e2e.js --ref origin/main
//   node scripts/select-e2e.js --list          print the selection, run nothing
//   node scripts/select-e2e.js --all           skip selection, run everything
//
// Anything the map cannot account for runs the full suite. That is the whole
// safety story: a selector that quietly runs too little is worse than one that
// runs too much. CI runs everything regardless, so a stale map shows up there.

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { selectSpecs } = require('./lib/test-impact');

const REPO = path.resolve(__dirname, '..');
const MAP_PATH = path.join(REPO, 'test', 'impact-map.json');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const val = (f, dflt) => {
  const i = argv.indexOf(`--${f}`);
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};

// Passthrough for anything playwright understands (--reporter, --headed, ...).
const OWN_FLAGS = new Set(['--ref', '--list', '--all']);
function passthrough() {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (OWN_FLAGS.has(a)) { if (a === '--ref') i++; continue; }
    out.push(a);
  }
  return out;
}

function gitDiff(ref) {
  // -U0 keeps the hunks to changed lines only, so a token has to come from an
  // edited line rather than from three lines of untouched context.
  const args = ['diff', '-U0', ref, '--'];
  const tracked = execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // A new file is untracked and absent from the diff, so its whole body is
  // added text as far as selection is concerned.
  let untracked = '';
  const listed = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: REPO, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }).split('\n').filter(Boolean);
  for (const rel of listed) {
    let body = '';
    try { body = fs.readFileSync(path.join(REPO, rel), 'utf8'); } catch (_) { continue; }
    untracked += `+++ b/${rel}\n@@ -0,0 +0,0 @@\n`;
    untracked += body.split('\n').map((l) => `+${l}`).join('\n');
    untracked += '\n';
  }
  return tracked + untracked;
}

function runPlaywright(specs, extra) {
  const args = [path.join(REPO, 'scripts', 'run-e2e.js'), 'test/playwright.config.js'];
  for (const s of specs) args.push(`test/e2e/${s}`);
  args.push(...extra);
  console.log(`\n> node ${args.join(' ')}\n`);
  const r = spawnSync(process.execPath, args, { cwd: REPO, stdio: 'inherit' });
  process.exit(r.status == null ? 1 : r.status);
}

function main() {
  const map = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
  const extra = passthrough();

  if (has('all')) {
    console.log('Running the full suite (--all).');
    if (has('list')) return;
    return runPlaywright([], extra);
  }

  const ref = val('ref', 'HEAD');
  const result = selectSpecs(gitDiff(ref), map);

  for (const r of result.reasons) console.log(`  ${r}`);

  if (result.full) {
    const all = fs.readdirSync(path.join(REPO, 'test', 'e2e')).filter((f) => f.endsWith('.spec.js'));
    console.log(`\nFull suite: ${all.length} spec files.`);
    if (has('list')) return;
    return runPlaywright([], extra);
  }

  const total = fs.readdirSync(path.join(REPO, 'test', 'e2e')).filter((f) => f.endsWith('.spec.js')).length;
  console.log(`\nSelected ${result.specs.length} of ${total} spec files:`);
  for (const s of result.specs) console.log(`  ${s}`);
  if (has('list')) return;
  if (!result.specs.length) { console.log('Nothing to run.'); return; }
  runPlaywright(result.specs, extra);
}

main();
