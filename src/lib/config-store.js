'use strict';

// Durable read and write of Husk's settings file. A save goes to a temp file in
// the same folder, is flushed, then renamed over the real file, so a crash
// leaves either the old file or the new one. Every good save is also copied to
// <file>.bak. A file that does not parse is kept as <file>.corrupt-<time>.

const nodeFs = require('fs');
const path = require('path');
const crypto = require('crypto');

function writeAtomic(file, text, { fs = nodeFs, mode = 0o600 } = {}) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w', mode);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    try { fs.chmodSync(tmp, mode); } catch (_) {}
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw err;
  }
  // The rename itself is durable once the folder entry is flushed.
  try { const d = fs.openSync(dir, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch (_) {}
}

function saveConfigFile(file, text, opts = {}) {
  writeAtomic(file, text, opts);
  try { writeAtomic(file + '.bak', text, opts); } catch (_) {}
}

function parseObject(text) {
  const v = JSON.parse(text);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('settings file is not an object');
  return v;
}

function stamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

// Returns { data, recovery }. data is null when there is no file (a new install)
// or nothing readable; recovery is null unless the file could not be read, then
// { corruptPath, from: 'backup' | 'defaults' }.
function loadConfigFile(file, { fs = nodeFs, now = () => new Date() } = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err && err.code === 'ENOENT') return { data: null, recovery: null };
    throw err;
  }
  try { return { data: parseObject(text), recovery: null }; } catch (_) {}
  let corruptPath = `${file}.corrupt-${stamp(now())}`;
  for (let i = 1; fs.existsSync(corruptPath); i++) corruptPath = `${file}.corrupt-${stamp(now())}-${i}`;
  fs.renameSync(file, corruptPath);
  try {
    const bakText = fs.readFileSync(file + '.bak', 'utf8');
    const data = parseObject(bakText);
    try { writeAtomic(file, bakText, { fs }); } catch (_) {}
    return { data, recovery: { corruptPath, from: 'backup' } };
  } catch (_) {
    return { data: null, recovery: { corruptPath, from: 'defaults' } };
  }
}

module.exports = { writeAtomic, saveConfigFile, loadConfigFile };
