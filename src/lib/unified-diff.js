'use strict';

// Parser and single-hunk patch builder for git's unified diff format.
//
// parseUnifiedDiff(text) turns `git diff` output into a hunk model: one entry
// per file, each carrying its hunks, each hunk carrying its lines with the
// number they hold on the old side and on the new side. The renderer paints
// from this model and the main process builds patches from it, so both read
// the same bytes the same way and cannot disagree about what a hunk is.
//
// buildHunkPatch(file, hunkIndex, opts) emits one hunk back out as a minimal
// single-file patch. The @@ counts are recomputed from the lines the hunk
// actually carries rather than copied, because a hunk lifted out of a larger
// diff has to stand on its own. opts.reverse emits the same hunk inverted.
//
// diffStat(files) totals the added and removed line counts.

// C-style escapes git writes inside a quoted path, mapped to byte values.
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

// The same table read the other way, for writing a path back out.
const ESCAPE_CHARS = {
  0x07: '\\a',
  0x08: '\\b',
  0x09: '\\t',
  0x0a: '\\n',
  0x0b: '\\v',
  0x0c: '\\f',
  0x0d: '\\r',
  0x22: '\\"',
  0x5c: '\\\\',
};

// Git wraps a path carrying special bytes in double quotes and escapes those
// bytes C-style. Decode the single-character escapes and the octal \NNN
// sequences back into the original UTF-8 path.
function decodeQuoted(raw) {
  const inner = raw.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== '\\') {
      const buf = Buffer.from(c, 'utf8');
      for (const b of buf) bytes.push(b);
      continue;
    }
    const next = inner[i + 1];
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
    // Unknown escape: keep the following character literally.
    const buf = Buffer.from(next, 'utf8');
    for (const b of buf) bytes.push(b);
    i++;
  }
  return Buffer.from(bytes).toString('utf8');
}

// A path needs quoting when any byte is a control byte, a quote, a backslash,
// or sits outside ASCII.
function needsQuoting(path) {
  const bytes = Buffer.from(path, 'utf8');
  for (const b of bytes) {
    if (b < 0x20 || b >= 0x7f || b === 0x22 || b === 0x5c) return true;
  }
  return false;
}

// The inside of a quoted path: escapes for the bytes that need one, octal for
// control bytes and for everything outside ASCII.
function escapeInner(path) {
  let out = '';
  for (const b of Buffer.from(path, 'utf8')) {
    if (Object.prototype.hasOwnProperty.call(ESCAPE_CHARS, b)) out += ESCAPE_CHARS[b];
    else if (b < 0x20 || b >= 0x7f) out += '\\' + b.toString(8).padStart(3, '0');
    else out += String.fromCharCode(b);
  }
  return out;
}

// Write a path the way git writes it, so a rebuilt header is byte identical to
// the one the same path came out of.
function quotePath(path) {
  if (!needsQuoting(path)) return path;
  return '"' + escapeInner(path) + '"';
}

// Both names on a `diff --git` line. Git quotes both as soon as either one
// needs it, so a pair is written together rather than one at a time.
function quotePair(a, b) {
  if (needsQuoting(a) || needsQuoting(b)) {
    return '"' + escapeInner(a) + '" "' + escapeInner(b) + '"';
  }
  return a + ' ' + b;
}

// Index of the quote that closes the one at position 0, or -1.
function quoteEnd(s) {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === '"') return i;
  }
  return -1;
}

// One path token, quoted or bare. A bare token runs to the tab git appends
// when the name holds a space, which is also where a classic unified diff
// keeps its timestamp field.
function readPathToken(rest) {
  if (rest.startsWith('"')) {
    const end = quoteEnd(rest);
    if (end === -1) return null;
    return decodeQuoted(rest.slice(0, end + 1));
  }
  const tab = rest.indexOf('\t');
  return tab === -1 ? rest : rest.slice(0, tab);
}

// Strip the a/ or b/ prefix git puts on both sides. /dev/null answers null so
// an added or deleted side is a missing path rather than a real one.
function stripPrefix(token, prefix) {
  if (token === null) return null;
  if (token === '/dev/null') return null;
  if (token.startsWith(prefix)) return token.slice(prefix.length);
  return token;
}

