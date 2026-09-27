'use strict';
/*
 * Two-way Google Calendar sync for one account. Pure orchestration: it takes
 * the user's ZenFlow data and sync state, talks to Google through `api`, and
 * returns the updated data/state. The caller persists them (data via the same
 * transactional merge the client uses, so concurrent edits are never lost).
 *
 * Invariants
 *  - An event is "pending push" when updatedAt > google.syncedAt. After a
 *    push, updatedAt is bumped by 1 and syncedAt set equal to it, so merges
 *    prefer the recorded result and nothing is pushed twice.
 *  - Inserts use a Google event id derived from the ZenFlow id, so a retried
 *    insert (e.g. after a timeout that actually succeeded) cannot duplicate.
 *  - state.linked maps local id -> { cal, id } so deletions made in ZenFlow
 *    (tombstones) can be propagated even though the event itself is gone.
 *  - Pulled changes never lower updatedAt (LWW merges stay correct).
 */
const PULL_WINDOW_MS = 90 * 86400000;
const PRUNE_AFTER_MS = 180 * 86400000;

function createGoogleSync({ C, K, api, now = Date.now, log = () => {} }) {
  const eventsOf = (data) => data.calendar.events;
  const findEvent = (data, id) => eventsOf(data).find((e) => e.id === id);
  const bump = (ev) => {
    ev.updatedAt = Math.max((ev.updatedAt || 0) + 1, (ev.google && ev.google.syncedAt) || 0);
    if (ev.google) ev.google.syncedAt = ev.updatedAt;
  };
  const isGone = (e) => e && (e.status === 404 || e.status === 410);

  function calendarStatus(items) {
    return items.map((c) => ({
      id: c.id, summary: c.summaryOverride || c.summary || c.id, color: /^#[0-9a-fA-F]{6}$/.test(c.backgroundColor) ? c.backgroundColor : '',
      accessRole: c.accessRole, primary: c.primary === true, timeZone: c.timeZone || '',
      defaultReminders: (c.defaultReminders || []).filter((r) => r && r.method === 'popup')
    }));
  }

  function upsertPulled(data, state, cal, g, stats) {
    const mapped = K.fromGoogle(g, { calendarId: cal.id, accessRole: cal.accessRole, timeZone: cal.timeZone, defaultReminders: cal.defaultReminders });
    if (mapped.deleted) {
      // A cancelled instance of a recurring series becomes an exdate.
      if (mapped.masterId && mapped.originalStart != null) {
        const master = findEvent(data, mapped.masterId);
        if (master && !master.exdates.includes(mapped.originalStart)) { master.exdates.push(mapped.originalStart); bump(master); stats.updated++; }
      }
      if (findEvent(data, mapped.id)) {
        delete state.linked[mapped.id];
        C.removeItem(data, ['calendar', 'events'], mapped.id, now());
        stats.deleted++;
      }
      return;
    }
    const clean = C.sanitizeEvent(mapped);
    if (!clean) return;
    state.linked[clean.id] = { cal: cal.id, id: g.id };
    const local = findEvent(data, clean.id);
    if (!local) {
      if (eventsOf(data).length >= C.LIMITS.events) { stats.skipped++; return; }
      if (data.tombstones['ev:' + clean.id] != null && data.tombstones['ev:' + clean.id] >= clean.updatedAt) {
        // Deleted in ZenFlow after this Google version: the push phase deletes it.
        return;
      }
      eventsOf(data).push(clean);
      stats.added++;
      return;
    }
    const localPendingNewer = K.needsPush(local) && local.updatedAt > clean.google.updated;
    if (localPendingNewer) return; // conflict: newer local edit wins and is pushed below
    if (local.google && local.google.updated >= clean.google.updated && local.google.etag === clean.google.etag) return;
    // Take Google's version; keep device-level fields that Google doesn't hold.
    const keep = {
      snoozes: local.snoozes, done: local.done, color: local.color, kind: local.kind, createdAt: local.createdAt,
      source: local.source, // events created in ZenFlow stay "local" (deselecting a calendar never deletes them)
      // Google has no "alarm" reminders; keep that type for matching offsets.
      reminders: clean.reminders.map((r) => {
        const l = local.reminders.find((x) => x.offsetMin === r.offsetMin);
        return l ? { offsetMin: r.offsetMin, type: l.type } : r;
      })
    };
    Object.assign(local, clean, keep);
    local.updatedAt = Math.max(clean.updatedAt, (local.updatedAt || 0) + 1);
    local.google.syncedAt = local.updatedAt;
    stats.updated++;
  }

  async function pull(data, state, cal, stats) {
    const cs = state.calendars[cal.id] || (state.calendars[cal.id] = {});
    let res;
    try {
      res = await api.listEvents(cal.id, cs.syncToken ? { syncToken: cs.syncToken } : { timeMin: new Date(now() - PULL_WINDOW_MS).toISOString() });
    } catch (e) {
      if (e.status !== 410) throw e;
      log('sync token expired; full resync', { cal: cal.id });
      delete cs.syncToken;
      res = await api.listEvents(cal.id, { timeMin: new Date(now() - PULL_WINDOW_MS).toISOString() });
    }
    // Masters first so cancelled/overridden instances can find them.
    const items = res.items.slice().sort((a, b) => (a.recurringEventId ? 1 : 0) - (b.recurringEventId ? 1 : 0));
    for (const g of items) upsertPulled(data, state, cal, g, stats);
    if (res.nextSyncToken) cs.syncToken = res.nextSyncToken;
  }

  async function pushOne(data, state, ev, calsById, stats) {
    const calId = ev.cal.slice(2);
    const cal = calsById.get(calId);
    if (!cal || (cal.accessRole !== 'owner' && cal.accessRole !== 'writer')) { stats.errors.push({ id: ev.id, code: 'calendar-not-writable' }); return; }
    const link = state.linked[ev.id];
    if (link && link.cal !== calId) {            // moved to another calendar
      try { await api.deleteEvent(link.cal, link.id); } catch (e) { if (!isGone(e)) throw e; }
      delete state.linked[ev.id];
    }
    const body = K.toGoogle(ev);
    let res;
    if (ev.recurrenceId) {
      const master = findEvent(data, ev.recurrenceId);
      const mlink = master && state.linked[master.id];
      if (!mlink || mlink.cal !== calId) return; // master not in Google yet; next run
      res = await api.patchEvent(calId, K.googleInstanceId(mlink.id, ev.originalStart), body);
    } else if (state.linked[ev.id]) {
      try { res = await api.patchEvent(calId, state.linked[ev.id].id, body); }
      catch (e) { if (!isGone(e)) throw e; delete state.linked[ev.id]; }
    }
    if (!res) {
      const gid = K.googleIdFor(ev.id);
      try { res = await api.insertEvent(calId, Object.assign({ id: gid }, body)); }
      catch (e) {
        if (e.status !== 409) throw e;             // already exists (earlier attempt succeeded)
        res = await api.patchEvent(calId, gid, Object.assign({ status: 'confirmed' }, body));
      }
    }
    state.linked[ev.id] = { cal: calId, id: res.id };
    ev.google = { calendarId: calId, eventId: res.id, etag: res.etag || '', updated: Date.parse(res.updated) || now(), syncedAt: 0 };
    bump(ev);
    stats.pushed++;
  }

  async function syncAccount({ data, state, pushOnly = false }) {
    state = Object.assign({ calendars: {}, linked: {}, selectionInitialized: false }, state || {});
    const stats = { added: 0, updated: 0, deleted: 0, pushed: 0, removedRemote: 0, skipped: 0, errors: [] };

    const calendars = calendarStatus(await api.listCalendars());
    const calsById = new Map(calendars.map((c) => [c.id, c]));

    // First connection: sync the primary calendar unless the user chose.
    if (!state.selectionInitialized) {
      if (!data.calendar.googleSelection.length) {
        const primary = calendars.find((c) => c.primary);
        if (primary) C.setScalar(data, 'calendar', 'googleSelection', [primary.id], now());
      }
      state.selectionInitialized = true;
    }
    const selection = data.calendar.googleSelection.filter((id) => calsById.has(id));

    if (!pushOnly) {
      for (const id of selection) await pull(data, state, calsById.get(id), stats);
      // Calendars no longer selected: drop their mirrored events (not in Google).
      for (const ev of eventsOf(data).slice()) {
        if (ev.source === 'google' && ev.cal.startsWith('g:') && !selection.includes(ev.cal.slice(2))) {
          delete state.linked[ev.id];
          C.removeItem(data, ['calendar', 'events'], ev.id, now());
          stats.deleted++;
        }
      }
      for (const id of Object.keys(state.calendars)) if (!selection.includes(id)) delete state.calendars[id];
    }

    // Deletions made in ZenFlow.
    for (const [id, link] of Object.entries(state.linked)) {
      if (findEvent(data, id)) continue;
      if (data.tombstones['ev:' + id] != null) {
        try { await api.deleteEvent(link.cal, link.id); stats.removedRemote++; } catch (e) { if (!isGone(e)) { stats.errors.push({ id, code: 'delete-failed', status: e.status }); continue; } }
      }
      delete state.linked[id];
    }

    // Events moved from Google back to the ZenFlow calendar.
    for (const ev of eventsOf(data)) {
      const link = state.linked[ev.id];
      if (ev.cal === 'local' && link) {
        try { await api.deleteEvent(link.cal, link.id); } catch (e) { if (!isGone(e)) throw e; }
        delete state.linked[ev.id];
        ev.google = null;
        ev.source = 'local';
        bump(ev);
      }
    }

    // Local changes to push (masters before their overrides).
    const pending = eventsOf(data).filter((ev) => K.needsPush(ev)).sort((a, b) => (a.recurrenceId ? 1 : 0) - (b.recurrenceId ? 1 : 0));
    for (const ev of pending) {
      try { await pushOne(data, state, ev, calsById, stats); }
      catch (e) { stats.errors.push({ id: ev.id, code: 'push-failed', status: e.status, message: e.message }); log('push failed', { id: ev.id, status: e.status }); }
    }

    // Keep the document small: forget old one-off Google events.
    const cutoff = now() - PRUNE_AFTER_MS;
    for (const ev of eventsOf(data).slice()) {
      const end = ev.allDay ? Date.parse(ev.endDate + 'T00:00:00Z') : ev.end;
      if (ev.source === 'google' && !ev.rrule && end < cutoff) {
        delete state.linked[ev.id]; // pruning must not delete it from Google
        C.removeItem(data, ['calendar', 'events'], ev.id, now());
      }
    }

    const status = {
      connected: true,
      calendars: calendars.map(({ defaultReminders, ...c }) => c),
      lastSyncAt: now(),
      error: stats.errors.length ? { code: stats.errors[0].code, message: `${stats.errors.length} event(s) could not be synced` } : null
    };
    return { data, state, status, stats };
  }

  return { syncAccount };
}

module.exports = { createGoogleSync, PULL_WINDOW_MS };
