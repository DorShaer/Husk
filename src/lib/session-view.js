'use strict';

// The Sessions roster's view model: filtering, threading, grouping, ordering
// and the label formats the rows read from. Pure functions over plain data,
// with the clock injected, so the whole pipeline is unit-testable and the
// renderer only paints what it is handed.

const { agentState } = require('./agent-state');

const DAY_MS = 86400000;
// Today plus the six previous calendar days stay in the roster; the rest goes
// to the Older drawer.
const OLDER_DAYS = 7;
// How much of the title an excerpt has to differ from before it earns a line.
const TITLE_KEY_LEN = 40;
// Below this length a query must appear in the title, not merely be a
// subsequence of it.
const FUZZY_MIN_Q = 4;
// Joins the two halves of a thread key. Never appears in a path or a title.
const SEP = '\u0000';

const pad2 = (n) => String(n).padStart(2, '0');

// Building a formatter is most of the cost of formatting a date, and every row
// formats one on every paint, so they are built once and kept.
const FORMATS = {
  clock: { hour: '2-digit', minute: '2-digit' },
  weekday: { weekday: 'short' },
  dayMonth: { day: 'numeric', month: 'short' },
  dayMonthYear: { day: 'numeric', month: 'short', year: '2-digit' },
  weekdayDayMonth: { weekday: 'short', day: 'numeric', month: 'short' },
  monthYear: { month: 'long', year: 'numeric' },
};
const formatters = new Map();
function fmt(name, ms) {
  let f = formatters.get(name);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, FORMATS[name]);
    formatters.set(name, f);
  }
  return f.format(new Date(ms));
}