// The two paths on a `diff --git` line. Both sides carry the same name unless
// the file moved, so a symmetric split reads an unquoted name with spaces that
// a first-space split would cut in the wrong place.
function splitDiffGitPaths(rest) {
  if (rest.startsWith('"')) {
    const end = quoteEnd(rest);
    if (end === -1 || rest[end + 1] !== ' ') return null;
    return [rest.slice(0, end + 1), rest.slice(end + 2)];
  }
  const mid = (rest.length - 1) / 2;
  if (Number.isInteger(mid) && rest[mid] === ' ') {
    const a = rest.slice(0, mid);
    const b = rest.slice(mid + 1);
    if (a.slice(2) === b.slice(2)) return [a, b];
  }
  const sp = rest.indexOf(' ');
  if (sp === -1) return null;
  return [rest.slice(0, sp), rest.slice(sp + 1)];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function newFile() {
  return {
    oldPath: null,
    newPath: null,
    status: 'modified',
    isBinary: false,
    isRename: false,
    similarity: null,
    oldMode: null,
    newMode: null,
    adds: 0,
    dels: 0,
    hunks: [],
  };
}

// Status follows the header lines git wrote, falling back to whichever side is
// missing when only the /dev/null form is present.
function settleStatus(file) {
  if (file.isRename) {
    file.status = 'renamed';
    return;
  }
  if (file.status === 'copied') return;
  if (file.oldPath === null && file.newPath !== null) file.status = 'added';
  else if (file.newPath === null && file.oldPath !== null) file.status = 'deleted';
  else file.status = 'modified';
}

function parseUnifiedDiff(text) {
  if (typeof text !== 'string' || text.length === 0) return { files: [] };

  const files = [];
  let file = null;
  let hunk = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;

  const closeHunk = () => {
    hunk = null;
    oldLeft = 0;
    newLeft = 0;
  };

  const closeFile = () => {
    closeHunk();
    if (file) settleStatus(file);
    file = null;
  };

  const openFile = () => {
    closeFile();
    file = newFile();
    files.push(file);
    return file;
  };

  try {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // The marker attaches to the line above it and can arrive after the hunk
      // has already been paid out in full.
      if (hunk && line.startsWith('\\')) {
        hunk.lines.push({ kind: 'nonl', oldNo: null, newNo: null, text: line.slice(2) });
        continue;
      }

      if (hunk && (oldLeft > 0 || newLeft > 0)) {
        const c = line[0];
        if (c === '+') {
          hunk.lines.push({ kind: 'add', oldNo: null, newNo, text: line.slice(1) });
          newNo++;
          newLeft--;
          file.adds++;
          continue;
        }
        if (c === '-') {
          hunk.lines.push({ kind: 'del', oldNo, newNo: null, text: line.slice(1) });
          oldNo++;
          oldLeft--;
          file.dels++;
          continue;
        }
        if (c === ' ' || line === '') {
          hunk.lines.push({ kind: 'ctx', oldNo, newNo, text: line.slice(1) });
          oldNo++;
          newNo++;
          oldLeft--;
          newLeft--;
          continue;
        }
        // Anything else means the hunk ended earlier than its header claimed.
        closeHunk();
      }

      if (line.startsWith('diff --git ')) {
        const pair = splitDiffGitPaths(line.slice(11));
        const f = openFile();
        if (pair) {
          f.oldPath = stripPrefix(readPathToken(pair[0]), 'a/');
          f.newPath = stripPrefix(readPathToken(pair[1]), 'b/');
        }
        continue;
      }

      if (line.startsWith('--- ')) {
        closeHunk();
        if (!file || file.hunks.length > 0) openFile();
        file.oldPath = stripPrefix(readPathToken(line.slice(4)), 'a/');
        continue;
      }

      if (line.startsWith('+++ ')) {
        if (!file) openFile();
        closeHunk();
        file.newPath = stripPrefix(readPathToken(line.slice(4)), 'b/');
        continue;
      }

      const m = HUNK_RE.exec(line);
      if (m && file) {
        const fn = m[5].startsWith(' ') ? m[5].slice(1) : m[5];
        hunk = {
          header: line,
          fn,
          oldStart: parseInt(m[1], 10),
          oldLines: m[2] === undefined ? 1 : parseInt(m[2], 10),
          newStart: parseInt(m[3], 10),
          newLines: m[4] === undefined ? 1 : parseInt(m[4], 10),
          lines: [],
        };
        file.hunks.push(hunk);
        oldLeft = hunk.oldLines;
        newLeft = hunk.newLines;
        oldNo = hunk.oldStart;
        newNo = hunk.newStart;
        continue;
      }

      if (!file) continue;

      if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
        file.isBinary = true;
        continue;
      }
      if (line.startsWith('new file mode ')) {
        file.newMode = line.slice(14).trim();
        file.oldPath = null;
        file.status = 'added';
        continue;
      }
      if (line.startsWith('deleted file mode ')) {
        file.oldMode = line.slice(18).trim();
        file.newPath = null;
        file.status = 'deleted';
        continue;
      }
      if (line.startsWith('old mode ')) {
        file.oldMode = line.slice(9).trim();
        continue;
      }
      if (line.startsWith('new mode ')) {
        file.newMode = line.slice(9).trim();
        continue;
      }
      if (line.startsWith('similarity index ') || line.startsWith('dissimilarity index ')) {
        const pct = /(\d+)%/.exec(line);
        if (pct) file.similarity = parseInt(pct[1], 10);
        continue;
      }
      if (line.startsWith('rename from ')) {
        file.oldPath = readPathToken(line.slice(12));
        file.isRename = true;
        continue;
      }
      if (line.startsWith('rename to ')) {
        file.newPath = readPathToken(line.slice(10));
        file.isRename = true;
        continue;
      }
      if (line.startsWith('copy from ')) {
        file.oldPath = readPathToken(line.slice(10));
        file.status = 'copied';
        continue;
      }
      if (line.startsWith('copy to ')) {
        file.newPath = readPathToken(line.slice(8));
        file.status = 'copied';
        continue;
      }
    }
  } catch (_) {
    return { files: [] };
  }

  closeFile();
  return { files };
}

