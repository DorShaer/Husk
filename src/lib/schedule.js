'use strict';

// Recurring runs: when a schedule next fires, and whether it is due.
//
// This is deliberately not cron. Cron's five fields can express things nobody
// wants from an agent runner and cannot express "every 90 minutes" without a
// lie, and a half-implemented cron is worse than a small vocabulary that means
// exactly what it says. Three recurrences cover what a person actually asks
// for:
//
//   every    every N minutes, from whenever it last ran
//   daily    at a wall-clock time, every day, or on chosen weekdays
//   weekly   at a wall-clock time, on one weekday
//
// Wall-clock, not elapsed. "Daily at 09:00" means nine in the morning where the
// user is, through a daylight-saving change, which is why every calculation
// here goes through Date's local-time constructors rather than adding a day in
// milliseconds. The clock is injected so that is testable.
//
// Nothing here spawns, reads a file or looks at a real clock. main.js owns the
// timer, the run, and what a missed window means.

const MINUTE_MS = 60000;

const KINDS = ['every', 'daily', 'weekly'];
// What a schedule can start. The scheduler refuses anything else rather than
// growing a third meaning for a stored id.
const TARGETS = ['workflow', 'autopilot'];

// Bounds. The floor stops a schedule from becoming a busy loop; the ceiling is
// where "every N minutes" stops being the right vocabulary and daily is.
const MIN_EVERY_MINUTES = 5;
const MAX_EVERY_MINUTES = 60 * 24 * 7;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const REFUSAL_CODES = [
  'no-name',
  'bad-kind',
  'bad-target',
  'bad-interval',
  'bad-time',
  'bad-days',
];

function refuse(code, message) {
  return { ok: false, code, message: String(message) };
}

// ─── reading a schedule ──────────────────────────────────────────────────

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// "HH:MM" in 24 hours, or null. Stored as text rather than as minutes since
// midnight because that is what the user typed and what the row shows back.
function readTime(value) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value == null ? '' : value).trim());
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

// Weekday numbers, Sunday first, deduplicated and sorted. An empty list means
// every day, which is what "daily" means without qualification.
function readDays(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value.slice(0, 7)) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0 && n <= 6 && !out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

// Validates one schedule as the user asked for it. Returns the stored shape or
// a refusal naming the field that was wrong.
function validateSchedule(raw) {
  const s = (raw && typeof raw === 'object') ? raw : {};
  const name = str(s.name, 80);
  if (!name) return refuse('no-name', 'give this schedule a name');

  const kind = KINDS.includes(s.kind) ? s.kind : null;
  if (!kind) return refuse('bad-kind', 'a schedule repeats every so often, daily, or weekly');

  const target = TARGETS.includes(s.target) ? s.target : null;
  if (!target) return refuse('bad-target', 'a schedule starts a workflow or an autopilot run');

  const out = {
    id: str(s.id, 60),
    name,
    kind,
    target,
    targetId: str(s.targetId, 120),
    cwd: str(s.cwd, 400),
    enabled: s.enabled !== false,
    lastRunAt: str(s.lastRunAt, 40),
  };

  if (kind === 'every') {
    const n = Number(s.everyMinutes);
    if (!Number.isInteger(n) || n < MIN_EVERY_MINUTES || n > MAX_EVERY_MINUTES) {
      return refuse('bad-interval', `choose between ${MIN_EVERY_MINUTES} minutes and a week`);
    }
    out.everyMinutes = n;
    return { ok: true, schedule: out };
  }

  const at = readTime(s.at);
  if (!at) return refuse('bad-time', 'give a time of day as HH:MM');
  out.at = `${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}`;

  if (kind === 'weekly') {
    const days = readDays(s.days);
    if (days.length !== 1) return refuse('bad-days', 'a weekly schedule runs on one day');
    out.days = days;
  } else {
    // Daily with no days named is every day, which is the common case and is
    // stored as the empty list rather than as all seven.
    out.days = readDays(s.days);
  }
  return { ok: true, schedule: out };
}

