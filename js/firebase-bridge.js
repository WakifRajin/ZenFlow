// Firebase bridge (ES module). Exposes a narrow, documented interface to the
// classic app scripts as window.ZenFlowFirebase and announces readiness with a
// 'zenflow-firebase-ready' event. The SDK version is pinned.
//
// Contract:
//   onAuth(cb)                    cb({uid,email}|null); returns unsubscribe
//   signUp/signIn(email, pw)      resolve on success, reject with Firebase error
//   signOut(), sendPasswordReset(email)
//   saveProfile(uid, {nickname})  merge-writes the profile field only
//   syncDocument(uid, build)      transaction: build(remoteDocOrNull) -> {doc, ...};
//                                 doc is written atomically (full replace).
//                                 build() may run several times; it must be pure.
//   deleteUserData(uid)
//   watchUser(uid, cb)            cb(doc) on server-confirmed changes; returns unsubscribe
//   call(name, data)              invoke a Cloud Function (region from config)
//   push.supported()              -> Promise<{ok, reason}>
//   push.register(uid, swReg)     -> Promise<{deviceId, token}>
//   push.unregister(uid, deviceId)
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-app.js';
import { getAnalytics, isSupported } from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-analytics.js';
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut as firebaseSignOut, onAuthStateChanged, sendPasswordResetEmail
} from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-auth.js';
import {
  getFirestore, doc, setDoc, deleteDoc, runTransaction, serverTimestamp, onSnapshot
} from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js';
import { getMessaging, getToken, deleteToken, isSupported as messagingSupported } from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-messaging.js';
import { firebaseConfig, firestoreDbId, usersCollection, functionsRegion, vapidKey } from './firebase-config.js?v=2.2.0';

for (const k of ['apiKey', 'authDomain', 'projectId', 'appId']) {
  if (!firebaseConfig[k]) throw new Error(`ZenFlow: firebase-config.js is missing "${k}"`);
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app, firestoreDbId);
const functions = getFunctions(app, functionsRegion);
const userDoc = (uid) => doc(db, usersCollection, uid);

async function deviceIdFor(token) {
  const bytes = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash).slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

window.ZenFlowFirebase = Object.freeze({
  onAuth(callback) {
    return onAuthStateChanged(auth, (user) => callback(user ? { uid: user.uid, email: user.email || '' } : null));
  },
  signUp: (email, password) => createUserWithEmailAndPassword(auth, email, password),
  signIn: (email, password) => signInWithEmailAndPassword(auth, email, password),
  signOut: () => firebaseSignOut(auth),
  sendPasswordReset: (email) => sendPasswordResetEmail(auth, email),
  saveProfile: (uid, profile) => setDoc(userDoc(uid), { profile, updatedAt: serverTimestamp() }, { merge: true }),
  syncDocument(uid, build) {
    return runTransaction(db, async (tx) => {
      const ref = userDoc(uid);
      const snap = await tx.get(ref);
      const out = build(snap.exists() ? snap.data() : null);
      tx.set(ref, { ...out.doc, updatedAt: serverTimestamp() });
      return out;
    }, { maxAttempts: 5 });
  },
  deleteUserData: (uid) => deleteDoc(userDoc(uid)),
  watchUser(uid, callback) {
    return onSnapshot(userDoc(uid), (snap) => {
      if (snap.metadata.hasPendingWrites) return; // our own write, not yet confirmed
      callback(snap.exists() ? snap.data() : null);
    }, () => { /* listener errors are non-fatal; regular sync still runs */ });
  },
  async call(name, data) {
    const res = await httpsCallable(functions, name, { timeout: 120000 })(data || {});
    return res.data;
  },
  push: Object.freeze({
    async supported() {
      if (!vapidKey) return { ok: false, reason: 'not-configured' };
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return { ok: false, reason: 'unsupported' };
      try { if (!(await messagingSupported())) return { ok: false, reason: 'unsupported' }; } catch (_) { return { ok: false, reason: 'unsupported' }; }
      return { ok: true };
    },
    async register(uid, serviceWorkerRegistration) {
      const token = await getToken(getMessaging(app), { vapidKey, serviceWorkerRegistration });
      if (!token) throw new Error('No push token');
      const deviceId = await deviceIdFor(token);
      await setDoc(doc(db, usersCollection, uid, 'devices', deviceId), {
        token, platform: String(navigator.userAgent || '').slice(0, 200), updatedAt: Date.now()
      });
      return { deviceId, token };
    },
    async unregister(uid, deviceId) {
      try { await deleteToken(getMessaging(app)); } catch (_) { /* token may already be gone */ }
      if (uid && deviceId) await deleteDoc(doc(db, usersCollection, uid, 'devices', deviceId));
    }
  })
});

window.dispatchEvent(new Event('zenflow-firebase-ready'));

isSupported().then((ok) => { if (ok) getAnalytics(app); }).catch(() => {
  // Analytics is optional and unavailable in some contexts (file://, blockers).
});
