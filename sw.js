/* ZenFlow service worker: delivers reminder push messages.
 *
 * Deliberately does no fetch caching (no stale-app risk). Push payloads are
 * FCM data messages: { data: { key, title, body, type, eventId, fireAt } }.
 * If a ZenFlow window is visible, the reminder is handed to it (it shows the
 * in-app alert and dedupes by key); otherwise a system notification is shown.
 */
'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function readPayload(event) {
  try {
    const json = event.data ? event.data.json() : {};
    return json.data || json;
  } catch (_) {
    return { title: 'ZenFlow reminder', body: event.data ? event.data.text() : '' };
  }
}

self.addEventListener('push', (event) => {
  const d = readPayload(event);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visible = windows.filter((c) => c.visibilityState === 'visible');
    if (visible.length) {
      visible.forEach((c) => c.postMessage({ type: 'zenflow-reminder', reminder: d }));
      return;
    }
    const alarm = d.type === 'alarm';
    await self.registration.showNotification(d.title || 'ZenFlow reminder', {
      body: d.body || '',
      tag: d.key || undefined,               // one notification per reminder instance
      renotify: true,
      requireInteraction: alarm,
      vibrate: alarm ? [400, 200, 400, 200, 400] : [200],
      icon: 'logo.png',
      badge: 'logo.png',
      data: d,
      actions: [
        { action: 'snooze', title: 'Snooze 10 min' },
        { action: 'dismiss', title: 'Dismiss' }
      ]
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  const d = event.notification.data || {};
  event.notification.close();
  if (event.action === 'dismiss') return;
  const action = event.action === 'snooze' ? 'snooze' : 'open';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const scope = self.registration.scope;
    const target = windows.find((c) => c.url.startsWith(scope)) || null;
    if (target) {
      target.postMessage({ type: 'zenflow-reminder-action', action, reminder: d });
      return target.focus();
    }
    const url = new URL(scope);
    url.searchParams.set('reminder', d.key || '');
    url.searchParams.set('action', action);
    return self.clients.openWindow(url.toString());
  })());
});
