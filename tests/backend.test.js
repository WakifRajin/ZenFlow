'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/core.js');
const K = require('../js/calendar-core.js');
const { createGoogleSync } = require('../functions/src/google-sync.js');
const { createReminderPlanner } = require('../functions/src/reminders.js');
const OAuth = require('../functions/src/oauth.js');

const H = 3600000;
const T0 = Date.UTC(2026, 8, 27, 4, 0);

// ---------------------------------------------------------------------------
// Fake Google Calendar with the behaviours the sync depends on.
// ---------------------------------------------------------------------------
function fakeGoogle() {
  let clock = T0, seq = 0;
  const cals = new Map();
  const g = {
    calls: [],
    failNextInsertAfterWrite: false,
    addCalendar(id, extra = {}) { cals.set(id, Object.assign({ id, summary: id, accessRole: 'owner', timeZone: 'UTC', events: new Map(), log: [] }, extra)); },
    events(calId) { return [...cals.get(calId).events.values()]; },
    live(calId) { return g.events(calId).filter((e) => e.status !== 'cancelled'); },
    touch(calId, ev) { ev.updated = new Date(clock += 1000).toISOString(); ev.etag = '"' + (++seq) + '"'; cals.get(calId).log.push({ id: ev.id, seq }); },
    put(calId, ev) { const e = Object.assign({ status: 'confirmed' }, ev); g.touch(calId, e); cals.get(calId).events.set(e.id, e); return e; },
    api: {
      async listCalendars() { return [...cals.values()].map(({ events, log, ...c }) => c); },
      async listEvents(calId, { syncToken }) {
        g.calls.push(['list', calId, syncToken || 'full']);
        const cal = cals.get(calId);
        if (syncToken && !/^tok-\d+$/.test(syncToken)) { const e = new Error('Gone'); e.status = 410; throw e; }
        const since = syncToken ? Number(syncToken.slice(4)) : -1;
        const ids = syncToken ? [...new Set(cal.log.filter((l) => l.seq > since).map((l) => l.id))] : [...cal.events.keys()];
        const items = ids.map((id) => cal.events.get(id)).filter(Boolean); // showDeleted=true: cancelled items included
        return { items: JSON.parse(JSON.stringify(items)), nextSyncToken: 'tok-' + seq };
      },
      async insertEvent(calId, body) {
        g.calls.push(['insert', calId, body.id]);
        const cal = cals.get(calId);
        if (cal.events.has(body.id)) { const e = new Error('Duplicate'); e.status = 409; throw e; }
        const e = g.put(calId, JSON.parse(JSON.stringify(body)));
        if (g.failNextInsertAfterWrite) { g.failNextInsertAfterWrite = false; const err = new Error('socket hang up'); err.status = 503; throw err; }
        return JSON.parse(JSON.stringify(e));
      },
      async patchEvent(calId, id, body) {
        g.calls.push(['patch', calId, id]);
        const cal = cals.get(calId);
        let e = cal.events.get(id);
        if (!e) {
          const m = /^(.+)_(\d{8}(T\d{6}Z)?)$/.exec(id);       // instance of a recurring master
          if (!m || !cal.events.has(m[1])) { const err = new Error('Not found'); err.status = 404; throw err; }
          const s = m[2];
          const orig = s.length === 8 ? { date: `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` } : { dateTime: `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z` };
          e = { id, recurringEventId: m[1], originalStartTime: orig };
          cal.events.set(id, e);
        }
        Object.assign(e, JSON.parse(JSON.stringify(body)));
        if (e.recurringEventId) delete e.recurrence;
        g.touch(calId, e);
        return JSON.parse(JSON.stringify(e));
      },
      async deleteEvent(calId, id) {
        g.calls.push(['delete', calId, id]);
        const e = cals.get(calId).events.get(id);
        if (!e || e.status === 'cancelled') { const err = new Error('Gone'); err.status = 410; throw err; }
        e.status = 'cancelled';
        g.touch(calId, e);
        return null;
      }
    }
  };
  return g;
}

