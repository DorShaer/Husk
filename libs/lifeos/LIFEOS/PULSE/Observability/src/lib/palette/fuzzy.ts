// Local-lane scorer for the command palette. Zero-network, <1ms per entry.
// Tiers: exact prefix > word-boundary prefix > substring > subsequence.

function subsequenceScore(query: string, text: string): number {
  let qi = 0;
  let streak = 0;
  let best = 0;
  for (let ti = 0; ti < text.length && qi < query.length; ti++) {
    if (text[ti] === query[qi]) {
      qi++;
      streak++;
      if (streak > best) best = streak;
    } else {
      streak = 0;
    }
  }
  if (qi < query.length) return 0; // not all query chars found in order
  // Density bonus: longer contiguous runs rank higher.
  return 30 + Math.min(20, best * 4);
}

function scoreOne(query: string, text: string): number {
  const t = text.toLowerCase();
  if (t === query) return 110;
  if (t.startsWith(query)) return 100;
  // Word-boundary prefix ("gr" matches "memory graph")
  const words = t.split(/[\s/_-]+/);
  if (words.some((w) => w.startsWith(query))) return 80;
  if (t.includes(query)) return 60;
  return subsequenceScore(query, t);
}

/** 0 = no match. Higher = better. Keywords count at 80% weight. */
export function fuzzyScore(rawQuery: string, title: string, keywords?: string[]): number {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return 0;
  let score = scoreOne(query, title);
  for (const kw of keywords ?? []) {
    score = Math.max(score, scoreOne(query, kw) * 0.8);
  }
  return score;
}
