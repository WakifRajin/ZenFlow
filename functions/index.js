'use strict';
/*
 * ZenFlow Cloud Functions (region asia-southeast1, next to the Firestore
 * database zenflow-db1). Thin Firebase glue around tested modules in src/.
 *
 * Collections (server-only unless noted)
 *   zenflow_users/{uid}            user doc; `data` is client-owned, `google` server-owned
 *   zenflow_users/{uid}/devices/*  push tokens (client-writable)
 *   zenflow_google/{uid}           refresh token, sync state, lease
 *   zenflow_reminders/{id}         pending reminder deliveries (deleted when sent)
 *   zenflow_reminder_users/{uid}   planning horizon per user
 *
 * Configuration (see docs/calendar-setup.md)
 *   GOOGLE_CLIENT_ID   param   OAuth web client id
 *   GOOGLE_CLIENT_SECRET secret OAuth client secret
 *   APP_ORIGINS        param   comma-separated origins allowed to start OAuth
 */
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const logger = require('firebase-functions/logger');
const { defineSecret, defineString } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

const C = require('./shared/core.js');
const K = require('./shared/calendar-core.js');
const { createGoogleApi } = require('./src/google-api.js');
const { createGoogleSync } = require('./src/google-sync.js');
const { createReminderPlanner } = require('./src/reminders.js');
const OAuth = require('./src/oauth.js');

const REGION = 'asia-southeast1';
setGlobalOptions({ region: REGION, maxInstances: 5 });

const GOOGLE_CLIENT_ID = defineString('GOOGLE_CLIENT_ID');
const GOOGLE_CLIENT_SECRET = defineSecret('GOOGLE_CLIENT_SECRET');
const APP_ORIGINS = defineString('APP_ORIGINS', { default: 'http://localhost:8765' });

const app = initializeApp();
const db = getFirestore(app, 'zenflow-db1');
const users = db.collection('zenflow_users');
const googleCol = db.collection('zenflow_google');
const reminderCol = db.collection('zenflow_reminders');
const horizonCol = db.collection('zenflow_reminder_users');
const planner = createReminderPlanner({ C, K });

const projectId = () => process.env.GCLOUD_PROJECT || (JSON.parse(process.env.FIREBASE_CONFIG || '{}').projectId);
const redirectUri = () => `https://${REGION}-${projectId()}.cloudfunctions.net/googleOAuthCallback`;
const allowedOrigins = () => APP_ORIGINS.value().split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
const requireAuth = (req) => { if (!req.auth) throw new HttpsError('unauthenticated', 'Log in to ZenFlow first.'); return req.auth.uid; };
const LEASE_MS = 120000;

// ---------------------------------------------------------------------------
// User document: server changes use the same transactional merge as clients.
// ---------------------------------------------------------------------------
async function writeUserData(uid, mutate) {
  const ref = users.doc(uid);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const doc = snap.exists ? snap.data() : {};
    const current = C.dataFromRemoteDoc(doc, Date.now()) || C.defaultData();
    const result = mutate(JSON.parse(JSON.stringify(current)), doc);
    const data = C.merge(current, C.sanitizeData(result.data), Date.now());
    C.assertCloudSize(data);
    const out = { schemaVersion: C.SCHEMA_VERSION, data, updatedAt: FieldValue.serverTimestamp() };
    if (doc.profile) out.profile = doc.profile;
    out.google = result.google !== undefined ? result.google : (doc.google === undefined ? null : doc.google);
    tx.set(ref, out);
    return data;
  });
}
async function readUserData(uid) {
  const snap = await users.doc(uid).get();
  const doc = snap.exists ? snap.data() : {};
  return { doc, data: C.dataFromRemoteDoc(doc, Date.now()) || C.defaultData() };
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------
async function scheduleFor(uid) {
  const now = Date.now();
  const { data } = await readUserData(uid);
  const desired = planner.plan(uid, data, now);
  const existing = (await reminderCol.where('uid', '==', uid).get()).docs.map((d) => Object.assign({ id: d.id }, d.data()));
  const { upserts, deletes } = planner.diff(existing, desired);
  const ops = [...upserts.map((d) => ['set', d]), ...deletes.map((id) => ['delete', id])];
  for (let i = 0; i < ops.length; i += 400) {
    const batch = db.batch();
    for (const [op, v] of ops.slice(i, i + 400)) {
      if (op === 'set') { const { id, ...rest } = v; batch.set(reminderCol.doc(id), rest); }
      else batch.delete(reminderCol.doc(v));
    }
    await batch.commit();
  }
  await horizonCol.doc(uid).set({ horizon: now + planner.HORIZON_MS, updatedAt: now });
  return { scheduled: desired.length, changed: ops.length };
}

async function deviceTokens(uid) {
  const snap = await users.doc(uid).collection('devices').get();
  return snap.docs.map((d) => ({ ref: d.ref, token: d.data().token })).filter((d) => typeof d.token === 'string' && d.token);
}

async function deliverDue() {
  const now = Date.now();
  const due = await reminderCol.where('fireAt', '<=', now + 15000).orderBy('fireAt').limit(300).get();
  const tokenCache = new Map();
  let sent = 0;
  for (const doc of due.docs) {
    // Claim by deleting inside a transaction: exactly-once even if runs overlap.
    const rem = await db.runTransaction(async (tx) => {
      const s = await tx.get(doc.ref);
      if (!s.exists) return null;
      tx.delete(doc.ref);
      return s.data();
    });
    if (!rem || planner.tooLate(rem, now)) continue;
    if (!tokenCache.has(rem.uid)) tokenCache.set(rem.uid, await deviceTokens(rem.uid));
    const devices = tokenCache.get(rem.uid);
    if (!devices.length) continue;
    const res = await getMessaging().sendEachForMulticast({
      tokens: devices.map((d) => d.token),
      data: planner.message(rem, now),
      webpush: { headers: { Urgency: 'high', TTL: '900' } }
    });
    res.responses.forEach((r, i) => {
      const code = r.error && r.error.code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        devices[i].ref.delete().catch(() => {});
      }
    });
    sent += res.successCount;
  }
  if (due.size) logger.info('reminders delivered', { due: due.size, sent });
}

