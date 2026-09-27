'use strict';
// Server-side reminder planning. A user's upcoming reminder instances (next
// HORIZON) are materialized as small documents indexed by fireAt; a
// per-minute job delivers and deletes them.
const HORIZON_MS = 48 * 3600000;
const LATE_LIMIT_MS = 60 * 60000; // don't deliver reminders more than 1h late

function createReminderPlanner({ C, K }) {
  const docId = (uid, key) => C.stableId('rm', uid + '|' + key);

  function describe(inst, tz) {
    const zone = K.validTimeZone(tz) ? tz : 'UTC';
    const when = inst.allDay
      ? 'All day'
      : new Date(inst.startsAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone });
    const lead = inst.offsetMin > 0 && !inst.snoozed ? `${K.describeOffset(inst.offsetMin, inst.allDay).replace(' before', '')} · ` : '';
    return (inst.kind === 'alarm' ? 'Alarm · ' : lead) + (inst.allDay ? 'All day' : `Starts ${when}`) + (inst.location ? ` · ${inst.location}` : '');
  }

  // Desired reminder documents for one user.
  function plan(uid, data, fromMs, timeZoneHint) {
    const toMs = fromMs + HORIZON_MS;
    const events = data.calendar.events;
    const byId = new Map(events.map((e) => [e.id, e]));
    return K.reminderInstances(events, fromMs, toMs).map((inst) => ({
      id: docId(uid, inst.key),
      uid, key: inst.key, fireAt: inst.fireAt, type: inst.type, eventId: inst.eventId,
      title: inst.title, body: describe(inst, (byId.get(inst.eventId) || {}).timeZone || timeZoneHint),
      startsAt: inst.startsAt
    }));
  }

  // Diff existing pending docs against desired ones.
  function diff(existing, desired) {
    const want = new Map(desired.map((d) => [d.id, d]));
    const have = new Map(existing.map((d) => [d.id, d]));
    const upserts = desired.filter((d) => {
      const h = have.get(d.id);
      return !h || h.fireAt !== d.fireAt || h.title !== d.title || h.body !== d.body || h.type !== d.type;
    });
    const deletes = existing.filter((d) => !want.has(d.id)).map((d) => d.id);
    return { upserts, deletes };
  }

  // FCM data payload (all values must be strings).
  function message(rem, now) {
    const late = now - rem.fireAt > 2 * 60000;
    return {
      key: rem.key, eventId: rem.eventId, type: rem.type, title: rem.title,
      body: late ? `${rem.body} (delivered late)` : rem.body,
      fireAt: String(rem.fireAt), startsAt: String(rem.startsAt || rem.fireAt)
    };
  }

  const tooLate = (rem, now) => now - rem.fireAt > LATE_LIMIT_MS;

  return { plan, diff, message, tooLate, docId, HORIZON_MS };
}

module.exports = { createReminderPlanner, HORIZON_MS, LATE_LIMIT_MS };
