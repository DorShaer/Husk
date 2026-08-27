'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const S = require('../../src/lib/schedule');

const MIN = 60_000;
const HOUR = 60 * MIN;
// A fixed local Wednesday at 10:00, so weekday arithmetic never depends on when
// the suite runs.
const NOW = new Date(2026, 7, 19, 10, 0, 0).getTime();
assert.equal(new Date(NOW).getDay(), 3, 'fixture must be a Wednesday');

const every = (over = {}) => ({ name: 'Nightly', kind: 'every', target: 'workflow', targetId: 'w1', everyMinutes: 60, ...over });
const daily = (over = {}) => ({ name: 'Morning', kind: 'daily', target: 'workflow', targetId: 'w1', at: '09:00', ...over });
const weekly = (over = {}) => ({ name: 'Friday', kind: 'weekly', target: 'workflow', targetId: 'w1', at: '17:00', days: [5], ...over });

// ─── validation ──────────────────────────────────────────────────────────

test('a schedule needs a name, a recurrence and something to start', () => {
  assert.equal(S.validateSchedule({}).code, 'no-name');
  assert.equal(S.validateSchedule({ name: 'x' }).code, 'bad-kind');
  assert.equal(S.validateSchedule({ name: 'x', kind: 'every' }).code, 'bad-target');
  assert.equal(S.validateSchedule({ name: 'x', kind: 'cron', target: 'workflow' }).code, 'bad-kind');
  assert.equal(S.validateSchedule({ name: 'x', kind: 'every', target: 'sudo' }).code, 'bad-target');
});

test('an interval is held between five minutes and a week', () => {
  assert.equal(S.validateSchedule(every({ everyMinutes: 4 })).code, 'bad-interval');
  assert.equal(S.validateSchedule(every({ everyMinutes: 0 })).code, 'bad-interval');
  assert.equal(S.validateSchedule(every({ everyMinutes: -60 })).code, 'bad-interval');
  assert.equal(S.validateSchedule(every({ everyMinutes: 60 * 24 * 8 })).code, 'bad-interval');
  assert.equal(S.validateSchedule(every({ everyMinutes: 90 })).ok, true);
  // A number field hands back a string, so a numeric one is read as the number
  // it spells. Anything that is not a whole number of minutes is not.
  assert.equal(S.validateSchedule(every({ everyMinutes: '90' })).schedule.everyMinutes, 90);
  assert.equal(S.validateSchedule(every({ everyMinutes: '90.5' })).code, 'bad-interval');
  assert.equal(S.validateSchedule(every({ everyMinutes: 'ninety' })).code, 'bad-interval');
  assert.equal(S.validateSchedule(every({ everyMinutes: null })).code, 'bad-interval');
});

test('a time of day is HH:MM in 24 hours or it is refused', () => {
  for (const at of ['24:00', '9:60', 'nine', '', '09', '09:0', null]) {
    assert.equal(S.validateSchedule(daily({ at })).code, 'bad-time', String(at));
  }
  assert.equal(S.validateSchedule(daily({ at: '9:05' })).schedule.at, '09:05');
  assert.equal(S.validateSchedule(daily({ at: '23:59' })).schedule.at, '23:59');
});

test('a weekly schedule runs on exactly one day', () => {
  assert.equal(S.validateSchedule(weekly({ days: [] })).code, 'bad-days');
  assert.equal(S.validateSchedule(weekly({ days: [1, 2] })).code, 'bad-days');
  assert.equal(S.validateSchedule(weekly({ days: [9] })).code, 'bad-days');
  assert.equal(S.validateSchedule(weekly({ days: [5] })).ok, true);
});

test('a daily schedule with no days named means every day', () => {
  assert.deepEqual(S.validateSchedule(daily()).schedule.days, []);
  assert.deepEqual(S.validateSchedule(daily({ days: [1, 3, 1] })).schedule.days, [1, 3]);
});

test('the stored shape carries only fields the scheduler reads', () => {
  const out = S.validateSchedule(every({ id: 's1', cwd: '/code', somethingElse: true })).schedule;
  assert.equal(out.somethingElse, undefined);
  assert.equal(out.cwd, '/code');
  assert.equal(out.enabled, true);
});

// ─── when it fires ───────────────────────────────────────────────────────

test('an interval that has never run is due now, not at some boundary', () => {
  assert.equal(S.nextRunAt(every(), NOW), NOW);
  assert.equal(S.isDue(every(), NOW), true);
});

test('an interval counts from the last run', () => {
  const s = every({ everyMinutes: 60, lastRunAt: new Date(NOW - 30 * MIN).toISOString() });
  assert.equal(S.nextRunAt(s, NOW), NOW + 30 * MIN);
  assert.equal(S.isDue(s, NOW), false);

  const overdue = every({ everyMinutes: 60, lastRunAt: new Date(NOW - 90 * MIN).toISOString() });
  assert.equal(S.isDue(overdue, NOW), true);
});

test('a daily time still to come today fires today', () => {
  const s = daily({ at: '17:00' });
  assert.equal(S.nextRunAt(s, NOW), new Date(2026, 7, 19, 17, 0, 0).getTime());
});

