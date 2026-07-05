'use strict';

// Subsequence fuzzy matching for command palettes and file pickers.
//
// fuzzyMatch(query, target) returns null when query is not a
// case-insensitive subsequence of target, otherwise a { score, positions }
// object. Scoring rewards consecutive matches, matches at word boundaries,
// and matches earlier in the string; it penalizes gaps between matches.
//
// fuzzyFilter(query, items, keyFn) keeps only the items whose key matches
// and returns them sorted by score descending, with stable tie-breaking.

// Bonus and penalty weights. Tuned so that a boundary or consecutive match
// clearly outranks a scattered subsequence match of the same characters.
const SCORE_MATCH = 16;          // base reward for any matched character
const SCORE_CONSECUTIVE = 18;    // extra when this match follows the previous one
const SCORE_BOUNDARY = 12;       // extra when the match starts a word
const SCORE_FIRST_CHAR = 6;      // extra when the match is at index 0
const PENALTY_GAP = 2;           // per skipped character between matches
const PENALTY_LEADING = 1;       // per skipped character before the first match

// A word boundary is the start of the string, or a position that follows a
// separator, or a camelCase hump (lowercase or digit followed by uppercase).
function isBoundary(target, index) {
  if (index === 0) return true;
  const prev = target[index - 1];
  if (prev === '/' || prev === '_' || prev === '-' || prev === '.' || prev === ' ') {
    return true;
  }
  const cur = target[index];
  const prevLower = prev >= 'a' && prev <= 'z';
  const prevDigit = prev >= '0' && prev <= '9';
  const curUpper = cur >= 'A' && cur <= 'Z';
  if ((prevLower || prevDigit) && curUpper) return true;
  return false;
}

function fuzzyMatch(query, target) {
  if (typeof query !== 'string' || typeof target !== 'string') return null;
  if (query.length === 0) return { score: 0, positions: [] };
  if (query.length > target.length) return null;

  const q = query.toLowerCase();
  const t = target.toLowerCase();

  const positions = [];
  let score = 0;
  let qi = 0;
  let prevMatch = -1;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;

    positions.push(ti);
    let charScore = SCORE_MATCH;

    if (prevMatch === -1) {
      // Reward matches that land early in the string.
      score -= ti * PENALTY_LEADING;
      if (ti === 0) charScore += SCORE_FIRST_CHAR;
    } else {
      const gap = ti - prevMatch - 1;
      if (gap === 0) {
        charScore += SCORE_CONSECUTIVE;
      } else {
        score -= gap * PENALTY_GAP;
      }
    }

    if (isBoundary(target, ti)) charScore += SCORE_BOUNDARY;

    score += charScore;
    prevMatch = ti;
    qi++;
  }

  if (qi !== q.length) return null;
  return { score, positions };
}

function identity(x) {
  return x;
}

function fuzzyFilter(query, items, keyFn) {
  const key = typeof keyFn === 'function' ? keyFn : identity;
  const list = Array.isArray(items) ? items : [];

  if (typeof query !== 'string' || query.length === 0) {
    return list.slice();
  }

  const scored = [];
  for (let i = 0; i < list.length; i++) {
    const target = key(list[i]);
    const match = fuzzyMatch(query, typeof target === 'string' ? target : String(target));
    if (match === null) continue;
    scored.push({
      item: list[i],
      score: match.score,
      length: typeof target === 'string' ? target.length : String(target).length,
      index: i,
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.length !== b.length) return a.length - b.length;
    return a.index - b.index;
  });

  return scored.map((s) => s.item);
}

module.exports = {
  fuzzyMatch,
  fuzzyFilter,
  isBoundary,
};
