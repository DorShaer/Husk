'use strict';

// Parsers for the machine-readable ref surfaces.
//
// parseForEachRef   the \x1f-delimited for-each-ref format
// parseTrack        the '[ahead 2, behind 1]' upstream-track field
// parseWorktreeList `git worktree list --porcelain`
// parseLogRecords   the \x1f field / \x1e record log format
// parseNumstat      `git diff --numstat`, with or without -z
//
// Every parser answers an array and never throws: malformed input reads as no
// records rather than as an error.

const FIELD = '\x1f';
const RECORD = '\x1e';

// C-style escapes git emits inside quoted paths, mapped to byte values.
const ESCAPE_BYTES = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  '\\': 0x5c,
  '"': 0x22,
};

// Git quotes a path with special characters and escapes the bytes C-style.
// Decode the single-character escapes and octal \NNN back into the real path.
function unquote(raw) {
  if (typeof raw !== 'string') return '';
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return raw;
  const inner = raw.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== '\\') {
      for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
      continue;
    }
    const next = inner[i + 1];
    if (next === undefined) break;
    if (next >= '0' && next <= '7') {
      let oct = next;
      let j = i + 2;
      while (j < inner.length && oct.length < 3 && inner[j] >= '0' && inner[j] <= '7') {
        oct += inner[j];
        j++;
      }
      bytes.push(parseInt(oct, 8) & 0xff);
      i = j - 1;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(ESCAPE_BYTES, next)) {
      bytes.push(ESCAPE_BYTES[next]);
      i++;
      continue;
    }
    for (const b of Buffer.from(next, 'utf8')) bytes.push(b);
    i++;
  }
  return Buffer.from(bytes).toString('utf8');
}

function toMs(unix) {
  const n = Number(unix);
  return Number.isFinite(n) && unix !== '' ? n * 1000 : null;
}

// The upstream-track field. An empty field means in sync, so it reads as zero
// and zero, and a gone upstream carries no counts at all.
function parseTrack(text) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (s === '[gone]') return { ahead: 0, behind: 0, gone: true };
  const ahead = s.match(/\bahead (\d+)/);
  const behind = s.match(/\bbehind (\d+)/);
  return {
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
    gone: false,
  };
}

// for-each-ref, one ref per line, eight \x1f-delimited fields in the order the
// git:branches format declares them.
function parseForEachRef(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const f = line.split(FIELD);
    if (f.length < 8 || !f[0]) continue;
    const upstream = f[2] || null;
    const track = parseTrack(f[3]);
    out.push({
      name: f[0],
      sha: f[1] || null,
      upstream,
      ahead: upstream && !track.gone ? track.ahead : null,
      behind: upstream && !track.gone ? track.behind : null,
      gone: track.gone,
      dateMs: toMs(f[4]),
      subject: f[5] || '',
      isHead: f[6] === '*',
      worktreePath: f[7] || null,
    });
  }
  return out;
}

// worktree list --porcelain: blank-line separated records of key or key-value
// lines. A branch is reported short, so a caller can compare it to a name.
function parseWorktreeList(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  let cur = null;
  const push = () => { if (cur) out.push(cur); cur = null; };
  for (const line of text.split('\n')) {
    if (!line) { push(); continue; }
    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? '' : line.slice(sp + 1);
    if (key === 'worktree') {
      push();
      cur = { path: value, head: null, branch: null, detached: false, bare: false, locked: false };
      continue;
    }
    if (!cur) continue;
    if (key === 'HEAD') cur.head = value || null;
    else if (key === 'branch') cur.branch = value.replace(/^refs\/heads\//, '') || null;
    else if (key === 'detached') cur.detached = true;
    else if (key === 'bare') cur.bare = true;
    else if (key === 'locked') cur.locked = true;
  }
  push();
  return out;
}

// The log format: nine \x1f fields per record, records closed by \x1e, so a
// body carrying its own newlines survives the parse.
function parseLogRecords(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const chunk of text.split(RECORD)) {
    const rec = chunk.replace(/^[\r\n]+/, '');
    if (!rec) continue;
    const f = rec.split(FIELD);
    if (f.length < 9 || !f[0]) continue;
    out.push({
      sha: f[0],
      shortSha: f[1],
      parents: f[2] ? f[2].split(' ').filter(Boolean) : [],
      author: f[3],
      email: f[4],
      dateMs: toMs(f[5]),
      refs: f[6] ? f[6].split(',').map((r) => r.trim()).filter(Boolean) : [],
      subject: f[7],
      body: f.slice(8).join(FIELD).replace(/[\r\n]+$/, ''),
    });
  }
  return out;
}

// A numstat path field. Git shortens a rename to a brace form in the line
// format and leaves the two paths as separate NUL fields in the -z format.
function splitRename(field) {
  const brace = field.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (brace) {
    const join = (mid) => (brace[1] + mid + brace[4]).replace(/\/{2,}/g, '/');
    return { oldPath: join(brace[2]), newPath: join(brace[3]) };
  }
  const arrow = field.indexOf(' => ');
  if (arrow !== -1) {
    return { oldPath: field.slice(0, arrow), newPath: field.slice(arrow + 4) };
  }
  return null;
}

function numstatEntry(addsRaw, delsRaw, pathField, oldPath) {
  const binary = addsRaw === '-' || delsRaw === '-';
  return {
    adds: binary ? 0 : Number(addsRaw) || 0,
    dels: binary ? 0 : Number(delsRaw) || 0,
    path: pathField,
    oldPath: oldPath || null,
    binary,
  };
}

// -z: NUL-terminated records. A rename leaves the path field empty and follows
// with the old path and the new path as two more records.
function parseNumstatZ(text) {
  const out = [];
  const tok = text.split('\0');
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i];
    if (!t) continue;
    const a = t.indexOf('\t');
    if (a === -1) continue;
    const b = t.indexOf('\t', a + 1);
    if (b === -1) continue;
    const adds = t.slice(0, a);
    const dels = t.slice(a + 1, b);
    const rest = t.slice(b + 1);
    if (rest === '') {
      const oldPath = tok[i + 1];
      const newPath = tok[i + 2];
      if (oldPath === undefined || newPath === undefined) break;
      out.push(numstatEntry(adds, dels, newPath, oldPath));
      i += 2;
      continue;
    }
    out.push(numstatEntry(adds, dels, rest, null));
  }
  return out;
}

// Line format: two counts, a tab, then the path, quoted when it carries
// special characters and shortened to a brace form when it is a rename.
function parseNumstatLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const a = line.indexOf('\t');
    if (a === -1) continue;
    const b = line.indexOf('\t', a + 1);
    if (b === -1) continue;
    const adds = line.slice(0, a);
    const dels = line.slice(a + 1, b);
    const field = line.slice(b + 1);
    const ren = splitRename(field);
    if (ren) out.push(numstatEntry(adds, dels, unquote(ren.newPath), unquote(ren.oldPath)));
    else out.push(numstatEntry(adds, dels, unquote(field), null));
  }
  return out;
}

function parseNumstat(text) {
  if (typeof text !== 'string' || !text) return [];
  return text.indexOf('\0') === -1 ? parseNumstatLines(text) : parseNumstatZ(text);
}

module.exports = {
  parseForEachRef,
  parseTrack,
  parseWorktreeList,
  parseLogRecords,
  parseNumstat,
};