function harness() {
  const google = fakeGoogle();
  google.addCalendar('me@x.com', { primary: true, timeZone: 'Asia/Dhaka' });
  google.addCalendar('team@x.com', { accessRole: 'owner' });
  google.addCalendar('holidays@x.com', { accessRole: 'reader' });
  let now = T0 + 10 * H;
  const sync = createGoogleSync({ C, K, api: google.api, now: () => now });
  const h = {
    google, data: C.defaultData(), state: undefined,
    advance(ms) { now += ms; },
    now: () => now,
    async run(opts = {}) {
      const res = await sync.syncAccount({ data: JSON.parse(JSON.stringify(h.data)), state: JSON.parse(JSON.stringify(h.state || {})), ...opts });
      // Persist like the server does: transactional merge into the stored doc.
      h.data = C.merge(h.data, C.sanitizeData(res.data), now);
      h.state = res.state;
      return res;
    },
    local(fields) {
      const ev = C.sanitizeEvent(Object.assign({ id: C.newId('ev'), title: 'Local', start: now + 24 * H, end: now + 25 * H, timeZone: 'Asia/Dhaka', createdAt: now, updatedAt: now }, fields));
      h.data.calendar.events.push(ev);
      return ev;
    },
    get: (id) => h.data.calendar.events.find((e) => e.id === id)
  };
  return h;
}
const timed = (id, summary, startIso, hours = 1, extra = {}) => Object.assign({
  id, summary,
  start: { dateTime: startIso, timeZone: 'Asia/Dhaka' },
  end: { dateTime: new Date(Date.parse(startIso) + hours * H).toISOString(), timeZone: 'Asia/Dhaka' }
}, extra);

test('first sync selects the primary calendar and mirrors its events (not pending push)', async () => {
  const h = harness();
  h.google.put('me@x.com', timed('g1', 'Dentist', '2026-09-29T10:00:00+06:00'));
  h.google.put('team@x.com', timed('t1', 'Team thing', '2026-09-29T11:00:00Z'));
  const res = await h.run();
  assert.deepEqual(h.data.calendar.googleSelection, ['me@x.com']);
  assert.deepEqual(h.data.calendar.events.map((e) => e.title), ['Dentist']);
  assert.equal(K.needsPush(h.data.calendar.events[0]), false);
  assert.equal(res.stats.added, 1);
  assert.equal(res.status.calendars.length, 3);
});

test('an event created in ZenFlow is inserted once with a deterministic id and never duplicated', async () => {
  const h = harness();
  await h.run();
  const ev = h.local({ title: 'Plan sprint', cal: 'g:me@x.com' });
  await h.run();
  const [g1] = h.google.live('me@x.com');
  assert.equal(g1.id, K.googleIdFor(ev.id));
  assert.equal(g1.extendedProperties.private.zenflowId, ev.id);
  await h.run(); await h.run();
  assert.equal(h.google.live('me@x.com').length, 1);
  assert.equal(h.data.calendar.events.length, 1, 'the pulled copy maps back to the same local event');
  assert.equal(h.google.calls.filter((c) => c[0] === 'insert').length, 1, 'nothing re-pushed');
});

test('an insert that timed out after succeeding is recovered without a duplicate', async () => {
  const h = harness();
  await h.run();
  h.local({ title: 'Flaky network', cal: 'g:me@x.com' });
  h.google.failNextInsertAfterWrite = true;
  const first = await h.run();
  assert.equal(first.stats.errors.length, 1);
  await h.run();
  assert.equal(h.google.live('me@x.com').length, 1);
  assert.ok(h.google.calls.some((c) => c[0] === 'patch'), 'second attempt patched the existing event (409 path)');
});

test('edits flow both ways; the newer edit wins a conflict and updatedAt never goes backwards', async () => {
  const h = harness();
  h.google.put('me@x.com', timed('g1', 'Original', '2026-09-29T10:00:00+06:00'));
  await h.run();
  const id = h.data.calendar.events[0].id;
  // Google-side edit.
  const g = h.google.events('me@x.com')[0]; g.summary = 'Edited in Google'; h.google.touch('me@x.com', g);
  const before = h.get(id).updatedAt;
  await h.run();
  assert.equal(h.get(id).title, 'Edited in Google');
  assert.ok(h.get(id).updatedAt > before);
  // Local edit newer than a concurrent Google edit.
  g.summary = 'Older Google edit'; h.google.touch('me@x.com', g);
  h.advance(60000);
  const ev = h.get(id); ev.title = 'Newer local edit'; C.touchItem(h.data, ev, h.now() + 3600000);
  await h.run();
  assert.equal(h.get(id).title, 'Newer local edit');
  assert.equal(h.google.events('me@x.com')[0].summary, 'Newer local edit');
});