// ---------------------------------------------------------------------------
// Google sync
// ---------------------------------------------------------------------------
async function runGoogleSync(uid, { pushOnly = false } = {}) {
  const gref = googleCol.doc(uid);
  const lease = await db.runTransaction(async (tx) => {
    const s = await tx.get(gref);
    if (!s.exists || !s.data().refreshToken || !s.data().connected) return { skip: 'not-connected' };
    if ((s.data().lockUntil || 0) > Date.now()) return { skip: 'busy' };
    tx.update(gref, { lockUntil: Date.now() + LEASE_MS });
    return { account: s.data() };
  });
  if (lease.skip) return { skipped: lease.skip };
  const account = lease.account;
  try {
    const { data, doc } = await readUserData(uid);
    const api = createGoogleApi({
      fetch,
      getAccessToken: OAuth.createTokenSource({ fetch, clientId: GOOGLE_CLIENT_ID.value(), clientSecret: GOOGLE_CLIENT_SECRET.value(), refreshToken: account.refreshToken })
    });
    const engine = createGoogleSync({ C, K, api, log: (m, c) => logger.info(m, Object.assign({ uid }, c)) });
    let res;
    try {
      res = await engine.syncAccount({ data, state: account.state || {}, pushOnly });
    } catch (e) {
      const reauth = e.code === 'invalid_grant' || e.status === 401;
      logger.warn('google sync failed', { uid, code: e.code, status: e.status });
      const prev = C.sanitizeGoogleStatus(doc.google);
      const status = Object.assign({}, prev, {
        connected: !reauth, email: account.email || prev.email,
        error: { code: reauth ? 'reauth' : 'sync-failed', message: reauth ? 'Google access expired. Connect Google Calendar again.' : 'Google Calendar sync failed; retrying.' }
      });
      await users.doc(uid).set({ google: status }, { merge: true });
      if (reauth) await gref.update({ connected: false });
      return { error: status.error.code };
    }
    await writeUserData(uid, () => ({ data: res.data, google: Object.assign({ email: account.email || '' }, res.status) }));
    await gref.update({ state: res.state, lastSyncAt: Date.now() });
    await scheduleFor(uid);
    return res.stats;
  } finally {
    await gref.update({ lockUntil: 0 }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Callable API
// ---------------------------------------------------------------------------
exports.googleConnectStart = onCall({ secrets: [GOOGLE_CLIENT_SECRET] }, async (req) => {
  const uid = requireAuth(req);
  const origin = String((req.data && req.data.origin) || '').replace(/\/+$/, '');
  if (!allowedOrigins().includes(origin)) throw new HttpsError('permission-denied', 'This site is not allowed to connect Google Calendar.');
  const state = OAuth.signState({ uid, origin }, GOOGLE_CLIENT_SECRET.value());
  return { url: OAuth.authUrl({ clientId: GOOGLE_CLIENT_ID.value(), redirectUri: redirectUri(), state, loginHint: req.auth.token.email }) };
});

exports.googleSyncNow = onCall({ secrets: [GOOGLE_CLIENT_SECRET], timeoutSeconds: 120 }, async (req) => {
  const uid = requireAuth(req);
  return runGoogleSync(uid, { pushOnly: !!(req.data && req.data.pushOnly) });
});

exports.googleDisconnect = onCall({ secrets: [GOOGLE_CLIENT_SECRET] }, async (req) => {
  const uid = requireAuth(req);
  const s = await googleCol.doc(uid).get();
  if (s.exists && s.data().refreshToken) await OAuth.revoke({ fetch, token: s.data().refreshToken });
  await googleCol.doc(uid).delete();
  await writeUserData(uid, (data) => {
    const now = Date.now();
    for (const ev of data.calendar.events.slice()) {
      if (ev.source === 'google') C.removeItem(data, ['calendar', 'events'], ev.id, now);
      else if (ev.cal !== 'local') { ev.cal = 'local'; ev.google = null; C.touchItem(data, ev, now); }
    }
    return { data, google: { connected: false, email: '', calendars: [], lastSyncAt: 0, error: null } };
  });
  await scheduleFor(uid);
  return { ok: true };
});

exports.scheduleReminders = onCall(async (req) => scheduleFor(requireAuth(req)));

// ---------------------------------------------------------------------------
// OAuth redirect target
// ---------------------------------------------------------------------------
function resultPage(res, status, { ok, message, origin }) {
  const payload = JSON.stringify({ type: 'zenflow-google', ok, message }).replace(/</g, '\\u003c');
  const target = JSON.stringify(origin || '').replace(/</g, '\\u003c');
  const text = String(message).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  res.set('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'");
  res.set('Cache-Control', 'no-store');
  res.status(status).send(`<!doctype html><meta charset="utf-8"><title>ZenFlow</title>
<body style="font:15px system-ui;padding:32px;background:#0b0b10;color:#ececf3"><p>${text}</p><p>You can close this window.</p>
<script>try{if(window.opener&&${target})window.opener.postMessage(${payload},${target});}catch(e){}setTimeout(function(){window.close()},${ok ? 600 : 4000});</script></body>`);
}

exports.googleOAuthCallback = onRequest({ secrets: [GOOGLE_CLIENT_SECRET], timeoutSeconds: 120 }, async (req, res) => {
  let payload;
  try {
    payload = OAuth.verifyState(req.query.state, GOOGLE_CLIENT_SECRET.value());
  } catch (e) {
    return resultPage(res, 400, { ok: false, message: e.message || 'Invalid request.' });
  }
  const origin = allowedOrigins().includes(payload.origin) ? payload.origin : '';
  if (req.query.error) return resultPage(res, 200, { ok: false, origin, message: req.query.error === 'access_denied' ? 'Google Calendar was not connected.' : 'Google sign-in failed.' });
  try {
    const t = await OAuth.exchangeCode({ fetch, code: String(req.query.code || ''), clientId: GOOGLE_CLIENT_ID.value(), clientSecret: GOOGLE_CLIENT_SECRET.value(), redirectUri: redirectUri() });
    const email = OAuth.emailFromIdToken(t.id_token);
    await googleCol.doc(payload.uid).set({ refreshToken: t.refresh_token, email, connected: true, connectedAt: Date.now(), state: {}, lockUntil: 0 });
    await users.doc(payload.uid).set({ google: { connected: true, email, calendars: [], lastSyncAt: 0, error: null } }, { merge: true });
    await runGoogleSync(payload.uid);
    return resultPage(res, 200, { ok: true, origin, message: `Connected ${email || 'Google Calendar'}.` });
  } catch (e) {
    logger.error('oauth callback failed', { uid: payload.uid, code: e.code });
    return resultPage(res, 200, { ok: false, origin, message: e instanceof OAuth.OAuthError ? e.message : 'Could not connect Google Calendar. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Background jobs
// ---------------------------------------------------------------------------
exports.deliverReminders = onSchedule({ schedule: 'every 1 minutes', timeoutSeconds: 60 }, deliverDue);

exports.refreshReminderHorizons = onSchedule({ schedule: 'every 60 minutes', timeoutSeconds: 300 }, async () => {
  const due = await horizonCol.where('horizon', '<=', Date.now() + 24 * 3600000).limit(200).get();
  for (const d of due.docs) await scheduleFor(d.id).catch((e) => logger.warn('reminder refresh failed', { uid: d.id, message: e.message }));
});

exports.syncGoogleCalendars = onSchedule({ schedule: 'every 5 minutes', timeoutSeconds: 300, secrets: [GOOGLE_CLIENT_SECRET] }, async () => {
  const started = Date.now();
  const accounts = await googleCol.where('connected', '==', true).limit(100).get();
  for (const d of accounts.docs) {
    if (Date.now() - started > 240000) break; // leave headroom before the timeout
    await runGoogleSync(d.id).catch((e) => logger.warn('scheduled sync failed', { uid: d.id, message: e.message }));
  }
});
