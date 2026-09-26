// Firebase bridge (ES module). Exposes a narrow, documented interface to the
// classic app script as window.ZenFlowFirebase and announces readiness with a
// 'zenflow-firebase-ready' event. The SDK version is pinned.
//
// Contract:
//   onAuth(cb)                    cb({uid,email}|null); returns unsubscribe
//   signUp/signIn(email, pw)      resolve on success, reject with Firebase error
//   signOut(), sendPasswordReset(email)
//   saveProfile(uid, {nickname})  merge-writes the profile field only
//   syncDocument(uid, build)      runs a transaction: build(remoteDocOrNull)
//                                 -> {doc, ...}; doc is written atomically
//                                 (full replace) and the build result returned.
//                                 build() may run several times; it must be pure.
//   deleteUserData(uid)
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-app.js';
import { getAnalytics, isSupported } from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-analytics.js';
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut as firebaseSignOut, onAuthStateChanged, sendPasswordResetEmail
} from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-auth.js';
import {
  getFirestore, doc, setDoc, deleteDoc, runTransaction, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js';
import { firebaseConfig, firestoreDbId, usersCollection } from './firebase-config.js';

for (const k of ['apiKey', 'authDomain', 'projectId', 'appId']) {
  if (!firebaseConfig[k]) throw new Error(`ZenFlow: firebase-config.js is missing "${k}"`);
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app, firestoreDbId);
const userDoc = (uid) => doc(db, usersCollection, uid);

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
  deleteUserData: (uid) => deleteDoc(userDoc(uid))
});

window.dispatchEvent(new Event('zenflow-firebase-ready'));

isSupported().then((ok) => { if (ok) getAnalytics(app); }).catch(() => {
  // Analytics is optional and unavailable in some contexts (file://, blockers).
});
