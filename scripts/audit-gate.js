#!/usr/bin/env node
'use strict';

// npm audit gate.
//
// `npm audit --audit-level=high` fails the build on any high or critical
// advisory, with no way to say "this one is understood and has no compatible
// fix yet". That leaves two bad options: stop scanning devDependencies (the
// build chain ships binaries to users, so it must stay in scope) or let the
// job sit red until upstream moves. This gate keeps the strict behaviour and
// adds one narrow exception list, so a known advisory is a recorded decision
// with a reason and a date rather than a silently weakened scan.
//
// Anything high or critical that is not listed here fails the build.

const { execFileSync } = require('node:child_process');

// Keyed by GHSA id. Each entry needs a reason and a review date. Reaching the
// review date does not fail the build; it prints a warning so the entry is
// revisited instead of living here forever.
const ALLOWED = {};

function auditJson() {
  let out;
  try {
    // npm audit exits non-zero when it finds anything, so the report comes
    // back through the error path on any run that has findings.
    out = execFileSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    out = (err && err.stdout) || '';
  }
  if (!out.trim()) {
    console.error('audit-gate: npm audit produced no output');
    process.exit(1);
  }
  try {
    return JSON.parse(out);
  } catch (err) {
    console.error('audit-gate: could not parse npm audit output:', err.message);
    process.exit(1);
  }
}

function ghsaFrom(url) {
  const m = String(url || '').match(/(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})/i);
  return m ? m[1] : '';
}

// Advisory ids are compared case-insensitively so an entry keyed in any casing
// still matches the id npm reports.
const allowedByKey = new Map(Object.entries(ALLOWED).map(([k, v]) => [k.toLowerCase(), v]));
const allowFor = (id) => allowedByKey.get(String(id).toLowerCase()) || null;

// One entry per distinct advisory, with the packages it lands on. npm reports
// the same advisory once per affected package, and the transitive dependents
// of an affected package repeat it again.
function collectAdvisories(report) {
  const found = new Map();
  for (const [name, v] of Object.entries(report.vulnerabilities || {})) {
    for (const via of v.via || []) {
      if (typeof via !== 'object' || !via) continue;
      const sev = String(via.severity || v.severity || '').toLowerCase();
      if (sev !== 'high' && sev !== 'critical') continue;
      const id = ghsaFrom(via.url) || `${via.source || via.title || 'unknown'}`;
      const hit = found.get(id) || { id, severity: sev, title: via.title || '', url: via.url || '', packages: new Set() };
      hit.packages.add(name);
      found.set(id, hit);
    }
  }
  return [...found.values()];
}

const report = auditJson();
const advisories = collectAdvisories(report);
const blocking = advisories.filter((a) => !allowFor(a.id));
const allowed = advisories.filter((a) => allowFor(a.id));

const today = new Date().toISOString().slice(0, 10);

for (const a of allowed) {
  const entry = allowFor(a.id);
  console.log(`allowed  ${a.severity.padEnd(8)} ${a.id}  ${a.title}`);
  console.log(`         packages: ${[...a.packages].sort().join(', ')}`);
  console.log(`         reason:   ${entry.reason}`);
  console.log(`         review:   ${entry.review}`);
  if (today >= entry.review) {
    console.log(`::warning::${a.id} is past its ${entry.review} review date. Recheck for a compatible fix and drop the entry or move the date.`);
  }
}

for (const id of Object.keys(ALLOWED)) {
  if (!advisories.some((a) => a.id.toLowerCase() === id.toLowerCase())) {
    console.log(`::warning::${id} is allow-listed but no longer reported. Remove it from scripts/audit-gate.js.`);
  }
}

if (!blocking.length) {
  console.log(`\naudit-gate: no unreviewed high or critical advisories (${allowed.length} allow-listed).`);
  process.exit(0);
}

console.log('');
for (const a of blocking) {
  console.error(`BLOCKING ${a.severity.padEnd(8)} ${a.id}  ${a.title}`);
  console.error(`         packages: ${[...a.packages].sort().join(', ')}`);
  if (a.url) console.error(`         ${a.url}`);
}
console.error(`\naudit-gate: ${blocking.length} high or critical ${blocking.length === 1 ? 'advisory needs' : 'advisories need'} a fix, or an entry in scripts/audit-gate.js explaining why not.`);
process.exit(1);
