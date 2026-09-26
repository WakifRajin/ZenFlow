# ZenFlow

A focus and productivity suite that runs entirely in the browser: Pomodoro timer, tasks, countdown timer, stopwatch, time tracker, and analytics. It works without an account. An optional email/password login syncs data across devices through Firebase.

## Running locally

It's a static site with no build step:

```bash
npm run serve        # python -m http.server 8765 --bind 127.0.0.1
```

Open http://localhost:8765. Opening `index.html` via `file://` also works, but ES modules, and therefore cloud sync, need an HTTP origin.

## Tests

```bash
npm test             # node --test "tests/*.test.js", no dependencies (Node 20+)
```

- `tests/core.test.js` covers the domain logic: sanitising hostile data, legacy migration, merge semantics (including a property test that merge is commutative, idempotent and associative), local-day handling across time zones, and the timer state machines.
- `tests/sync.test.js` covers local storage and cloud sync against a fake transactional backend: no remote overwrite of local data, account isolation, offline/timeout/backoff behaviour, account-switch races, two-tab convergence, quota failures and cloud deletion.

## Architecture

```
index.html              markup, CSS, CSP; loads the scripts below
js/core.js              pure domain logic (no DOM, storage or network) -> window.ZenCore
js/sync.js              LocalStore + SyncController (dependency-injected)  -> window.ZenSync
js/app.js               UI: rendering, events, timers, auth UI
js/firebase-bridge.js   ES module wrapping the Firebase SDK            -> window.ZenFlowFirebase
js/firebase-config.js   Firebase project identifiers (public, not secret)
firestore.rules         the server-side security boundary (deploy it!)
```

Dependencies point one way: `app.js` uses `sync.js` and `core.js`, and `sync.js` uses `core.js`. The Firebase SDK is reached only through the bridge's narrow interface (documented at the top of `firebase-bridge.js`).

### State ownership

| State | Owner | Persisted | Synced |
|---|---|---|---|
| `data`: tasks, lists, presets, projects, time entries, focus log and garden, focus stats, settings | LocalStore (device copy) and SyncController (cloud copy), reconciled by `ZenCore.merge` | localStorage `zf_v2_<namespace>` | yes |
| `runtime`: running or paused Pomodoro, countdown, stopwatch and tracker, stored as wall-clock timestamps | LocalStore | same blob | no (per device) |
| `prefs`: active list/filter/tag, sort, ambient sound | LocalStore | same blob | no |

Each account has its own namespace (`guest`, or `u_<uid>`), so people sharing a device never see each other's data. Logging out removes that account's copy from the device once it's safely in the cloud. Guest data is added to an account only when the user agrees.

### Sync semantics

- A sync is a Firestore transaction: read the remote document, `merge(local, remote)`, write the result. The cloud copy never simply replaces local data, and local data never simply replaces the cloud copy.
- Every collection item has a stable `id` and an `updatedAt`, and the newer version wins. Deletions leave tombstones, which are pruned after 90 days.
- Scalar settings are last-writer-wins per field (`data.clocks`).
- Focus statistics are per-replica grow-only counters, merged with `max`, so they're never lost or double-counted.
- Ties are broken by content, so every replica converges on the same result.
- The controller is a state machine: `signed-out → loading → synced ⇄ syncing`, with `error` retrying on backoff (2 s … 60 s, and immediately when the browser comes back online). Only one sync runs at a time; edits made meanwhile trigger another pass. Each call times out after 15 s. Results that arrive for a previous account are discarded.
- Tabs on the same device merge each other's writes through the `storage` event. Timer completion is serialised with the Web Locks API and made idempotent by session id, so a session is credited exactly once.

### Data contracts

- Timestamps are epoch milliseconds, and durations are seconds unless a field is named `mins`.
- Calendar days are **local** `YYYY-MM-DD` keys (`ZenCore.localDayKey`).
- "Focus time" means Pomodoro focus only; time-tracker entries are reported separately. Skipping a session credits only the time actually focused and never counts as a completed session.
- Everything read from localStorage, imported files or Firestore passes through `ZenCore.sanitizeData`, which drops invalid items, clamps out-of-range values and rejects unsafe ids. All rendering escapes interpolated values, and dynamic elements use `data-*` attributes rather than inline JavaScript.
- The cloud document is `zenflow_users/{uid}`: `{ schemaVersion: 2, data, profile: { nickname }, updatedAt }`. Version 1 documents (`{ state, dailyStats }`) are migrated automatically on first sync.
- Backups are `{ format: "zenflow-backup", schemaVersion: 2, exportedAt, data }`. Import accepts this format plus both v1 export formats, and **merges** rather than replaces: nothing current is removed, locally deleted items come back, and the backup's settings are applied.

### Diagnostics

Run `zenflowDiagnostics()` in the browser console. It returns the sync state, the last error, storage health and the last 200 log events. Logs never contain emails, passwords, tokens or user content.

## Deploying

1. Serve the repository root from any static host.
2. Deploy the Firestore rules: `firebase deploy --only firestore:rules` (uses `firebase.json`, database `zenflow-db1`). Without them the cloud data is only as safe as whatever rules the project currently has.
3. Recommended, in the Firebase console: turn on email enumeration protection, add App Check, and restrict the authorised domains to your real origin(s).
4. If the site's origin is shared with other apps (for example `username.github.io`), they share its localStorage and IndexedDB. A dedicated origin or custom domain isolates ZenFlow's data and login session.

## Known limitations

- There's no service worker, so the app needs a network connection to load. Alarms fire on time in a background desktop tab, but mobile browsers may suspend background tabs. When that happens, finished sessions are credited, and announced as "finished while you were away", when the app is reopened.
- Settings use per-field last-writer-wins based on device clocks. A device whose clock is badly wrong can win or lose a concurrent settings change.
- A device that stays offline for more than 90 days can bring back items deleted elsewhere, because tombstones expire.
- v1 daily statistics were stored under UTC dates and mixed tracker time into focus time. Migrated history keeps those values; everything recorded after the upgrade uses local days and Pomodoro time only.
- Firebase Analytics loads for every visitor, with no consent step.
