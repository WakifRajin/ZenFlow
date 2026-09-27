'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/core.js');
const K = require('../js/calendar-core.js');

const H = 3600000, MIN = 60000, DAY = 86400000;
const utc = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi);

function ev(fields) {
  return C.sanitizeEvent(Object.assign({ id: 'ev_' + Math.random().toString(36).slice(2, 10), title: 'Test', createdAt: 1, updatedAt: 1, timeZone: 'UTC' }, fields));
}
const starts = (list) => list.map((o) => (o.allDay ? o.startDate : new Date(o.start).toISOString().slice(0, 16)));

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------
test('zonedToUtc converts wall time in a zone, including across DST', () => {
  assert.equal(K.zonedToUtc(2026, 9, 27, 9, 0, 'Asia/Dhaka'), utc(2026, 9, 27, 3, 0));
  assert.equal(K.zonedToUtc(2026, 7, 1, 9, 0, 'America/New_York'), utc(2026, 7, 1, 13, 0)); // EDT
  assert.equal(K.zonedToUtc(2026, 12, 1, 9, 0, 'America/New_York'), utc(2026, 12, 1, 14, 0)); // EST
  // 02:30 does not exist on 2026-03-08 in New York; resolves to 03:30 EDT.
  assert.equal(K.zonedToUtc(2026, 3, 8, 2, 30, 'America/New_York'), utc(2026, 3, 8, 7, 30));
  const p = K.zonedParts(utc(2026, 9, 26, 20, 0), 'Asia/Dhaka');
  assert.deepEqual([p.y, p.m, p.d, p.h, p.wd], [2026, 9, 27, 2, 0]);
});

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------
test('weekly recurrence keeps local wall time across a DST change', () => {
  const e = ev({ start: K.zonedToUtc(2026, 10, 26, 9, 0, 'America/New_York'), end: K.zonedToUtc(2026, 10, 26, 10, 0, 'America/New_York'), timeZone: 'America/New_York', rrule: 'FREQ=WEEKLY;BYDAY=MO,WE' });
  const occ = K.occurrences(e, utc(2026, 10, 26), utc(2026, 11, 6));
  assert.deepEqual(starts(occ), ['2026-10-26T13:00', '2026-10-28T13:00', '2026-11-02T14:00', '2026-11-04T14:00']);
  for (const o of occ) assert.equal(K.zonedParts(o.start, 'America/New_York').h, 9);
  assert.equal(occ[0].end - occ[0].start, H);
});