// ─── when it next fires ──────────────────────────────────────────────────

// The local wall-clock instant of a given time on a given day offset.
function atLocal(now, dayOffset, hour, minute) {
  const d = new Date(now);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

// When this schedule should next run, at or after `now`.
//
// An interval counts from the last run, not from midnight, so a schedule that
// has never run is due immediately: the alternative is a schedule that sits
// idle until an arbitrary boundary the user never named.
//
// A wall-clock schedule walks forward a day at a time rather than adding
// 24 hours, so an hour gained or lost to daylight saving does not drag the
// hour it fires at along with it.
function nextRunAt(schedule, now) {
  const s = (schedule && typeof schedule === 'object') ? schedule : {};
  if (s.enabled === false) return null;

  if (s.kind === 'every') {
    const every = Number(s.everyMinutes);
    if (!Number.isInteger(every) || every < 1) return null;
    const last = Date.parse(String(s.lastRunAt || ''));
    if (!Number.isFinite(last)) return now;
    return last + every * MINUTE_MS;
  }

  const at = readTime(s.at);
  if (!at) return null;
  const days = readDays(s.days);

  // Today first, then each of the next seven days. Seven is enough for any
  // weekday set, and a set that matches nothing is answered with null rather
  // than a search that never ends.
  for (let offset = 0; offset <= 7; offset += 1) {
    const when = atLocal(now, offset, at.hour, at.minute);
    if (when < now) continue;
    if (days.length && !days.includes(new Date(when).getDay())) continue;
    return when;
  }
  return null;
}

// Whether this schedule is owed a run right now.
//
// A schedule that was due while Husk was closed fires once on the next tick
// rather than once per window it missed. Catching up would mean a machine that
// slept over a weekend starting dozens of runs at breakfast, which is never
// what a person meant by "daily".
function isDue(schedule, now) {
  const next = nextRunAt(schedule, now);
  return next !== null && next <= now;
}

// The schedules owed a run, in the order they should start.
function dueSchedules(schedules, now) {
  const list = Array.isArray(schedules) ? schedules : [];
  return list
    .filter((s) => isDue(s, now))
    .sort((a, b) => (nextRunAt(a, now) || 0) - (nextRunAt(b, now) || 0));
}

// ─── words ───────────────────────────────────────────────────────────────

// How a schedule reads on its row. Built here rather than in the renderer so
// the rule and its wording move together.
function describe(schedule) {
  const s = (schedule && typeof schedule === 'object') ? schedule : {};
  if (s.kind === 'every') {
    const n = Number(s.everyMinutes);
    if (!Number.isInteger(n)) return '';
    if (n < 60) return `every ${n} minutes`;
    if (n % (60 * 24) === 0) {
      const d = n / (60 * 24);
      return d === 1 ? 'every day' : `every ${d} days`;
    }
    if (n % 60 === 0) {
      const h = n / 60;
      return h === 1 ? 'every hour' : `every ${h} hours`;
    }
    return `every ${Math.floor(n / 60)}h ${n % 60}m`;
  }
  const at = readTime(s.at);
  if (!at) return '';
  const time = `${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}`;
  const days = readDays(s.days);
  if (s.kind === 'weekly' && days.length === 1) return `every ${DAY_NAMES[days[0]]} at ${time}`;
  if (!days.length) return `every day at ${time}`;
  if (days.length === 7) return `every day at ${time}`;
  return `${days.map((d) => DAY_NAMES[d].slice(0, 3)).join(', ')} at ${time}`;
}

module.exports = {
  KINDS,
  TARGETS,
  MIN_EVERY_MINUTES,
  MAX_EVERY_MINUTES,
  DAY_NAMES,
  REFUSAL_CODES,
  validateSchedule,
  nextRunAt,
  isDue,
  dueSchedules,
  describe,
  _internal: { readTime, readDays, atLocal },
};
