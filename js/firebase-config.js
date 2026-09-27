// Firebase web configuration. These values are public identifiers, not
// secrets: access control is enforced by firestore.rules (keep it deployed).
export const firebaseConfig = {
  apiKey: 'AIzaSyCbN1iPFE0c3WRHlmHBZ-9WyToVYsd2YSk',
  authDomain: 'zenflow-pro.firebaseapp.com',
  projectId: 'zenflow-pro',
  storageBucket: 'zenflow-pro.firebasestorage.app',
  messagingSenderId: '674620437450',
  appId: '1:674620437450:web:bb15d0451766ac1c93d533',
  measurementId: 'G-78QE2SSXE9'
};

export const firestoreDbId = 'zenflow-db1';
export const usersCollection = 'zenflow_users';

// Cloud Functions live next to the database.
export const functionsRegion = 'asia-southeast1';

// Web Push public key ("Web Push certificates" in Firebase console →
// Project settings → Cloud Messaging). Public by design. Push reminders stay
// disabled until this is set; in-app reminders work regardless.
export const vapidKey = '';
