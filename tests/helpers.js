'use strict';
const C = require('../js/core.js');
const S = require('../js/sync.js');

class MemoryStorage {
  constructor() { this.map = new Map(); this.quota = Infinity; this.writes = 0; }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) {
    v = String(v);
    let size = v.length;
    for (const [key, val] of this.map) if (key !== k) size += val.length;
    if (size > this.quota) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
    this.map.set(k, v);
    this.writes++;
  }
  removeItem(k) { this.map.delete(k); }
}

const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// Firestore stand-in with transaction semantics: build() runs against the
// current document and the result is written atomically. Calls can be gated
// (held until released), delayed, or failed as if offline.
function fakeBackend() {
  const docs = new Map();
  const b = {
    docs,
    offline: false,
    hang: false,
    calls: 0,
    gates: [],
    signedOut: 0,
    async syncDocument(uid, build) {
      b.calls++;
      if (b.hang) return new Promise(() => {});
      if (b.gates.length) await b.gates.shift();
      if (b.offline) { const e = new Error('offline'); e.code = 'unavailable'; throw e; }
      const out = build(clone(docs.get(uid) ?? null));
      docs.set(uid, clone(out.doc));
      return out;
    },
    async saveProfile(uid, profile) { docs.set(uid, Object.assign(clone(docs.get(uid)) || {}, { profile })); },
    async deleteUserData(uid) { docs.delete(uid); },
    async signOut() { b.signedOut++; },
    gate() { let release; b.gates.push(new Promise((r) => { release = r; })); return () => release(); }
  };
  return b;
}

const live = [];
function disposeAll() { while (live.length) live.pop().dispose(); }

function setup(opts = {}) {
  const storage = opts.storage || new MemoryStorage();
  const backend = opts.backend || fakeBackend();
  const errors = [];
  const store = S.createLocalStore({ core: C, storage, onError: (e) => errors.push(e) });
  store.boot();
  const events = [];
  const sync = S.createSyncController({
    core: C, bridge: backend, store,
    debounceMs: 1, timeoutMs: opts.timeoutMs || 200, backoff: opts.backoff || [20, 40],
    confirmGuestMerge: opts.confirmGuestMerge || (async () => false),
    onChange: (s) => events.push(s.status),
    onDataApplied: (why) => events.push('applied:' + why)
  });
  live.push(sync);
  return { storage, backend, store, sync, errors, events };
}

function addTodo(store, id, text, now = Date.now()) {
  store.data.todos.items.unshift({ id, text, note: '', due: '', listId: 'inbox', priority: 'none', tags: [], pomos: 1, completed: false, createdAt: now, updatedAt: now, subtasks: [] });
  store.save();
}
const todoIds = (d) => d.todos.items.map((t) => t.id).sort();
const remoteData = (backend, uid) => C.dataFromRemoteDoc(backend.docs.get(uid), Date.now());

module.exports = { disposeAll, C, S, MemoryStorage, fakeBackend, setup, addTodo, todoIds, remoteData, clone, tick };
