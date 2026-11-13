(function () {
'use strict';

// What moved in the working tree between two status reads. A chat turn takes a
// read when it opens and another when it closes; the difference is what changed
// while the turn ran. It is a time window, not an author: anything else writing
// to the tree in that window is counted too, and the wording at the call site
// says "during this turn" for that reason.

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }

// One row per dirty path, from a git:status reply and its parsed porcelain.
// A path staged and unstaged at once sums both sides of its numstat.
function snapshot(status, entries) {
  const out = Object.create(null);
  const s = status && typeof status === 'object' ? status : {};
  const mtimes = s.mtimes && typeof s.mtimes === 'object' ? s.mtimes : {};
  const stat = Object.create(null);
  const sides = s.numstat && typeof s.numstat === 'object' ? [s.numstat.staged, s.numstat.unstaged] : [];
  for (const side of sides) {
    for (const n of Array.isArray(side) ? side : []) {
      if (!n || typeof n.path !== 'string') continue;
      const cur = stat[n.path] || (stat[n.path] = { adds: 0, dels: 0 });
      cur.adds += num(n.adds);
      cur.dels += num(n.dels);
    }
  }
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e.path !== 'string' || !e.path || e.status === 'ignored') continue;
    const st = stat[e.path] || { adds: 0, dels: 0 };
    const mtime = Object.prototype.hasOwnProperty.call(mtimes, e.path) ? mtimes[e.path] : null;
    out[e.path] = {
      path: e.path,
      status: String(e.status || ''),
      staged: !!e.staged,
      unstaged: !!e.unstaged,
      adds: st.adds,
      dels: st.dels,
      sig: [e.status, e.staged ? 1 : 0, e.unstaged ? 1 : 0, mtime === null ? '' : mtime, st.adds, st.dels].join('|'),
    };
  }
  return out;
}

// Paths dirty now whose row differs from the earlier read, or was not in it.
// A path that left the dirty set (committed, reverted) is not listed: there is
// no working-tree change left to show for it.
function changedBetween(before, after) {
  const a = before && typeof before === 'object' ? before : {};
  const b = after && typeof after === 'object' ? after : {};
  const files = [];
  let adds = 0;
  let dels = 0;
  for (const p of Object.keys(b).sort()) {
    const now = b[p];
    const was = a[p];
    if (was && was.sig === now.sig) continue;
    files.push({ path: now.path, status: now.status, staged: now.staged, unstaged: now.unstaged, adds: now.adds, dels: now.dels });
    adds += now.adds;
    dels += now.dels;
  }
  return { files, adds, dels };
}

(function publish(exports) {
  if (typeof module !== 'undefined' && module.exports) module.exports = exports;
  if (typeof window !== 'undefined') window.HuskTurnChanges = exports;
})({ snapshot, changedBetween });
})();