test('deletions propagate both ways; pruning and deselection never delete in Google', async () => {
  const h = harness();
  h.google.put('me@x.com', timed('g1', 'Delete me in ZenFlow', '2026-09-29T10:00:00+06:00'));
  h.google.put('me@x.com', timed('g2', 'Delete me in Google', '2026-09-29T12:00:00+06:00'));
  await h.run();
  const localDel = h.data.calendar.events.find((e) => e.title.startsWith('Delete me in ZenFlow'));
  C.removeItem(h.data, ['calendar', 'events'], localDel.id, h.now());
  h.google.api.deleteEvent('me@x.com', 'g2');
  await h.run();
  assert.equal(h.google.live('me@x.com').length, 0);
  assert.equal(h.data.calendar.events.length, 0);

  h.google.put('team@x.com', timed('t1', 'Team', '2026-09-30T10:00:00Z'));
  C.setScalar(h.data, 'calendar', 'googleSelection', ['me@x.com', 'team@x.com'], h.now());
  const mine = h.local({ title: 'Mine, in team cal', cal: 'g:team@x.com' });
  await h.run();
  assert.equal(h.data.calendar.events.length, 2);
  C.setScalar(h.data, 'calendar', 'googleSelection', ['me@x.com'], h.now() + 1);
  await h.run();
  assert.deepEqual(h.data.calendar.events.map((e) => e.id), [mine.id], 'mirrored events removed, own events kept');
  assert.equal(h.google.live('team@x.com').length, 2, 'nothing deleted in Google');
});

test('recurring events: cancelled instances become exdates, edited instances override, no duplicates', async () => {
  const h = harness();
  h.google.put('me@x.com', timed('series', 'Standup', '2026-09-28T09:00:00+06:00', 0.25, { recurrence: ['RRULE:FREQ=DAILY;COUNT=5'] }));
  h.google.put('me@x.com', { id: 'series_20260929T030000Z', recurringEventId: 'series', originalStartTime: { dateTime: '2026-09-29T03:00:00Z' }, status: 'cancelled' });
  h.google.put('me@x.com', timed('series_20260930T030000Z', 'Standup (moved)', '2026-09-30T11:00:00+06:00', 0.25, { recurringEventId: 'series', originalStartTime: { dateTime: '2026-09-30T03:00:00Z' } }));
  await h.run();
  const occ = K.expandAll(h.data.calendar.events, Date.UTC(2026, 8, 28), Date.UTC(2026, 9, 5), 'UTC');
  assert.deepEqual(occ.map((o) => o.event.title + '@' + new Date(o.start).toISOString().slice(5, 13)), [
    'Standup@09-28T03', 'Standup (moved)@09-30T05', 'Standup@10-01T03', 'Standup@10-02T03'
  ]);
});

test('editing one occurrence of a Google series in ZenFlow patches that instance', async () => {
  const h = harness();
  h.google.put('me@x.com', timed('series', 'Gym', '2026-09-28T18:00:00+06:00', 1, { recurrence: ['RRULE:FREQ=WEEKLY'] }));
  await h.run();
  const master = h.data.calendar.events[0];
  const occStart = Date.parse('2026-10-05T12:00:00Z');
  master.exdates.push(occStart); C.touchItem(h.data, master, h.now());
  h.local({ title: 'Gym (late)', start: occStart + 2 * H, end: occStart + 3 * H, recurrenceId: master.id, originalStart: occStart, cal: 'g:me@x.com' });
  await h.run();
  const inst = h.google.events('me@x.com').find((e) => e.id === 'series_20261005T120000Z');
  assert.ok(inst, 'instance patched with the Google instance id');
  assert.equal(inst.summary, 'Gym (late)');
});

test('moving an event to the ZenFlow calendar removes it from Google but keeps it locally', async () => {
  const h = harness();
  await h.run();
  const ev = h.local({ title: 'Private', cal: 'g:me@x.com' });
  await h.run();
  const e = h.get(ev.id); e.cal = 'local'; C.touchItem(h.data, e, h.now() + 1000);
  await h.run();
  assert.equal(h.google.live('me@x.com').length, 0);
  assert.equal(h.get(ev.id).cal, 'local');
  assert.equal(h.get(ev.id).google, null);
});

