'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { disposeAll, C, S, MemoryStorage, fakeBackend, setup, addTodo, todoIds, remoteData, tick } = require('./helpers.js');

test.afterEach(disposeAll);

const userA = { uid: 'userA', email: 'a@example.com' };
const userB = { uid: 'userB', email: 'b@example.com' };

async function waitFor(pred, ms = 1000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return; await tick(5); }
  throw new Error('condition not met in time');
}

// ---------------------------------------------------------------------------
// H1 — the cloud copy must never overwrite unsynced local data
// ---------------------------------------------------------------------------
test('H1: loading an account merges local and remote instead of replacing local', async () => {
  const backend = fakeBackend();
  const remote = C.defaultData();
  remote.todos.items.push({ id: 'from_phone', text: 'phone', createdAt: 1, updatedAt: 1 });
  backend.docs.set('userA', { schemaVersion: 2, data: C.sanitizeData(remote) });
  const storage = new MemoryStorage();
  // A previous session left unsynced work in this account's namespace.
  const s1 = setup({ storage, backend });
  s1.store.switchTo('u_userA');
  addTodo(s1.store, 'offline_edit', 'made offline');

  const s2 = setup({ storage, backend }); // "reload"
  assert.equal(s2.store.namespace, 'u_userA', 'reload resumes the account namespace');
  await s2.sync.handleAuth(userA);
  assert.deepEqual(todoIds(s2.store.data), ['from_phone', 'offline_edit']);
  assert.deepEqual(todoIds(remoteData(backend, 'userA')), ['from_phone', 'offline_edit']);
  assert.equal(s2.sync.status, 'synced');
});

test('H1: edits made while the initial load is in flight survive and reach the cloud', async () => {
  const s = setup();
  const release = s.backend.gate();
  const loading = s.sync.handleAuth(userA);
  await tick(5);
  addTodo(s.store, 'during_load', 'typed during load');
  s.sync.markDirty();
  release();
  await loading;
  await waitFor(() => s.sync.status === 'synced' && todoIds(remoteData(s.backend, 'userA')).includes('during_load'));
  assert.deepEqual(todoIds(s.store.data), ['during_load']);
});

test('H1: an import followed immediately by a reload is not reverted by the cloud', async () => {
  const backend = fakeBackend();
  const storage = new MemoryStorage();
  const s1 = setup({ storage, backend });
  await s1.sync.handleAuth(userA);
  const backup = C.defaultData();
  backup.todos.items.push({ id: 'restored', text: 'from backup', createdAt: 5, updatedAt: 5 });
  s1.store.replaceData(C.merge(s1.store.data, C.prepareImport(s1.store.data, C.sanitizeData(backup), Date.now()), Date.now()));
  s1.store.save(); // no cloud sync before the "reload"
  const s2 = setup({ storage, backend });
  await s2.sync.handleAuth(userA);
  assert.deepEqual(todoIds(s2.store.data), ['restored']);
  assert.deepEqual(todoIds(remoteData(backend, 'userA')), ['restored']);
});

test('M5: two devices editing concurrently both keep their changes (transactional merge)', async () => {
  const backend = fakeBackend();
  const d1 = setup({ backend }), d2 = setup({ backend });
  await d1.sync.handleAuth(userA);
  await d2.sync.handleAuth(userA);
  addTodo(d1.store, 'laptop', 'laptop');
  addTodo(d2.store, 'phone', 'phone');
  await Promise.all([d1.sync.syncNow(), d2.sync.syncNow()]);
  await d1.sync.syncNow();
  assert.deepEqual(todoIds(remoteData(backend, 'userA')), ['laptop', 'phone']);
  assert.deepEqual(todoIds(d1.store.data), ['laptop', 'phone']);
});

test('v1 cloud documents are migrated, legacy fields dropped, profile preserved', async () => {
  const s = setup();
  s.backend.docs.set('userA', {
    profile: { nickname: 'Azu' },
    state: { todos: { items: [{ id: '111', text: 'v1 task' }] }, pomo: { totalSessions: 3 } },
    dailyStats: { '2026-09-01': { mins: 50, sessions: 2 } },
    clientUpdatedAt: 1000
  });
  await s.sync.handleAuth(userA);
  const doc = s.backend.docs.get('userA');
  assert.deepEqual(Object.keys(doc).sort(), ['data', 'profile', 'schemaVersion']);
  assert.equal(doc.profile.nickname, 'Azu');
  assert.equal(s.sync.snapshot().nickname, 'Azu');
  assert.deepEqual(todoIds(s.store.data), ['111']);
  assert.equal(C.lifetimeTotals(s.store.data.stats).sessions, 3);
});

test('hostile remote documents are sanitized before they reach local state', async () => {
  const s = setup();
  s.backend.docs.set('userA', { schemaVersion: 2, data: { schemaVersion: 2, todos: { items: [{ id: `x');alert(1)//`, text: 'hi' }] }, settings: { accent: 'red;x' } } });
  await s.sync.handleAuth(userA);
  const [item] = s.store.data.todos.items;
  assert.ok(C.isValidId(item.id));
  assert.equal(s.store.data.settings.accent, '#7c6af7');
});