// Local calendar day, never a division of the timestamp: an hour of DST would
// otherwise move a session to the wrong day twice a year.
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function dayIndex(ms) {
  const d = new Date(ms);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

function dayDiff(ms, now) {
  return dayIndex(now) - dayIndex(ms);
}

// An undated session stays in the roster rather than disappearing into a
// drawer nobody opens.
function isOlder(session, now) {
  if (!session || !session.mtime) return false;
  return dayDiff(session.mtime, now) >= OLDER_DAYS;
}

function normPath(p) {
  return String(p || '').replace(/\/+$/, '');
}

// The directory the session actually ran in. The recorded cwd is authoritative;
// the project path is a decode of the directory name and only a fallback.
function sessionCwd(s) {
  return normPath((s && s.originalCwd) || (s && s.projectPath));
}

function basename(p) {
  const segs = normPath(p).split('/').filter(Boolean);
  return segs.length ? segs[segs.length - 1] : '';
}

function inCurrentProject(s, currentCwd) {
  const cur = normPath(currentCwd);
  return cur !== '' && sessionCwd(s) === cur;
}

const norm = (x) => String(x == null ? '' : x).toLowerCase().replace(/\s+/g, ' ').trim();

function titleOf(s, names) {
  const custom = names && s ? names[s.id] : '';
  return String(custom || (s && s.title) || '');
}

// ─── Liveness ───────────────────────────────────────────────────────────────

// What the row says about work in flight, or null when nothing is. Blocked
// outranks running everywhere: a chat with an agent stuck on a question needs
// the row to say so even while its siblings are busy.
//
// `needs` is preferred over `detail` for a blocked agent. That inverts the
// order the agent switcher uses, because the one string worth a row is the
// question the agent is stuck on.
function signal(s, ctx) {
  if (!s || !ctx) return null;
  const byParent = ctx.byParent || new Map();
  const bySession = ctx.bySession || new Map();
  const kids = byParent.get(s.id) || [];
  const self = bySession.get(s.id) || null;
  const st = (a) => agentState(a.state, { started: !!a.hasTranscript });

  const blocked = kids.filter((a) => a.running && st(a) === 'blocked');
  const running = kids.filter((a) => a.running && st(a) !== 'blocked');
  const failed = kids.filter((a) => st(a) === 'failed');

  if (self && self.running && st(self) === 'blocked') {
    return { kind: 'blocked', tok: 'needs you', cont: self.needs || self.detail || '' };
  }
  if (blocked.length) {
    return { kind: 'blocked', tok: `${blocked.length} needs you`, cont: blocked[0].needs || blocked[0].detail || '' };
  }
  if (self && self.running) {
    return { kind: 'running', tok: 'working', cont: self.detail || self.intent || self.status || '' };
  }
  if (running.length) {
    return { kind: 'running', tok: `${running.length} working`, cont: running[0].detail || running[0].intent || running[0].status || '' };
  }
  if (failed.length) {
    return { kind: 'failed', tok: `${failed.length} failed`, cont: failed[0].detail || '' };
  }
  if (self && self.held) {
    return { kind: 'held', tok: 'held by an agent', cont: self.name || '' };
  }
  return null;
}

function signalKind(s, ctx) {
  const sig = signal(s, ctx);
  return sig ? sig.kind : '';
}

// The trailing prose on a row: what is happening, or what was asked, or
// nothing. The gate on `named` is deliberate, since an unnamed session's title
// IS its first message and an excerpt would restate it. A work item's slug is
// not prose and does not earn the line; the pane carries it.
function scent(s, sig, names) {
  if (sig) return sig.cont || '';
  if (s && s.named && s.firstMessage) {
    const a = norm(s.firstMessage);
    const b = norm(titleOf(s, names)).slice(0, TITLE_KEY_LEN);
    if (!b || !a.startsWith(b)) return s.firstMessage;
  }
  return '';
}

// ─── Filtering ──────────────────────────────────────────────────────────────

// Chips first, then search. An agent listed in its own right is shown only
// under the chat that started it, and only while that chat survives the filter.
function filterSessions(list, ctx) {
  const c = ctx || {};
  const chips = c.chips || {};
  const bySession = c.bySession || new Map();
  let out = Array.isArray(list) ? list.slice() : [];

  if (chips.project && c.currentCwd) out = out.filter((s) => inCurrentProject(s, c.currentCwd));
  if (chips.live) out = out.filter((s) => { const k = signalKind(s, c); return k === 'running' || k === 'blocked'; });
  if (chips.needs) out = out.filter((s) => signalKind(s, c) === 'blocked');
  if (chips.work) out = out.filter((s) => !!(s.prdSlug || s.prdPath));

  const present = new Set(out.map((s) => s.id));
  out = out.filter((s) => {
    const a = bySession.get(s.id);
    return !(a && a.parentSessionId && present.has(a.parentSessionId));
  });

  const q = String(c.query || '').trim();
  if (!q) return { rows: out, flat: false, hits: new Map() };

  // Two stages. Scored fuzzy on the title, which is what a person types, then
  // the substring behaviour the page has today so nothing that matches now
  // stops matching.
  const hits = new Map();
  const scored = [];
  const ql = q.toLowerCase();
  const match = typeof c.fuzzyMatch === 'function' ? c.fuzzyMatch : null;
  // A subsequence match on a short query is nearly free: "th" hits any title
  // with a t before an h. Under the threshold the query has to actually appear.
  const loose = q.length >= FUZZY_MIN_Q;
  out.forEach((s, i) => {
    const title = titleOf(s, c.names);
    const m = match && (loose || title.toLowerCase().includes(ql)) ? match(q, title) : null;
    if (m) {
      scored.push({ s, score: m.score + 1000, i });
      hits.set(s.id, m.positions);
      return;
    }
    const blob = [s.id, s.projectPath, s.prdPhase, s.prdSlug, s.firstMessage].join(' ').toLowerCase();
    if (blob.includes(ql)) scored.push({ s, score: 0, i });
  });
  scored.sort((a, b) => b.score - a.score || b.s.mtime - a.s.mtime || a.i - b.i);
  return { rows: scored.map((x) => x.s), flat: true, hits };
}

// ─── Threading ──────────────────────────────────────────────────────────────

// Repeated runs of the same task in the same project collapse to one row that
// counts them. Untitled rows never thread: their titles are not evidence of
// anything. The bucket is the directory grouping also uses, so a head and its
// siblings can never land in different groups, and the separator is a character
// no path or title contains, so two spellings cannot collide.
function threadKey(s, names) {
  const t = norm(titleOf(s, names));
  if (!t || t === '(empty)') return '';
  return sessionCwd(s) + SEP + t;
}

function collapseThreads(rows, opts) {
  const o = opts || {};
  // Select mode acts on files, so every session keeps its own row and its own
  // checkbox.
  if (o.picking) return rows.map((s) => ({ s, runs: 1, key: '', sibs: [] }));
  const seen = new Map();
  const out = [];
  for (const s of rows) {
    const k = threadKey(s, o.names);
    if (!k) { out.push({ s, runs: 1, key: '', sibs: [] }); continue; }
    const head = seen.get(k);
    if (!head) {
      const entry = { s, runs: 1, key: k, sibs: [] };
      seen.set(k, entry);
      out.push(entry);
    } else {
      head.runs += 1;
      head.sibs.push(s);
    }
  }
  return out;
}

// ─── Grouping ───────────────────────────────────────────────────────────────

function newestOf(entries) {
  let n = 0;
  for (const e of entries) { const m = (e.s && e.s.mtime) || 0; if (m > n) n = m; }
  return n;
}

function byProject(entries, ctx) {
  const buckets = new Map();
  for (const e of entries) {
    const cwd = sessionCwd(e.s);
    if (!buckets.has(cwd)) buckets.set(cwd, []);
    buckets.get(cwd).push(e);
  }
  const cur = normPath(ctx.currentCwd);
  const groups = [...buckets.entries()].map(([cwd, rows]) => ({
    id: `p:${cwd}`,
    kind: 'project',
    cwd,
    name: basename(cwd) || 'Unknown project',
    note: cwd !== '' && cwd === cur ? 'this project' : '',
    current: cwd !== '' && cwd === cur,
    newest: newestOf(rows),
    rows,
  }));
  groups.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    const aUnknown = a.cwd === '';
    const bUnknown = b.cwd === '';
    if (aUnknown !== bUnknown) return aUnknown ? 1 : -1;
    return b.newest - a.newest
      || a.name.localeCompare(b.name)
      || a.cwd.localeCompare(b.cwd);
  });
  return groups;
}

