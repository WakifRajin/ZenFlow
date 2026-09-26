/*
 * ZenFlow core — pure domain logic.
 *
 * No DOM, storage or network access lives here, so everything in this file can
 * be unit-tested under Node (`node --test`). Loaded as a classic script in the
 * browser (window.ZenCore) and via require() in tests.
 *
 * Data contracts (see README "Data model"):
 *  - All timestamps are epoch milliseconds (numbers). Durations are seconds
 *    unless a field name says otherwise (`mins`).
 *  - Calendar days are LOCAL-time keys "YYYY-MM-DD" (localDayKey).
 *  - Synced data ("data") is schema v2. Device-local timer state ("runtime")
 *    and UI preferences ("prefs") are never synced.
 *  - Every collection item has a stable `id` and an `updatedAt`; deletions are
 *    recorded as tombstones so merges never resurrect deleted items.
 *  - Scalar settings carry a per-field clock in `data.clocks`.
 *  - Focus statistics are per-replica grow-only counters, merged by max.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ZenCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCHEMA_VERSION = 2;
  const DAY_MS = 86400000;
  const LIMITS = Object.freeze({
    log: 50,
    garden: 1000,
    entries: 500,
    recent: 5,
    tombstoneTtlMs: 90 * DAY_MS,
    text: 200,
    note: 2000,
    name: 40,
    tag: 30,
    tags: 20,
    task: 80,
    desc: 200,
    subtasks: 50,
    nickname: 24,
    // Firestore's hard limit is 1 MiB per document; keep headroom.
    docBytes: 900000
  });

  class ZenError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'ZenError';
      this.code = code;
    }
  }

  // ---------------------------------------------------------------------------
  // Primitive validators
  // ---------------------------------------------------------------------------
  const ID_RE = /^(?!__)[A-Za-z0-9_-]{1,64}$/;
  const HEX_RE = /^#[0-9a-fA-F]{6}$/;
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const CLOCK_KEY_RE = /^[a-z]+:[A-Za-z0-9]+$/;

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const isValidId = (v) => typeof v === 'string' && ID_RE.test(v);
  const str = (v, max, dflt = '') => (typeof v === 'string' ? v.slice(0, max) : dflt);
  const bool = (v, dflt) => (typeof v === 'boolean' ? v : dflt);

  function num(v, min, max, dflt) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, n));
  }
  function int(v, min, max, dflt) {
    const n = num(v, min, max, NaN);
    return Number.isNaN(n) ? dflt : Math.round(n);
  }
  // Accepts epoch ms or an ISO string (legacy data); returns epoch ms.
  function toMs(v, dflt) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 8.64e15) return Math.round(v);
    if (typeof v === 'string' && v) {
      const t = Date.parse(v);
      if (Number.isFinite(t) && t >= 0) return t;
    }
    return dflt;
  }
  const uniq = (xs) => [...new Set(xs)];

  // ---------------------------------------------------------------------------
  // Output encoding
  // ---------------------------------------------------------------------------
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
  // Safe for element content AND quoted attribute values (single or double).
  function escapeHtml(v) {
    return v == null ? '' : String(v).replace(/[&<>"'`]/g, (c) => ESC[c]);
  }

  // ---------------------------------------------------------------------------
  // Identifiers
  // ---------------------------------------------------------------------------
  function hash32(s, seed) {
    let h = (0x811c9dc5 ^ seed) >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }
  // Deterministic id: the same legacy record migrated on two devices must get
  // the same id, otherwise merging would duplicate it.
  function stableId(prefix, s) {
    return prefix + '_' + hash32(s, 0).toString(36) + hash32(s, 0x9e3779b9).toString(36);
  }
  function newId(prefix) {
    const c = typeof crypto !== 'undefined' ? crypto : null;
    let r;
    if (c && typeof c.randomUUID === 'function') r = c.randomUUID().replace(/-/g, '');
    else if (c && typeof c.getRandomValues === 'function') {
      r = Array.from(c.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
    } else r = Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    return (prefix ? prefix + '_' : '') + r.slice(0, 24);
  }

  // ---------------------------------------------------------------------------
  // Dates (local calendar semantics everywhere)
  // ---------------------------------------------------------------------------
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  function localDayKey(d) {
    const x = d instanceof Date ? d : new Date(d == null ? Date.now() : d);
    return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate());
  }
  // "YYYY-MM-DD" -> local midnight Date, or null if invalid.
  function parseDayKey(k) {
    if (typeof k !== 'string' || !DAY_RE.test(k)) return null;
    const [y, m, d] = k.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return dt;
  }
  function addDays(date, n) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
  }
  // Whole calendar days from a to b (DST-safe).
  function dayDiff(aKey, bKey) {
    const a = parseDayKey(aKey), b = parseDayKey(bKey);
    if (!a || !b) return NaN;
    return Math.round((b - a) / DAY_MS);
  }
  function describeDue(due, now) {
    const d = parseDayKey(due);
    if (!d) return null;
    const diff = dayDiff(localDayKey(now), due);
    let label;
    if (diff === 0) label = 'Today';
    else if (diff === 1) label = 'Tomorrow';
    else if (diff === -1) label = 'Yesterday';
    else if (diff < 0) label = `${-diff}d overdue`;
    else if (diff < 7) label = `${diff}d left`;
    else label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return { diff, overdue: diff < 0, label };
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------
  function formatTime(s) {
    s = Math.max(0, Math.floor(s));
    return pad(Math.floor(s / 60)) + ':' + pad(s % 60);
  }
  function formatHMS(s) {
    s = Math.max(0, Math.floor(s));
    return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60);
  }
  function formatDuration(s) {
    s = Math.max(0, Math.round(s));
    if (s < 60) return s + 's';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h === 0) return m + 'm' + (sec ? ' ' + sec + 's' : '');
    return h + 'h' + (m ? ' ' + m + 'm' : '');
  }
  function formatMs(ms) {
    ms = Math.max(0, Math.floor(ms));
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000), r = ms % 1000;
    return pad(h) + ':' + pad(m) + ':' + pad(s) + '.' + pad(r, 3);
  }

  // ---------------------------------------------------------------------------
  // Schema v2: defaults
  // ---------------------------------------------------------------------------
  const SOUNDS = ['bell', 'chime', 'ding', 'beep', 'none'];
  const PRIORITIES = ['high', 'medium', 'low', 'none'];
  const POMO_MODES = ['work', 'short-break', 'long-break'];
  const AMBIENT_IDS = ['rain', 'forest', 'cafe', 'ocean', 'fire', 'white'];
  const TODO_FILTERS = ['all', 'today', 'upcoming', 'completed', 'priority-high'];
  const TRACK_FILTERS = ['all', 'today', 'week'];
  const PROJECT_COLORS = ['#7c6af7', '#4ade80', '#f87171', '#22d3ee', '#fbbf24', '#f472b6', '#fb923c', '#a78bfa'];

  const SCALARS = [
    ['settings', 'accent'], ['settings', 'accent2'], ['settings', 'theme'], ['settings', 'bgStyle'],
    ['settings', 'sound'], ['settings', 'volume'],
    ['pomo', 'workMins'], ['pomo', 'shortMins'], ['pomo', 'longMins'], ['pomo', 'sessionsBeforeLong'],
    ['pomo', 'autoBreak'], ['pomo', 'autoWork'], ['pomo', 'sound'],
    ['timer', 'recent']
  ];

  function defaultData() {
    return {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: 0,
      clocks: {},
      settings: { accent: '#7c6af7', accent2: '#a594ff', theme: 'dark', bgStyle: 'dark', sound: 'bell', volume: 70 },
      pomo: {
        workMins: 25, shortMins: 5, longMins: 15, sessionsBeforeLong: 4,
        autoBreak: false, autoWork: false, sound: true,
        log: [], garden: []
      },
      todos: {
        items: [],
        lists: [
          { id: 'inbox', name: 'Inbox', color: '#7c6af7', createdAt: 0, updatedAt: 0 },
          { id: 'work', name: 'Work', color: '#f87171', createdAt: 1, updatedAt: 0 },
          { id: 'personal', name: 'Personal', color: '#4ade80', createdAt: 2, updatedAt: 0 }
        ]
      },
      timer: {
        presets: [
          { id: 'p1', name: 'Quick Task', h: 0, m: 5, s: 0, createdAt: 1, updatedAt: 0 },
          { id: 'p2', name: 'Pomodoro', h: 0, m: 25, s: 0, createdAt: 2, updatedAt: 0 },
          { id: 'p3', name: 'Short Break', h: 0, m: 5, s: 0, createdAt: 3, updatedAt: 0 },
          { id: 'p4', name: 'Lunch Break', h: 0, m: 30, s: 0, createdAt: 4, updatedAt: 0 },
          { id: 'p5', name: 'Deep Work', h: 1, m: 30, s: 0, createdAt: 5, updatedAt: 0 }
        ],
        recent: []
      },
      tracking: {
        entries: [],
        projects: [
          { id: 'p0', name: 'Personal', color: 0, createdAt: 0, updatedAt: 0 },
          { id: 'p1', name: 'Work', color: 1, createdAt: 1, updatedAt: 0 }
        ]
      },
      stats: { daily: {}, counters: {} },
      tombstones: {}
    };
  }

  function defaultRuntime() {
    return {
      rev: 0,
      pomo: { mode: 'work', session: 1, status: 'idle', total: null, remaining: null, targetEnd: null, sessionId: null, startedAt: null, task: '' },
      timer: { status: 'idle', total: 300, remaining: 300, targetEnd: null, laps: [], activePreset: null, finishedAt: null },
      sw: { status: 'idle', startTime: 0, elapsed: 0, laps: [], lastLap: 0 },
      tracking: { status: 'idle', startTime: null, current: { desc: '', project: '', tag: 'none' } }
    };
  }

  function defaultPrefs() {
    return { activeList: 'all', activeFilter: 'all', activeTag: '', trackingFilter: 'all', todoSort: 'created', ambient: null, ambientPlaying: false };
  }

  // ---------------------------------------------------------------------------
  // Sanitizers — every trust boundary (localStorage, import, Firestore) passes
  // through these. They never throw on bad items; invalid items are dropped and
  // out-of-range values clamped, so the rest of the app can rely on the shape.
  // ---------------------------------------------------------------------------
  function sanitizeSettings(s, d) {
    s = isObj(s) ? s : {};
    return {
      accent: HEX_RE.test(s.accent) ? s.accent : d.accent,
      accent2: HEX_RE.test(s.accent2) ? s.accent2 : d.accent2,
      theme: s.theme === 'light' ? 'light' : 'dark',
      bgStyle: s.bgStyle === 'darker' ? 'darker' : 'dark',
      sound: SOUNDS.includes(s.sound) ? s.sound : d.sound,
      volume: int(s.volume, 0, 100, d.volume)
    };
  }

  function sanitizePomoConfig(p, d) {
    p = isObj(p) ? p : {};
    return {
      workMins: int(p.workMins, 1, 90, d.workMins),
      shortMins: int(p.shortMins, 1, 30, d.shortMins),
      longMins: int(p.longMins, 5, 60, d.longMins),
      sessionsBeforeLong: int(p.sessionsBeforeLong, 2, 8, d.sessionsBeforeLong),
      autoBreak: bool(p.autoBreak, d.autoBreak),
      autoWork: bool(p.autoWork, d.autoWork),
      sound: bool(p.sound, d.sound)
    };
  }

  function sanitizeTodo(t, idx) {
    if (!isObj(t)) return null;
    const text = str(t.text, LIMITS.text).trim();
    if (!text) return null;
    const createdAt = toMs(t.createdAt, 0);
    return {
      id: isValidId(t.id) ? t.id : stableId('t', text + '|' + createdAt + '|' + idx),
      text,
      note: str(t.note, LIMITS.note),
      due: parseDayKey(t.due) ? t.due : '',
      listId: isValidId(t.listId) ? t.listId : 'inbox',
      priority: PRIORITIES.includes(t.priority) ? t.priority : 'none',
      tags: uniq(arr(t.tags).map((x) => str(x, LIMITS.tag).trim()).filter(Boolean)).slice(0, LIMITS.tags),
      pomos: int(t.pomos, 1, 12, 1),
      completed: t.completed === true,
      createdAt,
      updatedAt: toMs(t.updatedAt, createdAt),
      subtasks: arr(t.subtasks).filter(isObj).slice(0, LIMITS.subtasks)
        .map((s) => ({ text: str(s.text, LIMITS.text), done: s.done === true }))
    };
  }

  function sanitizeList(l) {
    if (!isObj(l)) return null;
    const name = str(l.name, LIMITS.name).trim();
    if (!name) return null;
    return {
      id: isValidId(l.id) ? l.id : stableId('l', name),
      name,
      color: HEX_RE.test(l.color) ? l.color : '#7c6af7',
      createdAt: toMs(l.createdAt, 0),
      updatedAt: toMs(l.updatedAt, toMs(l.createdAt, 0))
    };
  }

  function sanitizePreset(p) {
    if (!isObj(p)) return null;
    const name = str(p.name, LIMITS.name).trim();
    if (!name) return null;
    return {
      id: isValidId(p.id) ? p.id : stableId('pr', name + '|' + p.h + '|' + p.m + '|' + p.s),
      name,
      h: int(p.h, 0, 23, 0),
      m: int(p.m, 0, 59, 0),
      s: int(p.s, 0, 59, 0),
      createdAt: toMs(p.createdAt, 0),
      updatedAt: toMs(p.updatedAt, toMs(p.createdAt, 0))
    };
  }

  function sanitizeRecent(list) {
    return arr(list)
      .map((r) => (isObj(r) ? int(r.total, 1, 86399, 0) : 0))
      .filter((t) => t > 0)
      .slice(0, LIMITS.recent)
      .map((total) => ({ total }));
  }

  function sanitizeProject(p) {
    if (!isObj(p)) return null;
    const name = str(p.name, LIMITS.name).trim();
    if (!name) return null;
    return {
      id: isValidId(p.id) ? p.id : stableId('pj', name),
      name,
      color: ((int(p.color, 0, 1e6, 0) % 8) + 8) % 8,
      createdAt: toMs(p.createdAt, 0),
      updatedAt: toMs(p.updatedAt, toMs(p.createdAt, 0))
    };
  }

  function sanitizeEntry(e) {
    if (!isObj(e)) return null;
    const start = toMs(e.start, NaN), end = toMs(e.end, NaN);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    const id = isValidId(e.id) ? e.id : stableId('e', start + '|' + end);
    return {
      id,
      desc: str(e.desc, LIMITS.desc),
      project: isValidId(e.project) ? e.project : '',
      tag: /^[a-z]{1,20}$/.test(e.tag) ? e.tag : 'none',
      start,
      end,
      duration: Math.round((end - start) / 1000),
      updatedAt: toMs(e.updatedAt, end)
    };
  }

  function sanitizeGarden(g) {
    if (!isObj(g) || !isValidId(g.id)) return null;
    return {
      id: g.id,
      mins: Math.round(num(g.mins, 0, 600, 0) * 100) / 100,
      at: toMs(g.at, 0),
      task: str(g.task, LIMITS.task),
      abandoned: g.abandoned === true,
      updatedAt: toMs(g.updatedAt, toMs(g.at, 0))
    };
  }

  function sanitizeLog(l) {
    if (!isObj(l) || !isValidId(l.id) || !POMO_MODES.includes(l.type)) return null;
    return {
      id: l.id,
      type: l.type,
      mins: Math.round(num(l.mins, 0, 600, 0) * 100) / 100,
      task: str(l.task, LIMITS.task),
      at: toMs(l.at, 0),
      label: str(l.label, 20),
      skipped: l.skipped === true,
      updatedAt: toMs(l.updatedAt, toMs(l.at, 0))
    };
  }

  function sanitizeCounterMap(m, fields) {
    const out = {};
    if (!isObj(m)) return out;
    for (const [replica, v] of Object.entries(m)) {
      if (!isValidId(replica) || !isObj(v)) continue;
      const o = {};
      for (const [f, max] of fields) o[f] = int(v[f], 0, max, 0);
      out[replica] = o;
    }
    return out;
  }

  function sanitizeStats(s) {
    s = isObj(s) ? s : {};
    const daily = {};
    if (isObj(s.daily)) {
      for (const [day, reps] of Object.entries(s.daily)) {
        if (!parseDayKey(day)) continue;
        const m = sanitizeCounterMap(reps, [['secs', 86400], ['sessions', 1000]]);
        if (Object.keys(m).length) daily[day] = m;
      }
    }
    return { daily, counters: sanitizeCounterMap(s.counters, [['sessions', 1e7], ['focusSecs', 1e10]]) };
  }

  function sanitizeTimeMap(m, keyOk) {
    const out = {};
    if (!isObj(m)) return out;
    for (const [k, v] of Object.entries(m)) {
      if (!keyOk(k)) continue;
      const t = toMs(v, NaN);
      if (Number.isFinite(t)) out[k] = t;
    }
    return out;
  }

  // Drops invalid items and duplicate ids (first occurrence wins).
  function cleanList(list, fn) {
    const seen = new Set(), out = [];
    arr(list).forEach((x, i) => {
      const v = fn(x, i);
      if (v && !seen.has(v.id)) { seen.add(v.id); out.push(v); }
    });
    return out;
  }

  function ensureInbox(lists) {
    if (!lists.some((l) => l.id === 'inbox')) lists.unshift({ id: 'inbox', name: 'Inbox', color: '#7c6af7', createdAt: 0, updatedAt: 0 });
    return lists;
  }

  // Total orders (id breaks ties) so merge(a, b) and merge(b, a) produce the
  // same sequence; otherwise two tabs could keep rewriting each other's order.
  const idCmp = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const byAtDesc = (a, b) => b.at - a.at || idCmp(a, b);
  const byAtAsc = (a, b) => a.at - b.at || idCmp(a, b);
  const byStartDesc = (a, b) => b.start - a.start || idCmp(a, b);
  const byCreatedDesc = (a, b) => b.createdAt - a.createdAt || idCmp(a, b);
  const byCreatedAsc = (a, b) => a.createdAt - b.createdAt || idCmp(a, b);

  // Sanitize a schema-v2 data object.
  function sanitizeData(raw) {
    if (!isObj(raw)) throw new ZenError('invalid-data', 'Data must be an object');
    const d = defaultData();
    const pomo = isObj(raw.pomo) ? raw.pomo : {};
    const todos = isObj(raw.todos) ? raw.todos : {};
    const timer = isObj(raw.timer) ? raw.timer : {};
    const tracking = isObj(raw.tracking) ? raw.tracking : {};
    const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const out = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: toMs(raw.updatedAt, 0),
      clocks: sanitizeTimeMap(raw.clocks, (k) => CLOCK_KEY_RE.test(k)),
      settings: sanitizeSettings(raw.settings, d.settings),
      pomo: Object.assign(sanitizePomoConfig(pomo, d.pomo), {
        log: cleanList(pomo.log, sanitizeLog).sort(byAtDesc).slice(0, LIMITS.log),
        garden: cleanList(pomo.garden, sanitizeGarden).sort(byAtAsc).slice(-LIMITS.garden)
      }),
      todos: {
        items: cleanList(todos.items, sanitizeTodo).sort(byCreatedDesc),
        lists: ensureInbox(has(todos, 'lists') ? cleanList(todos.lists, sanitizeList) : d.todos.lists).sort(byCreatedAsc)
      },
      timer: {
        presets: (has(timer, 'presets') ? cleanList(timer.presets, sanitizePreset) : d.timer.presets).sort(byCreatedAsc),
        recent: sanitizeRecent(timer.recent)
      },
      tracking: {
        entries: cleanList(tracking.entries, sanitizeEntry).sort(byStartDesc).slice(0, LIMITS.entries),
        projects: (has(tracking, 'projects') ? cleanList(tracking.projects, sanitizeProject) : d.tracking.projects).sort(byCreatedAsc)
      },
      stats: sanitizeStats(raw.stats),
      tombstones: sanitizeTimeMap(raw.tombstones, isValidId)
    };
    return out;
  }

  // Convert the pre-v2 persisted state (+ separate daily_stats) into v2.
  // `clock` is the time the legacy data was last written (0 if unknown), used
  // as the scalar clock so a newer v2 value always wins over it.
  function migrateLegacy(state, dailyStats, clock) {
    state = isObj(state) ? state : {};
    const p = isObj(state.pomo) ? state.pomo : {};
    const t = isObj(state.todos) ? state.todos : {};
    const tm = isObj(state.timer) ? state.timer : {};
    const tr = isObj(state.tracking) ? state.tracking : {};
    clock = toMs(clock, 0);

    // Occurrence counters make ids deterministic even for identical records.
    const occ = (map, key) => { map[key] = (map[key] || 0) + 1; return map[key]; };
    const gSeen = {};
    const garden = arr(p.garden).filter(isObj).map((g) => {
      const key = [g.date, g.mins, g.task, g.abandoned].join('|');
      return { id: stableId('g', key + '#' + occ(gSeen, key)), mins: g.mins, at: toMs(g.date, 0), task: g.task, abandoned: g.abandoned === true };
    });
    const lSeen = {};
    const log = arr(p.log).filter(isObj).slice().reverse().map((l) => {
      const key = [l.type, l.mins, l.time, l.task].join('|');
      return { id: stableId('lg', key + '#' + occ(lSeen, key)), type: l.type, mins: l.mins, task: l.task, at: 0, label: l.time };
    }).reverse();

    // v1 arrays were displayed in array order; keep it via creation index.
    const ordered = (xs) => (Array.isArray(xs) ? xs.map((x, i) => (isObj(x) ? Object.assign({}, x, { createdAt: i, updatedAt: 0 }) : x)) : undefined);
    const daily = {};
    if (isObj(dailyStats)) {
      for (const [day, v] of Object.entries(dailyStats)) {
        if (!isObj(v)) continue;
        daily[day] = { legacy: { secs: Math.round(num(v.mins, 0, 1440, 0) * 60), sessions: int(v.sessions, 0, 1000, 0) } };
      }
    }

    const v2 = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: clock,
      clocks: {},
      settings: state.settings,
      pomo: Object.assign({}, p, { log, garden }),
      todos: { items: t.items, lists: ordered(t.lists) },
      timer: { presets: ordered(tm.presets), recent: tm.recent },
      tracking: { entries: tr.entries, projects: ordered(tr.projects) },
      stats: {
        daily,
        counters: { legacy: { sessions: int(p.totalSessions, 0, 1e7, 0), focusSecs: Math.round(num(p.totalFocusMins, 0, 1e8, 0) * 60) } }
      },
      tombstones: {}
    };
    if (!Array.isArray(t.lists)) delete v2.todos.lists;
    if (!Array.isArray(tm.presets)) delete v2.timer.presets;
    if (!Array.isArray(tr.projects)) delete v2.tracking.projects;
    // Clock >= 1 so migrated values beat untouched defaults (clock 0) but lose
    // to any real edit made after the upgrade.
    for (const [g, k] of SCALARS) v2.clocks[g + ':' + k] = Math.max(1, clock);
    return sanitizeData(v2);
  }

  function sanitizeRuntime(r) {
    const d = defaultRuntime();
    r = isObj(r) ? r : {};
    const statusOf = (v, allowed) => (allowed.includes(v) ? v : 'idle');
    const p = isObj(r.pomo) ? r.pomo : {};
    const pStatus = statusOf(p.status, ['idle', 'running', 'paused']);
    const pomo = {
      mode: POMO_MODES.includes(p.mode) ? p.mode : 'work',
      session: int(p.session, 1, 8, 1),
      status: pStatus,
      total: pStatus === 'idle' ? null : int(p.total, 1, 5400, null),
      remaining: pStatus === 'idle' ? null : int(p.remaining, 0, 5400, null),
      targetEnd: pStatus === 'running' ? toMs(p.targetEnd, null) : null,
      sessionId: pStatus === 'idle' ? null : (isValidId(p.sessionId) ? p.sessionId : null),
      startedAt: pStatus === 'idle' ? null : toMs(p.startedAt, null),
      task: str(p.task, LIMITS.task)
    };
    // A running/paused session missing its essentials is not recoverable.
    if (pomo.status !== 'idle' && (pomo.total == null || pomo.remaining == null || pomo.sessionId == null ||
        (pomo.status === 'running' && pomo.targetEnd == null))) {
      Object.assign(pomo, d.pomo, { mode: pomo.mode, session: pomo.session, task: pomo.task });
    }

    const t = isObj(r.timer) ? r.timer : {};
    const tStatus = statusOf(t.status, ['idle', 'running', 'paused', 'done']);
    const timer = {
      status: tStatus,
      total: int(t.total, 0, 86399, d.timer.total),
      remaining: int(t.remaining, 0, 86399, d.timer.remaining),
      targetEnd: tStatus === 'running' ? toMs(t.targetEnd, null) : null,
      laps: arr(t.laps).map((x) => int(x, 0, 86399, 0)).slice(0, 100),
      activePreset: isValidId(t.activePreset) ? t.activePreset : null,
      finishedAt: toMs(t.finishedAt, null)
    };
    if (timer.status === 'running' && timer.targetEnd == null) timer.status = 'paused';

    const s = isObj(r.sw) ? r.sw : {};
    const sw = {
      status: statusOf(s.status, ['idle', 'running', 'paused']),
      startTime: toMs(s.startTime, 0),
      elapsed: int(s.elapsed, 0, 1e10, 0),
      laps: arr(s.laps).filter(isObj).slice(0, 1000).map((l, i) => ({ total: int(l.total, 0, 1e10, 0), lap: int(l.lap, 0, 1e10, 0), num: int(l.num, 1, 1e6, i + 1) })),
      lastLap: int(s.lastLap, 0, 1e10, 0)
    };

    const k = isObj(r.tracking) ? r.tracking : {};
    const cur = isObj(k.current) ? k.current : {};
    const tracking = {
      status: k.status === 'running' && toMs(k.startTime, null) != null ? 'running' : 'idle',
      startTime: k.status === 'running' ? toMs(k.startTime, null) : null,
      current: {
        desc: str(cur.desc, LIMITS.desc),
        project: isValidId(cur.project) ? cur.project : '',
        tag: /^[a-z]{1,20}$/.test(cur.tag) ? cur.tag : 'none'
      }
    };
    return { rev: toMs(r.rev, 0), pomo, timer, sw, tracking };
  }

  function sanitizePrefs(p) {
    const d = defaultPrefs();
    p = isObj(p) ? p : {};
    return {
      activeList: p.activeList === 'all' || isValidId(p.activeList) ? p.activeList : d.activeList,
      activeFilter: TODO_FILTERS.includes(p.activeFilter) ? p.activeFilter : d.activeFilter,
      activeTag: str(p.activeTag, LIMITS.tag),
      trackingFilter: TRACK_FILTERS.includes(p.trackingFilter) ? p.trackingFilter : d.trackingFilter,
      todoSort: ['created', 'priority', 'due', 'name'].includes(p.todoSort) ? p.todoSort : d.todoSort,
      ambient: AMBIENT_IDS.includes(p.ambient) ? p.ambient : null,
      ambientPlaying: p.ambientPlaying === true && AMBIENT_IDS.includes(p.ambient)
    };
  }

  // ---------------------------------------------------------------------------
  // Mutation helpers (keep clocks/tombstones correct)
  // ---------------------------------------------------------------------------
  // Clocks must strictly increase per field/item even if the wall clock steps
  // backwards, otherwise a later edit could lose a merge.
  function setScalar(data, group, key, value, now) {
    const ck = group + ':' + key;
    const t = Math.max(now, (data.clocks[ck] || 0) + 1);
    data[group][key] = value;
    data.clocks[ck] = t;
    data.updatedAt = Math.max(data.updatedAt || 0, t);
  }
  function touchItem(data, item, now) {
    item.updatedAt = Math.max(now, (item.updatedAt || 0) + 1);
    data.updatedAt = Math.max(data.updatedAt || 0, item.updatedAt);
    return item;
  }
  function getPath(obj, path) {
    return path.reduce((o, k) => o[k], obj);
  }
  function removeItem(data, path, id, now) {
    const list = getPath(data, path);
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return false;
    const t = Math.max(now, (list[i].updatedAt || 0) + 1);
    list.splice(i, 1);
    data.tombstones[id] = Math.max(t, data.tombstones[id] || 0);
    data.updatedAt = Math.max(data.updatedAt || 0, t);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Merge (deterministic: commutative, associative, idempotent)
  // ---------------------------------------------------------------------------
  const COLLECTIONS = [
    { path: ['todos', 'items'], sort: byCreatedDesc },
    { path: ['todos', 'lists'], sort: byCreatedAsc },
    { path: ['timer', 'presets'], sort: byCreatedAsc },
    { path: ['tracking', 'entries'], sort: byStartDesc, cap: LIMITS.entries },
    { path: ['tracking', 'projects'], sort: byCreatedAsc },
    { path: ['pomo', 'garden'], sort: byAtAsc, cap: -LIMITS.garden },
    { path: ['pomo', 'log'], sort: byAtDesc, cap: LIMITS.log }
  ];

  // Equal clocks with different content can happen (two devices, same ms).
  // Pick by content so every replica makes the same choice.
  function newerOf(x, y, tx, ty) {
    if (ty !== tx) return ty > tx ? y : x;
    return JSON.stringify(y) > JSON.stringify(x) ? y : x;
  }

  function mergeById(a, b, tomb, spec) {
    const map = new Map();
    const order = [];
    for (const x of a) { map.set(x.id, x); order.push(x.id); }
    for (const x of b) {
      const cur = map.get(x.id);
      if (!cur) { map.set(x.id, x); order.push(x.id); }
      else map.set(x.id, newerOf(cur, x, cur.updatedAt || 0, x.updatedAt || 0));
    }
    let out = order.map((id) => map.get(id)).filter((x) => !(tomb[x.id] != null && tomb[x.id] >= (x.updatedAt || 0)));
    out.sort(spec.sort);
    if (spec.cap > 0) out = out.slice(0, spec.cap);
    else if (spec.cap < 0) out = out.slice(spec.cap);
    return out;
  }

  function mergeCounterMaps(a, b) {
    const out = {};
    for (const src of [a, b]) {
      for (const [rep, v] of Object.entries(src || {})) {
        const o = out[rep] || (out[rep] = {});
        for (const [f, n] of Object.entries(v)) o[f] = Math.max(o[f] || 0, n);
      }
    }
    return out;
  }

  function mergeStats(a, b) {
    const daily = {};
    for (const day of uniq([...Object.keys(a.daily), ...Object.keys(b.daily)])) {
      daily[day] = mergeCounterMaps(a.daily[day], b.daily[day]);
    }
    return { daily, counters: mergeCounterMaps(a.counters, b.counters) };
  }

  function merge(a, b, now) {
    now = now == null ? Date.now() : now;
    const out = defaultData();
    // Tombstones: union (max), pruned after the TTL.
    const tomb = {};
    for (const src of [a.tombstones, b.tombstones]) {
      for (const [id, t] of Object.entries(src)) tomb[id] = Math.max(tomb[id] || 0, t);
    }
    for (const [id, t] of Object.entries(tomb)) if (t < now - LIMITS.tombstoneTtlMs) delete tomb[id];
    out.tombstones = tomb;

    // Scalars: per-field last-writer-wins.
    for (const [g, k] of SCALARS) {
      const ck = g + ':' + k;
      const ca = a.clocks[ck] || 0, cb = b.clocks[ck] || 0;
      out[g][k] = newerOf(a[g][k], b[g][k], ca, cb);
      const c = Math.max(ca, cb);
      if (c) out.clocks[ck] = c;
    }

    for (const spec of COLLECTIONS) {
      const [g, k] = spec.path;
      out[g][k] = mergeById(getPath(a, spec.path), getPath(b, spec.path), tomb, spec);
    }
    ensureInbox(out.todos.lists);
    out.stats = mergeStats(a.stats, b.stats);
    out.updatedAt = Math.max(a.updatedAt || 0, b.updatedAt || 0);
    // Deep copy: the result must not alias either input (it may be serialized
    // by Firestore while the live local object keeps changing).
    return JSON.parse(JSON.stringify(out));
  }

  // Import = explicit user restore. Imported scalar values become the newest,
  // and items deleted locally are resurrected — but an import never overrides
  // an item edit that is newer than the backup's copy.
  function prepareImport(local, imported, now) {
    const imp = JSON.parse(JSON.stringify(imported));
    for (const [g, k] of SCALARS) imp.clocks[g + ':' + k] = Math.max(now, (local.clocks[g + ':' + k] || 0) + 1);
    for (const spec of COLLECTIONS) {
      for (const item of getPath(imp, spec.path)) {
        const t = local.tombstones[item.id];
        if (t != null && t >= (item.updatedAt || 0)) item.updatedAt = t + 1;
      }
    }
    imp.tombstones = {};
    return imp;
  }

  // Remote Firestore document -> sanitized v2 data (or null). Handles the
  // legacy layout {state, dailyStats, clientUpdatedAt} written by v1 clients.
  function dataFromRemoteDoc(doc, now) {
    if (!isObj(doc)) return null;
    let out = null;
    if (isObj(doc.data)) out = sanitizeData(doc.data);
    if (isObj(doc.state)) {
      const legacy = migrateLegacy(doc.state, doc.dailyStats, toMs(doc.clientUpdatedAt, 0));
      out = out ? merge(out, legacy, now) : legacy;
    }
    return out;
  }

  function byteSize(obj) {
    const s = JSON.stringify(obj);
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
    return s.length * 3;
  }
  function assertCloudSize(data) {
    const n = byteSize(data);
    if (n > LIMITS.docBytes) throw new ZenError('zenflow/too-large', `Synced data is ${Math.round(n / 1024)} KB, above the ${Math.round(LIMITS.docBytes / 1024)} KB cloud limit`);
    return n;
  }

  function hasMeaningfulData(data) {
    if (!data) return false;
    return data.todos.items.length > 0 || data.tracking.entries.length > 0 || data.pomo.garden.length > 0 ||
      data.pomo.log.length > 0 || Object.keys(data.stats.daily).length > 0 ||
      Object.values(data.stats.counters).some((c) => c.sessions > 0 || c.focusSecs > 0);
  }

  // ---------------------------------------------------------------------------
  // Backups
  // ---------------------------------------------------------------------------
  function makeBackup(data, now) {
    return { format: 'zenflow-backup', schemaVersion: SCHEMA_VERSION, exportedAt: new Date(now).toISOString(), data };
  }
  function parseBackup(text) {
    let raw;
    try { raw = JSON.parse(text); } catch (_) { throw new ZenError('invalid-json', 'The file is not valid JSON.'); }
    if (!isObj(raw)) throw new ZenError('unrecognized', 'Unrecognized backup format.');
    if (raw.format === 'zenflow-backup') {
      if (raw.schemaVersion !== SCHEMA_VERSION || !isObj(raw.data)) throw new ZenError('unsupported-version', 'This backup was made by a newer or unknown version.');
      return sanitizeData(raw.data);
    }
    if (isObj(raw.state)) return migrateLegacy(raw.state, raw.dailyStats, 0); // v1 "Export JSON"
    if (isObj(raw.pomodoro) || isObj(raw.todos)) {                              // v1 "Export report"
      return migrateLegacy({ pomo: raw.pomodoro, todos: raw.todos, tracking: raw.tracking }, raw.dailyStats, 0);
    }
    throw new ZenError('unrecognized', 'Unrecognized backup format.');
  }

  // ---------------------------------------------------------------------------
  // Statistics
  // ---------------------------------------------------------------------------
  function creditFocus(data, replica, secs, session, now) {
    secs = Math.max(0, Math.round(secs));
    const day = localDayKey(now);
    const daily = data.stats.daily;
    const dayMap = daily[day] || (daily[day] = {});
    const r = dayMap[replica] || (dayMap[replica] = { secs: 0, sessions: 0 });
    r.secs = Math.min(86400, r.secs + secs);
    if (session) r.sessions += 1;
    const c = data.stats.counters[replica] || (data.stats.counters[replica] = { sessions: 0, focusSecs: 0 });
    c.focusSecs += secs;
    if (session) c.sessions += 1;
    data.updatedAt = Math.max(data.updatedAt || 0, now);
  }
  function dayTotals(stats, day) {
    const out = { secs: 0, sessions: 0 };
    for (const v of Object.values(stats.daily[day] || {})) { out.secs += v.secs; out.sessions += v.sessions; }
    return out;
  }
  function lifetimeTotals(stats) {
    const out = { sessions: 0, focusSecs: 0 };
    for (const v of Object.values(stats.counters)) { out.sessions += v.sessions; out.focusSecs += v.focusSecs; }
    return out;
  }
  // A streak is still "alive" today until the day ends, so if today has no
  // focus yet, counting starts from yesterday.
  function computeStreak(stats, now) {
    const active = new Set(Object.keys(stats.daily).filter((d) => dayTotals(stats, d).secs > 0));
    const today = parseDayKey(localDayKey(now));
    let d = active.has(localDayKey(today)) ? today : addDays(today, -1);
    let current = 0;
    while (active.has(localDayKey(d))) { current++; d = addDays(d, -1); }
    let longest = 0, run = 0, prev = null;
    for (const k of [...active].sort()) {
      run = prev && dayDiff(prev, k) === 1 ? run + 1 : 1;
      longest = Math.max(longest, run);
      prev = k;
    }
    return { current, longest };
  }

  // ---------------------------------------------------------------------------
  // Pomodoro state machine: idle -> running <-> paused -> (finish) -> idle
  // Durations are frozen for the session in `total`; config edits are only
  // allowed while idle.
  // ---------------------------------------------------------------------------
  function pomoTotalSecs(mode, cfg) {
    return (mode === 'work' ? cfg.workMins : mode === 'short-break' ? cfg.shortMins : cfg.longMins) * 60;
  }
  function pomoRemaining(p, cfg, now) {
    if (p.status === 'running') return Math.max(0, Math.ceil((p.targetEnd - now) / 1000));
    if (p.status === 'paused') return p.remaining;
    return pomoTotalSecs(p.mode, cfg);
  }
  function pomoTotal(p, cfg) {
    return p.status === 'idle' ? pomoTotalSecs(p.mode, cfg) : p.total;
  }
  function pomoStart(p, cfg, now) {
    if (p.status === 'running') return false;
    if (p.status === 'idle') {
      p.total = pomoTotalSecs(p.mode, cfg);
      p.remaining = p.total;
      p.sessionId = newId('s');
      p.startedAt = now;
    }
    p.status = 'running';
    p.targetEnd = now + p.remaining * 1000;
    return true;
  }
  function pomoPause(p, cfg, now) {
    if (p.status !== 'running') return false;
    p.remaining = pomoRemaining(p, cfg, now);
    p.status = 'paused';
    p.targetEnd = null;
    return true;
  }
  function pomoIsDue(p, now) {
    return p.status === 'running' && now >= p.targetEnd;
  }
  function pomoReset(p) {
    p.status = 'idle';
    p.total = null;
    p.remaining = null;
    p.targetEnd = null;
    p.sessionId = null;
    p.startedAt = null;
  }
  function pomoSetMode(p, mode) {
    if (p.status !== 'idle' || !POMO_MODES.includes(mode)) return false;
    p.mode = mode;
    return true;
  }
  // Finish the current phase (natural completion or skip). Credits only the
  // time actually elapsed; a skip never counts as a completed session.
  // Idempotent per session id (guards double completion across tabs/reloads).
  function pomoFinish(data, p, cfg, opts) {
    const now = opts.now, skipped = !!opts.skipped;
    const mode = p.mode;
    const total = pomoTotal(p, cfg);
    const remaining = skipped ? pomoRemaining(p, cfg, now) : 0;
    const elapsed = p.status === 'idle' ? 0 : Math.max(0, total - remaining);
    const sid = p.sessionId || newId('s');
    if (p.sessionId && (data.pomo.log.some((l) => l.id === sid) || data.pomo.garden.some((g) => g.id === sid))) {
      pomoReset(p);
      return { duplicate: true, mode, next: p.mode, completed: false, elapsedSecs: 0 };
    }
    const completed = !skipped;
    const task = str(opts.task, LIMITS.task);
    let next;
    if (mode === 'work') {
      if (elapsed > 0) creditFocus(data, opts.replica, elapsed, completed, now);
      if (completed || elapsed >= 60) {
        data.pomo.garden.push({ id: sid, mins: Math.round(elapsed / 60 * 100) / 100, at: now, task, abandoned: !completed, updatedAt: now });
        if (data.pomo.garden.length > LIMITS.garden) data.pomo.garden.splice(0, data.pomo.garden.length - LIMITS.garden);
      }
      if (p.session >= cfg.sessionsBeforeLong) { p.session = 1; next = 'long-break'; }
      else { p.session += 1; next = 'short-break'; }
    } else {
      next = 'work';
    }
    if (completed || elapsed > 0) {
      data.pomo.log.unshift({ id: sid, type: mode, mins: Math.round(elapsed / 60 * 100) / 100, task: mode === 'work' ? task : '', at: now, label: '', skipped, updatedAt: now });
      if (data.pomo.log.length > LIMITS.log) data.pomo.log.length = LIMITS.log;
    }
    data.updatedAt = Math.max(data.updatedAt || 0, now);
    pomoReset(p);
    p.mode = next;
    return { duplicate: false, mode, next, completed, elapsedSecs: elapsed };
  }

  // ---------------------------------------------------------------------------
  // Countdown timer: idle -> running <-> paused -> done
  // ---------------------------------------------------------------------------
  function timerRemaining(t, now) {
    if (t.status === 'running') return Math.max(0, Math.ceil((t.targetEnd - now) / 1000));
    if (t.status === 'done') return 0;
    return t.remaining;
  }
  function timerSetTotal(t, total) {
    if (t.status === 'running' || t.status === 'paused') return false;
    t.total = int(total, 0, 86399, 0);
    t.remaining = t.total;
    t.status = 'idle';
    t.finishedAt = null;
    return true;
  }
  // Returns 'started' (fresh), 'resumed', or null when not startable.
  function timerStart(t, now) {
    if (t.status === 'running') return null;
    let result = 'resumed';
    if (t.status === 'idle' || t.status === 'done') {
      if (t.total <= 0) return null;
      t.remaining = t.total;
      t.laps = [];
      t.finishedAt = null;
      result = 'started';
    }
    t.status = 'running';
    t.targetEnd = now + t.remaining * 1000;
    return result;
  }
  function timerPause(t, now) {
    if (t.status !== 'running') return false;
    t.remaining = timerRemaining(t, now);
    t.status = 'paused';
    t.targetEnd = null;
    return true;
  }
  function timerIsDue(t, now) {
    return t.status === 'running' && now >= t.targetEnd;
  }
  function timerFinish(t, now) {
    if (t.status !== 'running') return false;
    t.status = 'done';
    t.remaining = 0;
    t.finishedAt = t.targetEnd || now;
    t.targetEnd = null;
    return true;
  }
  function timerReset(t) {
    t.status = 'idle';
    t.remaining = t.total;
    t.targetEnd = null;
    t.laps = [];
    t.finishedAt = null;
  }

  // ---------------------------------------------------------------------------
  // Stopwatch
  // ---------------------------------------------------------------------------
  function swElapsed(sw, now) {
    return sw.status === 'running' ? Math.max(0, now - sw.startTime) : sw.elapsed;
  }
  function swStart(sw, now) {
    if (sw.status === 'running') return false;
    sw.startTime = now - sw.elapsed;
    sw.status = 'running';
    return true;
  }
  function swPause(sw, now) {
    if (sw.status !== 'running') return false;
    sw.elapsed = swElapsed(sw, now);
    sw.status = 'paused';
    return true;
  }
  function swLap(sw, now) {
    if (sw.status !== 'running') return null;
    const total = swElapsed(sw, now);
    const lap = { total, lap: total - sw.lastLap, num: sw.laps.length + 1 };
    sw.laps.push(lap);
    sw.lastLap = total;
    return lap;
  }
  function swReset(sw) {
    sw.status = 'idle';
    sw.startTime = 0;
    sw.elapsed = 0;
    sw.laps = [];
    sw.lastLap = 0;
  }

  // ---------------------------------------------------------------------------
  // Time tracker
  // ---------------------------------------------------------------------------
  const MIN_TRACKED_SECS = 5;
  function trackStart(tr, current, now) {
    if (tr.status === 'running') return false;
    tr.status = 'running';
    tr.startTime = now;
    tr.current = {
      desc: str(current.desc, LIMITS.desc),
      project: isValidId(current.project) ? current.project : '',
      tag: /^[a-z]{1,20}$/.test(current.tag) ? current.tag : 'none'
    };
    return true;
  }
  // Stops the tracker; returns the created entry, or null if too short.
  function trackStop(data, tr, now) {
    if (tr.status !== 'running') return null;
    const start = tr.startTime, end = Math.max(now, start);
    const duration = Math.round((end - start) / 1000);
    tr.status = 'idle';
    tr.startTime = null;
    if (duration < MIN_TRACKED_SECS) return null;
    const entry = { id: newId('e'), desc: tr.current.desc || 'Untitled', project: tr.current.project, tag: tr.current.tag, start, end, duration, updatedAt: now };
    data.tracking.entries.unshift(entry);
    if (data.tracking.entries.length > LIMITS.entries) data.tracking.entries.length = LIMITS.entries;
    data.updatedAt = Math.max(data.updatedAt || 0, now);
    return entry;
  }

  return {
    SCHEMA_VERSION, LIMITS, SCALARS, POMO_MODES, AMBIENT_IDS, PROJECT_COLORS, SOUNDS, MIN_TRACKED_SECS,
    ZenError,
    escapeHtml, isValidId, newId, stableId,
    pad, localDayKey, parseDayKey, addDays, dayDiff, describeDue,
    formatTime, formatHMS, formatDuration, formatMs,
    defaultData, defaultRuntime, defaultPrefs,
    sanitizeData, sanitizeRuntime, sanitizePrefs, migrateLegacy, dataFromRemoteDoc,
    setScalar, touchItem, removeItem,
    merge, prepareImport, byteSize, assertCloudSize, hasMeaningfulData,
    makeBackup, parseBackup,
    creditFocus, dayTotals, lifetimeTotals, computeStreak,
    pomoTotalSecs, pomoTotal, pomoRemaining, pomoStart, pomoPause, pomoIsDue, pomoReset, pomoSetMode, pomoFinish,
    timerRemaining, timerSetTotal, timerStart, timerPause, timerIsDue, timerFinish, timerReset,
    swElapsed, swStart, swPause, swLap, swReset,
    trackStart, trackStop
  };
});
