/*
 * ZenFlow calendar UI: views, event editor, Google Calendar panel, in-app
 * reminder scheduler, alarm ringing and push opt-in.
 *
 * Loaded before app.js and wrapped in an IIFE (no global name clashes). It
 * uses app.js globals (D, RT, PF, commit*, toast, dialogs, sync, bridge…)
 * only at call time, never at load time. app.js calls the hooks exposed on
 * window.ZenCalendarUI.
 */
(function () {
  'use strict';
  const C = window.ZenCore;
  const K = window.ZenCal;
  const esc = C.escapeHtml;
  const MIN = K.MIN;
  const HOUR_PX = 44;
  const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const RRULE_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const OFFSETS = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080];
  const MISSED_WINDOW = 12 * 3600000;

  const timers = { reminder: null, server: null, alarm: null };
  let pendingServer = { reminders: false, google: false };
  let lastSig = null;
  let unwatch = null;
  let dialog = null;          // { mode, eventId, occKey, occStart, isOverride, kind, readOnly }
  let alarmQueue = [];
  let serverDown = false;

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------
  const events = () => D().calendar.events;
  const byId = (id) => events().find((e) => e.id === id);
  const tz = () => K.localTimeZone();
  const todayKey = () => C.localDayKey();
  const cursorKey = () => PF().calCursor || todayKey();
  const narrow = () => window.matchMedia('(max-width: 780px)').matches;
  const dayMs = (key) => C.parseDayKey(key).getTime();
  const addDays = (key, n) => { const d = C.parseDayKey(key); return C.localDayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)); };
  const weekStartKey = (key) => addDays(key, -((C.parseDayKey(key).getDay() - PF().weekStart + 7) % 7));
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const fmtDay = (key, opts) => C.parseDayKey(key).toLocaleDateString('en-US', opts || { weekday: 'short', month: 'short', day: 'numeric' });
  const timeInput = (ms) => { const d = new Date(ms); return C.pad(d.getHours()) + ':' + C.pad(d.getMinutes()); };
  const googleStatus = () => (sync ? sync.snapshot().google : C.sanitizeGoogleStatus(null));
  const el = (id) => document.getElementById(id);

  function calendars() {
    const g = googleStatus();
    const list = [{ id: 'local', name: 'ZenFlow', color: 'var(--accent)', writable: true, google: false }];
    if (g.connected) {
      for (const c of g.calendars) {
        if (!D().calendar.googleSelection.includes(c.id)) continue;
        list.push({ id: 'g:' + c.id, name: c.summary, color: c.color || '#4285f4', writable: c.accessRole === 'owner' || c.accessRole === 'writer', google: true });
      }
    }
    return list;
  }
  function colorOf(ev) {
    if (ev.color) return ev.color;
    const c = calendars().find((x) => x.id === ev.cal);
    return c ? c.color : ev.cal === 'local' ? 'var(--accent)' : '#4285f4';
  }
  function visible() {
    const hidden = new Set(PF().hiddenCals);
    return events().filter((e) => !hidden.has(e.cal));
  }
  const expand = (fromMs, toMs) => K.expandAll(visible(), fromMs, toMs, tz());
  const kindIcon = (ev) => (ev.kind === 'alarm' ? '⏰ ' : ev.kind === 'reminder' ? '🔔 ' : '');
  function occLabel(o) {
    if (o.allDay) return 'All day';
    if (o.event.kind !== 'event' || o.end === o.start) return fmtTime(o.start);
    return `${fmtTime(o.start)} – ${fmtTime(o.end)}`;
  }

  function effectiveView() {
    const v = PF().calView;
    return v === 'week' && narrow() ? 'day' : v;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  function render() {
    const root = el('calendarView');
    if (!root || !el('page-calendar').classList.contains('active')) return;
    const view = effectiveView();
    document.querySelectorAll('#calViewSwitch .pomo-tab').forEach((b) => {
      const on = b.dataset.view === PF().calView;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
      if (b.dataset.view === 'week') b.textContent = narrow() ? 'Day' : 'Week';
    });
    el('calTitle').textContent = titleFor(view);
    if (view === 'month') renderMonth(root);
    else if (view === 'agenda') renderAgenda(root);
    else renderWeek(root, view === 'day' ? 1 : 7);
    renderSidebar();
  }

  function titleFor(view) {
    const k = cursorKey();
    if (view === 'month') return C.parseDayKey(k).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    if (view === 'day') return fmtDay(k, { weekday: 'long', month: 'long', day: 'numeric' });
    if (view === 'agenda') return 'From ' + fmtDay(k, { month: 'long', day: 'numeric' });
    const s = weekStartKey(k), e = addDays(s, 6);
    const sd = C.parseDayKey(s), ed = C.parseDayKey(e);
    const sameMonth = sd.getMonth() === ed.getMonth();
    return `${sd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${ed.toLocaleDateString('en-US', sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' })}, ${ed.getFullYear()}`;
  }

  function chip(o, extraClass = '') {
    const ev = o.event;
    const label = `${ev.title}, ${o.allDay ? 'all day' : occLabel(o)}`;
    return `<button type="button" class="cal-chip ${o.allDay ? 'is-allday' : ''} ${extraClass}" style="--chip:${esc(colorOf(ev))}"
      data-action="cal-open" data-id="${esc(ev.id)}" data-occ="${esc(o.key)}" data-start="${o.start}" aria-label="${esc(label)}">
      ${o.allDay ? '' : `<span class="cal-chip-time">${esc(fmtTime(o.start))}</span>`}<span class="cal-chip-title">${esc(kindIcon(ev) + ev.title)}</span></button>`;
  }

  function renderMonth(root) {
    const cur = C.parseDayKey(cursorKey());
    const first = C.localDayKey(new Date(cur.getFullYear(), cur.getMonth(), 1));
    const start = weekStartKey(first);
    const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
    const occ = expand(dayMs(days[0]), dayMs(addDays(days[41], 1)));
    const byDay = new Map(days.map((d) => [d, []]));
    for (const o of occ) {
      if (o.allDay) {
        for (let d = o.startDate; d < o.endDate; d = addDays(d, 1)) if (byDay.has(d)) byDay.get(d).push(o);
      } else {
        const k = C.localDayKey(o.start);
        if (byDay.has(k)) byDay.get(k).push(o);
      }
    }
    const today = todayKey();
    const head = Array.from({ length: 7 }, (_, i) => `<div class="cal-weekday" role="columnheader">${WEEKDAY_SHORT[(PF().weekStart + i) % 7]}</div>`).join('');
    const cells = days.map((d) => {
      const list = byDay.get(d);
      const inMonth = C.parseDayKey(d).getMonth() === cur.getMonth();
      const shown = list.slice(0, 3).map((o) => chip(o)).join('');
      const more = list.length > 3 ? `<button type="button" class="cal-more" data-action="cal-goto-day" data-day="${d}">+${list.length - 3} more</button>` : '';
      return `<div class="cal-cell ${inMonth ? '' : 'is-outside'} ${d === today ? 'is-today' : ''}" role="gridcell" data-action="cal-new-day" data-day="${d}">
        <button type="button" class="cal-daynum" data-action="cal-goto-day" data-day="${d}" aria-label="${esc(fmtDay(d, { weekday: 'long', month: 'long', day: 'numeric' }))}${list.length ? `, ${list.length} item${list.length === 1 ? '' : 's'}` : ''}">${C.parseDayKey(d).getDate()}</button>
        <div class="cal-chips">${shown}${more}</div></div>`;
    }).join('');
    root.innerHTML = `<div class="cal-month" role="grid" aria-label="${esc(titleFor('month'))}"><div class="cal-month-head" role="row">${head}</div><div class="cal-month-grid">${cells}</div></div>`;
  }

  // Greedy lane layout for overlapping timed events in one day column.
  function layoutDay(items) {
    items.sort((a, b) => a.s - b.s || b.e - a.e);
    let cluster = [], clusterEnd = -1;
    const flush = () => { const lanes = Math.max(...cluster.map((x) => x.lane)) + 1; cluster.forEach((x) => { x.lanes = lanes; }); cluster = []; };
    for (const it of items) {
      if (cluster.length && it.s >= clusterEnd) flush();
      const used = new Set(cluster.filter((x) => x.e > it.s).map((x) => x.lane));
      let lane = 0; while (used.has(lane)) lane++;
      it.lane = lane;
      cluster.push(it);
      clusterEnd = Math.max(clusterEnd, it.e);
    }
    if (cluster.length) flush();
    return items;
  }

  function renderWeek(root, n) {
    const start = n === 1 ? cursorKey() : weekStartKey(cursorKey());
    const days = Array.from({ length: n }, (_, i) => addDays(start, i));
    const occ = expand(dayMs(days[0]), dayMs(addDays(days[n - 1], 1)));
    const today = todayKey();
    const allDay = days.map((d) => occ.filter((o) => o.allDay && o.startDate <= d && o.endDate > d));
    const timed = days.map((d) => {
      const s0 = dayMs(d), s1 = dayMs(addDays(d, 1));
      return layoutDay(occ.filter((o) => !o.allDay && o.end > s0 && o.start < s1)
        .map((o) => ({ o, s: Math.max(o.start, s0), e: Math.min(Math.max(o.end, o.start + 20 * MIN), s1), day0: s0 })));
    });
    const head = days.map((d) => `<div class="cal-wk-head ${d === today ? 'is-today' : ''}"><button type="button" class="cal-daynum" data-action="cal-goto-day" data-day="${d}">
      <span>${WEEKDAY_SHORT[C.parseDayKey(d).getDay()]}</span><strong>${C.parseDayKey(d).getDate()}</strong></button></div>`).join('');
    const allDayRow = days.map((d, i) => `<div class="cal-wk-allday" data-action="cal-new-day" data-day="${d}" data-allday="1">${allDay[i].map((o) => chip(o)).join('')}</div>`).join('');
    const hours = Array.from({ length: 24 }, (_, h) => `<div class="cal-hour"><span>${h === 0 ? '' : new Date(2000, 0, 1, h).toLocaleTimeString('en-US', { hour: 'numeric' })}</span></div>`).join('');
    const cols = days.map((d, i) => {
      const evs = timed[i].map((it) => {
        const top = ((it.s - it.day0) / 3600000) * HOUR_PX;
        const height = Math.max(20, ((it.e - it.s) / 3600000) * HOUR_PX - 2);
        const w = 100 / it.lanes;
        const ev = it.o.event;
        return `<button type="button" class="cal-block ${height < 36 ? 'is-short' : ''}" style="top:${top}px;height:${height}px;left:calc(${it.lane * w}% + 2px);width:calc(${w}% - 4px);--chip:${esc(colorOf(ev))}"
          data-action="cal-open" data-id="${esc(ev.id)}" data-occ="${esc(it.o.key)}" data-start="${it.o.start}" aria-label="${esc(`${ev.title}, ${occLabel(it.o)}`)}">
          <span class="cal-block-title">${esc(kindIcon(ev) + ev.title)}</span><span class="cal-block-time">${esc(occLabel(it.o))}</span></button>`;
      }).join('');
      const now = Date.now();
      const nowLine = d === today ? `<div class="cal-now" style="top:${((now - dayMs(d)) / 3600000) * HOUR_PX}px" aria-hidden="true"></div>` : '';
      return `<div class="cal-wk-col ${d === today ? 'is-today' : ''}" data-action="cal-new-slot" data-day="${d}">${evs}${nowLine}</div>`;
    }).join('');
    const prevScroll = el('calWeekScroll') ? el('calWeekScroll').scrollTop : null;
    root.innerHTML = `<div class="cal-week" style="--days:${n}">
      <div class="cal-wk-headrow"><div class="cal-gutter"></div>${head}</div>
      <div class="cal-wk-alldayrow"><div class="cal-gutter cal-gutter-label">All day</div>${allDayRow}</div>
      <div class="cal-wk-scroll" id="calWeekScroll"><div class="cal-wk-body" style="height:${24 * HOUR_PX}px"><div class="cal-hours">${hours}</div>${cols}</div></div>
    </div>`;
    // Start near now when today is visible, otherwise at 7:00.
    const sc = el('calWeekScroll');
    if (sc && prevScroll !== null) sc.scrollTop = prevScroll;
    else if (sc) {
      const h = days.includes(today) ? Math.max(0, (Date.now() - dayMs(today)) / 3600000 - 2) : 7;
      requestAnimationFrame(() => { sc.scrollTop = h * HOUR_PX; });
    }
  }

  function renderAgenda(root) {
    const start = cursorKey();
    const days = 30;
    const occ = expand(dayMs(start), dayMs(addDays(start, days)));
    const groups = new Map();
    for (const o of occ) {
      const k = o.allDay ? (o.startDate < start ? start : o.startDate) : C.localDayKey(o.start);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(o);
    }
    if (!groups.size) {
      root.innerHTML = `<div class="empty-state"><div class="empty-state-text">Nothing scheduled</div><div class="empty-state-sub">No events, reminders or alarms in the next 30 days.</div>
        <button type="button" class="btn btn-primary mt-8" data-action="cal-new-day" data-day="${start}">New event</button></div>`;
      return;
    }
    const today = todayKey();
    root.innerHTML = `<div class="cal-agenda">${[...groups].sort((a, b) => a[0].localeCompare(b[0])).map(([k, list]) => `
      <section class="cal-agenda-day ${k === today ? 'is-today' : ''}" aria-label="${esc(fmtDay(k, { weekday: 'long', month: 'long', day: 'numeric' }))}">
        <h3 class="cal-agenda-date">${esc(k === today ? 'Today' : k === addDays(today, 1) ? 'Tomorrow' : fmtDay(k, { weekday: 'long', month: 'short', day: 'numeric' }))}</h3>
        ${list.map((o) => {
          const ev = o.event;
          return `<button type="button" class="cal-agenda-item" style="--chip:${esc(colorOf(ev))}" data-action="cal-open" data-id="${esc(ev.id)}" data-occ="${esc(o.key)}" data-start="${o.start}">
            <span class="cal-agenda-time">${esc(occLabel(o))}</span>
            <span class="cal-agenda-main"><span class="cal-agenda-title">${esc(kindIcon(ev) + ev.title)}</span>${ev.location ? `<span class="cal-agenda-sub">${esc(ev.location)}</span>` : ''}</span>
            ${ev.reminders.length ? '<span class="cal-agenda-bell" aria-label="Has reminders">🔔</span>' : ''}
          </button>`;
        }).join('')}
      </section>`).join('')}</div>`;
  }

  function renderSidebar() {
    const box = el('calSidebar');
    if (!box) return;
    const hidden = new Set(PF().hiddenCals);
    const cals = calendars();
    const upcoming = K.reminderInstances(events(), Date.now(), Date.now() + 7 * 86400000).slice(0, 5);
    box.innerHTML = `
      <section aria-labelledby="calListTitle">
        <h2 class="section-label" id="calListTitle">Calendars</h2>
        <div class="cal-list">${cals.map((c) => `
          <label class="cal-list-item"><input type="checkbox" data-action="cal-toggle-visible" data-cal="${esc(c.id)}" ${hidden.has(c.id) ? '' : 'checked'}>
            <span class="cal-swatch" style="background:${esc(c.color)}"></span><span>${esc(c.name)}</span>${c.google ? '<span class="cal-src">Google</span>' : ''}</label>`).join('')}
        </div>
      </section>
      <section class="card card-sm cal-google" aria-labelledby="calGoogleTitle">${googlePanel()}</section>
      <section aria-labelledby="calUpTitle">
        <h2 class="section-label" id="calUpTitle">Coming up</h2>
        ${upcoming.length ? `<ul class="cal-upcoming">${upcoming.map((r) => `<li><span class="cal-up-when">${esc(relativeWhen(r.fireAt))}</span><span class="cal-up-title">${esc((r.type === 'alarm' ? '⏰ ' : '🔔 ') + r.title)}</span></li>`).join('')}</ul>`
          : '<p class="text-xs">No reminders in the next 7 days.</p>'}
      </section>`;
  }

  function relativeWhen(ms) {
    const k = C.localDayKey(ms), today = todayKey();
    const day = k === today ? 'Today' : k === addDays(today, 1) ? 'Tomorrow' : fmtDay(k);
    return `${day} ${fmtTime(ms)}`;
  }

  function googlePanel() {
    const g = googleStatus();
    const head = '<h2 class="card-title" id="calGoogleTitle">Google Calendar</h2>';
    if (!isSignedIn()) {
      return `${head}<p class="text-sm mt-8">Log in to sync events with Google Calendar in both directions.</p>
        <button type="button" class="btn btn-ghost w-full mt-8" onclick="openAuthModal()">Log in</button>`;
    }
    if (!g.connected) {
      const reauth = g.error && g.error.code === 'reauth';
      return `${head}<p class="text-sm mt-8">${reauth ? 'Google access expired. Connect again to resume syncing.' : 'Show your Google events here and keep changes in sync both ways.'}</p>
        ${serverDown ? '<p class="field-error">The sync server isn’t available yet.</p>' : ''}
        <button type="button" class="btn btn-primary w-full mt-8" id="calConnectBtn" data-action="cal-google-connect">Connect Google Calendar</button>`;
    }
    const sel = new Set(D().calendar.googleSelection);
    const last = g.lastSyncAt ? `Synced ${relativeWhen(g.lastSyncAt)}` : 'Syncing…';
    return `${head}
      <p class="text-xs mt-4">${esc(g.email)} · ${esc(last)}</p>
      ${g.error ? `<p class="field-error" role="status">${esc(g.error.message)}</p>` : ''}
      <h3 class="section-label mt-8">Sync these calendars</h3>
      <div class="cal-list">${g.calendars.map((c) => `
        <label class="cal-list-item"><input type="checkbox" data-action="cal-google-select" data-gcal="${esc(c.id)}" ${sel.has(c.id) ? 'checked' : ''}>
          <span class="cal-swatch" style="background:${esc(c.color || '#4285f4')}"></span><span>${esc(c.summary)}</span>${c.accessRole === 'owner' || c.accessRole === 'writer' ? '' : '<span class="cal-src">Read-only</span>'}</label>`).join('') || '<p class="text-xs">Loading calendars…</p>'}
      </div>
      <div class="flex-row mt-8">
        <button type="button" class="btn btn-ghost" data-action="cal-google-sync">Sync now</button>
        <button type="button" class="btn btn-link" data-action="cal-google-disconnect">Disconnect</button>
      </div>`;
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------
  function setCursor(k) { PF().calCursor = k; commitPrefs(); render(); }
  function step(dir) {
    const v = effectiveView(), k = cursorKey();
    if (v === 'month') { const d = C.parseDayKey(k); setCursor(C.localDayKey(new Date(d.getFullYear(), d.getMonth() + dir, 1))); }
    else setCursor(addDays(k, dir * (v === 'day' ? 1 : 7)));
  }
  function setView(v) { PF().calView = ['month', 'week', 'agenda'].includes(v) ? v : 'month'; commitPrefs(); render(); }
  function goToday() { setCursor(todayKey()); }

  // -------------------------------------------------------------------------
  // Event editor
  // -------------------------------------------------------------------------
  function roundedNext(ms) { const q = 30 * MIN; return Math.ceil(ms / q) * q; }

  function openNew(opts = {}) {
    const kind = opts.kind || 'event';
    const day = opts.day || todayKey();
    let start;
    if (opts.startMs) start = opts.startMs;
    else if (day === todayKey()) start = roundedNext(Date.now() + 5 * MIN);
    else start = dayMs(day) + 9 * 3600000;
    const ev = {
      id: '', title: '', description: '', location: '', kind, allDay: !!opts.allDay, timeZone: tz(),
      start, end: start + (kind === 'event' ? 3600000 : 0), startDate: day, endDate: addDays(day, 1),
      rrule: kind === 'alarm' ? 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' : '', exdates: [],
      reminders: kind === 'alarm' ? [{ offsetMin: 0, type: 'alarm' }] : kind === 'reminder' ? [{ offsetMin: 0, type: 'notify' }] : [{ offsetMin: 10, type: 'notify' }],
      cal: 'local', color: '', readOnly: false
    };
    dialog = { mode: 'new', kind };
    fill(ev);
    openModal('modalEvent');
    setTimeout(() => el('evTitle').focus(), 60);
  }

  function openExisting(id, occKey, occStart) {
    const ev = byId(id);
    if (!ev) return;
    const isOverride = !!ev.recurrenceId;
    dialog = { mode: 'edit', eventId: id, occKey: ev.rrule ? occKey : null, occStart, isOverride, kind: ev.kind, readOnly: ev.readOnly };
    // Show the clicked occurrence's times, not the series start.
    const view = Object.assign({}, ev);
    if (ev.rrule && occKey != null) {
      if (ev.allDay) { const span = K.keyDiff(ev.startDate, ev.endDate); view.startDate = occKey; view.endDate = addDays(occKey, span); }
      else { view.start = Number(occKey); view.end = Number(occKey) + (ev.end - ev.start); }
    }
    fill(view);
    openModal('modalEvent');
  }

  function fill(ev) {
    const editing = dialog.mode === 'edit';
    el('eventModalTitle').textContent = editing ? (dialog.readOnly ? 'Event details' : 'Edit ' + (ev.kind === 'event' ? 'event' : ev.kind)) : 'New ' + ev.kind;
    setKind(ev.kind, true);
    el('evTitle').value = ev.title;
    el('evAllDay').checked = ev.allDay;
    if (ev.allDay) {
      el('evStartDate').value = ev.startDate;
      el('evEndDate').value = addDays(ev.endDate, -1);
      el('evStartTime').value = '09:00';
      el('evEndTime').value = '10:00';
    } else {
      el('evStartDate').value = C.localDayKey(ev.start);
      el('evStartTime').value = timeInput(ev.start);
      el('evEndDate').value = C.localDayKey(ev.end);
      el('evEndTime').value = timeInput(ev.end);
    }
    el('evLocation').value = ev.location;
    el('evDesc').value = ev.description;
    // Calendar choices: ZenFlow + writable Google calendars.
    const cals = calendars().filter((c) => c.writable || c.id === ev.cal);
    if (!cals.some((c) => c.id === ev.cal)) cals.push({ id: ev.cal, name: ev.cal.startsWith('g:') ? ev.cal.slice(2) : 'ZenFlow' });
    el('evCal').innerHTML = cals.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}${c.google ? ' (Google)' : ''}</option>`).join('');
    el('evCal').value = ev.cal;
    fillRepeat(ev);
    renderReminderRows(ev.reminders);
    el('evTzNote').textContent = ev.allDay ? '' : `Times in ${ev.timeZone || tz()}`;
    el('evDelete').hidden = !editing || dialog.readOnly;
    el('evSave').hidden = dialog.readOnly;
    el('evReadOnlyNote').hidden = !dialog.readOnly;
    el('evDone').hidden = !(editing && ev.kind === 'reminder' && !ev.rrule);
    el('evDone').textContent = ev.done ? 'Mark not done' : 'Mark done';
    document.querySelectorAll('#modalEvent input, #modalEvent select, #modalEvent textarea, #modalEvent .ev-kind button, #modalEvent .ev-dow, #modalEvent [data-action="ev-add-reminder"]')
      .forEach((x) => { x.disabled = dialog.readOnly; });
    onAllDay();
  }

  function setKind(kind, silent) {
    dialog.kind = kind;
    document.querySelectorAll('#modalEvent .ev-kind .pomo-tab').forEach((b) => {
      const on = b.dataset.kind === kind;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const isEvent = kind === 'event';
    el('evAllDayRow').hidden = !isEvent;
    el('evEndRow').hidden = !isEvent;
    el('evLocGroup').hidden = !isEvent;
    el('evDescGroup').hidden = kind === 'alarm';
    el('evStartLabel').textContent = isEvent ? 'Starts' : kind === 'alarm' ? 'Rings at' : 'Remind me at';
    if (!silent) {
      if (kind === 'alarm') { renderReminderRows([{ offsetMin: 0, type: 'alarm' }]); if (el('evRepeat').value === 'none') { el('evRepeat').value = 'weekdays'; onRepeat(); } }
      else if (kind === 'reminder') renderReminderRows([{ offsetMin: 0, type: 'notify' }]);
      else renderReminderRows([{ offsetMin: 10, type: 'notify' }]);
      if (!isEvent) el('evAllDay').checked = false;
      onAllDay();
    }
  }

  function onAllDay() {
    const allDay = el('evAllDay').checked && dialog.kind === 'event';
    el('evStartTime').hidden = allDay;
    el('evEndTime').hidden = allDay;
    el('evTzNote').hidden = allDay;
  }

  // Repeat UI <-> RRULE.
  function fillRepeat(ev) {
    const r = K.parseRRule(ev.rrule);
    const sel = el('evRepeat');
    const custom = sel.querySelector('option[value="custom"]');
    custom.hidden = true;
    el('evInterval').value = 1;
    el('evEnds').value = 'never';
    el('evCount').value = 10;
    el('evUntil').value = '';
    const startKey = ev.allDay ? ev.startDate : C.localDayKey(ev.start);
    const wd = C.parseDayKey(startKey).getDay();
    let days = [wd];
    if (!r) sel.value = 'none';
    else if (!K.isSupported(r) || r.bymonth.length || r.bymonthday.length > 1 || r.byday.length > 1 && r.freq === 'MONTHLY') {
      custom.hidden = false;
      custom.textContent = K.describeRRule(ev.rrule) + ' (keep)';
      sel.value = 'custom';
    } else {
      el('evInterval').value = r.interval;
      if (r.freq === 'DAILY') sel.value = 'daily';
      else if (r.freq === 'WEEKLY') {
        days = r.byday.length ? r.byday.map((b) => b.wd) : [wd];
        sel.value = r.interval === 1 && days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d)) ? 'weekdays' : 'weekly';
      } else if (r.freq === 'MONTHLY') sel.value = r.byday.length ? 'monthly-nth' : 'monthly-day';
      else sel.value = 'yearly';
      if (r.count) { el('evEnds').value = 'after'; el('evCount').value = r.count; }
      else if (r.until) { el('evEnds').value = 'on'; el('evUntil').value = r.until.date || C.localDayKey(r.until.ms); }
    }
    document.querySelectorAll('#evWeekdays .ev-dow').forEach((b) => b.setAttribute('aria-pressed', String(days.includes(Number(b.dataset.wd)))));
    onRepeat();
  }

  function onRepeat() {
    const v = el('evRepeat').value;
    const show = v !== 'none' && v !== 'custom';
    el('evRepeatMore').hidden = !show;
    el('evWeekdays').hidden = !(v === 'weekly' || v === 'weekdays');
    el('evIntervalRow').hidden = v === 'weekdays';
    el('evIntervalUnit').textContent = { daily: 'day(s)', weekly: 'week(s)', weekdays: 'week(s)', 'monthly-day': 'month(s)', 'monthly-nth': 'month(s)', yearly: 'year(s)' }[v] || '';
    if (v === 'weekdays') document.querySelectorAll('#evWeekdays .ev-dow').forEach((b) => b.setAttribute('aria-pressed', String([1, 2, 3, 4, 5].includes(Number(b.dataset.wd)))));
    const ends = el('evEnds').value;
    el('evUntil').hidden = ends !== 'on';
    el('evCount').hidden = ends !== 'after';
    const startKey = el('evStartDate').value;
    const d = C.parseDayKey(startKey);
    if (d) {
      const nth = Math.ceil(d.getDate() / 7);
      const last = d.getDate() + 7 > new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      const o1 = el('evRepeat').querySelector('option[value="monthly-day"]');
      const o2 = el('evRepeat').querySelector('option[value="monthly-nth"]');
      o1.textContent = `Monthly on day ${d.getDate()}`;
      o2.textContent = `Monthly on the ${last ? 'last' : ['first', 'second', 'third', 'fourth'][nth - 1]} ${WEEKDAY_SHORT[d.getDay()]}`;
      el('evRepeat').querySelector('option[value="weekly"]').textContent = `Weekly on ${WEEKDAY_SHORT[d.getDay()]}…`;
    }
  }

  function buildRRule(existing, startKey, allDay, startMs) {
    const v = el('evRepeat').value;
    if (v === 'none') return '';
    if (v === 'custom') return existing || '';
    const d = C.parseDayKey(startKey);
    const interval = Math.max(1, Math.min(99, parseInt(el('evInterval').value, 10) || 1));
    const r = { freq: 'DAILY', interval, byday: [], bymonthday: [], bymonth: [], count: null, until: null };
    if (v === 'daily') r.freq = 'DAILY';
    else if (v === 'weekdays') { r.freq = 'WEEKLY'; r.interval = 1; r.byday = [1, 2, 3, 4, 5].map((wd) => ({ n: 0, wd })); }
    else if (v === 'weekly') {
      r.freq = 'WEEKLY';
      const picked = [...document.querySelectorAll('#evWeekdays .ev-dow[aria-pressed="true"]')].map((b) => Number(b.dataset.wd));
      r.byday = (picked.length ? picked : [d.getDay()]).sort().map((wd) => ({ n: 0, wd }));
    } else if (v === 'monthly-day') { r.freq = 'MONTHLY'; r.bymonthday = [d.getDate()]; }
    else if (v === 'monthly-nth') {
      r.freq = 'MONTHLY';
      const last = d.getDate() + 7 > new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      r.byday = [{ n: last ? -1 : Math.ceil(d.getDate() / 7), wd: d.getDay() }];
    } else if (v === 'yearly') r.freq = 'YEARLY';
    const ends = el('evEnds').value;
    if (ends === 'after') r.count = Math.max(1, Math.min(999, parseInt(el('evCount').value, 10) || 1));
    else if (ends === 'on' && C.parseDayKey(el('evUntil').value)) {
      const u = el('evUntil').value;
      if (allDay) r.until = { date: u };
      else { const ud = C.parseDayKey(u); r.until = { ms: new Date(ud.getFullYear(), ud.getMonth(), ud.getDate(), 23, 59, 59).getTime() }; }
    }
    void startMs;
    return K.formatRRule(r);
  }

  function renderReminderRows(list) {
    const allDay = el('evAllDay').checked;
    const box = el('evReminders');
    const alarm = dialog.kind === 'alarm';
    box.innerHTML = list.map((r, i) => `
      <div class="ev-rem-row" data-index="${i}">
        <select class="input ev-rem-offset" aria-label="When">
          ${[...new Set([...OFFSETS, r.offsetMin])].sort((a, b) => a - b).map((m) => `<option value="${m}" ${m === r.offsetMin ? 'selected' : ''}>${esc(K.describeOffset(m, allDay))}</option>`).join('')}
        </select>
        <select class="input ev-rem-type" aria-label="How" ${alarm ? 'disabled' : ''}>
          <option value="notify" ${r.type === 'notify' ? 'selected' : ''}>Notification</option>
          <option value="alarm" ${r.type === 'alarm' ? 'selected' : ''}>Alarm (rings)</option>
        </select>
        ${alarm ? '' : `<button type="button" class="btn btn-icon btn-ghost" data-action="ev-remove-reminder" data-index="${i}" aria-label="Remove reminder">✕</button>`}
      </div>`).join('') || '<p class="text-xs">No reminders.</p>';
    const add = document.querySelector('#modalEvent [data-action="ev-add-reminder"]');
    if (add) add.hidden = alarm || list.length >= 5;
  }
  function readReminderRows() {
    return [...document.querySelectorAll('#evReminders .ev-rem-row')].map((row) => ({
      offsetMin: Number(row.querySelector('.ev-rem-offset').value) || 0,
      type: row.querySelector('.ev-rem-type').value === 'alarm' ? 'alarm' : 'notify'
    }));
  }

  function readForm() {
    const kind = dialog.kind;
    const allDay = kind === 'event' && el('evAllDay').checked;
    const titleEl = el('evTitle');
    const title = titleEl.value.trim();
    if (!title) { fieldError(titleEl, 'Give it a title.'); return null; }
    const sd = el('evStartDate').value;
    if (!C.parseDayKey(sd)) { fieldError(el('evStartDate'), 'Choose a date.'); return null; }
    const f = { title, kind, allDay, timeZone: tz(), cal: el('evCal').value || 'local', reminders: readReminderRows() };
    if (kind === 'event') { f.location = el('evLocation').value.trim(); }
    else f.location = '';
    f.description = kind === 'alarm' ? '' : el('evDesc').value.trim();
    if (allDay) {
      const ed = el('evEndDate').value || sd;
      if (!C.parseDayKey(ed) || ed < sd) { fieldError(el('evEndDate'), 'The end date must be on or after the start date.'); return null; }
      Object.assign(f, { startDate: sd, endDate: addDays(ed, 1), start: null, end: null });
    } else {
      const st = el('evStartTime').value;
      if (!st) { fieldError(el('evStartTime'), 'Enter a time.'); return null; }
      const start = new Date(sd + 'T' + st).getTime();
      let end = start;
      if (kind === 'event') {
        const ed = el('evEndDate').value || sd, et = el('evEndTime').value || st;
        end = new Date(ed + 'T' + et).getTime();
        if (!(end >= start)) { fieldError(el('evEndTime'), 'The end must be after the start.'); return null; }
      }
      Object.assign(f, { start, end, startDate: '', endDate: '' });
    }
    if (kind === 'alarm') f.reminders = [{ offsetMin: 0, type: 'alarm' }];
    if (kind === 'reminder' && !f.reminders.length) f.reminders = [{ offsetMin: 0, type: 'notify' }];
    if (el('evEnds').value === 'on' && el('evRepeat').value !== 'none' && el('evUntil').value && el('evUntil').value < sd) {
      fieldError(el('evUntil'), 'The repeat must end after it starts.'); return null;
    }
    return f;
  }

  async function save() {
    if (!dialog || dialog.readOnly) return;
    const f = readForm();
    if (!f) return;
    const now = Date.now();
    const d = D();
    if (dialog.mode === 'new') {
      f.rrule = buildRRule('', f.allDay ? f.startDate : C.localDayKey(f.start), f.allDay, f.start);
      const ev = C.sanitizeEvent(Object.assign({ id: C.newId('ev'), exdates: [], source: 'local', createdAt: now, updatedAt: now }, f));
      d.calendar.events.push(ev);
      finishSave(ev.kind === 'event' ? 'Event added' : ev.kind === 'alarm' ? 'Alarm set' : 'Reminder set', ev);
      return;
    }
    const ev = byId(dialog.eventId);
    if (!ev) { closeModal('modalEvent'); return; }
    const newRule = buildRRule(ev.rrule, f.allDay ? f.startDate : C.localDayKey(f.start), f.allDay, f.start);
    if (ev.rrule && dialog.occKey != null && !dialog.isOverride) {
      const choice = await choiceDialog({
        title: 'Edit repeating ' + (ev.kind === 'event' ? 'event' : ev.kind),
        message: 'Apply your changes to this occurrence only, or to the whole series?',
        choices: [{ label: 'Cancel', value: null }, { label: 'This one', value: 'one' }, { label: 'All in series', value: 'all', primary: true }]
      });
      if (!choice) return;
      if (choice === 'one') {
        const override = C.sanitizeEvent(Object.assign({}, ev, f, {
          id: C.newId('ev'), rrule: '', exdates: [], recurrenceId: ev.id, originalStart: dialog.occKey,
          google: null, source: 'local', snoozes: {}, createdAt: now, updatedAt: now
        }));
        d.calendar.events.push(override);
        finishSave('Occurrence updated', override);
        return;
      }
      // Whole series: shift the series by how far this occurrence moved.
      if (ev.allDay && f.allDay) {
        const delta = K.keyDiff(String(dialog.occKey), f.startDate);
        const span = K.keyDiff(f.startDate, f.endDate);
        f.startDate = addDays(ev.startDate, delta);
        f.endDate = addDays(f.startDate, span);
        if (delta) ev.exdates = [];
      } else if (!ev.allDay && !f.allDay) {
        const delta = f.start - Number(dialog.occKey);
        const dur = f.end - f.start;
        f.start = ev.start + delta;
        f.end = f.start + dur;
        if (delta) ev.exdates = [];
      } else ev.exdates = [];
    }
    Object.assign(ev, f, { rrule: dialog.isOverride ? '' : newRule });
    C.touchItem(d, ev, now);
    finishSave('Saved', ev);
  }

  function finishSave(msg, ev) {
    commitData();
    closeModal('modalEvent');
    if (ev.reminders.length && !('Notification' in window && Notification.permission !== 'default')) askNotificationsOnce();
    onDataChanged();
    toast(msg, 'success');
  }

  async function removeFromDialog() {
    if (!dialog || dialog.mode !== 'edit') return;
    const ev = byId(dialog.eventId);
    if (!ev) return;
    closeModal('modalEvent');
    const now = Date.now();
    if (ev.rrule && dialog.occKey != null) {
      const choice = await choiceDialog({
        title: 'Delete repeating ' + (ev.kind === 'event' ? 'event' : ev.kind),
        message: 'Delete only this occurrence, or the whole series?',
        choices: [{ label: 'Cancel', value: null }, { label: 'This one', value: 'one' }, { label: 'All in series', value: 'all', danger: true }]
      });
      if (!choice) return;
      if (choice === 'one') {
        const key = dialog.occKey;
        ev.exdates.push(key);
        C.touchItem(D(), ev, now);
        commitData();
        onDataChanged();
        toast('Occurrence deleted', 'info', '🗑️', {
          action: { label: 'Undo', onClick: () => { const e = byId(ev.id); if (!e) return; e.exdates = e.exdates.filter((x) => x !== key); C.touchItem(D(), e, Date.now()); commitData(); onDataChanged(); } }
        });
        return;
      }
    }
    if (ev.recurrenceId) {
      // Deleting an edited occurrence removes that occurrence from the series.
      const master = byId(ev.recurrenceId);
      if (master && !master.exdates.includes(ev.originalStart)) { master.exdates.push(ev.originalStart); C.touchItem(D(), master, now); }
    }
    const ids = [ev.id, ...events().filter((e) => e.recurrenceId === ev.id).map((e) => e.id)];
    removeWithUndo(['calendar', 'events'], ids, ev.kind === 'event' ? 'Event' : ev.kind === 'alarm' ? 'Alarm' : 'Reminder', () => onDataChanged());
  }

  function toggleDone() {
    const ev = dialog && byId(dialog.eventId);
    if (!ev) return;
    ev.done = !ev.done;
    C.touchItem(D(), ev, Date.now());
    commitData();
    closeModal('modalEvent');
    onDataChanged();
    toast(ev.done ? 'Marked done' : 'Marked not done', 'success');
  }

  // Generic multi-choice dialog. Resolves with the chosen value (or null).
  function choiceDialog({ title, message, choices }) {
    const d = el('modalChoice');
    if (!d || d.open) return Promise.resolve(null);
    el('choiceTitle').textContent = title;
    el('choiceMessage').textContent = message;
    const box = el('choiceActions');
    box.innerHTML = choices.map((c, i) => `<button type="button" class="btn ${c.primary ? 'btn-primary' : c.danger ? 'btn-danger' : 'btn-ghost'}" data-choice="${i}">${esc(c.label)}</button>`).join('');
    return new Promise((resolve) => {
      let result = null;
      box.onclick = (e) => {
        const b = e.target.closest('[data-choice]');
        if (!b) return;
        result = choices[Number(b.dataset.choice)].value;
        d.close();
      };
      d.addEventListener('close', () => resolve(result), { once: true });
      openModal('modalChoice');
      const primary = box.querySelector('.btn-primary') || box.querySelector('.btn');
      if (primary) primary.focus();
    });
  }

  // -------------------------------------------------------------------------
  // Reminders (in-app) and alarms
  // -------------------------------------------------------------------------
  function pushActive() { return !!(PF().pushDeviceId && isSignedIn()); }

  function scheduleReminders() {
    clearTimeout(timers.reminder);
    const now = Date.now();
    const rt = RT();
    const since = rt.reminderCheckedAt ? Math.max(rt.reminderCheckedAt, now - MISSED_WINDOW) : now;
    const list = K.reminderInstances(events(), since - 1000, now + 36 * 3600000);
    const fired = rt.firedReminders;
    const due = list.filter((r) => r.fireAt <= now && fired[r.key] !== r.fireAt);
    rt.reminderCheckedAt = now;
    for (const [k, t] of Object.entries(fired)) if (t < now - 3 * 86400000) delete fired[k];
    commitRuntime();
    const late = due.filter((r) => now - r.fireAt > 90000);
    due.filter((r) => !late.includes(r)).forEach((r) => fire(r, false));
    late.slice(0, 3).forEach((r) => fire(r, true));
    if (late.length > 3) toast(`${late.length - 3} more reminders were missed while ZenFlow was closed.`, 'info', '🔔');
    const next = list.find((r) => r.fireAt > now && fired[r.key] !== r.fireAt);
    timers.reminder = setTimeout(scheduleReminders, next ? Math.max(250, Math.min(next.fireAt - now + 50, 60000)) : 60000);
  }

  // Delivers one reminder exactly once across tabs (lock + shared fired map).
  async function fire(r, late) {
    const claimed = await withLock('zenflow-reminders', () => {
      refreshFromStorage();
      const fired = RT().firedReminders;
      if (fired[r.key] === r.fireAt) return false;
      fired[r.key] = r.fireAt;
      commitRuntime();
      return true;
    }).catch(() => false);
    if (!claimed) return;
    const when = r.allDay ? 'Today' : fmtTime(r.startsAt || r.fireAt);
    const body = (r.body || `${r.kind === 'alarm' ? 'Alarm' : 'Starts'} ${when}${r.location ? ' · ' + r.location : ''}`) + (late ? ' (missed)' : '');
    if (r.type === 'alarm') { showAlarm(Object.assign({}, r, { body })); return; }
    playSound(true);
    toast(`${r.title} — ${body}`, 'info', '🔔', { duration: 12000, action: { label: 'Snooze 10 min', onClick: () => snooze(r, 10) } });
    systemNotify(r, body);
  }

  function systemNotify(r, body) {
    const hidden = document.hidden || !document.hasFocus();
    if (!hidden || pushActive()) return; // push devices get the service-worker notification instead
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const n = new Notification(r.title, { body, tag: r.key, icon: 'logo.png', requireInteraction: r.type === 'alarm' });
        n.onclick = () => { window.focus(); navigate('calendar'); n.close(); };
      } catch (_) { /* some browsers only allow notifications from a service worker */ }
    }
  }

  function snooze(r, minutes) {
    const ev = byId(r.eventId);
    if (!ev) return;
    const until = Date.now() + minutes * MIN;
    ev.snoozes = Object.assign({}, ev.snoozes, { [r.key]: until });
    const entries = Object.entries(ev.snoozes).sort((a, b) => b[1] - a[1]).slice(0, 20);
    ev.snoozes = Object.fromEntries(entries);
    C.touchItem(D(), ev, Date.now());
    commitData();
    onDataChanged();
    toast(`Snoozed until ${fmtTime(until)}`, 'success');
  }

  function showAlarm(r) {
    const d = el('modalAlarm');
    if (d.open) { alarmQueue.push(r); return; }
    d.dataset.key = r.key;
    el('alarmTitle').textContent = r.title;
    el('alarmBody').textContent = r.body;
    el('alarmTime').textContent = fmtTime(Date.now());
    const ev = byId(r.eventId);
    el('alarmDone').hidden = !(ev && ev.kind === 'reminder' && !ev.rrule);
    const handler = (e) => {
      const b = e.target.closest('[data-alarm]');
      if (!b) return;
      const a = b.dataset.alarm;
      if (a === 'snooze5') snooze(r, 5);
      else if (a === 'snooze10') snooze(r, 10);
      else if (a === 'done' && ev) { ev.done = true; C.touchItem(D(), ev, Date.now()); commitData(); onDataChanged(); }
      d.close();
    };
    d.onclick = handler;
    d.addEventListener('close', () => { stopRinging(); const next = alarmQueue.shift(); if (next) setTimeout(() => showAlarm(next), 300); }, { once: true });
    openModal('modalAlarm');
    el('alarmDismiss').focus();
    startRinging();
    systemNotify(r, r.body);
  }

  function startRinging() {
    stopRinging();
    const started = Date.now();
    const ring = () => {
      if (Date.now() - started > 3 * 60000) return stopRinging();
      alarmTone();
      if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
    };
    ring();
    timers.alarm = setInterval(ring, 2500);
  }
  function stopRinging() {
    clearInterval(timers.alarm);
    timers.alarm = null;
    if (navigator.vibrate) navigator.vibrate(0);
  }
  function alarmTone() {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const play = () => {
      const vol = Math.max(0.05, D().settings.volume / 100);
      [0, 0.25, 0.5].forEach((t) => {
        const osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.type = 'square'; osc.frequency.value = 880;
        osc.connect(gain); gain.connect(ctx.destination);
        const s = ctx.currentTime + t;
        gain.gain.setValueAtTime(0, s);
        gain.gain.linearRampToValueAtTime(0.18 * vol, s + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, s + 0.18);
        osc.start(s); osc.stop(s + 0.2);
        osc.onended = () => { osc.disconnect(); gain.disconnect(); };
      });
    };
    if (ctx.state === 'suspended') ctx.resume().then(play).catch(() => {}); else play();
  }

  let askedNotifications = false;
  function askNotificationsOnce() {
    if (askedNotifications || !('Notification' in window) || Notification.permission !== 'default') return;
    askedNotifications = true;
    toast('Allow notifications to get reminders when this tab is in the background.', 'info', '🔔', {
      duration: 10000, action: { label: 'Allow', onClick: () => Notification.requestPermission().then(() => renderSettings()) }
    });
  }

  // Messages from the service worker (push while visible, notification taps).
  function onWorkerMessage(e) {
    const m = e.data || {};
    if (m.type === 'zenflow-reminder' && m.reminder) {
      const r = m.reminder;
      fire({ key: r.key, eventId: r.eventId, fireAt: Number(r.fireAt), type: r.type === 'alarm' ? 'alarm' : 'notify', title: r.title || 'Reminder', body: r.body, startsAt: Number(r.startsAt) }, false);
    } else if (m.type === 'zenflow-reminder-action' && m.reminder) {
      handleReminderAction(m.reminder.key, m.action);
    }
  }
  function handleReminderAction(key, action) {
    const p = K.parseReminderKey(key);
    if (action === 'snooze' && p) snooze({ key, eventId: p.eventId }, 10);
    else navigate('calendar');
  }

  // -------------------------------------------------------------------------
  // Server coordination (only after local changes reached the cloud)
  // -------------------------------------------------------------------------
  function onDataChanged() {
    const sig = JSON.stringify(events());
    if (lastSig !== null && sig !== lastSig) {
      pendingServer.reminders = true;
      if (events().some((e) => K.needsPush(e))) pendingServer.google = true;
    }
    lastSig = sig;
    render();
    scheduleReminders();
  }

  function flushServer() {
    clearTimeout(timers.server);
    timers.server = setTimeout(async () => {
      if (!isSignedIn() || !bridge || !bridge.call) return;
      const p = pendingServer;
      pendingServer = { reminders: false, google: false };
      try {
        if (p.google && googleStatus().connected) await bridge.call('googleSyncNow', { pushOnly: true });
        else if (p.reminders && pushActive()) await bridge.call('scheduleReminders');
        serverDown = false;
      } catch (err) {
        serverDown = true;
        log.warn('server call failed', { code: err && err.code });
        pendingServer.google = pendingServer.google || p.google;
      }
    }, 1200);
  }

  // -------------------------------------------------------------------------
  // Google Calendar actions
  // -------------------------------------------------------------------------
  function serverMessage(err) {
    const code = String((err && err.code) || '');
    if (code.includes('not-found') || code.includes('internal') || code.includes('unavailable')) return 'The sync server isn’t set up yet, or can’t be reached right now.';
    if (code.includes('permission-denied')) return (err && err.message) || 'This site isn’t allowed to connect Google Calendar.';
    if (code.includes('unauthenticated')) return 'Log in to ZenFlow first.';
    return 'Something went wrong talking to the sync server. Please try again.';
  }

  async function connectGoogle() {
    if (!isSignedIn()) { openAuthModal(); return; }
    // Open the window synchronously (popup blockers), then point it at Google.
    const popup = window.open('', 'zenflow-google', 'width=520,height=680');
    const btn = el('calConnectBtn');
    await withBusy(btn, async () => {
      try {
        const { url } = await bridge.call('googleConnectStart', { origin: location.origin });
        if (popup) popup.location.href = url; else location.href = url;
      } catch (err) {
        if (popup) popup.close();
        serverDown = true;
        toast(serverMessage(err), 'error');
        renderSidebar();
      }
    });
  }

  function onWindowMessage(e) {
    if (!/^https:\/\/[a-z0-9-]+\.cloudfunctions\.net$/.test(e.origin) || !e.data || e.data.type !== 'zenflow-google') return;
    toast(e.data.message || (e.data.ok ? 'Google Calendar connected' : 'Google Calendar was not connected'), e.data.ok ? 'success' : 'error');
    if (e.data.ok && sync) sync.syncNow();
  }

  async function syncGoogle(btn) {
    await withBusy(btn, async () => {
      try {
        await sync.syncNow();
        const res = await bridge.call('googleSyncNow', {});
        await sync.syncNow();
        toast(res && res.skipped === 'busy' ? 'A sync is already running' : 'Google Calendar synced', 'success');
      } catch (err) { toast(serverMessage(err), 'error'); }
    });
  }

  async function disconnectGoogle(btn) {
    const ok = await confirmDialog({
      title: 'Disconnect Google Calendar?',
      message: 'Google events will be removed from ZenFlow. Events you created in ZenFlow stay here, moved to the ZenFlow calendar. Nothing is deleted from Google.',
      confirmLabel: 'Disconnect', danger: true
    });
    if (!ok) return;
    await withBusy(btn, async () => {
      try { await sync.flush(8000); await bridge.call('googleDisconnect', {}); await sync.syncNow(); toast('Google Calendar disconnected', 'success'); }
      catch (err) { toast(serverMessage(err), 'error'); }
    });
  }

  function toggleGoogleCalendar(id, on) {
    const sel = new Set(D().calendar.googleSelection);
    if (on) sel.add(id); else sel.delete(id);
    C.setScalar(D(), 'calendar', 'googleSelection', [...sel], Date.now());
    commitData();
    pendingServer.google = true;
    // A full sync pulls newly selected calendars.
    clearTimeout(timers.server);
    timers.server = setTimeout(() => { sync.syncNow().then(() => bridge.call('googleSyncNow', {})).then(() => sync.syncNow()).catch((err) => toast(serverMessage(err), 'error')); }, 800);
    renderSidebar();
  }

  // -------------------------------------------------------------------------
  // Push reminders on this device
  // -------------------------------------------------------------------------
  async function enablePush(btn) {
    if (!isSignedIn()) { toast('Log in to get reminders even when ZenFlow is closed.', 'info'); openAuthModal(); return; }
    await withBusy(btn, async () => {
      const sup = await bridge.push.supported();
      if (!sup.ok) {
        toast(sup.reason === 'not-configured' ? 'Push reminders aren’t set up on this server yet. In-app reminders still work.'
          : 'This browser can’t receive push reminders. On iPhone, add ZenFlow to your Home Screen first.', 'error');
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { toast('Notifications are blocked. Allow them in your browser’s site settings.', 'error'); renderSettings(); return; }
      try {
        const reg = await navigator.serviceWorker.register('sw.js', { scope: './' });
        await navigator.serviceWorker.ready;
        const { deviceId } = await bridge.push.register(sync.uid, reg);
        PF().pushDeviceId = deviceId;
        commitPrefs();
        pendingServer.reminders = true;
        flushServer();
        toast('Push reminders are on for this device', 'success');
      } catch (err) {
        log.warn('push registration failed', { name: err && err.name, code: err && err.code });
        toast('Couldn’t turn on push reminders on this device.', 'error');
      }
    });
    renderSettings();
  }
  async function disablePush(btn) {
    await withBusy(btn, async () => {
      try { await bridge.push.unregister(sync && sync.uid, PF().pushDeviceId); } catch (_) { /* best effort */ }
      PF().pushDeviceId = '';
      commitPrefs();
    });
    renderSettings();
    toast('Push reminders are off for this device', 'info');
  }

  function renderSettings() {
    const status = el('pushStatus'), btn = el('pushBtn');
    if (el('weekStartSelect')) el('weekStartSelect').value = String(PF().weekStart);
    if (!status || !btn) return;
    const on = pushActive();
    status.textContent = on ? 'On' : isSignedIn() ? 'Off' : 'Log in required';
    status.className = 'status-pill' + (on ? ' on' : '');
    btn.textContent = on ? 'Turn off' : 'Turn on';
    btn.dataset.action = on ? 'cal-push-off' : 'cal-push-on';
  }

  // -------------------------------------------------------------------------
  // Hooks & events
  // -------------------------------------------------------------------------
  function onAuth(user) {
    if (unwatch) { unwatch(); unwatch = null; }
    if (user && bridge && bridge.watchUser) unwatch = bridge.watchUser(user.uid, (doc) => sync && sync.applyRemote(user.uid, doc));
    // Keep this device's push token fresh.
    if (user && PF().pushDeviceId && 'Notification' in window && Notification.permission === 'granted') {
      navigator.serviceWorker.getRegistration('./').then((reg) => (reg ? bridge.push.register(user.uid, reg) : null))
        .then((r) => { if (r && r.deviceId !== PF().pushDeviceId) { PF().pushDeviceId = r.deviceId; commitPrefs(); } })
        .catch(() => {});
    }
    lastSig = null;
    renderSettings();
    render();
  }
  async function beforeSignOut() {
    if (unwatch) { unwatch(); unwatch = null; }
    if (PF().pushDeviceId && bridge) { try { await bridge.push.unregister(sync.uid, PF().pushDeviceId); } catch (_) { /* offline */ } }
  }
  function onSync(s) {
    renderSidebar();
    if (s.status === 'synced' && (pendingServer.reminders || pendingServer.google)) flushServer();
  }
  function nextUpText() {
    const now = Date.now();
    const occ = K.expandAll(events(), now, now + 12 * 3600000, tz()).find((o) => !o.allDay && o.start >= now);
    return occ ? `Next: ${occ.event.title} at ${fmtTime(occ.start)}` : '';
  }

  const CAL_ACTIONS = {
    'cal-open': (ds) => openExisting(ds.id, /^\d+$/.test(ds.occ) ? Number(ds.occ) : ds.occ, Number(ds.start)),
    'cal-goto-day': (ds) => { PF().calCursor = ds.day; PF().calView = 'week'; commitPrefs(); render(); if (!narrow()) { /* week of that day */ } },
    'cal-new-day': (ds) => openNew({ day: ds.day, allDay: ds.allday === '1' }),
    'cal-google-connect': () => connectGoogle(),
    'cal-google-sync': (ds, e, b) => syncGoogle(b),
    'cal-google-disconnect': (ds, e, b) => disconnectGoogle(b),
    'cal-push-on': (ds, e, b) => enablePush(b),
    'cal-push-off': (ds, e, b) => disablePush(b),
    'ev-add-reminder': () => { const list = readReminderRows(); list.push({ offsetMin: 10, type: 'notify' }); renderReminderRows(list); },
    'ev-remove-reminder': (ds) => { const list = readReminderRows(); list.splice(Number(ds.index), 1); renderReminderRows(list); }
  };

  function onClick(e) {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const a = t.dataset.action;
    if (a === 'cal-new-slot') {
      if (e.target !== t) return;
      const rect = t.getBoundingClientRect();
      const mins = Math.max(0, Math.min(23.5 * 60, Math.round(((e.clientY - rect.top) / HOUR_PX) * 2) * 30));
      openNew({ day: t.dataset.day, startMs: dayMs(t.dataset.day) + mins * MIN });
      return;
    }
    if (a === 'cal-new-day' && e.target !== t) return; // clicks on chips/buttons inside the cell
    if (CAL_ACTIONS[a]) { e.preventDefault(); CAL_ACTIONS[a](t.dataset, e, t); }
  }
  function onChange(e) {
    const t = e.target;
    if (t.dataset.action === 'cal-toggle-visible') {
      const hidden = new Set(PF().hiddenCals);
      if (t.checked) hidden.delete(t.dataset.cal); else hidden.add(t.dataset.cal);
      PF().hiddenCals = [...hidden];
      commitPrefs();
      render();
    } else if (t.dataset.action === 'cal-google-select') toggleGoogleCalendar(t.dataset.gcal, t.checked);
  }

  function init() {
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    window.addEventListener('message', onWindowMessage);
    if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', onWorkerMessage);
    document.querySelectorAll('#evWeekdays .ev-dow').forEach((b) => b.addEventListener('click', () => {
      b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
      if (el('evRepeat').value === 'weekdays') el('evRepeat').value = 'weekly';
      onRepeat();
    }));
    ['evRepeat', 'evEnds', 'evStartDate'].forEach((id) => el(id) && el(id).addEventListener('change', onRepeat));
    el('evAllDay') && el('evAllDay').addEventListener('change', () => { renderReminderRows(readReminderRows()); onAllDay(); });
    el('evStartDate') && el('evStartDate').addEventListener('change', () => {
      if (el('evEndDate').value < el('evStartDate').value) el('evEndDate').value = el('evStartDate').value;
    });
    window.matchMedia('(max-width: 780px)').addEventListener('change', render);
    // Deep link from a notification tap: ?reminder=<key>&action=snooze|open
    const q = new URLSearchParams(location.search);
    if (q.get('reminder')) {
      const key = q.get('reminder'), action = q.get('action');
      history.replaceState(null, '', location.pathname);
      setTimeout(() => handleReminderAction(key, action), 800);
    }
    setInterval(() => { if (el('page-calendar').classList.contains('active') && effectiveView() !== 'month') render(); }, 60000);
    scheduleReminders();
  }

  window.ZenCalendarUI = {
    init, render, onDataChanged, onAuth, onSync, beforeSignOut, renderSettings, nextUpText,
    step, setView, goToday, openNew, save, removeFromDialog, toggleDone, setKind, onAllDay, onRepeat,
    setWeekStart: (v) => { PF().weekStart = v === '0' ? 0 : 1; commitPrefs(); render(); }
  };
})();