// Folders the user made, in the order they made them, plus everything that is
// in none of them.
//
// The other two groupings derive their headings from the sessions: a day exists
// because something happened on it, a project because something ran there. A
// folder exists because somebody said so, which is why an empty one still
// renders. A folder you cannot see is a folder you cannot drop anything into,
// and a filing scheme that disappears when it is empty cannot be started.
//
// The unfiled group is last and is only drawn when it holds something, since
// "everything else" is a description rather than a place.
function byFolder(entries, ctx) {
  const defined = Array.isArray(ctx.folders) ? ctx.folders : [];
  const assignment = (ctx.folderOf && typeof ctx.folderOf === 'object') ? ctx.folderOf : {};

  const buckets = new Map();
  for (const f of defined) {
    if (f && typeof f.id === 'string' && f.id) buckets.set(f.id, []);
  }
  const unfiled = [];
  for (const e of entries) {
    // A thread stands for several sessions; it is filed where its lead session
    // is filed, because that is the row the user dragged.
    const id = assignment[(e.s && e.s.id) || ''];
    if (typeof id === 'string' && buckets.has(id)) buckets.get(id).push(e);
    else unfiled.push(e);
  }

  const groups = defined
    .filter((f) => f && typeof f.id === 'string' && buckets.has(f.id))
    .map((f) => {
      const rows = buckets.get(f.id);
      return {
        id: `f:${f.id}`,
        kind: 'folder',
        folderId: f.id,
        name: (typeof f.name === 'string' && f.name.trim()) ? f.name.trim() : 'Folder',
        note: '',
        current: false,
        newest: newestOf(rows),
        rows,
      };
    });

  if (unfiled.length) {
    groups.push({
      id: 'f:unfiled', kind: 'folder', folderId: '', name: 'Unfiled',
      note: '', current: false, newest: newestOf(unfiled), rows: unfiled,
    });
  }
  return groups;
}

function byDay(entries, ctx) {
  const buckets = new Map();
  const undated = [];
  for (const e of entries) {
    const ms = (e.s && e.s.mtime) || 0;
    if (!ms) { undated.push(e); continue; }
    const k = dayKey(ms);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(e);
  }
  const groups = [...buckets.entries()].map(([key, rows]) => {
    const ms = rows[0].s.mtime;
    const d = dayDiff(ms, ctx.now);
    let name;
    if (d === 0) name = 'Today';
    else if (d === 1) name = 'Yesterday';
    else name = fmt('weekdayDayMonth', ms);
    return { id: `d:${key}`, kind: 'day', key, name, note: '', current: d === 0, newest: newestOf(rows), rows };
  });
  groups.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  if (undated.length) {
    groups.push({ id: 'd:undated', kind: 'day', key: '', name: 'Undated', note: '', current: false, newest: 0, rows: undated });
  }
  return groups;
}