test('a daily time already past today fires tomorrow', () => {
  const s = daily({ at: '09:00' });
  assert.equal(S.nextRunAt(s, NOW), new Date(2026, 7, 20, 9, 0, 0).getTime());
});

test('a daily time exactly now is due rather than pushed a day out', () => {
  const s = daily({ at: '10:00' });
  assert.equal(S.nextRunAt(s, NOW), NOW);
  assert.equal(S.isDue(s, NOW), true);
});

test('a weekly schedule finds its weekday', () => {
  // Wednesday now, Friday at 17:00 wanted.
  assert.equal(S.nextRunAt(weekly(), NOW), new Date(2026, 7, 21, 17, 0, 0).getTime());
});

test('a weekly schedule on today, later today, fires today', () => {
  const s = weekly({ days: [3], at: '17:00' });
  assert.equal(S.nextRunAt(s, NOW), new Date(2026, 7, 19, 17, 0, 0).getTime());
});

test('a weekly schedule on today, already past, waits a week', () => {
  const s = weekly({ days: [3], at: '09:00' });
  assert.equal(S.nextRunAt(s, NOW), new Date(2026, 7, 26, 9, 0, 0).getTime());
});

test('a daily schedule on chosen weekdays skips the days it was not given', () => {
  // Weekdays only; now is Wednesday 10:00, so the next 09:00 is Thursday.
  const s = daily({ at: '09:00', days: [1, 2, 3, 4, 5] });
  assert.equal(S.nextRunAt(s, NOW), new Date(2026, 7, 20, 9, 0, 0).getTime());

  // Weekends only; the next Saturday.
  const w = daily({ at: '09:00', days: [0, 6] });
  assert.equal(S.nextRunAt(w, NOW), new Date(2026, 7, 22, 9, 0, 0).getTime());
});

test('a wall-clock schedule keeps its hour rather than adding 24 hours', () => {
  // Walking a day at a time is what makes this hold across a clock change; the
  // property checked here is that the hour and minute never drift.
  let cursor = NOW;
  const s = daily({ at: '09:00' });
  for (let i = 0; i < 10; i += 1) {
    const next = S.nextRunAt(s, cursor);
    const d = new Date(next);
    assert.equal(d.getHours(), 9);
    assert.equal(d.getMinutes(), 0);
    cursor = next + MIN;
  }
});

test('a disabled schedule never fires', () => {
  assert.equal(S.nextRunAt(every({ enabled: false }), NOW), null);
  assert.equal(S.isDue(daily({ enabled: false }), NOW), false);
});

test('a malformed schedule answers null rather than throwing', () => {
  assert.equal(S.nextRunAt(null, NOW), null);
  assert.equal(S.nextRunAt({}, NOW), null);
  assert.equal(S.nextRunAt(daily({ at: 'nope' }), NOW), null);
  assert.equal(S.nextRunAt(every({ everyMinutes: 0 }), NOW), null);
  assert.equal(S.isDue(undefined, NOW), false);
});

// ─── the due list ────────────────────────────────────────────────────────

test('only what is owed comes back, soonest first', () => {
  const list = [
    daily({ name: 'later', at: '17:00' }),
    every({ name: 'now', everyMinutes: 60 }),
    every({ name: 'overdue', everyMinutes: 60, lastRunAt: new Date(NOW - 5 * HOUR).toISOString() }),
  ];
  const due = S.dueSchedules(list, NOW);
  assert.deepEqual(due.map((s) => s.name), ['overdue', 'now']);
});

test('a missed window fires once, not once per window that passed', () => {
  // Away for a week on an hourly schedule: one run is owed, not 168.
  const s = every({ everyMinutes: 60, lastRunAt: new Date(NOW - 7 * 24 * HOUR).toISOString() });
  assert.equal(S.dueSchedules([s], NOW).length, 1);
});

test('nothing scheduled is an empty list rather than an error', () => {
  assert.deepEqual(S.dueSchedules(null, NOW), []);
  assert.deepEqual(S.dueSchedules([], NOW), []);
});

// ─── words ───────────────────────────────────────────────────────────────

test('a schedule says what it does in the words a person would use', () => {
  assert.equal(S.describe(every({ everyMinutes: 30 })), 'every 30 minutes');
  assert.equal(S.describe(every({ everyMinutes: 60 })), 'every hour');
  assert.equal(S.describe(every({ everyMinutes: 180 })), 'every 3 hours');
  assert.equal(S.describe(every({ everyMinutes: 90 })), 'every 1h 30m');
  assert.equal(S.describe(every({ everyMinutes: 1440 })), 'every day');
  assert.equal(S.describe(daily({ at: '09:00' })), 'every day at 09:00');
  assert.equal(S.describe(daily({ at: '09:00', days: [1, 2, 3, 4, 5] })), 'Mon, Tue, Wed, Thu, Fri at 09:00');
  assert.equal(S.describe(weekly({ days: [5], at: '17:00' })), 'every Friday at 17:00');
  assert.equal(S.describe({}), '');
  assert.equal(S.describe(null), '');
});