test('an expired sync token triggers a full resync; read-only calendars are never written', async () => {
  const h = harness();
  h.google.put('me@x.com', timed('g1', 'A', '2026-09-29T10:00:00+06:00'));
  await h.run();
  h.state.calendars['me@x.com'].syncToken = 'expired!';
  await h.run();
  assert.ok(h.google.calls.some((c) => c[0] === 'list' && c[2] === 'full' && h.google.calls.indexOf(c) > 1));
  h.local({ title: 'Not allowed', cal: 'g:holidays@x.com' });
  const res = await h.run();
  assert.equal(res.stats.errors[0].code, 'calendar-not-writable');
  assert.equal(h.google.live('holidays@x.com').length, 0);
});

// ---------------------------------------------------------------------------
// Reminders & OAuth
// ---------------------------------------------------------------------------
test('reminder planner materializes the next 48h and diffs minimal changes', () => {
  const P = createReminderPlanner({ C, K });
  const d = C.defaultData();
  d.calendar.events.push(C.sanitizeEvent({ id: 'ev_a', title: 'Call', start: T0 + 2 * H, end: T0 + 3 * H, timeZone: 'Asia/Dhaka', reminders: [{ offsetMin: 10, type: 'notify' }], rrule: 'FREQ=DAILY', createdAt: 1, updatedAt: 1 }));
  const plan = P.plan('u1', d, T0);
  assert.equal(plan.length, 2, 'two daily occurrences within 48h');
  assert.match(plan[0].body, /Starts 12:00 PM/);
  const again = P.diff(plan, P.plan('u1', d, T0));
  assert.deepEqual([again.upserts.length, again.deletes.length], [0, 0]);
  d.calendar.events[0].reminders = [];
  const cleared = P.diff(plan, P.plan('u1', d, T0));
  assert.equal(cleared.deletes.length, 2);
  assert.equal(P.tooLate({ fireAt: T0 }, T0 + 2 * H), true);
  assert.equal(P.message(plan[0], plan[0].fireAt).fireAt, String(plan[0].fireAt));
});

test('OAuth state is signed, bound to its payload, and expires', () => {
  const s = OAuth.signState({ uid: 'u1', origin: 'https://app.example' }, 'secret', T0);
  assert.equal(OAuth.verifyState(s, 'secret', T0 + 1000).uid, 'u1');
  assert.throws(() => OAuth.verifyState(s, 'other-secret', T0), { code: 'bad-state' });
  const [body, sig] = s.split('.');
  const forged = Buffer.from(JSON.stringify({ uid: 'attacker', exp: T0 + 1e9 })).toString('base64url');
  assert.throws(() => OAuth.verifyState(forged + '.' + sig, 'secret', T0), { code: 'bad-state' });
  assert.throws(() => OAuth.verifyState(s, 'secret', T0 + 11 * 60000), { code: 'expired-state' });
  assert.ok(body);
});

test('code exchange insists on offline access and the calendar scope', async () => {
  const fetchWith = (json, ok = true) => async () => ({ ok, status: ok ? 200 : 400, json: async () => json });
  await assert.rejects(OAuth.exchangeCode({ fetch: fetchWith({ access_token: 'a', scope: 'https://www.googleapis.com/auth/calendar' }), code: 'c', clientId: 'i', clientSecret: 's', redirectUri: 'r' }), { code: 'no-refresh-token' });
  await assert.rejects(OAuth.exchangeCode({ fetch: fetchWith({ refresh_token: 'r', scope: 'openid email' }), code: 'c', clientId: 'i', clientSecret: 's', redirectUri: 'r' }), { code: 'scope-denied' });
  await assert.rejects(OAuth.exchangeCode({ fetch: fetchWith({ error: 'invalid_grant' }, false), code: 'c', clientId: 'i', clientSecret: 's', redirectUri: 'r' }), { code: 'invalid_grant' });
  const ok = await OAuth.exchangeCode({ fetch: fetchWith({ refresh_token: 'r', access_token: 'a', scope: 'openid https://www.googleapis.com/auth/calendar' }), code: 'c', clientId: 'i', clientSecret: 's', redirectUri: 'r' });
  assert.equal(ok.refresh_token, 'r');
});
