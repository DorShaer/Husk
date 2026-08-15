'use strict';

// Line-count deltas for a run's touched files.
//
// A stacked change bar and a plus/minus pair need two numbers per file. The
// comparison is a multiset over lines, which costs one pass per side and no
// quadratic table, so a whole run's diff stays cheap to summarize.

// countLines reports how many lines a body of text holds. Empty text is zero
// lines, and a trailing newline does not invent one.
function countLines(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return s.charCodeAt(s.length - 1) === 10 ? n - 1 : n;
}

function tally(text) {
  const counts = new Map();
  const s = String(text == null ? '' : text);
  if (!s) return counts;
  const lines = s.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) counts.set(line, (counts.get(line) || 0) + 1);
  return counts;
}

// lineDelta reports how many lines the after side gains and loses against the
// before side. Lines that survive in place, or move, count as neither.
function lineDelta(before, after) {
  const a = tally(before);
  const b = tally(after);
  let insertions = 0;
  let deletions = 0;
  for (const [line, n] of b) {
    const was = a.get(line) || 0;
    if (n > was) insertions += n - was;
  }
  for (const [line, n] of a) {
    const now = b.get(line) || 0;
    if (n > now) deletions += n - now;
  }
  return { insertions, deletions };
}

// emptyRunStats is the shape every run summary carries, so a caller can add to
// it without checking for missing fields.
function emptyRunStats() {
  return { files: 0, added: 0, modified: 0, deleted: 0, insertions: 0, deletions: 0, truncated: false };
}

// addFileDelta folds one file's outcome into a run's running totals.
function addFileDelta(stats, status, delta) {
  const out = stats || emptyRunStats();
  out.files += 1;
  if (status === 'added') out.added += 1;
  else if (status === 'deleted') out.deleted += 1;
  else out.modified += 1;
  out.insertions += Math.max(0, Number(delta && delta.insertions) || 0);
  out.deletions += Math.max(0, Number(delta && delta.deletions) || 0);
  return out;
}

module.exports = { countLines, lineDelta, emptyRunStats, addFileDelta };
