/*
 * ZenFlow calendar engine — pure functions shared by the browser app and the
 * Cloud Functions backend (no DOM, storage or network).
 *
 * Event model (sanitized by ZenCore.sanitizeEvent):
 *   timed:   start/end = epoch ms, timeZone = IANA zone used for recurrence
 *   all-day: startDate/endDate = "YYYY-MM-DD" (end exclusive)
 *   rrule:   RFC 5545 RRULE subset (FREQ, INTERVAL, COUNT, UNTIL, BYDAY,
 *            BYMONTHDAY, BYMONTH, WKST); exdates = occurrence keys
 *   Occurrence key: timed -> start ms (number); all-day -> date key (string)
 *   Overrides ("only this occurrence") are separate events with
 *   recurrenceId = master id and originalStart = occurrence key; the master
 *   lists that key in exdates.
 *   reminders: [{ offsetMin, type: 'notify' | 'alarm' }] relative to the
 *   occurrence start (all-day: 09:00 in the event's time zone).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.ZenCal = factory(root.ZenCore);
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  const MIN = 60000;
  const DAY = 86400000;
  const MAX_OCCURRENCES = 2000;
  const MAX_ITERATIONS = 20000;
  const ALLDAY_REMINDER_HOUR = 9;

  // -------------------------------------------------------------------------
  // Time zones (Intl-based; correct across DST)
  // -------------------------------------------------------------------------
  const fmtCache = new Map();
  function validTimeZone(tz) {
    if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (_) { return false; }
  }
  function localTimeZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; }
  }
  function formatter(tz) {
    let f = fmtCache.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', weekday: 'short',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
      fmtCache.set(tz, f);
    }
    return f;
  }
  const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  // Wall-clock parts of an instant in a zone.
  function zonedParts(ms, tz) {
    const p = {};
    for (const x of formatter(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
    return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, wd: WEEKDAY[p.weekday] };
  }
  function tzOffset(ms, tz) {
    const z = zonedParts(ms, tz);
    return Date.UTC(z.y, z.m - 1, z.d, z.h, z.mi, z.s) - Math.floor(ms / 1000) * 1000;
  }
  // Wall-clock time in a zone -> instant. Repeated times (DST fall-back) pick
  // the first instant; nonexistent times (spring-forward gap) move forward.
  function zonedToUtc(y, m, d, h, mi, tz) {
    const guess = Date.UTC(y, m - 1, d, h, mi);
    const matches = (t) => { const z = zonedParts(t, tz); return z.h === h % 24 && z.mi === mi && z.d === new Date(guess).getUTCDate(); };
    const t1 = guess - tzOffset(guess, tz);
    const t2 = guess - tzOffset(t1, tz);
    const ok = [t1, t2].filter(matches);
    if (ok.length) return Math.min(...ok);
    return Math.max(t1, t2);
  }

  // -------------------------------------------------------------------------
  // Date keys (calendar dates independent of zone)
  // -------------------------------------------------------------------------
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const keyOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  function keyParts(key) { const [y, m, d] = key.split('-').map(Number); return { y, m, d }; }
  function addDaysKey(key, n) {
    const { y, m, d } = keyParts(key);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return keyOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  function weekdayOfKey(key) { const { y, m, d } = keyParts(key); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function keyDiff(a, b) { const p = keyParts(a), q = keyParts(b); return Math.round((Date.UTC(q.y, q.m - 1, q.d) - Date.UTC(p.y, p.m - 1, p.d)) / DAY); }
  function keyInZone(ms, tz) { const z = zonedParts(ms, tz); return keyOf(z.y, z.m, z.d); }

  // -------------------------------------------------------------------------
  // RRULE
  // -------------------------------------------------------------------------
  const FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];
  const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

  function parseUntil(v) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
    if (!m) return null;
    if (!m[4]) return { date: `${m[1]}-${m[2]}-${m[3]}` };
    return { ms: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) };
  }
  function parseRRule(str) {
    if (typeof str !== 'string' || !str.trim()) return null;
    const r = { freq: null, interval: 1, count: null, until: null, byday: [], bymonthday: [], bymonth: [], wkst: 1, unsupported: [] };
    for (const part of str.trim().replace(/^RRULE:/i, '').split(';')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      if (eq < 1) { r.unsupported.push(part); continue; }
      const k = part.slice(0, eq).toUpperCase(), v = part.slice(eq + 1).toUpperCase();
      if (k === 'FREQ') { if (FREQS.includes(v)) r.freq = v; else r.unsupported.push(k); }
      else if (k === 'INTERVAL') r.interval = Math.max(1, Math.min(999, parseInt(v, 10) || 1));
      else if (k === 'COUNT') r.count = Math.max(1, Math.min(5000, parseInt(v, 10) || 1));
      else if (k === 'UNTIL') { r.until = parseUntil(v); if (!r.until) r.unsupported.push(k); }
      else if (k === 'BYDAY') {
        for (const t of v.split(',')) {
          const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(t);
          if (!m) { r.unsupported.push(k); break; }
          r.byday.push({ n: m[1] ? parseInt(m[1], 10) : 0, wd: DAYS.indexOf(m[2]) });
        }
      } else if (k === 'BYMONTHDAY') {
        for (const t of v.split(',')) { const n = parseInt(t, 10); if (!n || n < -31 || n > 31) { r.unsupported.push(k); break; } r.bymonthday.push(n); }
      } else if (k === 'BYMONTH') {
        for (const t of v.split(',')) { const n = parseInt(t, 10); if (!(n >= 1 && n <= 12)) { r.unsupported.push(k); break; } r.bymonth.push(n); }
      } else if (k === 'WKST') { if (DAYS.includes(v)) r.wkst = DAYS.indexOf(v); }
      else r.unsupported.push(k);
    }
    return r.freq ? r : null;
  }
  function formatUntil(u) {
    if (!u) return '';
    if (u.date) return u.date.replace(/-/g, '');
    const d = new Date(u.ms);
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  }
  function formatRRule(r) {
    const parts = [`FREQ=${r.freq}`];
    if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
    if (r.byday && r.byday.length) parts.push('BYDAY=' + r.byday.map((b) => (b.n ? b.n : '') + DAYS[b.wd]).join(','));
    if (r.bymonthday && r.bymonthday.length) parts.push('BYMONTHDAY=' + r.bymonthday.join(','));
    if (r.bymonth && r.bymonth.length) parts.push('BYMONTH=' + r.bymonth.join(','));
    if (r.count) parts.push(`COUNT=${r.count}`);
    else if (r.until) parts.push(`UNTIL=${formatUntil(r.until)}`);
    return parts.join(';');
  }
  const isSupported = (r) => !!r && r.unsupported.length === 0;

  // Human description, e.g. "Every 2 weeks on Mon, Wed until Dec 31, 2026".
  function describeRRule(str, startInfo) {
    const r = parseRRule(str);
    if (!r) return '';
    if (!isSupported(r)) return 'Custom repeat';
    const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[r.freq];
    let s = r.interval > 1 ? `Every ${r.interval} ${unit}s` : ({ DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly', YEARLY: 'Yearly' }[r.freq]);
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const ord = (n) => (n === -1 ? 'last' : ['', 'first', 'second', 'third', 'fourth', 'fifth'][n] || `${n}th`);
    if (r.freq === 'DAILY' && r.byday.length === 5 && [1, 2, 3, 4, 5].every((d) => r.byday.some((b) => b.wd === d))) s = 'Every weekday';
    else if (r.byday.length && r.byday.every((b) => !b.n)) s += ' on ' + r.byday.map((b) => dayNames[b.wd]).join(', ');
    else if (r.byday.length) s += ' on the ' + r.byday.map((b) => `${ord(b.n)} ${dayNames[b.wd]}`).join(', ');
    else if (r.bymonthday.length) s += ' on day ' + r.bymonthday.join(', ');
    if (r.count) s += `, ${r.count} times`;
    else if (r.until) {
      const k = r.until.date || (startInfo && startInfo.timeZone ? keyInZone(r.until.ms, startInfo.timeZone) : new Date(r.until.ms).toISOString().slice(0, 10));
      const { y, m, d } = keyParts(k);
      s += ' until ' + new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    }
    return s;
  }

  // Candidate dates (date keys, ascending) for one period of the rule.
  function periodDates(r, k, base) {
    const out = [];
    if (r.freq === 'DAILY') {
      out.push(addDaysKey(base.key, k * r.interval));
    } else if (r.freq === 'WEEKLY') {
      const shift = (base.wd - r.wkst + 7) % 7;               // days since week start
      const weekStart = addDaysKey(base.key, -shift + k * 7 * r.interval);
      const wds = r.byday.length ? r.byday.map((b) => b.wd) : [base.wd];
      for (const wd of wds) out.push(addDaysKey(weekStart, (wd - r.wkst + 7) % 7));
    } else {
      let y, months;
      if (r.freq === 'MONTHLY') {
        const idx = (base.m - 1) + k * r.interval;
        y = base.y + Math.floor(idx / 12);
        months = [(idx % 12) + 1];
      } else {
        y = base.y + k * r.interval;
        months = r.bymonth.length ? r.bymonth : [base.m];
      }
      for (const m of months) {
        const dim = daysInMonth(y, m);
        if (r.bymonthday.length) {
          for (const n of r.bymonthday) { const d = n > 0 ? n : dim + n + 1; if (d >= 1 && d <= dim) out.push(keyOf(y, m, d)); }
        } else if (r.byday.length) {
          for (const b of r.byday) {
            const firstWd = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
            const first = 1 + ((b.wd - firstWd + 7) % 7);
            const all = [];
            for (let d = first; d <= dim; d += 7) all.push(d);
            if (!b.n) all.forEach((d) => out.push(keyOf(y, m, d)));
            else { const d = b.n > 0 ? all[b.n - 1] : all[all.length + b.n]; if (d) out.push(keyOf(y, m, d)); }
          }
        } else if (base.d <= dim) out.push(keyOf(y, m, base.d)); // months without that day are skipped (RFC 5545)
      }
    }
    return [...new Set(out)].sort();
  }

  function dayFilter(r, key) {
    if (r.freq === 'DAILY') {
      if (r.byday.length && !r.byday.some((b) => b.wd === weekdayOfKey(key))) return false;
      if (r.bymonth.length && !r.bymonth.includes(keyParts(key).m)) return false;
      if (r.bymonthday.length && !r.bymonthday.includes(keyParts(key).d)) return false;
    }
    return true;
  }

  // Occurrences of an event overlapping [fromMs, toMs). `tz` anchors all-day
  // dates to instants for the overlap test (default: the event's zone).
  function occurrences(ev, fromMs, toMs, tz, skipKeys) {
    const zone = tz || ev.timeZone || 'UTC';
    const allDayMs = (key) => { const { y, m, d } = keyParts(key); return zonedToUtc(y, m, d, 0, 0, zone); };
    const make = (key) => {
      if (ev.allDay) {
        const endKey = addDaysKey(key, Math.max(1, keyDiff(ev.startDate, ev.endDate)));
        return { key, allDay: true, startDate: key, endDate: endKey, start: allDayMs(key), end: allDayMs(endKey) };
      }
      return { key, allDay: false, start: key, end: key + (ev.end - ev.start) };
    };
    const overlaps = (o) => o.end > fromMs && o.start < toMs;
    const r = parseRRule(ev.rrule);
    if (!r || !isSupported(r)) {
      const o = make(ev.allDay ? ev.startDate : ev.start);
      return overlaps(o) ? [o] : [];
    }
    // Base (wall-clock) components of the first occurrence.
    let base, wall;
    if (ev.allDay) {
      const p = keyParts(ev.startDate);
      base = { key: ev.startDate, y: p.y, m: p.m, d: p.d, wd: weekdayOfKey(ev.startDate) };
    } else {
      const z = zonedParts(ev.start, ev.timeZone);
      base = { key: keyOf(z.y, z.m, z.d), y: z.y, m: z.m, d: z.d, wd: z.wd };
      wall = { h: z.h, mi: z.mi };
    }
    const exdates = new Set(ev.exdates || []);
    if (skipKeys) for (const k of skipKeys) exdates.add(k);
    const toKey = (dateKey) => {
      if (ev.allDay) return dateKey;
      const { y, m, d } = keyParts(dateKey);
      return zonedToUtc(y, m, d, wall.h, wall.mi, ev.timeZone);
    };
    const beyondUntil = (dateKey, occKey) => {
      if (!r.until) return false;
      if (r.until.date) return dateKey > r.until.date;
      return ev.allDay ? allDayMs(dateKey) > r.until.ms : occKey > r.until.ms;
    };
    const out = [];
    let produced = 0;
    // Without COUNT, skip whole periods that end before the range (daily/weekly).
    let k = 0;
    if (!r.count && (r.freq === 'DAILY' || r.freq === 'WEEKLY')) {
      const periodDays = (r.freq === 'DAILY' ? 1 : 7) * r.interval;
      const firstMs = ev.allDay ? allDayMs(ev.startDate) : ev.start;
      const span = (ev.allDay ? keyDiff(ev.startDate, ev.endDate) * DAY : (ev.end - ev.start)) + 8 * DAY;
      k = Math.max(0, Math.floor((fromMs - span - firstMs) / (periodDays * DAY)) - 1);
    }
    for (let iter = 0; iter < MAX_ITERATIONS && out.length < MAX_OCCURRENCES; iter++, k++) {
      const dates = periodDates(r, k, base);
      let stop = false;
      for (const dk of dates) {
        if (dk < base.key || !dayFilter(r, dk)) continue;
        const occKey = toKey(dk);
        if (!ev.allDay && occKey < ev.start) continue;
        if (beyondUntil(dk, occKey)) { stop = true; break; }
        produced++;
        if (r.count && produced > r.count) { stop = true; break; }
        if (exdates.has(occKey)) continue;
        const o = make(occKey);
        if (o.start >= toMs) { stop = true; break; }
        if (overlaps(o)) out.push(o);
      }
      if (stop) break;
    }
    return out;
  }

  // Occurrence keys replaced by override events, per master id. Google lists
  // edited instances as separate events without EXDATEs on the master.
  function overrideIndex(events) {
    const idx = new Map();
    for (const ev of events) {
      if (!ev.recurrenceId || ev.originalStart == null) continue;
      if (!idx.has(ev.recurrenceId)) idx.set(ev.recurrenceId, new Set());
      idx.get(ev.recurrenceId).add(ev.originalStart);
    }
    return idx;
  }

  // All events expanded for a view range, sorted by start.
  function expandAll(events, fromMs, toMs, tz) {
    const out = [];
    const idx = overrideIndex(events);
    for (const ev of events) for (const o of occurrences(ev, fromMs, toMs, tz, idx.get(ev.id))) out.push(Object.assign(o, { event: ev }));
    return out.sort((a, b) => a.start - b.start || (b.allDay - a.allDay));
  }

  // -------------------------------------------------------------------------
  // Reminders
  // -------------------------------------------------------------------------
  const reminderKey = (eventId, occKey, i) => `${eventId}|${occKey}|${i}`;
  function parseReminderKey(key) {
    const parts = String(key).split('|');
    if (parts.length !== 3) return null;
    const occ = /^\d+$/.test(parts[1]) ? Number(parts[1]) : parts[1];
    return { eventId: parts[0], occKey: occ, index: Number(parts[2]) };
  }
  function anchorOf(occ, ev) {
    if (!occ.allDay) return occ.start;
    const { y, m, d } = keyParts(occ.startDate);
    return zonedToUtc(y, m, d, ALLDAY_REMINDER_HOUR, 0, ev.timeZone || 'UTC');
  }
  // Reminder instances with fireAt in [fromMs, toMs), sorted. Snoozes replace
  // an instance's fire time. Completed one-off reminders never fire.
  function reminderInstances(events, fromMs, toMs) {
    const out = [];
    const idx = overrideIndex(events);
    for (const ev of events) {
      if (!ev.reminders || !ev.reminders.length) continue;
      if (ev.done && !ev.rrule) continue;
      const snoozes = ev.snoozes || {};
      const maxOff = Math.max(...ev.reminders.map((r) => r.offsetMin)) * MIN;
      const occs = occurrences(ev, fromMs - DAY, toMs + maxOff + DAY, ev.timeZone, idx.get(ev.id));
      for (const occ of occs) {
        const anchor = anchorOf(occ, ev);
        ev.reminders.forEach((rem, i) => {
          const key = reminderKey(ev.id, occ.key, i);
          if (snoozes[key] != null) return;
          const fireAt = anchor - rem.offsetMin * MIN;
          if (fireAt >= fromMs && fireAt < toMs) out.push(instance(ev, occ, anchor, rem, key, fireAt, false));
        });
      }
      for (const [key, until] of Object.entries(snoozes)) {
        if (until < fromMs || until >= toMs) continue;
        const p = parseReminderKey(key);
        if (!p || p.eventId !== ev.id || !ev.reminders[p.index]) continue;
        const occ = occurrences(ev, (typeof p.occKey === 'number' ? p.occKey : 0) - DAY * 400, Infinity, ev.timeZone)
          .find((o) => o.key === p.occKey) || { key: p.occKey, allDay: ev.allDay, start: typeof p.occKey === 'number' ? p.occKey : until, startDate: typeof p.occKey === 'string' ? p.occKey : null };
        out.push(instance(ev, occ, anchorOf(occ, ev), ev.reminders[p.index], key, until, true));
      }
    }
    return out.sort((a, b) => a.fireAt - b.fireAt || a.key.localeCompare(b.key));
  }
  function instance(ev, occ, anchor, rem, key, fireAt, snoozed) {
    return {
      key, eventId: ev.id, fireAt, type: rem.type, offsetMin: rem.offsetMin, snoozed,
      title: ev.title, kind: ev.kind, location: ev.location || '', allDay: !!occ.allDay,
      startsAt: anchor, occKey: occ.key
    };
  }
  function describeOffset(min, allDay) {
    if (min === 0) return allDay ? 'On the day (9:00)' : 'At time of event';
    if (min % 10080 === 0) return `${min / 10080} week${min === 10080 ? '' : 's'} before`;
    if (min % 1440 === 0) return `${min / 1440} day${min === 1440 ? '' : 's'} before`;
    if (min % 60 === 0) return `${min / 60} hour${min === 60 ? '' : 's'} before`;
    return `${min} minutes before`;
  }

  // -------------------------------------------------------------------------
  // Google Calendar mapping
  // -------------------------------------------------------------------------
  // Deterministic Google event id for events created in ZenFlow: Google ids
  // allow base32hex characters, and hex is a subset. Makes inserts idempotent.
  function googleIdFor(localId) {
    let hex = '';
    for (const ch of String(localId)) hex += ch.charCodeAt(0).toString(16).padStart(2, '0');
    return hex.slice(0, 1000);
  }
  const localIdForGoogle = (calId, eventId) => C.stableId('gev', calId + '|' + eventId);

  function htmlToText(s) {
    return String(s || '')
      .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
      .replace(/\n{3,}/g, '\n\n').trim();
  }
  function basicDateTime(ms, tz) {
    const z = zonedParts(ms, tz);
    return `${z.y}${pad(z.m)}${pad(z.d)}T${pad(z.h)}${pad(z.mi)}${pad(z.s)}`;
  }
  function parseExdateLine(line, eventTz) {
    const m = /^EXDATE(;[^:]*)?:(.+)$/i.exec(line);
    if (!m) return [];
    const params = (m[1] || '').toUpperCase();
    const tzm = /TZID=([^;:]+)/i.exec(m[1] || '');
    const tz = tzm && validTimeZone(tzm[1]) ? tzm[1] : eventTz;
    return m[2].split(',').map((v) => {
      const d = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v.trim());
      if (!d) return null;
      if (!d[4] || params.includes('VALUE=DATE')) return `${d[1]}-${d[2]}-${d[3]}`;
      if (d[7]) return Date.UTC(+d[1], +d[2] - 1, +d[3], +d[4], +d[5], +d[6]);
      return zonedToUtc(+d[1], +d[2], +d[3], +d[4], +d[5], tz);
    }).filter((x) => x != null);
  }
  const googleTime = (t) => (t && t.date ? t.date : t && t.dateTime ? Date.parse(t.dateTime) : null);

  // Google event -> ZenFlow event (or a deletion / exdate instruction).
  // ctx: { calendarId, accessRole, timeZone, defaultReminders }
  function fromGoogle(g, ctx) {
    const calId = ctx.calendarId;
    const privateId = g.extendedProperties && g.extendedProperties.private && g.extendedProperties.private.zenflowId;
    const id = C.isValidId(privateId) ? privateId : localIdForGoogle(calId, g.id);
    const masterId = g.recurringEventId ? localIdForGoogle(calId, g.recurringEventId) : '';
    const originalStart = g.originalStartTime ? googleTime(g.originalStartTime) : null;
    if (g.status === 'cancelled') return { deleted: true, id, googleEventId: g.id, masterId, originalStart };
    const allDay = !!(g.start && g.start.date);
    const tz = validTimeZone(g.start && g.start.timeZone) ? g.start.timeZone : (validTimeZone(ctx.timeZone) ? ctx.timeZone : 'UTC');
    let rrule = '', exdates = [], unsupported = false;
    for (const line of g.recurrence || []) {
      if (/^RRULE:/i.test(line)) { rrule = line.slice(6); const r = parseRRule(rrule); if (!isSupported(r)) unsupported = true; }
      else if (/^EXDATE/i.test(line)) exdates = exdates.concat(parseExdateLine(line, tz));
      else unsupported = true; // RDATE etc.
    }
    const overrides = g.reminders && !g.reminders.useDefault ? (g.reminders.overrides || []) : (ctx.defaultReminders || []);
    const updated = Date.parse(g.updated) || Date.now();
    const writable = ctx.accessRole === 'owner' || ctx.accessRole === 'writer';
    const ev = {
      id, title: g.summary || '(No title)', description: htmlToText(g.description), location: g.location || '',
      kind: 'event', allDay, timeZone: tz, rrule, exdates,
      recurrenceId: masterId, originalStart,
      reminders: overrides.slice(0, 5).map((o) => ({ offsetMin: Math.max(0, Math.min(40320, o.minutes | 0)), type: 'notify' })),
      color: '', cal: 'g:' + calId, source: 'google', readOnly: !writable || unsupported,
      google: { calendarId: calId, eventId: g.id, etag: g.etag || '', updated, syncedAt: updated },
      createdAt: Date.parse(g.created) || updated, updatedAt: updated, snoozes: {}, done: false
    };
    if (allDay) { ev.startDate = g.start.date; ev.endDate = (g.end && g.end.date) || addDaysKey(g.start.date, 1); ev.start = null; ev.end = null; }
    else { ev.start = Date.parse(g.start.dateTime); ev.end = Date.parse((g.end && g.end.dateTime) || g.start.dateTime); ev.startDate = ''; ev.endDate = ''; }
    return ev;
  }

  // ZenFlow event -> Google API body.
  function toGoogle(ev) {
    const body = {
      summary: ev.title, description: ev.description || '', location: ev.location || '',
      reminders: { useDefault: false, overrides: ev.reminders.slice(0, 5).map((r) => ({ method: 'popup', minutes: r.offsetMin })) },
      extendedProperties: { private: { zenflowId: ev.id } }
    };
    if (ev.allDay) { body.start = { date: ev.startDate }; body.end = { date: ev.endDate }; }
    else {
      body.start = { dateTime: new Date(ev.start).toISOString(), timeZone: ev.timeZone };
      body.end = { dateTime: new Date(ev.end).toISOString(), timeZone: ev.timeZone };
    }
    if (ev.rrule && !ev.recurrenceId) {
      const rec = ['RRULE:' + ev.rrule];
      if (ev.exdates && ev.exdates.length) {
        rec.push(ev.allDay
          ? 'EXDATE;VALUE=DATE:' + ev.exdates.map((k) => String(k).replace(/-/g, '')).join(',')
          : `EXDATE;TZID=${ev.timeZone}:` + ev.exdates.map((ms) => basicDateTime(ms, ev.timeZone)).join(','));
      }
      body.recurrence = rec;
    }
    return body;
  }
  // Google id of one instance of a recurring event ("only this" edits).
  function googleInstanceId(masterGoogleId, originalStart) {
    if (typeof originalStart === 'string') return `${masterGoogleId}_${originalStart.replace(/-/g, '')}`;
    const d = new Date(originalStart);
    return `${masterGoogleId}_${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  }
  const needsPush = (ev) => ev.cal !== 'local' && !ev.readOnly && (!ev.google || ev.updatedAt > (ev.google.syncedAt || 0));

  return {
    MIN, DAY, validTimeZone, localTimeZone, zonedParts, zonedToUtc, tzOffset,
    keyOf, keyParts, addDaysKey, weekdayOfKey, keyDiff, keyInZone, daysInMonth,
    parseRRule, formatRRule, describeRRule, isSupported,
    occurrences, expandAll, overrideIndex,
    reminderKey, parseReminderKey, reminderInstances, describeOffset,
    googleIdFor, localIdForGoogle, fromGoogle, toGoogle, googleInstanceId, needsPush, htmlToText
  };
});
