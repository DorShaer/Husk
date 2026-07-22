// Frecency store for the command palette: log-decayed selection counts in
// localStorage. The thing you pick daily floats to the top; the empty-query
// state IS this list.

const KEY = "pulse.palette.frecency";
const MAX_ENTRIES = 200;
const HALF_LIFE_DAYS = 14;

interface FrecencyEntry {
  count: number;
  last: number; // epoch ms
}

type Store = Record<string, FrecencyEntry>;

function load(): Store {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as Store;
  } catch {
    return {};
  }
}

function save(store: Store) {
  try {
    const ids = Object.keys(store);
    if (ids.length > MAX_ENTRIES) {
      ids
        .sort((a, b) => store[a].last - store[b].last)
        .slice(0, ids.length - MAX_ENTRIES)
        .forEach((id) => delete store[id]);
    }
    window.localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // storage full/unavailable — frecency is a nicety, never an error
  }
}

export function recordSelection(id: string) {
  const store = load();
  const cur = store[id] ?? { count: 0, last: 0 };
  store[id] = { count: cur.count + 1, last: Date.now() };
  save(store);
}

function decayedScore(e: FrecencyEntry): number {
  const ageDays = (Date.now() - e.last) / 86_400_000;
  return e.count * Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

/** Rank boost added to fuzzy match scores. */
export function frecencyBoost(id: string, store?: Store): number {
  const s = store ?? load();
  const e = s[id];
  if (!e) return 0;
  return Math.min(25, decayedScore(e) * 5);
}

/** Top-N ids by decayed score, for the empty-query recents view. */
export function topRecents(n: number): string[] {
  const store = load();
  return Object.keys(store)
    .sort((a, b) => decayedScore(store[b]) - decayedScore(store[a]))
    .slice(0, n);
}

export function loadStore(): Store {
  return load();
}
