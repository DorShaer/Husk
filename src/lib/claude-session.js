'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');

// Choose which claude session id to resume for a project dir on a fresh app
// boot, so relaunching Husk continues the ongoing discussion instead of minting
// a new session (which splits one conversation into many entries in the list).
//
// Order of preference:
//   1. a previously-saved id whose transcript still exists on disk
//   2. the newest transcript in the project dir (covers first upgrade, or a
//      session started outside Husk)
//   3. null -> the caller mints a fresh session id
//
// `deps` is injectable so this stays a pure, testable unit.
function pickResumeSessionId(projDir, savedId, deps) {
  const fs = (deps && deps.fs) || nodeFs;
  const path = (deps && deps.path) || nodePath;
  if (savedId) {
    try { if (fs.existsSync(path.join(projDir, `${savedId}.jsonl`))) return savedId; } catch (_) {}
  }
  try {
    const newest = fs.readdirSync(projDir)
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => {
        try { return { id: n.slice(0, -6), mtime: fs.statSync(path.join(projDir, n)).mtimeMs }; }
        catch (_) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)[0];
    return newest ? newest.id : null;
  } catch (_) { return null; }
}

module.exports = { pickResumeSessionId };
