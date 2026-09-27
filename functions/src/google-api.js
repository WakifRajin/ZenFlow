'use strict';
// Minimal Google Calendar v3 REST client. `fetch` and `getAccessToken` are
// injected so the sync engine can be tested against a fake.
const BASE = 'https://www.googleapis.com/calendar/v3';

class GoogleApiError extends Error {
  constructor(status, message, reason) {
    super(message);
    this.name = 'GoogleApiError';
    this.status = status;
    this.reason = reason || '';
  }
}

function createGoogleApi({ fetch, getAccessToken }) {
  async function call(method, path, { query, body } = {}) {
    const token = await getAccessToken();
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const res = await fetch(url.toString(), {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (res.status === 204) return null;
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON error page */ }
    if (!res.ok) {
      const e = json && json.error;
      throw new GoogleApiError(res.status, (e && e.message) || `Google Calendar API returned ${res.status}`, e && e.errors && e.errors[0] && e.errors[0].reason);
    }
    return json;
  }
  const cal = (id) => '/calendars/' + encodeURIComponent(id);

  return {
    async listCalendars() {
      const items = [];
      let pageToken;
      do {
        const r = await call('GET', '/users/me/calendarList', { query: { maxResults: 250, pageToken } });
        items.push(...((r && r.items) || []));
        pageToken = r && r.nextPageToken;
      } while (pageToken);
      return items;
    },
    // Full listing from timeMin, or an incremental listing from syncToken.
    async listEvents(calendarId, { syncToken, timeMin, maxItems = 5000 }) {
      const items = [];
      let pageToken, nextSyncToken;
      do {
        const query = { maxResults: 250, showDeleted: true, pageToken };
        if (syncToken) query.syncToken = syncToken;
        else query.timeMin = timeMin;
        const r = await call('GET', cal(calendarId) + '/events', { query });
        items.push(...((r && r.items) || []));
        pageToken = r && r.nextPageToken;
        nextSyncToken = (r && r.nextSyncToken) || nextSyncToken;
      } while (pageToken && items.length < maxItems);
      return { items, nextSyncToken };
    },
    insertEvent: (calendarId, body) => call('POST', cal(calendarId) + '/events', { body }),
    patchEvent: (calendarId, eventId, body) => call('PATCH', cal(calendarId) + '/events/' + encodeURIComponent(eventId), { body }),
    deleteEvent: (calendarId, eventId) => call('DELETE', cal(calendarId) + '/events/' + encodeURIComponent(eventId))
  };
}

module.exports = { createGoogleApi, GoogleApiError };