// ---------------------------------------------------------------------------
// H2 — account isolation on a shared device
// ---------------------------------------------------------------------------
test('H2: guest data is only added to an account when the user agrees', async () => {
  const declined = setup({ confirmGuestMerge: async () => false });
  addTodo(declined.store, 'guest_note', 'guest');
  await declined.sync.handleAuth(userA, { interactive: true });
  assert.deepEqual(todoIds(declined.store.data), []);
  assert.deepEqual(todoIds(remoteData(declined.backend, 'userA')), []);

  const accepted = setup({ confirmGuestMerge: async () => true });
  addTodo(accepted.store, 'guest_note', 'guest');
  await accepted.sync.handleAuth(userA, { interactive: true });
  assert.deepEqual(todoIds(remoteData(accepted.backend, 'userA')), ['guest_note']);
  assert.equal(accepted.store.readNamespace('guest'), null, 'guest copy is cleared once it belongs to the account');
});

test('H2: after logout, the next person on the device sees nothing and uploads nothing of the previous user', async () => {
  const s = setup({ confirmGuestMerge: async () => true });
  await s.sync.handleAuth(userA, { interactive: true });
  addTodo(s.store, 'private_a', 'A private');
  await s.sync.syncNow();
  await s.sync.signOut();
  assert.equal(s.store.namespace, 'guest');
  assert.deepEqual(todoIds(s.store.data), []);
  assert.equal(s.storage.getItem(s.store.keyFor('u_userA')), null, "A's device copy is removed");
  assert.ok(![...s.storage.map.values()].some((v) => v.includes('private_a')), 'no trace in local storage');

  await s.sync.handleAuth(userB, { interactive: true }); // B even agrees to merge guest data
  addTodo(s.store, 'b_task', 'B');
  await s.sync.syncNow();
  assert.deepEqual(todoIds(remoteData(s.backend, 'userB')), ['b_task']);
  assert.deepEqual(todoIds(remoteData(s.backend, 'userA')), ['private_a'], "A's cloud data is intact");
});

test('v1 upgrade with a restored session: the v1 blob is attached to that account automatically', async () => {
  const storage = new MemoryStorage();
  storage.setItem('zf_state', JSON.stringify({ todos: { items: [{ id: '42', text: 'v1 local' }] } }));
  storage.setItem('zf_daily_stats', JSON.stringify({ '2026-09-01': { mins: 30, sessions: 1 } }));
  storage.setItem('unrelated_app_key', 'keep me');
  const s = setup({ storage });
  assert.equal(storage.getItem('zf_state'), null, 'v1 keys removed after successful migration');
  await s.sync.handleAuth(userA, { interactive: false });
  assert.deepEqual(todoIds(s.store.data), ['42']);
  assert.equal(s.store.readNamespace('guest'), null);
  assert.equal(storage.getItem('unrelated_app_key'), 'keep me');
});

// ---------------------------------------------------------------------------
// M4 — sync pipeline liveness
// ---------------------------------------------------------------------------
test('M4: offline sync enters a visible error state, retries with backoff, and recovers', async () => {
  const s = setup({ backoff: [15, 30] });
  s.backend.offline = true;
  await s.sync.handleAuth(userA);
  assert.equal(s.sync.status, 'error');
  assert.equal(s.sync.snapshot().lastError.code, 'unavailable');
  addTodo(s.store, 'while_offline', 'x');
  s.sync.markDirty(); // must not bypass the backoff with an immediate attempt
  const callsBefore = s.backend.calls;
  await tick(5);
  assert.equal(s.backend.calls, callsBefore);
  s.backend.offline = false;
  await waitFor(() => s.sync.status === 'synced');
  assert.deepEqual(todoIds(remoteData(s.backend, 'userA')), ['while_offline']);
});

test('M4: a hung backend call times out instead of blocking every later sync', async () => {
  const s = setup({ timeoutMs: 30, backoff: [10] });
  s.backend.hang = true;
  await s.sync.handleAuth(userA);
  assert.equal(s.sync.status, 'error');
  assert.equal(s.sync.snapshot().lastError.code, 'zenflow/timeout');
  s.backend.hang = false;
  await waitFor(() => s.sync.status === 'synced');
});

test('M4: logout is bounded in time when the backend hangs, and reports the failure', async () => {
  const s = setup({ timeoutMs: 1000 });
  await s.sync.handleAuth(userA);
  addTodo(s.store, 'x', 'x');
  s.backend.hang = true;
  const t0 = Date.now();
  const ok = await s.sync.flush(50);
  assert.equal(ok, false);
  assert.ok(Date.now() - t0 < 500);
});

test('M4: changes made during an in-flight sync trigger another pass (no dropped update)', async () => {
  const s = setup();
  await s.sync.handleAuth(userA);
  const release = s.backend.gate();
  addTodo(s.store, 'first', '1');
  const p = s.sync.syncNow();
  await tick(5);
  addTodo(s.store, 'second', '2');
  s.sync.markDirty();
  release();
  await p;
  await waitFor(() => todoIds(remoteData(s.backend, 'userA')).length === 2);
});