test('monthly on the 31st skips short months; last Friday and 2nd Tuesday work', () => {
  const on31 = ev({ start: utc(2026, 1, 31, 12), end: utc(2026, 1, 31, 13), rrule: 'FREQ=MONTHLY' });
  assert.deepEqual(starts(K.occurrences(on31, utc(2026, 1, 1), utc(2026, 8, 1))).map((s) => s.slice(0, 10)), ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31']);
  const lastFri = ev({ start: utc(2026, 1, 30, 12), end: utc(2026, 1, 30, 13), rrule: 'FREQ=MONTHLY;BYDAY=-1FR;COUNT=3' });
  assert.deepEqual(starts(K.occurrences(lastFri, 0, utc(2027, 1, 1))).map((s) => s.slice(0, 10)), ['2026-01-30', '2026-02-27', '2026-03-27']);
  const secondTue = ev({ start: utc(2026, 9, 8, 12), end: utc(2026, 9, 8, 13), rrule: 'FREQ=MONTHLY;BYDAY=2TU' });
  assert.deepEqual(starts(K.occurrences(secondTue, utc(2026, 9, 1), utc(2026, 12, 1))).map((s) => s.slice(0, 10)), ['2026-09-08', '2026-10-13', '2026-11-10']);
});

test('COUNT includes excluded dates; UNTIL (date) is inclusive', () => {
  const start = utc(2026, 9, 1, 8);
  const counted = ev({ start, end: start + H, rrule: 'FREQ=DAILY;COUNT=5', exdates: [start + DAY] });
  assert.equal(K.occurrences(counted, 0, utc(2027, 1, 1)).length, 4);
  const until = ev({ start, end: start + H, rrule: 'FREQ=DAILY;UNTIL=20260903' });
  assert.deepEqual(starts(K.occurrences(until, 0, utc(2027, 1, 1))).map((s) => s.slice(0, 10)), ['2026-09-01', '2026-09-02', '2026-09-03']);
});

test('skip-ahead for long-running daily rules matches a naive walk', () => {
  const start = utc(2020, 1, 1, 7, 30);
  const e = ev({ start, end: start + 30 * MIN, rrule: 'FREQ=DAILY;INTERVAL=3' });
  const from = utc(2026, 9, 1), to = utc(2026, 9, 15);
  const got = starts(K.occurrences(e, from, to));
  const expected = [];
  for (let t = start; t < to; t += 3 * DAY) if (t + 30 * MIN > from) expected.push(new Date(t).toISOString().slice(0, 16));
  assert.deepEqual(got, expected);
});

test('all-day events: multi-day overlap and Feb 29 yearly only in leap years', () => {
  const trip = ev({ allDay: true, startDate: '2026-09-25', endDate: '2026-09-28' });
  const o = K.occurrences(trip, utc(2026, 9, 27), utc(2026, 9, 28), 'UTC');
  assert.equal(o.length, 1);
  assert.equal(o[0].endDate, '2026-09-28');
  const leap = ev({ allDay: true, startDate: '2024-02-29', endDate: '2024-03-01', rrule: 'FREQ=YEARLY' });
  assert.deepEqual(starts(K.occurrences(leap, utc(2024, 1, 1), utc(2033, 1, 1), 'UTC')), ['2024-02-29', '2028-02-29', '2032-02-29']);
});

test('an override replaces its occurrence instead of duplicating it', () => {
  const start = utc(2026, 9, 7, 10);
  const master = ev({ id: 'ev_master', start, end: start + H, rrule: 'FREQ=WEEKLY' });
  const moved = ev({ id: 'ev_moved', title: 'Moved', start: start + 7 * DAY + 2 * H, end: start + 7 * DAY + 3 * H, recurrenceId: 'ev_master', originalStart: start + 7 * DAY });
  const all = K.expandAll([master, moved], utc(2026, 9, 1), utc(2026, 9, 22), 'UTC');
  assert.deepEqual(all.map((o) => o.event.title + '@' + new Date(o.start).toISOString().slice(5, 16)), ['Test@09-07T10:00', 'Moved@09-14T12:00', 'Test@09-21T10:00']);
});

test('unsupported rules degrade to a single occurrence and read as custom', () => {
  const e = ev({ start: utc(2026, 9, 1, 9), end: utc(2026, 9, 1, 10), rrule: 'FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO,TU' });
  assert.equal(K.occurrences(e, 0, utc(2027, 1, 1)).length, 1);
  assert.equal(K.describeRRule(e.rrule), 'Custom repeat');
  assert.equal(K.describeRRule('FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR'), 'Every weekday');
  assert.equal(K.describeRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=6'), 'Every 2 weeks on Mon, Wed, 6 times');
  assert.equal(K.formatRRule(K.parseRRule('FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20261231')), 'FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20261231');
});

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------
test('reminders fire at offset before each occurrence; all-day at 09:00 local', () => {
  const start = K.zonedToUtc(2026, 9, 28, 15, 0, 'Asia/Dhaka');
  const meeting = ev({ id: 'ev_meet', start, end: start + H, timeZone: 'Asia/Dhaka', rrule: 'FREQ=DAILY;COUNT=2', reminders: [{ offsetMin: 10, type: 'notify' }, { offsetMin: 0, type: 'alarm' }] });
  const bday = ev({ id: 'ev_bday', allDay: true, startDate: '2026-09-29', endDate: '2026-09-30', timeZone: 'Asia/Dhaka', reminders: [{ offsetMin: 1440, type: 'notify' }] });
  const got = K.reminderInstances([meeting, bday], utc(2026, 9, 27), utc(2026, 9, 30));
  assert.deepEqual(got.map((r) => [r.eventId, new Date(r.fireAt).toISOString().slice(5, 16), r.type]), [
    ['ev_bday', '09-28T03:00', 'notify'],   // 09:00 Dhaka on the day before
    ['ev_meet', '09-28T08:50', 'notify'],
    ['ev_meet', '09-28T09:00', 'alarm'],
    ['ev_meet', '09-29T08:50', 'notify'],
    ['ev_meet', '09-29T09:00', 'alarm']
  ]);
  assert.equal(new Set(got.map((r) => r.key)).size, got.length, 'keys are unique');
});

test('a snooze moves exactly one reminder instance; done one-off reminders are silent', () => {
  const start = utc(2026, 9, 28, 9);
  const e = ev({ id: 'ev_s', start, end: start, kind: 'reminder', reminders: [{ offsetMin: 0, type: 'notify' }] });
  const key = K.reminderKey('ev_s', start, 0);
  e.snoozes[key] = start + 10 * MIN;
  const got = K.reminderInstances([e], start - H, start + H);
  assert.deepEqual(got.map((r) => [r.fireAt - start, r.snoozed]), [[10 * MIN, true]]);
  const done = ev({ id: 'ev_d', start, end: start, kind: 'reminder', done: true, reminders: [{ offsetMin: 0, type: 'notify' }] });
  assert.equal(K.reminderInstances([done], start - H, start + H).length, 0);
});

// ---------------------------------------------------------------------------
// Google mapping
// ---------------------------------------------------------------------------
const ctx = { calendarId: 'me@example.com', accessRole: 'owner', timeZone: 'Asia/Dhaka', defaultReminders: [{ method: 'popup', minutes: 30 }] };

test('fromGoogle maps timed recurring events with TZID exdates and default reminders', () => {
  const g = {
    id: 'abc123', etag: '"1"', status: 'confirmed', summary: 'Standup', description: '<p>Daily <b>sync</b></p>', location: 'Room 1',
    start: { dateTime: '2026-09-28T09:00:00+06:00', timeZone: 'Asia/Dhaka' }, end: { dateTime: '2026-09-28T09:15:00+06:00', timeZone: 'Asia/Dhaka' },
    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'EXDATE;TZID=Asia/Dhaka:20260929T090000'],
    reminders: { useDefault: true }, updated: '2026-09-20T10:00:00.000Z', created: '2026-09-01T00:00:00.000Z'
  };
  const e = C.sanitizeEvent(K.fromGoogle(g, ctx));
  assert.equal(e.id, K.localIdForGoogle('me@example.com', 'abc123'));
  assert.equal(e.description, 'Daily sync');
  assert.equal(e.cal, 'g:me@example.com');
  assert.deepEqual(e.exdates, [utc(2026, 9, 29, 3)]);
  assert.deepEqual(e.reminders, [{ offsetMin: 30, type: 'notify' }]);
  assert.equal(e.readOnly, false);
  assert.equal(e.updatedAt, e.google.syncedAt, 'freshly pulled events are not pending push');
  assert.equal(K.needsPush(e), false);
  const occ = K.occurrences(e, utc(2026, 9, 28), utc(2026, 10, 3));
  assert.deepEqual(starts(occ).map((s) => s.slice(0, 10)), ['2026-09-28', '2026-09-30', '2026-10-01', '2026-10-02']);
});

test('fromGoogle: cancelled, all-day, read-only calendars and ZenFlow-origin ids', () => {
  assert.deepEqual(K.fromGoogle({ id: 'x', status: 'cancelled' }, ctx).deleted, true);
  const allDay = C.sanitizeEvent(K.fromGoogle({ id: 'd1', summary: 'Holiday', start: { date: '2026-12-25' }, end: { date: '2026-12-26' }, updated: '2026-01-01T00:00:00Z' }, Object.assign({}, ctx, { accessRole: 'reader' })));
  assert.equal(allDay.allDay, true);
  assert.equal(allDay.startDate, '2026-12-25');
  assert.equal(allDay.readOnly, true);
  const mine = K.fromGoogle({ id: K.googleIdFor('ev_local1'), summary: 'x', start: { dateTime: '2026-09-28T09:00:00Z' }, end: { dateTime: '2026-09-28T10:00:00Z' }, extendedProperties: { private: { zenflowId: 'ev_local1' } }, updated: '2026-09-28T00:00:00Z' }, ctx);
  assert.equal(mine.id, 'ev_local1', 'events created in ZenFlow map back to the same local event');
});

test('toGoogle -> fromGoogle round-trips the fields ZenFlow owns', () => {
  const start = K.zonedToUtc(2026, 10, 5, 14, 0, 'Asia/Dhaka');
  const local = ev({ id: 'ev_rt', title: 'Review', description: 'Line 1\nLine 2', location: 'Online', start, end: start + H, timeZone: 'Asia/Dhaka', rrule: 'FREQ=WEEKLY;BYDAY=MO', exdates: [start + 7 * DAY], reminders: [{ offsetMin: 15, type: 'notify' }], cal: 'g:me@example.com' });
  const body = K.toGoogle(local);
  assert.equal(body.recurrence[1], 'EXDATE;TZID=Asia/Dhaka:20261012T140000');
  const back = C.sanitizeEvent(K.fromGoogle(Object.assign({ id: K.googleIdFor('ev_rt'), updated: '2026-10-01T00:00:00Z' }, body), ctx));
  for (const f of ['id', 'title', 'location', 'start', 'end', 'timeZone', 'rrule', 'exdates', 'reminders']) assert.deepEqual(back[f], local[f], f);
  assert.match(K.googleIdFor('ev_Rt-1_x'), /^[0-9a-v]+$/);
  assert.equal(K.googleInstanceId('abc', utc(2026, 10, 12, 8)), 'abc_20261012T080000Z');
  assert.equal(K.googleInstanceId('abc', '2026-12-25'), 'abc_20261225');
});

// ---------------------------------------------------------------------------
// Schema & merge
// ---------------------------------------------------------------------------
test('sanitizeEvent rejects broken events and neutralizes hostile fields', () => {
  assert.equal(C.sanitizeEvent({ id: 'ev_1', title: 'x' }), null, 'no start');
  assert.equal(C.sanitizeEvent({ id: 'bad id!', start: 1 }), null);
  const e = C.sanitizeEvent({ id: 'ev_2', start: 1000, end: 10, timeZone: 'Mars/Olympus', rrule: 'FREQ=DAILY;X-EVIL=<script>', cal: 'g: spaced', color: 'red', reminders: [{ offsetMin: 999999, type: 'boom' }], snoozes: { 'not a key': 5 } });
  assert.equal(e.end, 1000 + 30 * MIN);
  assert.equal(e.timeZone, 'UTC');
  assert.equal(e.rrule, '');
  assert.equal(e.cal, 'local');
  assert.equal(e.color, '');
  assert.deepEqual(e.reminders, [{ offsetMin: 40320, type: 'notify' }]);
  assert.deepEqual(e.snoozes, {});
});

test('events merge by id with tombstones, like other collections', () => {
  const a = C.defaultData(), b = C.defaultData();
  const e = ev({ id: 'ev_m', start: 5, end: 10, createdAt: 5, updatedAt: 5 });
  a.calendar.events.push(JSON.parse(JSON.stringify(e)));
  b.calendar.events.push(JSON.parse(JSON.stringify(e)));
  C.removeItem(a, ['calendar', 'events'], 'ev_m', 100);
  const m = C.merge(a, b, 200);
  assert.equal(m.calendar.events.length, 0);
  assert.ok(m.tombstones['ev:ev_m']);
  C.setScalar(b, 'calendar', 'googleSelection', ['me@example.com'], 300);
  assert.deepEqual(C.merge(a, b, 400).calendar.googleSelection, ['me@example.com']);
});

test('DST fall-back: a repeated wall time resolves to its first instant', () => {
  // 01:30 happens twice in New York on 2026-11-01 (EDT, then EST).
  assert.equal(K.zonedToUtc(2026, 11, 1, 1, 30, 'America/New_York'), utc(2026, 11, 1, 5, 30));
  // Around the world: noon maps back to noon.
  for (const tz of ['Pacific/Auckland', 'Asia/Kolkata', 'Europe/London', 'America/Los_Angeles', 'Australia/Lord_Howe']) {
    for (const [y, m, d] of [[2026, 1, 15], [2026, 4, 5], [2026, 7, 15], [2026, 10, 4]]) {
      const t = K.zonedToUtc(y, m, d, 12, 0, tz);
      const p = K.zonedParts(t, tz);
      assert.deepEqual([p.y, p.m, p.d, p.h, p.mi], [y, m, d, 12, 0], tz + ' ' + [y, m, d]);
    }
  }
});