function byMonth(entries) {
  const buckets = new Map();
  for (const e of entries) {
    const ms = (e.s && e.s.mtime) || 0;
    const d = new Date(ms);
    const key = ms ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}` : '';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(e);
  }
  const groups = [...buckets.entries()].map(([key, rows]) => ({
    id: `m:${key}`,
    kind: 'month',
    key,
    name: key ? fmt('monthYear', rows[0].s.mtime) : 'Undated',
    note: '',
    current: false,
    newest: newestOf(rows),
    rows,
  }));
  groups.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  return groups;
}

// The group the user is standing in always renders, empty or not, so the page
// can always start something where they already are.
function ensureCurrentGroup(groups, ctx) {
  if (ctx.groupBy === 'day') {
    const id = `d:${dayKey(ctx.now)}`;
    if (!groups.some((g) => g.id === id)) {
      groups.unshift({ id, kind: 'day', key: dayKey(ctx.now), name: 'Today', note: '', current: true, newest: 0, rows: [], ghost: true });
    }
    return groups;
  }
  const cur = normPath(ctx.currentCwd);
  if (!cur) return groups;
  if (!groups.some((g) => g.current)) {
    groups.unshift({
      id: `p:${cur}`, kind: 'project', cwd: cur, name: basename(cur) || 'Unknown project',
      note: 'this project', current: true, newest: 0, rows: [], ghost: true,
    });
  }
  return groups;
}

// How many sessions a set of rows stands for. A collapsed thread is one row and
// several sessions.
function countSessions(entries) {
  let n = 0;
  for (const e of entries) n += 1 + ((e.sibs && e.sibs.length) || 0);
  return n;
}

// Deterministic and total, so the order never depends on the input order.
function sortRows(entries) {
  return entries.slice().sort((a, b) =>
    (b.s.mtime || 0) - (a.s.mtime || 0)
    || (b.s.sizeBytes || 0) - (a.s.sizeBytes || 0)
    || String(a.s.id).localeCompare(String(b.s.id)));
}

function groupSessions(entries, ctx) {
  const c = ctx || {};
  if (c.flat) {
    return { groups: [{ id: 'results', kind: 'results', name: 'Results', note: '', current: false, rows: entries }], olderCount: 0 };
  }
  const hot = entries.filter((e) => !isOlder(e.s, c.now));
  const cold = entries.filter((e) => isOlder(e.s, c.now));

  let groups = c.groupBy === 'folder' ? byFolder(hot, c)
    : c.groupBy === 'day' ? byDay(hot, c)
      : byProject(hot, c);
  // Folders are the user's own headings, so none is invented to stand in for
  // where they happen to be.
  if (c.groupBy !== 'folder') ensureCurrentGroup(groups, c);

  if (c.olderOpen && cold.length) {
    // The drawer can repeat a project that also has recent work, so the archive
    // copy says which one it is rather than showing the same header twice.
    const older = (c.groupBy === 'folder' ? byFolder(cold, c)
      : c.groupBy === 'day' ? byMonth(cold, c)
        : byProject(cold, c)).map((g) => ({
      ...g, id: `older:${g.id}`, older: true, current: false,
      note: c.groupBy === 'day' ? '' : 'older',
    }));
    groups = groups.concat(older);
  }
  for (const g of groups) g.rows = sortRows(g.rows);
  // Counted in sessions, not in rows: a thread is one row standing for several
  // sessions, so a row count could never be subtracted from the session total.
  return { groups, olderCount: countSessions(cold) };
}

// ─── Labels ─────────────────────────────────────────────────────────────────

// Every step floors. Rounding reports a 90 minute session as two hours old and
// a 20 hour session as a day old while it is still today.
function formatWhen(ms, now) {
  if (!ms) return { label: 'no date', title: '' };
  const title = new Date(ms).toLocaleString();
  const diff = now - ms;
  if (diff < 45000) return { label: 'now', title };
  if (diff < 3600000) return { label: `${Math.floor(diff / 60000)}m`, title };
  const d = dayDiff(ms, now);
  const clock = fmt('clock', ms);
  if (d === 0) return { label: clock, title };
  // Inside the week the weekday alone places the session. The clock would be
  // the widest label the column ever holds and the exact minute is already on
  // the row's tooltip and in the detail pane.
  if (d <= 6) return { label: fmt('weekday', ms), title };
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return { label: fmt(sameYear ? 'dayMonth' : 'dayMonthYear', ms), title };
}

function formatDuration(startMs, endMs) {
  if (!(startMs > 0 && endMs > startMs)) return '';
  const s = Math.floor((endMs - startMs) / 1000);
  if (s < 60) return 'under a minute';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return h ? `${d}d ${h}h` : `${d}d`;
}

function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Only sessions the main process will actually delete are offered for it.
function isDeletable(s) {
  return !!(s && typeof s.path === 'string' && /\.jsonl$/.test(s.path));
}

// The whole pipeline in one call, so the renderer has a single entry point and
// the tests exercise what the page actually runs.
function buildView(list, ctx) {
  const c = ctx || {};
  const { rows, flat, hits } = filterSessions(list, c);
  const entries = collapseThreads(rows, { picking: c.picking, names: c.names });
  const { groups, olderCount } = groupSessions(entries, { ...c, flat });
  return { groups, olderCount, flat, hits, total: Array.isArray(list) ? list.length : 0, shown: rows.length };
}

module.exports = {
  DAY_MS,
  OLDER_DAYS,
  TITLE_KEY_LEN,
  FUZZY_MIN_Q,
  dayKey,
  dayIndex,
  dayDiff,
  isOlder,
  normPath,
  sessionCwd,
  basename,
  inCurrentProject,
  titleOf,
  signal,
  signalKind,
  scent,
  filterSessions,
  threadKey,
  collapseThreads,
  byFolder,
  groupSessions,
  buildView,
  formatWhen,
  formatDuration,
  formatSize,
  isDeletable,
};