test('oversized data fails visibly without a retry storm', async () => {
  const s = setup({ backoff: [5] });
  s.store.switchTo('u_userA');
  for (let i = 0; i < 700; i++) {
    s.store.data.todos.items.push({ id: 't' + i, text: 'x'.repeat(190), note: 'n'.repeat(1500), createdAt: i, updatedAt: i, tags: [], subtasks: [], due: '', listId: 'inbox', priority: 'none', pomos: 1, completed: false });
  }
  await s.sync.handleAuth(userA);
  const calls = s.backend.calls;
  await tick(30);
  assert.equal(s.sync.status, 'error');
  assert.equal(s.sync.snapshot().lastError.code, 'zenflow/too-large');
  assert.equal(s.backend.calls, calls, 'non-retryable errors are not retried automatically');
});

// ---------------------------------------------------------------------------
// M6 — account switch while a sync is in flight
// ---------------------------------------------------------------------------
test('M6: a late result for the previous account is discarded, never applied to the new one', async () => {
  const backend = fakeBackend();
  const a = C.defaultData();
  a.todos.items.push({ id: 'a_secret', text: 'A', createdAt: 1, updatedAt: 1 });
  backend.docs.set('userA', { schemaVersion: 2, data: C.sanitizeData(a) });
  const s = setup({ backend });
  const release = backend.gate();
  const loadingA = s.sync.handleAuth(userA);
  await tick(5);
  await s.sync.handleAuth(userB); // switch before A's load returns
  release();
  await loadingA;
  await waitFor(() => s.sync.status === 'synced');
  assert.equal(s.store.namespace, 'u_userB');
  assert.deepEqual(todoIds(s.store.data), []);
  assert.deepEqual(todoIds(remoteData(backend, 'userB')), []);
});

// ---------------------------------------------------------------------------
// LocalStore failure modes (M5, M7, M9)
// ---------------------------------------------------------------------------
test('M7: a storage quota failure is reported, not swallowed, and data stays in memory', () => {
  const storage = new MemoryStorage();
  const s = setup({ storage });
  storage.quota = 10;
  addTodo(s.store, 'big', 'x');
  assert.equal(s.errors.length, 1);
  assert.equal(s.errors[0].name, 'QuotaExceededError');
  assert.ok(s.store.lastError);
  assert.deepEqual(todoIds(s.store.data), ['big']);
  storage.quota = Infinity;
  assert.equal(s.store.save(), true);
  assert.equal(s.store.lastError, null);
});

test('corrupt local data boots to a usable empty state instead of crashing', () => {
  const storage = new MemoryStorage();
  storage.setItem('zf_v2_active', 'guest');
  storage.setItem('zf_v2_guest', '{not json');
  const s = setup({ storage });
  assert.deepEqual(todoIds(s.store.data), []);
  storage.setItem('zf_v2_active', '../../evil');
  const s2 = setup({ storage });
  assert.equal(s2.store.namespace, 'guest');
});

test('M5: two tabs on one device converge through storage events without a write loop', () => {
  const storage = new MemoryStorage();
  const tab1 = S.createLocalStore({ core: C, storage }); tab1.boot();
  const tab2 = S.createLocalStore({ core: C, storage }); tab2.boot();
  addTodo(tab1, 'from_tab1', '1');
  const afterTab1 = storage.getItem(tab1.keyFor('guest'));
  addTodo(tab2, 'from_tab2', '2'); // tab2's in-memory copy does not know tab1's item yet...
  const afterTab2 = storage.getItem(tab2.keyFor('guest'));
  // ...deliver the events each tab would receive.
  tab2.applyExternal(tab2.keyFor('guest'), afterTab1);
  const writes = storage.writes;
  tab1.applyExternal(tab1.keyFor('guest'), storage.getItem(tab1.keyFor('guest')));
  assert.deepEqual(todoIds(tab1.data), ['from_tab1', 'from_tab2']);
  assert.deepEqual(todoIds(tab2.data), ['from_tab1', 'from_tab2']);
  assert.deepEqual(todoIds(JSON.parse(storage.getItem(tab1.keyFor('guest'))).data), ['from_tab1', 'from_tab2']);
  assert.equal(storage.writes, writes, 'converged state is not rewritten');
  assert.ok(afterTab2);
});

test('M9: clearAll removes only ZenFlow keys', () => {
  const storage = new MemoryStorage();
  storage.setItem('other_project_data', 'x');
  const s = setup({ storage });
  addTodo(s.store, 't', 't');
  assert.equal(s.store.clearAll(), true);
  assert.deepEqual([...storage.map.keys()], ['other_project_data']);
});

test('M9: deleting cloud data waits for an in-flight sync so the document is not re-created', async () => {
  const s = setup();
  await s.sync.handleAuth(userA);
  addTodo(s.store, 'x', 'x');
  const release = s.backend.gate();
  s.sync.syncNow();
  await tick(5);
  const deleting = s.sync.deleteCloudData(1000);
  release();
  await deleting;
  s.sync.markDirty(); // stale debounce/retry must not resurrect it either
  await tick(30);
  assert.equal(s.backend.docs.has('userA'), false);
});
