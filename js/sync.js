/*
 * ZenFlow sync — local persistence and cloud sync orchestration.
 *
 * Ownership model
 *  - LocalStore owns the device copy. One blob per namespace ("guest" or
 *    "u_<uid>") so accounts on a shared device never see each other's data.
 *    A blob = { data (synced), runtime (device-local timers), prefs (UI) }.
 *    Writes are a single setItem, so data and runtime change atomically.
 *  - SyncController owns the cloud relationship for the signed-in user. It is
 *    an explicit state machine:
 *        signed-out -> loading -> synced <-> syncing
 *                         \          \-> error (retry with backoff) -> syncing
 *    Every sync is a read-merge-write transaction (never "remote overwrites
 *    local"), at most one runs at a time, changes made during a sync mark the
 *    state dirty and trigger another pass, and every async step checks a
 *    generation counter so results for a previous account are discarded.
 *
 * Dependencies are injected (storage, backend bridge, clock, timers) so the
 * whole module is testable under Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ZenSync = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Logger: console output + in-memory ring buffer for diagnostics.
  // Never log emails, passwords, tokens or user content.
  // ---------------------------------------------------------------------------
  function createLogger(scope, opts) {
    opts = opts || {};
    const sink = opts.sink === undefined ? (typeof console !== 'undefined' ? console : null) : opts.sink;
    const ring = opts.ring || [];
    const max = opts.max || 200;
    function push(level, msg, ctx) {
      const e = { t: new Date().toISOString(), level, scope, msg };
      if (ctx !== undefined) e.ctx = ctx;
      ring.push(e);
      if (ring.length > max) ring.shift();
      if (sink) {
        const fn = level === 'error' ? sink.error : level === 'warn' ? sink.warn : sink.info;
        if (fn) fn.call(sink, `[ZenFlow:${scope}] ${msg}`, ctx === undefined ? '' : ctx);
      }
    }
    return {
      info: (m, c) => push('info', m, c),
      warn: (m, c) => push('warn', m, c),
      error: (m, c) => push('error', m, c),
      child: (s) => createLogger(s, { sink, ring, max }),
      events: () => ring.slice()
    };
  }

  function errCode(err) {
    if (!err) return 'unknown';
    const c = err.code || err.name || '';
    return String(c).replace(/^firestore\//, '') || 'unknown';
  }

  function withTimeout(promise, ms, timers, C) {
    let t;
    Promise.resolve(promise).catch(() => {}); // the loser of the race must not surface as unhandled
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        t = timers.setTimeout(() => reject(new C.ZenError('zenflow/timeout', `Timed out after ${ms} ms`)), ms);
      })
    ]).finally(() => timers.clearTimeout(t));
  }

  // ---------------------------------------------------------------------------
  // LocalStore
  // ---------------------------------------------------------------------------
  const NS_RE = /^(guest|u_[A-Za-z0-9_-]{1,128})$/;

  function createLocalStore(opts) {
    const C = opts.core;
    const storage = opts.storage;
    const log = opts.log || createLogger('store', { sink: null });
    const now = opts.now || Date.now;
    const onError = opts.onError || (() => {});
    const prefix = opts.prefix || 'zf_';
    const ACTIVE_KEY = prefix + 'v2_active';
    const LEGACY_STATE_KEY = prefix + 'state';
    const LEGACY_STATS_KEY = prefix + 'daily_stats';
    const nsKey = (ns) => prefix + 'v2_' + ns;

    let ns = 'guest';
    let blob = null;
    let lastError = null;

    function freshBlob(origin) {
      return { v: 2, replica: C.newId('r'), origin: origin || '', data: C.defaultData(), runtime: C.defaultRuntime(), prefs: C.defaultPrefs() };
    }

    function normalize(o) {
      if (!o || typeof o !== 'object') return null;
      let data;
      try { data = C.sanitizeData(o.data); } catch (_) { data = C.defaultData(); }
      return {
        v: 2,
        replica: C.isValidId(o.replica) ? o.replica : C.newId('r'),
        origin: o.origin === 'legacy' ? 'legacy' : '',
        data,
        runtime: C.sanitizeRuntime(o.runtime),
        prefs: C.sanitizePrefs(o.prefs)
      };
    }

    function safeGet(key) {
      try { return storage.getItem(key); } catch (e) { log.error('storage read failed', { key, name: e && e.name }); return null; }
    }

    function readBlob(n) {
      const raw = safeGet(nsKey(n));
      if (raw == null) return null;
      try {
        return normalize(JSON.parse(raw));
      } catch (e) {
        log.error('local data unreadable; starting empty for this namespace', { ns: n });
        return null;
      }
    }

    function writeBlob(n, b) {
      try {
        storage.setItem(nsKey(n), JSON.stringify(b));
        if (lastError) log.info('local save recovered');
        lastError = null;
        return true;
      } catch (e) {
        lastError = e;
        log.error('local save failed', { ns: n, name: e && e.name });
        onError(e);
        return false;
      }
    }

    // v1 kept one global blob (zf_state) + zf_daily_stats. Move it into the
    // guest namespace once; the v1 keys are only removed after the v2 copy
    // has been written successfully.
    function migrateLegacyKeys() {
      const rawState = safeGet(LEGACY_STATE_KEY);
      if (rawState == null) return;
      let state = null, stats = null;
      try { state = JSON.parse(rawState); } catch (_) { log.warn('legacy state unreadable'); }
      try { stats = JSON.parse(safeGet(LEGACY_STATS_KEY) || 'null'); } catch (_) { log.warn('legacy stats unreadable'); }
      const legacyData = C.migrateLegacy(state, stats, 0);
      const guest = readBlob('guest') || freshBlob('legacy');
      guest.data = C.merge(guest.data, legacyData, now());
      if (C.hasMeaningfulData(legacyData)) guest.origin = 'legacy';
      if (state && state.settings && typeof state.settings === 'object') {
        const p = C.sanitizePrefs({ ambient: state.settings.ambient, ambientPlaying: state.settings.ambientPlaying });
        guest.prefs.ambient = p.ambient;
        guest.prefs.ambientPlaying = p.ambientPlaying;
      }
      if (writeBlob('guest', guest)) {
        try { storage.removeItem(LEGACY_STATE_KEY); storage.removeItem(LEGACY_STATS_KEY); } catch (_) { /* best effort */ }
        log.info('migrated v1 local data to v2 guest namespace');
      }
    }

    function switchTo(next) {
      if (!NS_RE.test(next)) throw new C.ZenError('invalid-namespace', 'Invalid namespace');
      ns = next;
      blob = readBlob(ns) || freshBlob();
      try { storage.setItem(ACTIVE_KEY, ns); } catch (_) { /* surfaced on next save */ }
      log.info('namespace active', { ns: ns === 'guest' ? 'guest' : 'user' });
    }

    function boot() {
      migrateLegacyKeys();
      const active = safeGet(ACTIVE_KEY);
      switchTo(active && NS_RE.test(active) ? active : 'guest');
    }

    // Another tab wrote our namespace. Merge its data (never drop ours), adopt
    // its runtime if newer, and write back only if we hold something it lacks.
    function applyExternal(key, newValue) {
      if (key !== nsKey(ns) || newValue == null || !blob) return null;
      let incoming;
      try { incoming = normalize(JSON.parse(newValue)); } catch (_) { return null; }
      if (!incoming) return null;
      const before = JSON.stringify(blob.data);
      const merged = C.merge(blob.data, incoming.data, now());
      const mergedStr = JSON.stringify(merged);
      const dataChanged = mergedStr !== before;
      blob.data = merged;
      let runtimeChanged = false;
      if (incoming.runtime.rev > blob.runtime.rev) {
        blob.runtime = incoming.runtime;
        runtimeChanged = true;
      }
      if (mergedStr !== JSON.stringify(incoming.data)) writeBlob(ns, blob);
      return { dataChanged, runtimeChanged };
    }

    function clearAll() {
      const keys = [];
      try {
        for (let i = 0; i < storage.length; i++) {
          const k = storage.key(i);
          if (k && k.startsWith(prefix)) keys.push(k);
        }
        keys.forEach((k) => storage.removeItem(k));
      } catch (e) {
        log.error('clear failed', { name: e && e.name });
        return false;
      }
      return true;
    }

    return {
      boot,
      switchTo,
      save: () => writeBlob(ns, blob),
      get namespace() { return ns; },
      get data() { return blob.data; },
      get runtime() { return blob.runtime; },
      get prefs() { return blob.prefs; },
      get replica() { return blob.replica; },
      get origin() { return blob.origin; },
      get lastError() { return lastError; },
      replaceData(d) { blob.data = d; },
      touchRuntime() { blob.runtime.rev = Math.max(now(), blob.runtime.rev + 1); },
      readNamespace: (n) => (n === ns ? blob : readBlob(n)),
      removeNamespace(n) {
        try { storage.removeItem(nsKey(n)); } catch (_) { /* ignore */ }
        if (n === ns) blob = freshBlob();
      },
      applyExternal,
      clearAll,
      keyFor: nsKey
    };
  }

  // ---------------------------------------------------------------------------
  // SyncController
  // ---------------------------------------------------------------------------
  const RETRYABLE = new Set(['unavailable', 'deadline-exceeded', 'aborted', 'internal', 'unknown',
    'resource-exhausted', 'cancelled', 'zenflow/timeout', 'network-request-failed', 'auth/network-request-failed']);

  function createSyncController(opts) {
    const C = opts.core;
    const bridge = opts.bridge;
    const store = opts.store;
    const log = opts.log || createLogger('sync', { sink: null });
    const now = opts.now || Date.now;
    const timers = opts.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) };
    const debounceMs = opts.debounceMs == null ? 350 : opts.debounceMs;
    const timeoutMs = opts.timeoutMs || 15000;
    const backoff = opts.backoff || [2000, 4000, 8000, 16000, 32000, 60000];
    const onChange = opts.onChange || (() => {});
    const onDataApplied = opts.onDataApplied || (() => {});
    const confirmGuestMerge = opts.confirmGuestMerge || (async () => false);

    const st = {
      status: 'signed-out', uid: null, email: '', profile: null,
      gen: 0, dirty: false, running: null, runningGen: -1, debounce: null, retry: null, attempt: 0,
      lastSyncedAt: null, lastError: null, nextRetryAt: null
    };

    function snapshot() {
      return {
        status: st.status, uid: st.uid, email: st.email,
        nickname: (st.profile && st.profile.nickname) || '',
        lastSyncedAt: st.lastSyncedAt, lastError: st.lastError, nextRetryAt: st.nextRetryAt,
        pending: st.dirty || !!st.running
      };
    }
    function setStatus(s) {
      if (st.status !== s) log.info('state', { from: st.status, to: s });
      st.status = s;
      onChange(snapshot());
    }
    function clearTimers() {
      if (st.debounce) { timers.clearTimeout(st.debounce); st.debounce = null; }
      if (st.retry) { timers.clearTimeout(st.retry); st.retry = null; }
      st.nextRetryAt = null;
    }

    // Pure (may run several times inside a transaction).
    function buildDoc(local, remoteDoc) {
      const remoteData = C.dataFromRemoteDoc(remoteDoc, now());
      const merged = C.merge(local, remoteData || local, now());
      const bytes = C.assertCloudSize(merged);
      const doc = { schemaVersion: C.SCHEMA_VERSION, data: merged };
      const profile = remoteDoc && remoteDoc.profile && typeof remoteDoc.profile === 'object' ? remoteDoc.profile : null;
      if (profile) doc.profile = profile;
      return { doc, data: merged, profile, bytes };
    }

    function fail(err, gen) {
      const code = errCode(err);
      const retryable = RETRYABLE.has(code);
      st.lastError = { code, message: (err && err.message) || code };
      log.warn('sync failed', { code, attempt: st.attempt + 1, retryable });
      if (retryable) {
        const delay = backoff[Math.min(st.attempt, backoff.length - 1)];
        st.attempt += 1;
        st.nextRetryAt = now() + delay;
        st.retry = timers.setTimeout(() => {
          st.retry = null;
          st.nextRetryAt = null;
          if (gen === st.gen) runLoop(gen);
        }, delay);
      }
      setStatus('error');
    }

    function runLoop(gen) {
      // The active loop for this generation re-checks `dirty`. A loop left over
      // from a previous account is not reused: it can no longer apply anything.
      if (st.running && st.runningGen === gen) return st.running;
      const loop = (async () => {
        try {
          while (st.dirty && gen === st.gen && st.uid) {
            st.dirty = false;
            if (st.status !== 'loading') setStatus('syncing');
            const uid = st.uid;
            const local = JSON.parse(JSON.stringify(store.data));
            const t0 = now();
            let result;
            try {
              result = await withTimeout(bridge.syncDocument(uid, (remote) => buildDoc(local, remote)), timeoutMs, timers, C);
            } catch (err) {
              if (gen !== st.gen) return false;
              st.dirty = true; // still not in the cloud
              fail(err, gen);
              return false;
            }
            if (gen !== st.gen) {
              log.info('discarded result for a previous session');
              return false;
            }
            // Merge the server copy with anything changed locally meanwhile.
            store.replaceData(C.merge(store.data, result.data, now()));
            store.save();
            st.profile = result.profile || st.profile;
            st.lastSyncedAt = now();
            st.lastError = null;
            st.attempt = 0;
            log.info('sync ok', { ms: now() - t0, bytes: result.bytes });
            onDataApplied('remote');
          }
          if (gen === st.gen && st.uid) setStatus('synced');
          return gen === st.gen;
        } finally {
          if (st.running === loop) { st.running = null; st.runningGen = -1; }
        }
      })();
      st.running = loop;
      st.runningGen = gen;
      return loop;
    }

    async function handleAuth(user, o) {
      o = o || {};
      const gen = ++st.gen;
      clearTimers();
      st.dirty = false;
      st.attempt = 0;
      if (!user) {
        Object.assign(st, { uid: null, email: '', profile: null, lastSyncedAt: null, lastError: null });
        if (store.namespace !== 'guest') {
          store.switchTo('guest');
          onDataApplied('namespace');
        }
        setStatus('signed-out');
        return;
      }
      const userNs = 'u_' + user.uid;
      const switching = st.uid !== user.uid || store.namespace !== userNs;
      Object.assign(st, { uid: user.uid, email: user.email || '' });
      if (switching) {
        st.profile = null;
        st.lastSyncedAt = null;
        if (store.namespace !== userNs) store.switchTo(userNs);
      }
      setStatus('loading');
      let merged = false;
      const guest = store.readNamespace('guest');
      if (guest && C.hasMeaningfulData(guest.data)) {
        // Restored v1 sessions: the v1 blob belonged to the signed-in user.
        let accept = !o.interactive && guest.origin === 'legacy';
        if (!accept && o.interactive) {
          accept = await confirmGuestMerge();
          if (gen !== st.gen) return;
        }
        if (accept) {
          store.replaceData(C.merge(store.data, guest.data, now()));
          store.save();
          store.removeNamespace('guest');
          merged = true;
          log.info('guest data merged into account');
        }
      }
      if (switching || merged) onDataApplied('namespace');
      st.dirty = true;
      await runLoop(gen);
    }

    function markDirty() {
      if (!st.uid) return;
      st.dirty = true;
      if (st.running || st.retry) return; // the loop or the pending retry picks it up
      if (st.debounce) timers.clearTimeout(st.debounce);
      const gen = st.gen;
      st.debounce = timers.setTimeout(() => { st.debounce = null; runLoop(gen); }, debounceMs);
    }

    function syncNow() {
      if (!st.uid) return Promise.resolve(false);
      clearTimers();
      st.dirty = true;
      return runLoop(st.gen);
    }

    // Best effort: returns true only if the cloud has everything.
    async function flush(ms) {
      if (!st.uid) return true;
      clearTimers();
      st.dirty = true;
      try {
        return await withTimeout(runLoop(st.gen), ms || 8000, timers, C);
      } catch (_) {
        return false;
      }
    }

    // Explicit logout: leave the account namespace first so nothing written
    // afterwards can land in it, then drop the device copy of the account.
    async function signOut() {
      const uid = st.uid;
      await handleAuth(null);
      try {
        await bridge.signOut();
      } finally {
        if (uid) store.removeNamespace('u_' + uid);
      }
    }

    // Cancels pending syncs and waits for an in-flight one first, so a sync
    // cannot re-create the document right after it is deleted. On failure the
    // controller resumes normal syncing.
    async function deleteCloudData(ms) {
      if (!st.uid) return;
      const uid = st.uid;
      st.gen++;
      clearTimers();
      st.dirty = false;
      if (st.running) await st.running.catch(() => {});
      try {
        await withTimeout(bridge.deleteUserData(uid), ms || 10000, timers, C);
        log.info('cloud data deleted');
        // Detach from the account: nothing may be written back to it.
        st.uid = null;
        setStatus('signed-out');
      } catch (err) {
        st.dirty = true;
        runLoop(st.gen);
        throw err;
      }
    }

    function setProfile(profile) {
      st.profile = profile;
      onChange(snapshot());
    }

    function onOnline() {
      if (st.retry && st.uid) {
        clearTimers();
        runLoop(st.gen);
      }
    }

    // Shutdown: cancel timers and invalidate any in-flight result. Terminal.
    function dispose() {
      st.gen++;
      clearTimers();
      st.uid = null;
      st.dirty = false;
      st.status = 'disposed';
    }

    return {
      handleAuth, markDirty, syncNow, flush, signOut, deleteCloudData, setProfile, onOnline, dispose,
      snapshot,
      get uid() { return st.uid; },
      get status() { return st.status; },
      _buildDoc: buildDoc
    };
  }

  return { createLogger, createLocalStore, createSyncController, withTimeout, errCode };
});
