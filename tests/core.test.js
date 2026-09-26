'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/core.js');

const T0 = Date.UTC(2026, 8, 27, 4, 0, 0); // fixed reference instant

function data() { return C.defaultData(); }

// ---------------------------------------------------------------------------
// Output encoding / input sanitization (M1)
// ---------------------------------------------------------------------------
test('escapeHtml neutralizes element and attribute breakouts, including single quotes', () => {
  const payload = `<img src=x onerror="alert(1)">'); alert(2);//\``;
  const out = C.escapeHtml(payload);
  assert.ok(!/[<>"'`]/.test(out), out);
  assert.equal(C.escapeHtml(null), '');
  assert.equal(C.escapeHtml(0), '0');
});

test('sanitizeData drops hostile ids and malformed records at the trust boundary', () => {
  const raw = {
    schemaVersion: 2,
    todos: {
      items: [
        { id: "x');alert(1);//", text: '<b>ok</b>', listId: "');x", priority: 'evil', tags: ['a', 'a', 5, '<t>'], due: '2026-13-45', pomos: 99 },
        { id: 'good_1', text: '' },            // empty text -> dropped
        'not an object',
        { id: '__proto__', text: 'proto' }     // reserved-looking id -> re-keyed
      ],
      lists: [{ id: 'inbox', name: 'Inbox', color: 'red;background:url(x)' }]
    },
    tracking: { entries: [{ id: 'e1', start: 10, end: 5 }, { id: 'e2', start: T0, end: T0 + 60000, duration: 999999 }] },
    pomo: { workMins: 1e9, log: [{ id: 'l1', type: 'hack', mins: 1 }] }
  };
  const d = C.sanitizeData(raw);
  assert.equal(d.todos.items.length, 2);
  for (const it of d.todos.items) assert.ok(C.isValidId(it.id) && !it.id.startsWith('__'), it.id);
  const first = d.todos.items[0];
  assert.equal(first.text, '<b>ok</b>'); // content preserved; escaping is the renderer's job
  assert.equal(first.listId, 'inbox');
  assert.equal(first.priority, 'none');
  assert.deepEqual(first.tags, ['a', '<t>']);
  assert.equal(first.due, '');
  assert.equal(first.pomos, 12);
  assert.equal(d.todos.lists[0].color, '#7c6af7');
  assert.deepEqual(d.tracking.entries.map((e) => e.id), ['e2']);
  assert.equal(d.tracking.entries[0].duration, 60); // recomputed, not trusted
  assert.equal(d.pomo.workMins, 90);
  assert.equal(d.pomo.log.length, 0);
});

test('sanitizeData rejects non-objects; parseBackup rejects unknown formats with typed errors', () => {
  assert.throws(() => C.sanitizeData(null), { code: 'invalid-data' });
  assert.throws(() => C.parseBackup('not json'), { code: 'invalid-json' });
  assert.throws(() => C.parseBackup('{"hello":1}'), { code: 'unrecognized' });
  assert.throws(() => C.parseBackup('{"format":"zenflow-backup","schemaVersion":99,"data":{}}'), { code: 'unsupported-version' });
  // Malformed-but-recognizable backups load instead of bricking the app (M7).
  const d = C.parseBackup(JSON.stringify({ state: { todos: { items: null }, pomo: { garden: 'x' } } }));
  assert.deepEqual(d.todos.items, []);
  assert.deepEqual(d.pomo.garden, []);
});

// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------
const legacyState = {
  pomo: {
    workMins: 30, totalSessions: 7, totalFocusMins: 175,
    log: [{ type: 'work', mins: 25, time: '9:00 AM', task: 'x' }, { type: 'work', mins: 25, time: '9:00 AM', task: 'x' }],
    garden: [{ type: 'work', mins: 25, date: '2026-09-20T03:00:00.000Z', task: '', abandoned: false }]
  },
  todos: { items: [{ id: '1726000000000', text: 'Legacy task', createdAt: '2026-09-01T00:00:00.000Z', completed: false }], lists: [{ id: 'inbox', name: 'Inbox', color: '#7c6af7' }] },
  tracking: { entries: [{ id: '1726000000001', desc: 'Work', start: T0, end: T0 + 3600000, duration: 3600, date: 'x' }], projects: [{ id: 'p0', name: 'Personal', color: 9 }] },
  settings: { accent: '#4ade80', theme: 'light' }
};
const legacyStats = { '2026-09-20': { mins: 25, sessions: 1 } };

test('legacy migration preserves user data and produces deterministic ids', () => {
  const a = C.migrateLegacy(legacyState, legacyStats, 0);
  const b = C.migrateLegacy(JSON.parse(JSON.stringify(legacyState)), legacyStats, 0);
  assert.deepEqual(a, b, 'same legacy input must migrate identically on every device');
  assert.equal(a.pomo.workMins, 30);
  assert.equal(a.pomo.log.length, 2);
  assert.notEqual(a.pomo.log[0].id, a.pomo.log[1].id, 'identical records get distinct ids');
  assert.equal(a.todos.items[0].id, '1726000000000');
  assert.equal(a.todos.items[0].createdAt, Date.parse('2026-09-01T00:00:00.000Z'));
  assert.equal(a.tracking.projects[0].color, 1);
  assert.equal(a.settings.theme, 'light');
  assert.deepEqual(C.lifetimeTotals(a.stats), { sessions: 7, focusSecs: 175 * 60 });
  assert.equal(C.dayTotals(a.stats, '2026-09-20').secs, 1500);
});

test('legacy settings survive being merged into a fresh v2 copy (upgrade path)', () => {
  const legacy = C.migrateLegacy({ settings: { accent: '#4ade80', accent2: '#86efac', theme: 'light' }, pomo: { workMins: 30 } }, null, 0);
  for (const [x, y] of [[C.defaultData(), legacy], [legacy, C.defaultData()]]) {
    const m = C.merge(x, y, T0);
    assert.equal(m.settings.accent, '#4ade80');
    assert.equal(m.settings.theme, 'light');
    assert.equal(m.pomo.workMins, 30);
  }
  const edited = C.defaultData();
  C.setScalar(edited, 'settings', 'theme', 'dark', T0);
  assert.equal(C.merge(legacy, edited, T0).settings.theme, 'dark', 'a real edit beats migrated values');
});

test('merging a legacy copy with itself does not duplicate anything', () => {
  const a = C.migrateLegacy(legacyState, legacyStats, 0);
  const m = C.merge(a, C.migrateLegacy(legacyState, legacyStats, 0), T0);
  assert.equal(m.pomo.log.length, 2);
  assert.equal(m.pomo.garden.length, 1);
  assert.equal(m.todos.items.length, 1);
  assert.deepEqual(C.lifetimeTotals(m.stats), { sessions: 7, focusSecs: 175 * 60 });
});

// ---------------------------------------------------------------------------
// Merge semantics (H1, M5)
// ---------------------------------------------------------------------------
function addTodo(d, id, text, now) {
  d.todos.items.unshift({ id, text, note: '', due: '', listId: 'inbox', priority: 'none', tags: [], pomos: 1, completed: false, createdAt: now, updatedAt: now, subtasks: [] });
}

test('H1: merge keeps unsynced local items AND remote items (no overwrite in either direction)', () => {
  const local = data(), remote = data();
  addTodo(local, 'local_1', 'made offline', T0 + 1000);
  addTodo(remote, 'remote_1', 'made on phone', T0 + 2000);
  const m = C.merge(local, remote, T0 + 3000);
  assert.deepEqual(m.todos.items.map((t) => t.id).sort(), ['local_1', 'remote_1']);
});

test('merge: newer item version wins regardless of argument order', () => {
  const a = data(), b = data();
  addTodo(a, 't1', 'old', T0);
  addTodo(b, 't1', 'old', T0);
  b.todos.items[0].text = 'new';
  C.touchItem(b, b.todos.items[0], T0 + 10);
  assert.equal(C.merge(a, b, T0).todos.items[0].text, 'new');
  assert.equal(C.merge(b, a, T0).todos.items[0].text, 'new');
});

test('merge: deletions propagate via tombstones and are not resurrected by a stale copy', () => {
  const a = data(), stale = data();
  addTodo(a, 't1', 'x', T0);
  addTodo(stale, 't1', 'x', T0);
  assert.ok(C.removeItem(a, ['todos', 'items'], 't1', T0 + 5));
  const m = C.merge(a, stale, T0 + 6);
  assert.equal(m.todos.items.length, 0);
  assert.ok(m.tombstones.t1 >= T0 + 5);
  // ...but an edit made after the deletion wins.
  const edited = data();
  addTodo(edited, 't1', 'edited later', T0 + 100);
  assert.equal(C.merge(a, edited, T0 + 200).todos.items.length, 1);
});

test('merge: scalar settings are last-writer-wins per field, not per document', () => {
  const a = data(), b = data();
  C.setScalar(a, 'settings', 'theme', 'light', T0 + 10);     // device A changes theme later
  C.setScalar(b, 'pomo', 'workMins', 50, T0 + 5);            // device B changed focus length earlier
  const m = C.merge(a, b, T0 + 20);
  assert.equal(m.settings.theme, 'light');
  assert.equal(m.pomo.workMins, 50);
});

test('merge: per-replica focus counters are neither lost nor double counted', () => {
  const a = data(), b = data();
  C.creditFocus(a, 'rA', 1500, true, T0);
  C.creditFocus(b, 'rB', 600, true, T0);
  const m1 = C.merge(a, b, T0);
  const m2 = C.merge(m1, a, T0); // re-merging the same copy is idempotent
  assert.deepEqual(C.lifetimeTotals(m2.stats), { sessions: 2, focusSecs: 2100 });
});

test('merge result never aliases its inputs', () => {
  const a = data();
  addTodo(a, 't1', 'x', T0);
  const m = C.merge(a, data(), T0);
  m.todos.items[0].text = 'mutated';
  assert.equal(a.todos.items[0].text, 'x');
});

test('merge prunes tombstones after the TTL', () => {
  const a = data();
  a.tombstones.old = T0 - C.LIMITS.tombstoneTtlMs - 1;
  a.tombstones.fresh = T0 - 1000;
  const m = C.merge(a, data(), T0);
  assert.ok(!('old' in m.tombstones));
  assert.ok('fresh' in m.tombstones);
});

test('import resurrects locally deleted items but never overrides a newer local edit', () => {
  const local = data();
  addTodo(local, 'gone', 'deleted locally', T0);
  C.removeItem(local, ['todos', 'items'], 'gone', T0 + 10);
  addTodo(local, 'edited', 'local newer', T0 + 50);
  const backup = data();
  addTodo(backup, 'gone', 'deleted locally', T0);
  addTodo(backup, 'edited', 'backup older', T0 + 1);
  C.setScalar(backup, 'settings', 'theme', 'light', 1);
  const m = C.merge(local, C.prepareImport(local, backup, T0 + 100), T0 + 100);
  const byId = Object.fromEntries(m.todos.items.map((t) => [t.id, t.text]));
  assert.equal(byId.gone, 'deleted locally');
  assert.equal(byId.edited, 'local newer');
  assert.equal(m.settings.theme, 'light', 'restored settings apply');
});

test('dataFromRemoteDoc reads v1 documents and combines them with v2 data', () => {
  const v1Doc = { state: legacyState, dailyStats: legacyStats, clientUpdatedAt: T0 };
  const d = C.dataFromRemoteDoc(v1Doc, T0);
  assert.equal(d.todos.items[0].text, 'Legacy task');
  assert.equal(d.clocks['settings:theme'], T0);
  assert.equal(C.dataFromRemoteDoc(null, T0), null);
  assert.equal(C.dataFromRemoteDoc({ profile: { nickname: 'a' } }, T0), null);
});

test('assertCloudSize refuses documents over the Firestore budget with a typed error', () => {
  const d = data();
  for (let i = 0; i < 700; i++) addTodo(d, 't' + i, 'x'.repeat(190), T0), d.todos.items[0].note = 'n'.repeat(1500);
  assert.throws(() => C.assertCloudSize(d), { code: 'zenflow/too-large' });
});

// ---------------------------------------------------------------------------
// Dates & streaks (M3, L2)
// ---------------------------------------------------------------------------
function withTZ(tz, fn) {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try { fn(); } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
}

test('M3: localDayKey uses the local calendar day in UTC+6 and UTC-4', () => {
  withTZ('Asia/Dhaka', () => {
    // 02:00 local on Sep 27 is still Sep 26 in UTC — the old code filed it under Sep 26.
    assert.equal(C.localDayKey(new Date(2026, 8, 27, 2, 0)), '2026-09-27');
  });
  withTZ('America/New_York', () => {
    // 23:00 local on Sep 27 is Sep 28 in UTC.
    assert.equal(C.localDayKey(new Date(2026, 8, 27, 23, 0)), '2026-09-27');
  });
});

test('M3: a due date is "Today" on that local day in every timezone', () => {
  for (const tz of ['America/Los_Angeles', 'UTC', 'Asia/Dhaka', 'Pacific/Kiritimati']) {
    withTZ(tz, () => {
      const now = new Date(2026, 8, 27, 20, 0);
      assert.equal(C.describeDue('2026-09-27', now).label, 'Today', tz);
      assert.equal(C.describeDue('2026-09-26', now).overdue, true, tz);
      assert.equal(C.describeDue('2026-09-28', now).label, 'Tomorrow', tz);
    });
  }
});

test('M3: focus credited late at night lands on the local day, and the streak sees it the same day', () => {
  withTZ('Asia/Dhaka', () => {
    const d = data();
    const lateNight = new Date(2026, 8, 27, 1, 30).getTime();
    C.creditFocus(d, 'r1', 1500, true, lateNight);
    assert.equal(C.dayTotals(d.stats, '2026-09-27').secs, 1500);
    assert.equal(C.computeStreak(d.stats, new Date(2026, 8, 27, 10)).current, 1);
  });
});

test('L2: streak stays alive until the day ends and longest is computed over all history', () => {
  withTZ('UTC', () => {
    const d = data();
    const on = (y, m, day) => C.creditFocus(d, 'r', 60, true, new Date(y, m, day, 12).getTime());
    [1, 2, 3, 4, 5].forEach((x) => on(2026, 8, x));   // 5-day run
    [25, 26].forEach((x) => on(2026, 8, x));          // current run
    const noFocusYetToday = C.computeStreak(d.stats, new Date(2026, 8, 27, 9));
    assert.deepEqual(noFocusYetToday, { current: 2, longest: 5 });
    assert.equal(C.computeStreak(d.stats, new Date(2026, 8, 29, 9)).current, 0);
  });
});

// ---------------------------------------------------------------------------
// Pomodoro state machine (H3, M2, L1)
// ---------------------------------------------------------------------------
const cfg = () => data().pomo;

test('M2: skipping a work session credits only elapsed time and never a completed session', () => {
  const d = data(), p = C.defaultRuntime().pomo, c = cfg();
  C.pomoStart(p, c, T0);
  const r = C.pomoFinish(d, p, c, { now: T0 + 1000, skipped: true, task: '', replica: 'r' });
  assert.equal(r.completed, false);
  assert.deepEqual(C.lifetimeTotals(d.stats), { sessions: 0, focusSecs: 1 });
  assert.equal(d.pomo.garden.length, 0, 'no tree (not even a dead one) for a 1-second attempt');
  assert.equal(p.mode, 'short-break');
});

test('M2: skipping after 10 minutes credits 10 minutes and plants one abandoned tree', () => {
  const d = data(), p = C.defaultRuntime().pomo, c = cfg();
  C.pomoStart(p, c, T0);
  C.pomoFinish(d, p, c, { now: T0 + 600000, skipped: true, task: 't', replica: 'r' });
  assert.equal(C.lifetimeTotals(d.stats).focusSecs, 600);
  assert.equal(d.pomo.garden.length, 1);
  assert.equal(d.pomo.garden[0].abandoned, true);
  assert.equal(d.pomo.garden[0].mins, 10);
});

test('M2: natural completion credits the frozen session length, even if settings change mid-session', () => {
  const d = data(), p = C.defaultRuntime().pomo, c = cfg();
  C.pomoStart(p, c, T0);
  c.workMins = 90; // UI blocks this while running; the model is robust to it anyway
  assert.ok(C.pomoIsDue(p, T0 + 25 * 60000));
  const r = C.pomoFinish(d, p, c, { now: T0 + 25 * 60000, replica: 'r' });
  assert.equal(r.completed, true);
  assert.deepEqual(C.lifetimeTotals(d.stats), { sessions: 1, focusSecs: 1500 });
  assert.equal(d.pomo.log[0].mins, 25);
});

test('pause/resume preserves remaining time; mode changes are refused mid-session', () => {
  const p = C.defaultRuntime().pomo, c = cfg();
  C.pomoStart(p, c, T0);
  C.pomoPause(p, c, T0 + 60000);
  assert.equal(C.pomoRemaining(p, c, T0 + 999999), 1440);
  assert.equal(C.pomoSetMode(p, 'long-break'), false);
  C.pomoStart(p, c, T0 + 120000);
  assert.equal(C.pomoRemaining(p, c, T0 + 120000 + 1000), 1439);
  assert.equal(C.pomoStart(p, c, T0 + 130000), false, 'start is idempotent (L1)');
});

test('H3: a running session survives a reload (serialize -> sanitize) and completes exactly once', () => {
  const d = data(), rt = C.defaultRuntime(), c = cfg();
  C.pomoStart(rt.pomo, c, T0);
  const restored = C.sanitizeRuntime(JSON.parse(JSON.stringify(rt)));
  assert.equal(restored.pomo.status, 'running');
  assert.equal(C.pomoRemaining(restored.pomo, c, T0 + 60000), 1440);
  // Two tabs (or a reload racing a timer) try to complete the same session.
  const copy = JSON.parse(JSON.stringify(restored.pomo));
  const first = C.pomoFinish(d, restored.pomo, c, { now: T0 + 1500000, replica: 'r' });
  const second = C.pomoFinish(d, copy, c, { now: T0 + 1500001, replica: 'r' });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(C.lifetimeTotals(d.stats).sessions, 1);
});

test('H3: a running time-tracker survives a reload and produces the full entry', () => {
  const d = data(), rt = C.defaultRuntime();
  C.trackStart(rt.tracking, { desc: 'Deep work', project: 'p0', tag: 'work' }, T0);
  const restored = C.sanitizeRuntime(JSON.parse(JSON.stringify(rt)));
  assert.equal(restored.tracking.status, 'running');
  const e = C.trackStop(d, restored.tracking, T0 + 3 * 3600000);
  assert.equal(e.duration, 3 * 3600);
  assert.equal(d.tracking.entries.length, 1);
  assert.equal(restored.tracking.status, 'idle');
});

test('sanitizeRuntime downgrades corrupt running state instead of crashing', () => {
  const r = C.sanitizeRuntime({ pomo: { status: 'running', total: 1500 }, timer: { status: 'running' }, tracking: { status: 'running' } });
  assert.equal(r.pomo.status, 'idle');
  assert.equal(r.timer.status, 'paused');
  assert.equal(r.tracking.status, 'idle');
});

test('countdown timer: fresh start vs resume, finish is single-shot, survives reload', () => {
  const t = C.defaultRuntime().timer;
  C.timerSetTotal(t, 90);
  assert.equal(C.timerStart(t, T0), 'started');
  C.timerPause(t, T0 + 30000);
  assert.equal(C.timerStart(t, T0 + 40000), 'resumed');
  const restored = C.sanitizeRuntime({ timer: JSON.parse(JSON.stringify(t)) }).timer;
  assert.equal(C.timerRemaining(restored, T0 + 40000), 60);
  assert.equal(C.timerSetTotal(restored, 10), false, 'cannot change total while running');
  assert.ok(C.timerIsDue(restored, T0 + 100000));
  assert.equal(C.timerFinish(restored, T0 + 100000), true);
  assert.equal(C.timerFinish(restored, T0 + 100001), false);
});

test('stopwatch elapsed is wall-clock based and never negative', () => {
  const sw = C.defaultRuntime().sw;
  C.swStart(sw, T0);
  assert.equal(C.swElapsed(sw, T0 + 1234), 1234);
  assert.equal(C.swElapsed(sw, T0 - 5000), 0);
  C.swLap(sw, T0 + 1000);
  C.swLap(sw, T0 + 2500);
  assert.deepEqual(sw.laps.map((l) => l.lap), [1000, 1500]);
});

test('clocks advance monotonically even if the wall clock steps backwards', () => {
  const d = data();
  C.setScalar(d, 'settings', 'theme', 'light', T0);
  C.setScalar(d, 'settings', 'theme', 'dark', T0 - 60000);
  assert.ok(d.clocks['settings:theme'] > T0);
});

test('formatDuration has no trailing whitespace and handles hours', () => {
  assert.equal(C.formatDuration(59), '59s');
  assert.equal(C.formatDuration(1500), '25m');
  assert.equal(C.formatDuration(1530), '25m 30s');
  assert.equal(C.formatDuration(3600), '1h');
  assert.equal(C.formatDuration(5400), '1h 30m');
});

// ---------------------------------------------------------------------------
// Merge algebra (property-style): convergence requires these laws.
// ---------------------------------------------------------------------------
function rng(seed) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
}
function randomReplica(r, shared) {
  const d = data();
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  for (let i = 0; i < 8; i++) {
    const id = pick(shared);
    const t = Math.floor(r() * 5); // few distinct timestamps => plenty of ties
    if (r() < 0.2) { d.tombstones[id] = T0 + t; continue; }
    if (!d.todos.items.some((x) => x.id === id)) addTodo(d, id, 'v' + Math.floor(r() * 3), T0 + t);
    d.pomo.log.push({ id: 'l' + id, type: 'work', mins: 1, task: '', at: T0 + t, label: '', skipped: false, updatedAt: T0 + t });
    d.todos.lists.push({ id: 'L' + id, name: 'n', color: '#7c6af7', createdAt: t, updatedAt: t });
  }
  C.setScalar(d, 'settings', 'volume', Math.floor(r() * 100), T0 + Math.floor(r() * 5));
  C.creditFocus(d, pick(['r1', 'r2', 'r3']), Math.floor(r() * 3000), r() < 0.5, T0);
  return C.sanitizeData(d);
}

test('merge is commutative, idempotent and associative (so replicas converge)', () => {
  const r = rng(12345);
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  for (let i = 0; i < 300; i++) {
    const [x, y, z] = [randomReplica(r, ids), randomReplica(r, ids), randomReplica(r, ids)];
    const xy = C.merge(x, y, T0), yx = C.merge(y, x, T0);
    const strip = (d) => d;
    assert.deepEqual(strip(xy), strip(yx), 'commutative');
    assert.deepEqual(C.merge(xy, xy, T0), xy, 'idempotent');
    assert.deepEqual(strip(C.merge(C.merge(x, y, T0), z, T0)), strip(C.merge(x, C.merge(y, z, T0), T0)), 'associative');
  }
});
