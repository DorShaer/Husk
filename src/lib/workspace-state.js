'use strict';

// Pure helpers behind the Projects board and the per-project workspace view.
//
// Everything here is DERIVED, never persisted. The project record on disk
// stays the small thing the user created (id, name, path, timestamps); this
// layer answers "what is going on in that folder right now" from sources that
// already exist: git status, session transcripts, retained autopilot runs.
// Keeping it pure (no fs, no child_process) is what makes it unit-testable;
// main.js gathers the raw inputs and calls down into here.

const { parsePorcelain } = require('./git-porcelain');

// A project counts as recently active for this long after its last session or
// launch. Beyond it, a clean repo drops into the Quiet group.
const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Parse `git status --porcelain=v1 --branch` output. The `## ` header line
// carries the branch name and its distance from upstream; every other line is
// one changed path, which parsePorcelain already knows how to read (quoted
// paths, renames, conflict pairs). Header shapes handled:
//
//   ## main...origin/main [ahead 2, behind 1]
//   ## main...origin/main [gone]
//   ## main                          (no upstream configured)
//   ## No commits yet on main        (fresh repo)
//   ## HEAD (no branch)              (detached)
function parseGitStatus(text) {
  const out = { branch: null, ahead: 0, behind: 0, dirty: 0, conflicts: 0 };
  if (typeof text !== 'string' || !text) return out;
  const body = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('## ')) { body.push(line); continue; }
    const h = line.slice(3).trim();
    if (h.startsWith('No commits yet on ')) { out.branch = h.slice('No commits yet on '.length); continue; }
    if (h.startsWith('HEAD (no branch)')) { out.branch = 'detached'; continue; }
    const bracket = h.match(/\[([^\]]*)\]$/);
    if (bracket) {
      const a = bracket[1].match(/ahead (\d+)/);
      const b = bracket[1].match(/behind (\d+)/);
      if (a) out.ahead = Number(a[1]);
      if (b) out.behind = Number(b[1]);
    }
    const namePart = (bracket ? h.slice(0, bracket.index) : h).trim();
    const dots = namePart.indexOf('...');
    out.branch = dots === -1 ? namePart : namePart.slice(0, dots);
  }
  for (const e of parsePorcelain(body.join('\n'))) {
    if (e.status === 'ignored') continue;
    out.dirty += 1;
    if (e.status === 'conflicted') out.conflicts += 1;
  }
  return out;
}

// The board's whole point is priority, so grouping is the load-bearing logic:
//
//   Needs you  something is waiting on a human decision. Retained autopilot
//              worktrees are exactly that (kept alive for Apply/Discard), and
//              a merge conflict blocks everything until resolved.
//   Active     work is happening or recently happened: an agent is live in
//              the folder, the tree is dirty, or there was a session within
//              the window.
//   Quiet      everything else, including folders whose path has gone away
//              (those get a badge in the UI, not a group of their own; a
//              missing external drive should not shout from the top zone).
//
// Within a group: live folders first, then most recent activity, then name,
// so the ordering is stable when timestamps are missing.
function groupBoard(projects, states, nowMs) {
  const needsYou = [];
  const active = [];
  const quiet = [];
  const list = Array.isArray(projects) ? projects.filter((p) => p && p.id) : [];
  const stateOf = (p) => (states && states[p.id]) || {};
  const activityMs = (p) => {
    const st = stateOf(p);
    const used = Date.parse(p.lastUsedAt || '') || 0;
    return Math.max(st.lastSessionMs || 0, used);
  };
  for (const p of list) {
    const st = stateOf(p);
    if (!st.available) { quiet.push(p.id); continue; }
    if ((st.retainedCount || 0) > 0 || (st.conflicts || 0) > 0) { needsYou.push(p.id); continue; }
    const recent = nowMs - activityMs(p) < ACTIVE_WINDOW_MS;
    if (st.live || (st.dirty || 0) > 0 || (activityMs(p) > 0 && recent)) { active.push(p.id); continue; }
    quiet.push(p.id);
  }
  const byId = new Map(list.map((p) => [p.id, p]));
  const order = (a, b) => {
    const pa = byId.get(a); const pb = byId.get(b);
    const sa = stateOf(pa); const sb = stateOf(pb);
    if (!!sb.live - !!sa.live) return (!!sb.live - !!sa.live);
    const d = activityMs(pb) - activityMs(pa);
    if (d) return d;
    return String(pa.name || '').localeCompare(String(pb.name || ''));
  };
  needsYou.sort(order);
  active.sort(order);
  quiet.sort(order);
  return { needsYou, active, quiet };
}

module.exports = {
  ACTIVE_WINDOW_MS,
  parseGitStatus,
  groupBoard,
};