// One header side, with the tab git appends when the name holds a space.
function sideLine(marker, prefix, path) {
  if (path === null || path === undefined) return marker + ' /dev/null';
  const full = prefix + path;
  return marker + ' ' + quotePath(full) + (full.includes(' ') ? '\t' : '');
}

function countText(start, count) {
  return count === 1 ? String(start) : start + ',' + count;
}

// A minimal patch carrying one hunk, ready for `git apply`.
//
// The counts come from the lines the hunk holds rather than from the header it
// was parsed out of, because a hunk taken out of a longer diff is applied on
// its own preimage. The new-side start follows the old-side start for the same
// reason: nothing ahead of this hunk has been applied.
function buildHunkPatch(file, hunkIndex, opts) {
  const reverse = !!(opts && opts.reverse);
  if (!file || typeof file !== 'object' || !Array.isArray(file.hunks)) return null;
  if (file.isBinary) return null;
  if (!Number.isInteger(hunkIndex) || hunkIndex < 0 || hunkIndex >= file.hunks.length) return null;

  const hunk = file.hunks[hunkIndex];
  if (!hunk || !Array.isArray(hunk.lines)) return null;

  const body = [];
  let ctx = 0;
  let adds = 0;
  let dels = 0;
  for (const line of hunk.lines) {
    if (!line || typeof line.text !== 'string') continue;
    if (line.kind === 'nonl') {
      body.push('\\ ' + line.text);
      continue;
    }
    if (line.kind === 'add') {
      adds++;
      body.push((reverse ? '-' : '+') + line.text);
      continue;
    }
    if (line.kind === 'del') {
      dels++;
      body.push((reverse ? '+' : '-') + line.text);
      continue;
    }
    if (line.kind === 'ctx') {
      ctx++;
      body.push(' ' + line.text);
    }
  }
  if (body.length === 0) return null;

  let aPath = reverse ? file.newPath : file.oldPath;
  let bPath = reverse ? file.oldPath : file.newPath;
  let aStart = reverse ? hunk.newStart : hunk.oldStart;
  let bStart = reverse ? hunk.oldStart : hunk.newStart;
  const aCount = ctx + (reverse ? adds : dels);
  const bCount = ctx + (reverse ? dels : adds);
  if (aCount > 0 && bCount > 0) bStart = aStart;

  // Git names both sides on the `diff --git` line even when one of them is
  // /dev/null, so borrow the side that exists.
  const namedA = aPath === null ? bPath : aPath;
  const namedB = bPath === null ? aPath : bPath;
  if (namedA === null || namedB === null) return null;

  // The mode belongs to the side that exists, which reverse swaps along with
  // everything else.
  const aMode = reverse ? file.newMode : file.oldMode;
  const bMode = reverse ? file.oldMode : file.newMode;

  const out = ['diff --git ' + quotePair('a/' + namedA, 'b/' + namedB)];
  if (aPath === null && bMode) out.push('new file mode ' + bMode);
  if (bPath === null && aMode) out.push('deleted file mode ' + aMode);
  if (file.isRename && aPath !== null && bPath !== null && aPath !== bPath) {
    if (typeof file.similarity === 'number') out.push('similarity index ' + file.similarity + '%');
    out.push('rename from ' + aPath);
    out.push('rename to ' + bPath);
  }
  out.push(sideLine('---', 'a/', aPath));
  out.push(sideLine('+++', 'b/', bPath));
  out.push(
    '@@ -' + countText(aStart, aCount) + ' +' + countText(bStart, bCount) + ' @@'
    + (hunk.fn ? ' ' + hunk.fn : ''),
  );
  for (const b of body) out.push(b);
  return out.join('\n') + '\n';
}

function diffStat(files) {
  let adds = 0;
  let dels = 0;
  if (!Array.isArray(files)) return { adds, dels };
  for (const f of files) {
    if (!f || typeof f !== 'object') continue;
    if (Number.isFinite(f.adds)) adds += f.adds;
    if (Number.isFinite(f.dels)) dels += f.dels;
  }
  return { adds, dels };
}

module.exports = {
  parseUnifiedDiff,
  buildHunkPatch,
  diffStat,
};
