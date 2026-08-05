'use strict';

// Pick the e2e specs a change can actually affect.
//
// The specs never import the app, they spawn `src/main.js` as a subprocess, so
// no import-graph tool can connect a source edit to a spec. What does connect
// them is this codebase's naming: a stylesheet rule, a markup class, a renderer
// selector string and a spec's own locators all spell the same prefix, and the
// map in test/impact-map.json records which prefixes belong to which specs.
//
// The rule that keeps this safe is the fallback. Anything unrecognized, any
// shared-chrome token, and any known file whose diff yields no usable token
// runs the whole suite. Under-selecting hides a regression; over-selecting only
// costs time, so every ambiguous case resolves toward running more.

// A hunk header from `git diff -U0`, e.g. `@@ -12,3 +12,4 @@`.
const HUNK_RE = /^@@ /;
const FILE_RE = /^\+\+\+ b\/(.+)$/;

// parseDiff turns `git diff -U0` output into one entry per file carrying the
// content of every added or removed line. Line bodies are what the token
// extraction reads; line numbers are not needed to pick a spec.
function parseDiff(diffText) {
  const files = [];
  let current = null;
  for (const raw of String(diffText || '').split('\n')) {
    const fileMatch = FILE_RE.exec(raw);
    if (fileMatch) {
      current = { path: fileMatch[1], lines: [] };
      // /dev/null on a delete; the path is still worth recording.
      if (current.path !== 'dev/null') files.push(current);
      continue;
    }
    if (!current || HUNK_RE.test(raw)) continue;
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (raw.startsWith('+') || raw.startsWith('-')) current.lines.push(raw.slice(1));
  }
  return files;
}

// Prefix tokens a line mentions. One extractor covers all three renderer file
// types because they all name the same things: `.ag-row` in the stylesheet,
// `class="ag-row"` in the markup, `'.ag-row'` in a renderer query.
function tokensFromLine(line) {
  const out = new Set();
  const text = String(line || '');
  // .ag-row / #ag-list / class="ag-row" / id="ag-list"
  for (const m of text.matchAll(/[.#]([a-zA-Z]{2,8})-[a-zA-Z]/g)) out.add(m[1].toLowerCase());
  for (const m of text.matchAll(/(?:class|id)="([a-zA-Z]{2,8})-[a-zA-Z]/g)) out.add(m[1].toLowerCase());
  // data-page="agents" names a page outright.
  for (const m of text.matchAll(/data-page="([a-zA-Z]+)"/g)) out.add(`page:${m[1].toLowerCase()}`);
  // An IPC channel is the main process's own vocabulary for a feature.
  for (const m of text.matchAll(/['"`]([a-zA-Z]{3,20}):[a-zA-Z]/g)) out.add(`ipc:${m[1].toLowerCase()}`);
  return out;
}

function tokensForFile(file) {
  const out = new Set();
  for (const line of file.lines) for (const t of tokensFromLine(line)) out.add(t);
  return out;
}

// Everything the map needs to answer a lookup, indexed once per call.
function indexMap(map) {
  const byToken = new Map();
  const byPath = new Map();
  for (const [area, def] of Object.entries(map.areas || {})) {
    for (const t of def.tokens || []) {
      if (!byToken.has(t)) byToken.set(t, new Set());
      byToken.get(t).add(area);
    }
    for (const p of def.paths || []) {
      if (!byPath.has(p)) byPath.set(p, new Set());
      byPath.get(p).add(area);
    }
  }
  return { byToken, byPath };
}

function specsForAreas(map, areas) {
  const out = new Set(map.alwaysRun || []);
  for (const a of areas) for (const s of (map.areas[a] || {}).specs || []) out.add(s);
  return [...out].sort();
}

// selectSpecs decides what to run. Returns either the full suite or an explicit
// spec list, always with the reason, so a surprising selection can be argued
// with rather than guessed at.
function selectSpecs(diffText, map) {
  const files = parseDiff(diffText);
  if (!files.length) {
    return { full: false, specs: [...(map.alwaysRun || [])].sort(), areas: [], reasons: ['no changed files'] };
  }

  const { byToken, byPath } = indexMap(map);
  const shared = new Set(map.sharedTokens || []);
  const areas = new Set();
  const reasons = [];
  const full = (why) => ({ full: true, specs: [], areas: [], reasons: [...reasons, why] });

  for (const file of files) {
    const p = file.path;

    if ((map.fullSuiteWhenChanged || []).some((x) => p === x || p.startsWith(`${x}/`))) {
      return full(`${p} is shared by every spec`);
    }

    // A spec is its own signal: run the one that changed.
    const specMatch = /^test\/e2e\/(.+\.spec\.js)$/.exec(p);
    if (specMatch) {
      areas.add(`spec:${specMatch[1]}`);
      reasons.push(`${p} changed`);
      continue;
    }
    // Test scaffolding that any spec may pull in.
    if (p.startsWith('test/') && !p.startsWith('test/unit/')) {
      return full(`${p} is test scaffolding`);
    }
    // Unit tests and their subject are covered by the unit suite, which always
    // runs in full and costs under a second.
    if (p.startsWith('test/unit/')) { reasons.push(`${p} is unit-only`); continue; }

    const pathAreas = byPath.get(p);
    if (pathAreas) {
      for (const a of pathAreas) areas.add(a);
      reasons.push(`${p} maps to ${[...pathAreas].join(', ')}`);
      continue;
    }

    if (!(map.tokenScannedPaths || []).includes(p)) {
      return full(`${p} has no mapping`);
    }

    const tokens = tokensForFile(file);
    if (!tokens.size) return full(`${p} changed with no recognizable token`);

    const hitShared = [...tokens].filter((t) => shared.has(t));
    if (hitShared.length) {
      return full(`${p} touches shared chrome (${hitShared.slice(0, 4).join(', ')})`);
    }

    const matched = [];
    const unmatched = [];
    for (const t of tokens) {
      const owners = byToken.get(t);
      if (owners) { for (const a of owners) areas.add(a); matched.push(t); }
      else unmatched.push(t);
    }
    // A token nobody claims may name a feature the map has not learned yet, so
    // it is treated as unknown reach rather than as noise.
    if (!matched.length) return full(`${p} tokens are all unmapped (${unmatched.slice(0, 4).join(', ')})`);
    reasons.push(`${p} tokens ${matched.sort().join(', ')}`);
  }

  const specs = new Set(map.alwaysRun || []);
  for (const a of areas) {
    if (a.startsWith('spec:')) { specs.add(a.slice(5)); continue; }
    for (const s of (map.areas[a] || {}).specs || []) specs.add(s);
  }

  const areaList = [...areas].sort();
  // Past a few areas the selection stops being a saving and starts being a
  // guess about a cross-cutting change.
  const realAreas = areaList.filter((a) => !a.startsWith('spec:'));
  if (map.maxAreas && realAreas.length > map.maxAreas) {
    return full(`change spans ${realAreas.length} areas (${realAreas.join(', ')})`);
  }

  return { full: false, specs: [...specs].sort(), areas: areaList, reasons };
}

module.exports = { parseDiff, tokensFromLine, tokensForFile, selectSpecs, specsForAreas };
