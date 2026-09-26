/*
 * ZenFlow UI layer.
 *
 * Owns rendering and user interaction only. Domain rules live in core.js,
 * persistence/sync in sync.js. State access always goes through the store
 * getters (D/RT/PF) — never cache references to store objects, because a merge,
 * namespace switch or another tab can replace them.
 *
 * Rendering rule: every dynamic value interpolated into HTML goes through
 * esc(). Dynamic elements carry data-action/data-* attributes handled by one
 * delegated listener; no data is ever placed inside inline JavaScript.
 *
 * Functions referenced from static markup (onclick="...") are top-level so
 * they are globals.
 */
'use strict';

const C = window.ZenCore;
const S = window.ZenSync;
const esc = C.escapeHtml;
const logRoot = S.createLogger('app');
const log = logRoot;

// ---------------------------------------------------------------------------
// Storage & state
// ---------------------------------------------------------------------------
function memoryStorage() {
  const m = new Map();
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); }
  };
}
let storageUnavailable = false;
function pickStorage() {
  try {
    const s = window.localStorage;
    const probe = 'zf_probe';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch (e) {
    storageUnavailable = true;
    log.error('localStorage unavailable; data will not persist', { name: e && e.name });
    return memoryStorage();
  }
}

const store = S.createLocalStore({
  core: C,
  storage: pickStorage(),
  log: logRoot.child('store'),
  onError: () => updateStorageBanner()
});
const D = () => store.data;
const RT = () => store.runtime;
const PF = () => store.prefs;

let bridge = null;
let sync = null;
let firebaseState = 'connecting'; // connecting | ready | unavailable
let pendingInteractive = false;

function commitData() {
  store.save();
  if (sync) sync.markDirty();
  updateStorageBanner();
  renderHomeHero();
}
function commitRuntime() {
  store.touchRuntime();
  store.save();
  updateStorageBanner();
}
function commitPrefs() {
  store.save();
  updateStorageBanner();
}

// Serialize cross-tab critical sections (timer completion). Falls back to
// running directly where the Web Locks API is unavailable.
function withLock(name, fn) {
  if (navigator.locks && navigator.locks.request) return navigator.locks.request(name, fn);
  return Promise.resolve().then(fn);
}
// Pull the latest copy written by another tab before deciding anything.
function refreshFromStorage() {
  try {
    const key = store.keyFor(store.namespace);
    const res = store.applyExternal(key, window.localStorage.getItem(key));
    return res;
  } catch (_) {
    return null;
  }
}

window.zenflowDiagnostics = () => ({
  namespace: store.namespace === 'guest' ? 'guest' : 'user',
  firebase: firebaseState,
  sync: sync ? (({ email, uid, ...rest }) => rest)(sync.snapshot()) : null,
  storageError: store.lastError ? store.lastError.name : null,
  storageUnavailable,
  events: logRoot.events()
});

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------
function updateClock() {
  const now = new Date();
  document.getElementById('clock').textContent = now.toLocaleTimeString('en-US', { hour12: false });
  document.getElementById('topdate').textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// Navigation & layout
// ---------------------------------------------------------------------------
function navigate(page) {
  const target = document.getElementById('page-' + page);
  if (!target) return;
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  target.classList.add('active');
  document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');
  if (page === 'todo') { renderTodoLists(); renderTodos(); }
  if (page === 'tracking') renderTrackingPage();
  if (page === 'forest') renderForest();
  if (page === 'timer') renderTimerPresets();
  if (page === 'settings') renderSettings();
  if (page === 'stopwatch') renderStopwatch();
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('expanded');
}
function updateViewportHeightVar() {
  const vh = (window.visualViewport ? window.visualViewport.height : window.innerHeight) * 0.01;
  document.documentElement.style.setProperty('--app-vh', `${vh * 100}px`);
}
function syncResponsiveLayout() {
  const sidebar = document.getElementById('sidebar');
  if (sidebar && window.innerWidth <= 780) sidebar.classList.remove('expanded');
}

// ---------------------------------------------------------------------------
// Toasts, banner, modals
// ---------------------------------------------------------------------------
function toast(msg, type = 'info', icon = '') {
  const t = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast toast-' + (['info', 'success', 'error'].includes(type) ? type : 'info');
  const i = document.createElement('span');
  i.className = 'toast-icon';
  i.textContent = icon || { info: 'ℹ️', success: '✅', error: '❌' }[type] || 'ℹ️';
  el.append(i, document.createTextNode(String(msg)));
  t.appendChild(el);
  setTimeout(() => el.remove(), 3400);
}

function updateStorageBanner() {
  const el = document.getElementById('storageBanner');
  if (!el) return;
  let msg = '';
  if (storageUnavailable) msg = 'Browser storage is blocked, so ZenFlow cannot save on this device. Your changes will be lost when you close this tab.';
  else if (store.lastError) msg = "Couldn't save to this device's storage (it may be full). Recent changes will be lost if you close ZenFlow — export a backup from Settings.";
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function openModal(id) { document.getElementById(id).classList.add('open'); }

// ---------------------------------------------------------------------------
// Auth & cloud sync UI
// ---------------------------------------------------------------------------
function authErrorMessage(err) {
  const code = (err && err.code) || '';
  if (code.includes('invalid-email')) return 'Please enter a valid email address.';
  if (code.includes('email-already-in-use')) return 'This email is already in use.';
  if (code.includes('weak-password')) return 'Password must be at least 6 characters.';
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) return 'Invalid email or password.';
  if (code.includes('too-many-requests')) return 'Too many attempts. Please wait a moment and try again.';
  if (code.includes('network-request-failed')) return 'Network error. Please check your connection.';
  return 'Authentication failed. Please try again.';
}

function cloudErrorMessage(code) {
  code = code || '';
  if (code.includes('permission-denied')) return 'Cloud sync blocked by the server (permission denied).';
  if (code.includes('unauthenticated')) return 'Session expired. Please log in again.';
  if (code === 'zenflow/too-large') return 'Your data is too large to sync. Export a backup and remove old items.';
  if (code === 'zenflow/timeout' || code.includes('unavailable') || code.includes('network') || code.includes('deadline')) return 'Offline — changes are saved on this device and will sync when you reconnect.';
  if (code.includes('failed-precondition')) return 'Cloud database is not configured for this app.';
  return 'Cloud sync failed. Your data is safe on this device; retrying.';
}

function setAuthStatusMessage(msg, isError = false) {
  const el = document.getElementById('authStatusMessage');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? 'var(--red)' : 'var(--text3)';
}

function normalizedNickname(v) {
  return (v || '').replace(/\s+/g, ' ').trim();
}

let authMode = 'login';
function setAuthMode(mode) {
  if (mode !== 'login' && mode !== 'signup') return;
  authMode = mode;
  const isSignup = mode === 'signup';
  document.getElementById('authModeLoginBtn')?.classList.toggle('active', !isSignup);
  document.getElementById('authModeSignupBtn')?.classList.toggle('active', isSignup);
  const group = document.getElementById('authNicknameGroup');
  if (group) group.style.display = isSignup ? 'block' : 'none';
  const note = document.getElementById('authModeNote');
  if (note) note.textContent = isSignup ? 'Choose a nickname. This is what appears in the top-right corner.' : 'Use your account email and password to log in.';
  const primary = document.getElementById('authPrimaryBtn');
  if (primary) primary.textContent = isSignup ? 'Create Account' : 'Log In';
  const forgot = document.getElementById('authForgotBtn');
  if (forgot) forgot.style.display = isSignup ? 'none' : '';
  document.getElementById('authPasswordInput')?.setAttribute('autocomplete', isSignup ? 'new-password' : 'current-password');
  if (isSignup) setTimeout(() => document.getElementById('authNicknameInput')?.focus(), 50);
}

function syncSnap() {
  return sync ? sync.snapshot() : { status: 'signed-out', uid: null, nickname: '', email: '', lastError: null, lastSyncedAt: null };
}
function isSignedIn() {
  return !!(sync && sync.uid);
}
function getDisplayNickname() {
  return normalizedNickname(syncSnap().nickname) || 'Zen User';
}

function syncStatusText(s) {
  const time = (t) => new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (s.status === 'loading') return 'Syncing your data…';
  if (s.status === 'syncing') return 'Saving to the cloud…';
  if (s.status === 'error') {
    const retry = s.nextRetryAt ? ` Next retry at ${time(s.nextRetryAt)}.` : '';
    return cloudErrorMessage(s.lastError && s.lastError.code) + retry;
  }
  if (s.lastSyncedAt) return 'All changes synced. Last sync: ' + time(s.lastSyncedAt);
  return 'Cloud sync is active for this account.';
}

function updateAuthCorner() {
  const btn = document.getElementById('authCornerBtn');
  const txt = document.getElementById('authCornerText');
  const avatar = document.getElementById('authCornerAvatar');
  if (!btn || !txt || !avatar) return;
  const s = syncSnap();
  const dot = btn.querySelector('.auth-corner-dot');
  if (isSignedIn()) {
    btn.classList.add('auth-on');
    const nick = getDisplayNickname();
    txt.textContent = nick;
    avatar.textContent = nick.charAt(0).toUpperCase();
    btn.title = syncStatusText(s);
    if (dot) dot.style.background = s.status === 'error' ? 'var(--red)' : (s.status === 'synced' ? '' : 'var(--orange)');
  } else {
    btn.classList.remove('auth-on');
    if (dot) dot.style.background = '';
    avatar.textContent = 'Z';
    txt.textContent = firebaseState === 'connecting' ? 'Login...' : 'Login';
    btn.title = firebaseState === 'unavailable' ? 'Cloud sync is unavailable right now (offline or blocked)' :
      firebaseState === 'connecting' ? 'Connecting to Firebase...' : 'Optional account login';
  }
  renderHomeHero();
}

function renderAuthModal() {
  const outView = document.getElementById('authLoggedOutView');
  const inView = document.getElementById('authLoggedInView');
  if (!outView || !inView) return;
  if (isSignedIn()) {
    const s = syncSnap();
    outView.style.display = 'none';
    inView.style.display = 'block';
    document.getElementById('authUserNickname').textContent = getDisplayNickname();
    document.getElementById('authUserEmail').textContent = s.email || '';
    const info = document.getElementById('authSyncInfo');
    info.textContent = syncStatusText(s);
    info.style.color = s.status === 'error' ? 'var(--red)' : 'var(--text3)';
  } else {
    outView.style.display = 'block';
    inView.style.display = 'none';
  }
}

function openAuthModal() {
  renderAuthModal();
  openModal('modalAuth');
  if (!isSignedIn()) {
    setAuthMode('login');
    setAuthStatusMessage(firebaseState === 'ready' ? 'Use your email and password to log in or create an account.' :
      firebaseState === 'unavailable' ? 'Cloud sync is unavailable right now. You can keep using ZenFlow on this device.' : 'Connecting to Firebase...');
    setTimeout(() => document.getElementById('authEmailInput')?.focus(), 80);
  }
}

function handleAuthPrimary() {
  return authMode === 'signup' ? handleAuthSignup() : handleAuthLogin();
}

function readCredentials() {
  return {
    email: (document.getElementById('authEmailInput')?.value || '').trim(),
    // Passwords are used verbatim: trimming would silently change them.
    password: document.getElementById('authPasswordInput')?.value || ''
  };
}

async function handleAuthSignup() {
  if (!bridge) { toast('Cloud sync is not available yet. Please try again.', 'error'); return; }
  const nickname = normalizedNickname(document.getElementById('authNicknameInput')?.value || '');
  const { email, password } = readCredentials();
  if (!nickname) return setAuthStatusMessage('Nickname is required for sign up.', true);
  if (nickname.length < 2 || nickname.length > C.LIMITS.nickname) return setAuthStatusMessage('Nickname should be 2 to 24 characters.', true);
  if (!email || !password) return setAuthStatusMessage('Email and password are required.', true);
  if (password.length < 6) return setAuthStatusMessage('Password must be at least 6 characters.', true);
  setAuthStatusMessage('Creating your account...');
  pendingInteractive = true;
  try {
    const cred = await bridge.signUp(email, password);
    try {
      await bridge.saveProfile(cred.user.uid, { nickname });
    } catch (err) {
      log.warn('profile save failed', { code: S.errCode(err) });
    }
    if (sync) sync.setProfile({ nickname });
    updateAuthCorner();
    closeModal('modalAuth');
    toast('Signed up successfully', 'success');
  } catch (err) {
    pendingInteractive = false;
    setAuthStatusMessage(authErrorMessage(err), true);
  }
}

async function handleAuthLogin() {
  if (!bridge) { toast('Cloud sync is not available yet. Please try again.', 'error'); return; }
  const { email, password } = readCredentials();
  if (!email || !password) return setAuthStatusMessage('Email and password are required.', true);
  setAuthStatusMessage('Logging in...');
  pendingInteractive = true;
  try {
    await bridge.signIn(email, password);
    closeModal('modalAuth');
    toast('Logged in successfully', 'success');
  } catch (err) {
    pendingInteractive = false;
    setAuthStatusMessage(authErrorMessage(err), true);
  }
}

async function handleForgotPassword() {
  if (!bridge) return;
  const { email } = readCredentials();
  if (!email) return setAuthStatusMessage('Enter your email above, then press "Forgot password?" again.', true);
  try {
    await bridge.sendPasswordReset(email);
  } catch (err) {
    if (String(err && err.code).includes('invalid-email')) return setAuthStatusMessage('Please enter a valid email address.', true);
    log.warn('password reset request failed', { code: S.errCode(err) });
  }
  // Same message either way, so this cannot be used to probe for accounts.
  setAuthStatusMessage('If an account exists for that email, a password reset link is on its way.');
}

async function handleAuthLogout() {
  if (!isSignedIn()) return;
  const info = document.getElementById('authSyncInfo');
  if (info) info.textContent = 'Saving your latest changes…';
  const ok = await sync.flush(8000);
  if (!ok && !window.confirm('Your latest changes could not be saved to the cloud (you may be offline).\n\nLog out anyway? Unsynced changes on this device will be lost.')) {
    renderAuthModal();
    return;
  }
  stopRuntimeTimers();
  try {
    await sync.signOut();
    toast('Logged out. This device is now in guest mode.', 'info');
  } catch (err) {
    log.error('sign-out failed', { code: S.errCode(err) });
    toast('Could not log out cleanly. Please try again.', 'error');
  }
  closeModal('modalAuth');
}

async function syncCloudNow() {
  if (!isSignedIn()) return;
  const ok = await sync.syncNow();
  const s = syncSnap();
  if (ok) toast('Data synced', 'success');
  else toast(cloudErrorMessage(s.lastError && s.lastError.code), 'error');
}

let lastSyncErrorToast = 0;
function onSyncChange(s) {
  updateAuthCorner();
  renderAuthModal();
  if (s.status === 'error' && Date.now() - lastSyncErrorToast > 60000) {
    lastSyncErrorToast = Date.now();
    toast(cloudErrorMessage(s.lastError && s.lastError.code), 'error');
  }
}

function onDataApplied(why) {
  if (why === 'namespace') restoreRuntime();
  refreshUiFromState();
}

function confirmGuestMerge() {
  return Promise.resolve(window.confirm('This device has ZenFlow data that was created while logged out.\n\nAdd it to your account?\n\nOK = add it to this account\nCancel = keep it on this device only (guest mode)'));
}

function initAuthIntegration() {
  const attach = () => {
    if (bridge || !window.ZenFlowFirebase) return;
    bridge = window.ZenFlowFirebase;
    firebaseState = 'ready';
    sync = S.createSyncController({
      core: C, bridge, store, log: logRoot.child('sync'),
      onChange: onSyncChange, onDataApplied, confirmGuestMerge
    });
    bridge.onAuth((user) => {
      const interactive = pendingInteractive && !!user;
      pendingInteractive = false;
      sync.handleAuth(user, { interactive }).catch((err) => log.error('auth handling failed', { code: S.errCode(err) }));
    });
    updateAuthCorner();
  };
  if (window.ZenFlowFirebase) attach();
  else {
    window.addEventListener('zenflow-firebase-ready', attach, { once: true });
    window.addEventListener('zenflow-firebase-failed', () => {
      if (!bridge) { firebaseState = 'unavailable'; log.warn('firebase module failed to load'); updateAuthCorner(); }
    }, { once: true });
    setTimeout(() => {
      if (!bridge && firebaseState === 'connecting') { firebaseState = 'unavailable'; log.warn('firebase did not load in time'); updateAuthCorner(); }
    }, 20000);
  }
}

// ---------------------------------------------------------------------------
// Sound & notifications (one shared AudioContext)
// ---------------------------------------------------------------------------
let audioCtx = null;
function getAudioCtx() {
  if (audioCtx) return audioCtx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try { audioCtx = new AC(); } catch (e) { log.warn('audio context unavailable', { name: e && e.name }); return null; }
  return audioCtx;
}
// Browsers only allow audio to start after a user gesture; resume on each.
function unlockAudio() {
  const ctx = getAudioCtx();
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
}

const SOUND_PRESETS = {
  bell: { type: 'sine', notes: [880, 1175, 1568], spacing: 0.12, hold: 0.42, gain: 0.26 },
  chime: { type: 'triangle', notes: [523, 659, 784, 988], spacing: 0.11, hold: 0.36, gain: 0.24 },
  ding: { type: 'sine', notes: [1047], spacing: 0.08, hold: 0.55, gain: 0.3 },
  beep: { type: 'square', notes: [740, 740], spacing: 0.16, hold: 0.2, gain: 0.18 }
};

function playSound(preview = false) {
  if (!preview && !D().pomo.sound) return;
  const soundType = D().settings.sound;
  if (soundType === 'none') return;
  const ctx = getAudioCtx();
  if (!ctx) return;
  const play = () => {
    const cfg = SOUND_PRESETS[soundType] || SOUND_PRESETS.bell;
    const volume = D().settings.volume / 100;
    cfg.notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = cfg.type;
      const start = ctx.currentTime + i * cfg.spacing;
      const peak = Math.max(0.001, cfg.gain * volume);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(peak, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, start + cfg.hold);
      osc.start(start);
      osc.stop(start + cfg.hold);
      osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    });
  };
  if (ctx.state === 'suspended') {
    ctx.resume().then(play).catch((e) => log.warn('sound blocked until the page is interacted with', { name: e && e.name }));
  } else {
    try { play(); } catch (e) { log.warn('sound failed', { name: e && e.name }); }
  }
}

function showNotification(msg) {
  toast(msg, 'success');
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification('ZenFlow', { body: msg, icon: 'logo.png' }); } catch (e) { log.warn('notification failed', { name: e && e.name }); }
  }
}

function requestNotifications() {
  if (!('Notification' in window)) return toast('Notifications not supported', 'error');
  Notification.requestPermission().then((p) => toast(p === 'granted' ? 'Notifications enabled' : 'Permission denied', p === 'granted' ? 'success' : 'error'));
}

// ---------------------------------------------------------------------------
// Runtime timers (display intervals + one-shot completion timeouts)
// ---------------------------------------------------------------------------
const handles = { pomoTick: null, pomoDue: null, timerTick: null, timerDue: null, track: null, swRaf: null };
function clearHandle(k) {
  if (handles[k] == null) return;
  if (k === 'swRaf') cancelAnimationFrame(handles[k]);
  else if (k.endsWith('Due')) clearTimeout(handles[k]);
  else clearInterval(handles[k]);
  handles[k] = null;
}
function stopRuntimeTimers() {
  Object.keys(handles).forEach(clearHandle);
}
// A single non-repeating timeout at the deadline is throttled far less than a
// repeating interval in background tabs, so the alarm fires on time.
function scheduleDeadline(key, targetEnd, fn) {
  clearHandle(key);
  if (targetEnd == null) return;
  handles[key] = setTimeout(fn, Math.max(0, targetEnd - Date.now()) + 30);
}

// ---------------------------------------------------------------------------
// Pomodoro
// ---------------------------------------------------------------------------
const pomoCirc = 2 * Math.PI * 126;
const focusCirc = 2 * Math.PI * 145;
const PLAY_ICON = '<polygon points="5,3 19,12 5,21"></polygon>';
const PAUSE_ICON = '<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>';

function updatePomoDisplay() {
  const p = RT().pomo, cfg = D().pomo, now = Date.now();
  const remaining = C.pomoRemaining(p, cfg, now);
  const total = C.pomoTotal(p, cfg) || 1;
  const frac = Math.min(1, Math.max(0, remaining / total));
  const ring = document.getElementById('pomoRing');
  ring.style.strokeDashoffset = pomoCirc * (1 - frac);
  ring.setAttribute('class', 'ring-progress ring-' + p.mode);
  document.getElementById('pomoDisplay').textContent = C.formatTime(remaining);
  const labels = { work: 'FOCUS', 'short-break': 'BREAK', 'long-break': 'LONG BREAK' };
  document.getElementById('pomoModeLabel').textContent = labels[p.mode];
  document.getElementById('pomoSession').textContent = `Session ${Math.min(p.session, cfg.sessionsBeforeLong)} of ${cfg.sessionsBeforeLong}`;
  document.getElementById('focusTime').textContent = C.formatTime(remaining);
  document.getElementById('focusModeLabel').textContent = labels[p.mode];
  const fr = document.getElementById('focusRing');
  if (fr) fr.style.strokeDashoffset = focusCirc * (1 - frac);
  const running = p.status === 'running';
  document.getElementById('pomoPlayIcon').innerHTML = running ? PAUSE_ICON : PLAY_ICON;
  document.getElementById('focusPlayIcon').innerHTML = running ? PAUSE_ICON : PLAY_ICON;
  document.getElementById('pomoBtnMain').className = 'pomo-btn-main ' + (running ? 'pause' : 'play');
  const tabs = document.querySelectorAll('.pomo-tab');
  tabs.forEach((t, i) => t.classList.toggle('active', C.POMO_MODES[i] === p.mode));
  document.querySelectorAll('.pomo-settings .num-btn').forEach((b) => { b.disabled = p.status !== 'idle'; });
  updatePomoDots();
}

function updatePomoDots() {
  const p = RT().pomo, cfg = D().pomo;
  const dots = document.getElementById('pomoDots');
  let html = '';
  for (let i = 0; i < cfg.sessionsBeforeLong; i++) {
    html += `<div class="pomo-dot${i < p.session - 1 ? ' done' : i === p.session - 1 ? ' current' : ''}"></div>`;
  }
  dots.innerHTML = html;
}

function schedulePomo() {
  clearHandle('pomoTick');
  clearHandle('pomoDue');
  const p = RT().pomo;
  if (p.status !== 'running') return;
  handles.pomoTick = setInterval(tickPomo, 1000);
  scheduleDeadline('pomoDue', p.targetEnd, tickPomo);
}

function tickPomo() {
  if (C.pomoIsDue(RT().pomo, Date.now())) finishPomodoro(false);
  else updatePomoDisplay();
}

function startPomodoro() {
  const p = RT().pomo;
  unlockAudio();
  if (p.status === 'idle') p.task = document.getElementById('pomoTask').value.slice(0, C.LIMITS.task);
  if (!C.pomoStart(p, D().pomo, Date.now())) return;
  commitRuntime();
  schedulePomo();
  updatePomoDisplay();
}

function pausePomodoro() {
  if (!C.pomoPause(RT().pomo, D().pomo, Date.now())) return;
  commitRuntime();
  schedulePomo();
  updatePomoDisplay();
}

function togglePomodoro() {
  if (RT().pomo.status === 'running') pausePomodoro();
  else startPomodoro();
}

let finishing = false;
async function finishPomodoro(skipped, late = false) {
  if (finishing) return;
  finishing = true;
  clearHandle('pomoTick');
  clearHandle('pomoDue');
  let res = null;
  const before = C.lifetimeTotals(D().stats).sessions;
  try {
    res = await withLock('zenflow-pomodoro', () => {
      refreshFromStorage(); // another tab may already have finished this session
      const p = RT().pomo;
      const now = Date.now();
      if (!skipped && !C.pomoIsDue(p, now)) return null;
      const task = (document.getElementById('pomoTask').value || p.task || '').slice(0, C.LIMITS.task);
      const out = C.pomoFinish(D(), p, D().pomo, { now, skipped, task, replica: store.replica });
      store.touchRuntime();
      commitData();
      return out;
    });
  } catch (e) {
    log.error('pomodoro completion failed', { name: e && e.name });
  } finally {
    finishing = false;
  }
  schedulePomo();
  updatePomoDisplay();
  renderPomoLog();
  if (!res || res.duplicate) return;
  if (!skipped) {
    playSound();
    const msg = res.mode === 'work' ? 'Focus session complete! Time for a break 🎉' : "Break time is over. Let's focus! 🎯";
    showNotification(late ? msg + ' (finished while you were away)' : msg);
  }
  announceMilestones(before, C.lifetimeTotals(D().stats).sessions);
  if (!skipped && !late) {
    const cfg = D().pomo;
    const auto = res.next === 'work' ? cfg.autoWork : cfg.autoBreak;
    if (auto) {
      setTimeout(() => {
        const p = RT().pomo;
        if (p.status === 'idle' && p.mode === res.next) startPomodoro();
      }, 500);
    }
  }
}

function skipPomodoro() {
  finishPomodoro(true);
}

function resetPomodoro() {
  C.pomoReset(RT().pomo);
  commitRuntime();
  schedulePomo();
  updatePomoDisplay();
}

function setPomoMode(mode) {
  if (!C.pomoSetMode(RT().pomo, mode)) {
    if (RT().pomo.status !== 'idle') toast('Reset the current session before switching modes.', 'info');
    return;
  }
  commitRuntime();
  updatePomoDisplay();
}

const POMO_LIMITS = { work: ['workMins', 1, 90], short: ['shortMins', 1, 30], long: ['longMins', 5, 60], sessions: ['sessionsBeforeLong', 2, 8] };
function adjustPomo(type, delta) {
  const spec = POMO_LIMITS[type];
  if (!spec) return;
  if (RT().pomo.status !== 'idle') {
    toast('Durations can be changed when no session is in progress. Reset the session first.', 'info');
    return;
  }
  const [key, min, max] = spec;
  const v = Math.max(min, Math.min(max, D().pomo[key] + delta));
  C.setScalar(D(), 'pomo', key, v, Date.now());
  commitData();
  renderPomoSettings();
  updatePomoDisplay();
}

function renderPomoSettings() {
  const cfg = D().pomo;
  document.getElementById('workVal').textContent = cfg.workMins;
  document.getElementById('shortVal').textContent = cfg.shortMins;
  document.getElementById('longVal').textContent = cfg.longMins;
  document.getElementById('sessionsVal').textContent = cfg.sessionsBeforeLong;
  document.getElementById('autoBreak').checked = cfg.autoBreak;
  document.getElementById('autoWork').checked = cfg.autoWork;
  document.getElementById('soundToggle').checked = cfg.sound;
}

function logTime(l) {
  return l.at ? new Date(l.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : l.label;
}

function renderPomoLog() {
  const el = document.getElementById('pomoLog');
  const list = D().pomo.log;
  if (!list.length) {
    el.innerHTML = '<div class="empty-state" style="padding:20px"><div class="empty-state-icon">🍅</div><div class="empty-state-sub">Sessions will appear here</div></div>';
    return;
  }
  const names = { work: '🍅 Focus', 'short-break': '☕ Short Break', 'long-break': '🌊 Long Break' };
  el.innerHTML = list.slice(0, 15).map((l) => `
    <div class="log-entry ${esc(l.type)}">
      <div style="flex:1">
        <div class="log-entry-label">${esc(names[l.type])} · ${esc(Math.round(l.mins))}m${l.skipped ? ' (skipped)' : ''}</div>
        ${l.task ? `<div class="log-entry-task">${esc(l.task)}</div>` : ''}
      </div>
      <div class="log-entry-time">${esc(logTime(l))}</div>
    </div>`).join('');
}

function clearPomoLog() {
  const now = Date.now();
  for (const l of [...D().pomo.log]) C.removeItem(D(), ['pomo', 'log'], l.id, now);
  commitData();
  renderPomoLog();
}

const MILESTONES = [1, 10, 25, 50, 100, 250, 500];
function announceMilestones(before, after) {
  const hit = MILESTONES.filter((m) => before < m && after >= m).pop();
  if (hit) toast(`🏆 Achievement Unlocked: ${hit === 1 ? 'First Focus' : hit + ' Sessions'}!`, 'success', '🏆');
}

let soundPreviewTimer = null;
function saveSettings(source = '') {
  const now = Date.now();
  const d = D();
  const set = (g, k, v) => { if (d[g][k] !== v) C.setScalar(d, g, k, v, now); };
  set('pomo', 'autoBreak', document.getElementById('autoBreak').checked);
  set('pomo', 'autoWork', document.getElementById('autoWork').checked);
  set('pomo', 'sound', document.getElementById('soundToggle').checked);
  const sound = document.getElementById('soundSelect').value;
  if (C.SOUNDS.includes(sound)) set('settings', 'sound', sound);
  const vol = parseInt(document.getElementById('volumeSlider').value, 10);
  if (Number.isFinite(vol)) set('settings', 'volume', Math.max(0, Math.min(100, vol)));
  commitData();
  if (source === 'soundSelect') playSound(true);
  else if (source === 'volumeSlider') {
    updateAmbientVolume();
    clearTimeout(soundPreviewTimer);
    soundPreviewTimer = setTimeout(() => playSound(true), 120);
  }
}

// ---------------------------------------------------------------------------
// Todos
// ---------------------------------------------------------------------------
const editState = { id: null, tags: [], priority: 'none', pomos: 1, newListColor: '#7c6af7' };

function openAddTask(taskId = null) {
  const task = taskId ? D().todos.items.find((i) => i.id === taskId) : null;
  editState.id = task ? task.id : null;
  editState.tags = task ? [...task.tags] : [];
  editState.priority = task ? task.priority : 'none';
  editState.pomos = task ? task.pomos : 1;
  document.getElementById('taskModalTitle').textContent = task ? 'Edit Task' : 'Add Task';
  document.getElementById('taskNameInput').value = task ? task.text : '';
  document.getElementById('taskNoteInput').value = task ? task.note : '';
  document.getElementById('taskDueInput').value = task ? task.due : '';
  const sel = document.getElementById('taskListInput');
  sel.innerHTML = D().todos.lists.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('');
  sel.value = task && D().todos.lists.some((l) => l.id === task.listId) ? task.listId : 'inbox';
  renderTagInputArea();
  document.querySelectorAll('.prio-btn').forEach((b) => b.classList.toggle('active', b.classList.contains(editState.priority)));
  document.getElementById('estPomos').textContent = editState.pomos;
  openModal('modalAddTask');
  setTimeout(() => document.getElementById('taskNameInput').focus(), 100);
}

function selectPriority(p, el) {
  if (!['high', 'medium', 'low', 'none'].includes(p)) return;
  editState.priority = p;
  document.querySelectorAll('.prio-btn').forEach((b) => b.classList.remove('active'));
  el.classList.add('active');
}

function adjustEstPomos(d) {
  editState.pomos = Math.max(1, Math.min(12, editState.pomos + d));
  document.getElementById('estPomos').textContent = editState.pomos;
}

function handleTagInput(e) {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    const val = e.target.value.replace(/,/g, '').trim().slice(0, C.LIMITS.tag);
    if (val && !editState.tags.includes(val) && editState.tags.length < C.LIMITS.tags) editState.tags.push(val);
    e.target.value = '';
    renderTagInputArea();
    document.getElementById('tagInputField').focus();
  } else if (e.key === 'Backspace' && !e.target.value) {
    editState.tags.pop();
    renderTagInputArea();
    document.getElementById('tagInputField').focus();
  }
}

function renderTagInputArea() {
  const area = document.getElementById('tagInputArea');
  const tags = editState.tags.map((t, i) =>
    `<div class="tag selected" style="background:var(--accent-glow);color:var(--accent2);border-color:var(--accent)" data-action="remove-edit-tag" data-index="${i}">${esc(t)} ✕</div>`
  ).join('');
  area.innerHTML = tags + '<input class="tag-input-field" id="tagInputField" placeholder="Add tags..." onkeydown="handleTagInput(event)">';
}

function saveTask() {
  const name = document.getElementById('taskNameInput').value.trim().slice(0, C.LIMITS.text);
  if (!name) { toast('Task name is required', 'error'); return; }
  const d = D(), now = Date.now();
  const due = document.getElementById('taskDueInput').value;
  const listId = document.getElementById('taskListInput').value;
  const fields = {
    text: name,
    note: document.getElementById('taskNoteInput').value.trim().slice(0, C.LIMITS.note),
    due: C.parseDayKey(due) ? due : '',
    listId: d.todos.lists.some((l) => l.id === listId) ? listId : 'inbox',
    priority: editState.priority,
    tags: [...editState.tags],
    pomos: editState.pomos
  };
  const existing = editState.id ? d.todos.items.find((i) => i.id === editState.id) : null;
  if (existing) {
    Object.assign(existing, fields);
    C.touchItem(d, existing, now);
  } else {
    d.todos.items.unshift(Object.assign({ id: C.newId('t'), completed: false, createdAt: now, updatedAt: now, subtasks: [] }, fields));
  }
  closeModal('modalAddTask');
  commitData();
  renderTodos();
  renderTodoLists();
  toast(existing ? 'Task updated' : 'Task added', 'success');
}

function quickAddTask(e) {
  if (e.key !== 'Enter') return;
  const input = document.getElementById('quickTaskInput');
  const val = input.value.trim().slice(0, C.LIMITS.text);
  if (!val) return;
  const now = Date.now();
  D().todos.items.unshift({ id: C.newId('t'), text: val, note: '', due: '', listId: 'inbox', priority: 'none', tags: [], pomos: 1, completed: false, createdAt: now, updatedAt: now, subtasks: [] });
  input.value = '';
  commitData();
  renderTodos();
  renderTodoLists();
  toast('Task added', 'success');
}

function toggleTodo(id) {
  const t = D().todos.items.find((i) => i.id === id);
  if (!t) return;
  t.completed = !t.completed;
  C.touchItem(D(), t, Date.now());
  commitData();
  renderTodos();
  renderTodoLists();
}

function deleteTodo(id) {
  if (!C.removeItem(D(), ['todos', 'items'], id, Date.now())) return;
  commitData();
  renderTodos();
  renderTodoLists();
}

function startPomoForTask(id) {
  const task = D().todos.items.find((t) => t.id === id);
  if (!task) return;
  document.getElementById('pomoTask').value = task.text.slice(0, C.LIMITS.task);
  navigate('pomodoro');
  toast('Starting Pomodoro for: ' + task.text, 'info', '🍅');
}

function setTodoSort(v) {
  PF().todoSort = ['created', 'priority', 'due', 'name'].includes(v) ? v : 'created';
  commitPrefs();
  renderTodos();
}

function renderTodos() {
  const pf = PF();
  const el = document.getElementById('todoItems');
  const now = new Date();
  let items = [...D().todos.items];
  if (pf.activeList !== 'all') items = items.filter((i) => i.listId === pf.activeList);
  if (pf.activeTag) items = items.filter((i) => i.tags.includes(pf.activeTag));
  const due = (i) => C.describeDue(i.due, now);
  if (pf.activeFilter === 'today') items = items.filter((i) => due(i)?.diff === 0);
  else if (pf.activeFilter === 'upcoming') items = items.filter((i) => due(i)?.diff > 0 && !i.completed);
  else if (pf.activeFilter === 'completed') items = items.filter((i) => i.completed);
  else if (pf.activeFilter === 'priority-high') items = items.filter((i) => i.priority === 'high' && !i.completed);
  const sort = pf.todoSort;
  const sortSel = document.getElementById('todoSort');
  if (sortSel) sortSel.value = sort;
  if (sort === 'priority') { const ord = { high: 0, medium: 1, low: 2, none: 3 }; items.sort((a, b) => ord[a.priority] - ord[b.priority]); }
  else if (sort === 'due') items.sort((a, b) => (a.due ? (b.due ? a.due.localeCompare(b.due) : -1) : b.due ? 1 : 0));
  else if (sort === 'name') items.sort((a, b) => a.text.localeCompare(b.text));
  document.querySelectorAll('#todoFilters .chip').forEach((c) => c.classList.toggle('active', !pf.activeTag && c.dataset.filter === pf.activeFilter));
  if (!items.length) {
    el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">✅</div><div class="empty-state-text">No tasks here</div><div class="empty-state-sub">' +
      (pf.activeTag ? `Showing tag “${esc(pf.activeTag)}” — click it again to clear` : 'Add a task to get started') + '</div></div>';
    return;
  }
  const prioCols = { high: 'var(--red)', medium: 'var(--orange)', low: 'var(--green)', none: 'var(--surface2)' };
  el.innerHTML = items.map((task) => {
    const dd = due(task);
    const id = esc(task.id);
    return `
    <div class="todo-item ${task.completed ? 'completed' : ''}">
      <div class="todo-priority" style="background:${prioCols[task.priority]}"></div>
      <div class="todo-checkbox ${task.completed ? 'checked' : ''}" data-action="toggle-todo" data-id="${id}">
        <svg viewBox="0 0 24 24"><polyline points="20,6 9,17 4,12"/></svg>
      </div>
      <div class="todo-content">
        <div class="todo-text">${esc(task.text)}</div>
        ${task.note ? `<div class="todo-note">${esc(task.note)}</div>` : ''}
        <div class="todo-meta">
          ${dd ? `<span class="badge ${dd.overdue && !task.completed ? 'badge-red' : 'badge-accent'}">${esc(dd.label)}</span>` : ''}
          ${task.tags.map((tg) => `<span class="badge badge-cyan">${esc(tg)}</span>`).join('')}
          ${task.pomos > 1 ? `<span class="badge badge-orange">🍅 ×${esc(task.pomos)}</span>` : ''}
          ${task.subtasks.length ? `<span class="text-xs">${task.subtasks.filter((s) => s.done).length}/${task.subtasks.length} subtasks</span>` : ''}
        </div>
      </div>
      <div class="todo-actions">
        <button class="btn btn-icon btn-ghost" data-action="edit-todo" data-id="${id}" title="Edit">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="btn btn-icon btn-ghost" data-action="pomo-todo" data-id="${id}" title="Start Pomodoro">🍅</button>
        <button class="btn btn-icon btn-danger" data-action="delete-todo" data-id="${id}" title="Delete">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
        </button>
      </div>
    </div>`;
  }).join('');
}

function renderTodoLists() {
  const t = D().todos, pf = PF();
  const el = document.getElementById('todoListsSidebar');
  const open = t.items.filter((i) => !i.completed);
  const lists = [{ id: 'all', name: 'All Tasks', color: 'var(--text2)' }, ...t.lists];
  el.innerHTML = lists.map((l) => {
    const count = l.id === 'all' ? open.length : open.filter((i) => i.listId === l.id).length;
    return `<div class="todo-list-item ${pf.activeList === l.id ? 'active' : ''}" data-action="select-list" data-id="${esc(l.id)}">
      <span style="display:flex;align-items:center;gap:8px">
        <span style="width:8px;height:8px;border-radius:50%;background:${esc(l.color)};flex-shrink:0"></span>
        ${esc(l.name)}
      </span>
      <span class="todo-list-count">${count}</span>
    </div>`;
  }).join('');
  const allTags = [...new Set(t.items.flatMap((i) => i.tags))];
  document.getElementById('todoTagsSidebar').innerHTML = allTags.map((tg) =>
    `<div class="tag${pf.activeTag === tg ? ' selected' : ''}" style="background:var(--cyan-dim);color:var(--cyan)${pf.activeTag === tg ? ';outline:1px solid var(--cyan)' : ''}" data-action="filter-tag" data-tag="${esc(tg)}">${esc(tg)}</div>`
  ).join('');
}

function selectList(id) {
  PF().activeList = id === 'all' || D().todos.lists.some((l) => l.id === id) ? id : 'all';
  commitPrefs();
  renderTodoLists();
  renderTodos();
}

function filterTodo(f) {
  PF().activeFilter = f;
  PF().activeTag = '';
  commitPrefs();
  renderTodoLists();
  renderTodos();
}

function filterByTag(tag) {
  const pf = PF();
  pf.activeTag = pf.activeTag === tag ? '' : tag;
  pf.activeFilter = 'all';
  commitPrefs();
  renderTodoLists();
  renderTodos();
}

function openNewList() { openModal('modalNewList'); }
function selectListColor(c, el) {
  editState.newListColor = c;
  document.querySelectorAll('#modalNewList .color-opt').forEach((o) => o.classList.remove('selected'));
  el.classList.add('selected');
}
function saveNewList() {
  const name = document.getElementById('newListName').value.trim().slice(0, C.LIMITS.name);
  if (!name) { toast('List name is required', 'error'); return; }
  const now = Date.now();
  D().todos.lists.push({ id: C.newId('l'), name, color: editState.newListColor, createdAt: now, updatedAt: now });
  closeModal('modalNewList');
  document.getElementById('newListName').value = '';
  commitData();
  renderTodoLists();
}

// ---------------------------------------------------------------------------
// Countdown timer
// ---------------------------------------------------------------------------
function readTimerInputs() {
  const v = (id, max) => Math.max(0, Math.min(max, parseInt(document.getElementById(id).value, 10) || 0));
  return v('timerH', 23) * 3600 + v('timerM', 59) * 60 + v('timerS', 59);
}
function writeTimerInputs(total) {
  document.getElementById('timerH').value = Math.floor(total / 3600);
  document.getElementById('timerM').value = Math.floor((total % 3600) / 60);
  document.getElementById('timerS').value = total % 60;
}

function renderTimer() {
  const t = RT().timer;
  const remaining = C.timerRemaining(t, Date.now());
  const display = document.getElementById('timerDisplay');
  display.textContent = C.formatHMS(t.status === 'idle' ? t.total : remaining);
  display.className = 'timer-time-big' + (t.status === 'running' ? ' running' : t.status === 'done' ? ' done' : '');
  document.getElementById('timerLabel').textContent =
    t.status === 'running' ? 'COUNTING DOWN' : t.status === 'paused' ? 'PAUSED' : t.status === 'done' ? "TIME'S UP!" : 'SET YOUR TIMER';
  const label = t.status === 'running' ? 'Pause' : t.status === 'paused' ? 'Resume' : 'Start';
  const icon = t.status === 'running'
    ? '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'
    : '<polygon points="5,3 19,12 5,21"/>';
  document.getElementById('timerStartBtn').innerHTML = `<svg viewBox="0 0 24 24" fill="white" style="width:16px;height:16px">${icon}</svg> ${label}`;
  document.getElementById('timerLaps').innerHTML = t.laps.map((lap, i) =>
    `<div class="lap-item"><span class="lap-num">#${i + 1}</span><span class="lap-time">${C.formatHMS(lap)}</span></div>`).reverse().join('');
}

function scheduleTimer() {
  clearHandle('timerTick');
  clearHandle('timerDue');
  const t = RT().timer;
  if (t.status !== 'running') return;
  handles.timerTick = setInterval(tickTimer, 1000);
  scheduleDeadline('timerDue', t.targetEnd, tickTimer);
}

function tickTimer() {
  if (C.timerIsDue(RT().timer, Date.now())) finishTimer(false);
  else renderTimer();
}

async function finishTimer(late) {
  clearHandle('timerTick');
  clearHandle('timerDue');
  const finished = await withLock('zenflow-timer', () => {
    refreshFromStorage();
    const t = RT().timer;
    if (!C.timerIsDue(t, Date.now())) return false;
    C.timerFinish(t, Date.now());
    commitRuntime();
    return true;
  }).catch((e) => { log.error('timer completion failed', { name: e && e.name }); return false; });
  renderTimer();
  if (!finished) { scheduleTimer(); return; }
  playSound();
  const at = new Date(RT().timer.finishedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  showNotification(late ? `⏰ Timer finished at ${at} while you were away` : '⏰ Timer complete!');
}

function updateTimerFromInput() {
  const t = RT().timer;
  if (!C.timerSetTotal(t, readTimerInputs())) return;
  t.activePreset = null;
  commitRuntime();
  renderTimer();
}

function toggleTimer() {
  const t = RT().timer, now = Date.now();
  unlockAudio();
  if (t.status === 'running') {
    C.timerPause(t, now);
  } else {
    if (t.status === 'idle' || t.status === 'done') C.timerSetTotal(t, readTimerInputs());
    const res = C.timerStart(t, now);
    if (!res) { toast('Set a time first', 'error'); return; }
    if (res === 'started') {
      const recent = [{ total: t.total }, ...D().timer.recent.filter((r) => r.total !== t.total)].slice(0, C.LIMITS.recent);
      C.setScalar(D(), 'timer', 'recent', recent, now);
      commitData();
      renderRecentTimers();
    }
  }
  commitRuntime();
  scheduleTimer();
  renderTimer();
}

function resetTimer() {
  const t = RT().timer;
  C.timerReset(t);
  C.timerSetTotal(t, readTimerInputs());
  commitRuntime();
  scheduleTimer();
  renderTimer();
}

function addTimerLap() {
  const t = RT().timer;
  if (t.status !== 'running') return;
  t.laps.push(C.timerRemaining(t, Date.now()));
  commitRuntime();
  renderTimer();
}

function renderTimerPresets() {
  const el = document.getElementById('timerPresetList');
  const active = RT().timer.activePreset;
  el.innerHTML = D().timer.presets.map((p) => `
    <div class="preset-item ${active === p.id ? 'active' : ''}" data-action="apply-preset" data-id="${esc(p.id)}">
      <div><div class="preset-name">${esc(p.name)}</div></div>
      <div class="flex-row" style="gap:8px;align-items:center">
        <span class="preset-duration">${C.formatHMS(p.h * 3600 + p.m * 60 + p.s)}</span>
        <button class="btn btn-icon btn-ghost" data-action="delete-preset" data-id="${esc(p.id)}" style="width:24px;height:24px" title="Delete preset">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>`).join('');
  renderRecentTimers();
}

function applyPreset(id) {
  const p = D().timer.presets.find((x) => x.id === id);
  const t = RT().timer;
  if (!p || t.status === 'running' || t.status === 'paused') return;
  writeTimerInputs(p.h * 3600 + p.m * 60 + p.s);
  C.timerSetTotal(t, readTimerInputs());
  t.activePreset = id;
  commitRuntime();
  renderTimer();
  renderTimerPresets();
}

function deletePreset(id) {
  if (!C.removeItem(D(), ['timer', 'presets'], id, Date.now())) return;
  commitData();
  renderTimerPresets();
}

function openAddPreset() { openModal('modalAddPreset'); }
function savePreset() {
  const name = document.getElementById('presetName').value.trim().slice(0, C.LIMITS.name);
  if (!name) { toast('Name required', 'error'); return; }
  const v = (id, max) => Math.max(0, Math.min(max, parseInt(document.getElementById(id).value, 10) || 0));
  const now = Date.now();
  const preset = { id: C.newId('pr'), name, h: v('presetH', 23), m: v('presetM', 59), s: v('presetS', 59), createdAt: now, updatedAt: now };
  if (preset.h + preset.m + preset.s === 0) { toast('Preset duration must be longer than 0', 'error'); return; }
  D().timer.presets.push(preset);
  closeModal('modalAddPreset');
  commitData();
  renderTimerPresets();
}

function renderRecentTimers() {
  const el = document.getElementById('recentTimers');
  if (!el) return;
  el.innerHTML = D().timer.recent.map((r) => `
    <div class="flex-row justify-between align-center" style="padding:8px 12px;background:var(--bg3);border-radius:8px;cursor:pointer" data-action="apply-recent" data-total="${esc(r.total)}">
      <span class="text-mono text-sm">${C.formatHMS(r.total)}</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;color:var(--text3)"><polygon points="5,3 19,12 5,21"/></svg>
    </div>`).join('');
}

function applyRecent(total) {
  const t = RT().timer;
  if (t.status === 'running' || t.status === 'paused') return;
  writeTimerInputs(Math.max(0, Math.min(86399, total | 0)));
  updateTimerFromInput();
}

// ---------------------------------------------------------------------------
// Stopwatch (rAF-driven: no work while hidden or on another page)
// ---------------------------------------------------------------------------
function renderStopwatch() {
  const sw = RT().sw;
  const ms = C.swElapsed(sw, Date.now());
  const full = C.formatMs(ms);
  document.getElementById('swMain').textContent = full.slice(0, 8);
  document.getElementById('swMs').textContent = full.slice(8);
  const running = sw.status === 'running';
  document.getElementById('swMain').parentElement.className = 'sw-time' + (running ? ' running' : '');
  const btn = document.getElementById('swStartBtn');
  const label = running ? 'Pause' : sw.status === 'paused' ? 'Resume' : 'Start';
  const icon = running ? '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>' : '<polygon points="5,3 19,12 5,21"/>';
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="white" style="width:18px;height:18px">${icon}</svg> ${label}`;
  btn.className = 'btn btn-xl ' + (running ? 'btn-danger' : sw.status === 'paused' ? 'btn-success' : 'btn-primary');
  document.getElementById('swLapBtn').disabled = !running;
  document.getElementById('swResetBtn').disabled = sw.status === 'idle';
}

function swFrame() {
  handles.swRaf = null;
  if (RT().sw.status !== 'running') return;
  if (document.getElementById('page-stopwatch').classList.contains('active')) renderStopwatch();
  handles.swRaf = requestAnimationFrame(swFrame);
}
function scheduleStopwatch() {
  clearHandle('swRaf');
  if (RT().sw.status === 'running') handles.swRaf = requestAnimationFrame(swFrame);
}

function toggleStopwatch() {
  const sw = RT().sw, now = Date.now();
  if (sw.status === 'running') C.swPause(sw, now);
  else C.swStart(sw, now);
  commitRuntime();
  scheduleStopwatch();
  renderStopwatch();
}

function addLap() {
  if (!C.swLap(RT().sw, Date.now())) return;
  commitRuntime();
  renderLaps();
}

function renderLaps() {
  const sw = RT().sw;
  const el = document.getElementById('lapsList');
  document.getElementById('lapCount').textContent = sw.laps.length + ' laps';
  if (!sw.laps.length) {
    el.innerHTML = '<div class="empty-state" style="padding:24px"><div class="empty-state-icon">⏱️</div><div class="empty-state-sub">Lap times will appear here</div></div>';
    return;
  }
  const times = sw.laps.map((l) => l.lap);
  const best = Math.min(...times), worst = Math.max(...times);
  el.innerHTML = [...sw.laps].reverse().map((l) => {
    const cls = sw.laps.length > 1 ? (l.lap === best ? 'best' : l.lap === worst ? 'worst' : '') : '';
    return `<div class="lap-item ${cls}">
      <span class="lap-num">L${l.num}</span>
      <span class="lap-time">${C.formatMs(l.total)}</span>
      <span class="lap-split">+${C.formatMs(l.lap)}</span>
    </div>`;
  }).join('');
}

function resetStopwatch() {
  C.swReset(RT().sw);
  commitRuntime();
  scheduleStopwatch();
  renderStopwatch();
  renderLaps();
}

// ---------------------------------------------------------------------------
// Time tracking
// ---------------------------------------------------------------------------
function renderTracker() {
  const tr = RT().tracking;
  const running = tr.status === 'running';
  const btn = document.getElementById('trackerBtn');
  const icon = running ? '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>' : '<polygon points="5,3 19,12 5,21"/>';
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px">${icon}</svg> ${running ? 'Stop' : 'Start'}`;
  btn.className = 'btn ' + (running ? 'btn-danger' : 'btn-success');
  document.getElementById('trackerPulse').classList.toggle('active', running);
  const timerEl = document.getElementById('trackerTimer');
  timerEl.className = 'tracker-time' + (running ? ' running' : '');
  timerEl.textContent = C.formatHMS(running ? (Date.now() - tr.startTime) / 1000 : 0);
}

function scheduleTracker() {
  clearHandle('track');
  if (RT().tracking.status === 'running') handles.track = setInterval(renderTracker, 1000);
}

function toggleTracking() {
  const tr = RT().tracking, now = Date.now();
  if (tr.status === 'running') {
    const entry = C.trackStop(D(), tr, now);
    store.touchRuntime();
    commitData();
    if (entry) toast('Entry saved: ' + C.formatDuration(entry.duration), 'success');
    else toast(`Entries shorter than ${C.MIN_TRACKED_SECS} seconds are not saved`, 'info');
    renderTrackingPage();
  } else {
    C.trackStart(tr, {
      desc: document.getElementById('trackerDesc').value,
      project: document.getElementById('trackerProject').value,
      tag: document.getElementById('trackerPriority').value
    }, now);
    commitRuntime();
  }
  scheduleTracker();
  renderTracker();
}

function renderTrackingPage() {
  renderTrackingEntries();
  renderTrackingSummary();
  renderProjectsList();
  populateProjectDropdowns();
  document.querySelectorAll('#page-tracking .chip').forEach((c) => c.classList.toggle('active', c.dataset.filter === PF().trackingFilter));
}

function projectById(id) {
  return D().tracking.projects.find((p) => p.id === id) || null;
}

function renderTrackingEntries() {
  const el = document.getElementById('trackingEntries');
  const filter = PF().trackingFilter;
  const today = C.localDayKey();
  let entries = D().tracking.entries;
  if (filter === 'today') entries = entries.filter((e) => C.localDayKey(e.start) === today);
  else if (filter === 'week') { const from = Date.now() - 7 * 86400000; entries = entries.filter((e) => e.start >= from); }
  if (!entries.length) {
    el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">⏱️</div><div class="empty-state-text">No time entries</div><div class="empty-state-sub">Start the tracker or add a manual entry</div></div>';
    return;
  }
  const byDay = new Map();
  for (const e of entries) {
    const k = C.localDayKey(e.start);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(e);
  }
  const hm = (t) => new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = [...byDay].map(([day, ents]) => {
    const total = ents.reduce((a, e) => a + e.duration, 0);
    return `<div class="date-header">${esc(C.parseDayKey(day).toDateString())} · ${C.formatDuration(total)}</div>` + ents.map((e) => {
      const proj = projectById(e.project);
      return `<div class="entry-item">
        <div class="entry-dot proj-dot-${proj ? proj.color : 0}" style="width:10px;height:10px;border-radius:50%;flex-shrink:0"></div>
        <div style="flex:1">
          <div class="entry-desc">${esc(e.desc || 'Untitled')}</div>
          <div class="entry-project">${proj ? esc(proj.name) : ''} ${e.tag && e.tag !== 'none' ? '· ' + esc(e.tag) : ''}</div>
        </div>
        <div class="entry-time">${hm(e.start)} – ${hm(e.end)}</div>
        <div class="entry-duration">${C.formatDuration(e.duration)}</div>
        <div class="entry-actions">
          <button class="btn btn-icon btn-danger" data-action="delete-entry" data-id="${esc(e.id)}" title="Delete entry">✕</button>
        </div>
      </div>`;
    }).join('');
  }).join('');
}

function deleteEntry(id) {
  if (!C.removeItem(D(), ['tracking', 'entries'], id, Date.now())) return;
  commitData();
  renderTrackingPage();
}

function renderTrackingSummary() {
  const today = C.localDayKey();
  const todayEntries = D().tracking.entries.filter((e) => C.localDayKey(e.start) === today);
  const total = todayEntries.reduce((a, e) => a + e.duration, 0);
  document.getElementById('trackingSummaryToday').innerHTML = `
    <div class="stat-value text-mono">${C.formatDuration(total)}</div>
    <div class="text-xs mt-4">${todayEntries.length} entries today</div>
    <div class="progress-bar mt-8" style="height:6px">
      <div class="progress-fill" style="width:${Math.min(100, (total / 28800) * 100)}%;background:var(--accent)"></div>
    </div>
    <div class="text-xs mt-4">Goal: 8 hours</div>`;
  const projEl = document.getElementById('trackingByProject');
  const byProj = new Map();
  for (const e of todayEntries) byProj.set(e.project || '', (byProj.get(e.project || '') || 0) + e.duration);
  const rows = [...byProj].sort((a, b) => b[1] - a[1]);
  if (!rows.length) { projEl.innerHTML = '<div class="text-xs" style="color:var(--text3)">No data today</div>'; return; }
  projEl.innerHTML = rows.map(([pid, dur]) => {
    const proj = projectById(pid);
    const color = proj ? proj.color : 0;
    return `<div class="flex-row justify-between align-center mb-8">
      <div class="flex-row align-center" style="gap:8px">
        <div class="proj-dot-${color}" style="width:8px;height:8px;border-radius:50%"></div>
        <span class="text-sm">${proj ? esc(proj.name) : 'No Project'}</span>
      </div>
      <span class="text-mono text-xs">${C.formatDuration(dur)}</span>
    </div>
    <div class="progress-bar mb-8"><div class="progress-fill" style="width:${Math.round((dur / total) * 100)}%;background:${C.PROJECT_COLORS[color]}"></div></div>`;
  }).join('');
}

function renderProjectsList() {
  document.getElementById('projectsList').innerHTML = D().tracking.projects.map((p) => `
    <div class="flex-row justify-between align-center mb-8">
      <div class="flex-row align-center" style="gap:8px">
        <div style="width:10px;height:10px;border-radius:50%;background:${C.PROJECT_COLORS[p.color]}"></div>
        <span class="text-sm">${esc(p.name)}</span>
      </div>
      <button class="btn btn-icon btn-ghost" data-action="delete-project" data-id="${esc(p.id)}" style="width:24px;height:24px" title="Delete project">✕</button>
    </div>`).join('');
}

function populateProjectDropdowns() {
  const opts = '<option value="">No Project</option>' + D().tracking.projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  ['trackerProject', 'manualProject'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const v = el.value;
    el.innerHTML = opts;
    el.value = D().tracking.projects.some((p) => p.id === v) ? v : '';
  });
}

function openAddProject() { openModal('modalAddProject'); }
function saveProject() {
  const name = document.getElementById('projectName').value.trim().slice(0, C.LIMITS.name);
  if (!name) { toast('Name required', 'error'); return; }
  const now = Date.now();
  const used = new Set(D().tracking.projects.map((p) => p.color));
  const color = [0, 1, 2, 3, 4, 5, 6, 7].find((c) => !used.has(c)) ?? D().tracking.projects.length % 8;
  D().tracking.projects.push({ id: C.newId('pj'), name, color, createdAt: now, updatedAt: now });
  closeModal('modalAddProject');
  document.getElementById('projectName').value = '';
  commitData();
  renderTrackingPage();
}
function deleteProject(id) {
  if (!C.removeItem(D(), ['tracking', 'projects'], id, Date.now())) return;
  commitData();
  renderTrackingPage();
}

function filterTracking(f) {
  PF().trackingFilter = ['all', 'today', 'week'].includes(f) ? f : 'all';
  commitPrefs();
  renderTrackingPage();
}

function openAddManualEntry() {
  const now = new Date();
  const hm = C.pad(now.getHours()) + ':' + C.pad(now.getMinutes());
  document.getElementById('manualDate').value = C.localDayKey(now);
  document.getElementById('manualStart').value = hm;
  document.getElementById('manualEnd').value = hm;
  populateProjectDropdowns();
  openModal('modalManualEntry');
}

function saveManualEntry() {
  const desc = document.getElementById('manualDesc').value.trim().slice(0, C.LIMITS.desc);
  const startTime = document.getElementById('manualStart').value;
  const endTime = document.getElementById('manualEnd').value;
  const date = document.getElementById('manualDate').value;
  if (!startTime || !endTime || !C.parseDayKey(date)) { toast('Fill in all fields', 'error'); return; }
  // "YYYY-MM-DDTHH:MM" without a zone is parsed as local time.
  const start = new Date(date + 'T' + startTime).getTime();
  const end = new Date(date + 'T' + endTime).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) { toast('End time must be after start time', 'error'); return; }
  const project = document.getElementById('manualProject').value;
  const now = Date.now();
  D().tracking.entries.unshift({
    id: C.newId('e'), desc: desc || 'Manual Entry', project: projectById(project) ? project : '', tag: 'none',
    start, end, duration: Math.round((end - start) / 1000), updatedAt: now
  });
  D().tracking.entries.sort((a, b) => b.start - a.start);
  closeModal('modalManualEntry');
  document.getElementById('manualDesc').value = '';
  commitData();
  renderTrackingPage();
  toast('Entry added', 'success');
}

// ---------------------------------------------------------------------------
// Analytics / forest
// ---------------------------------------------------------------------------
const TREES = ['🌱', '🌿', '🌲', '🌳', '🎄', '🌴', '🌵', '🎋', '🍀', '🎍'];
const DEAD_TREES = ['🪵', '🍂', '🍃'];
const minsOf = (secs) => Math.round(secs / 60);

function dayKeysBack(n) {
  const today = C.parseDayKey(C.localDayKey());
  return Array.from({ length: n }, (_, i) => C.localDayKey(C.addDays(today, -i)));
}

function renderForest() {
  renderAnalyticsStats();
  renderGarden();
  renderStreak();
  renderHeatmap();
  renderWeekBar();
  renderFocusScore();
  renderAchievements();
  renderProductivityReport();
}

function renderAnalyticsStats() {
  const stats = D().stats;
  const today = C.dayTotals(stats, C.localDayKey());
  const weekSecs = dayKeysBack(7).reduce((a, k) => a + C.dayTotals(stats, k).secs, 0);
  const activeDays = Object.keys(stats.daily).filter((k) => C.dayTotals(stats, k).secs > 0).length;
  const life = C.lifetimeTotals(stats);
  const items = D().todos.items;
  document.getElementById('analyticsStats').innerHTML = [
    { label: "Today's Focus", value: C.formatDuration(today.secs), sub: `${today.sessions} sessions`, color: 'var(--accent)' },
    { label: 'This Week', value: C.formatDuration(weekSecs), sub: `${activeDays} active days`, color: 'var(--green)' },
    { label: 'Total Sessions', value: String(life.sessions), sub: `${C.formatDuration(life.focusSecs)} focused`, color: 'var(--orange)' },
    { label: 'Tasks Done', value: String(items.filter((t) => t.completed).length), sub: `${items.length} total`, color: 'var(--cyan)' }
  ].map((s) => `<div class="stat-card" style="border-left:3px solid ${s.color}">
    <div class="stat-value" style="color:${s.color}">${esc(s.value)}</div>
    <div class="stat-label">${esc(s.label)}</div>
    <div class="text-xs">${esc(s.sub)}</div>
  </div>`).join('');
}

function renderGarden() {
  const garden = D().pomo.garden;
  const el = document.getElementById('gardenGrid');
  document.getElementById('gardenCount').textContent = garden.filter((g) => !g.abandoned).length + ' trees';
  if (!garden.length) {
    el.innerHTML = '<div class="text-xs" style="color:var(--text3);grid-column:1/-1;padding:20px;text-align:center">Complete focus sessions to grow your garden 🌱</div>';
    return;
  }
  el.innerHTML = [...garden].reverse().slice(0, 60).map((g, i) => {
    const emoji = g.abandoned ? DEAD_TREES[i % DEAD_TREES.length] : TREES[Math.min(Math.floor(g.mins / 5), TREES.length - 1)];
    const when = g.at ? new Date(g.at).toLocaleDateString() : '';
    return `<div class="tree-item ${g.abandoned ? 'tree-dead' : ''}" title="${esc(g.task || 'Focus session')} · ${Math.round(g.mins)}m · ${esc(when)}">
      <div class="tree-emoji">${emoji}</div>
      <div class="tree-mins">${Math.round(g.mins)}m</div>
    </div>`;
  }).join('');
}

function renderStreak() {
  const stats = D().stats;
  const { current, longest } = C.computeStreak(stats, Date.now());
  document.getElementById('streakNum').textContent = current;
  document.getElementById('streakSub').textContent = current > 0 ? `${current} day${current !== 1 ? 's' : ''} in a row!` : 'Start a session today!';
  document.getElementById('longestStreak').textContent = `Longest: ${longest} day${longest !== 1 ? 's' : ''}`;
  const today = C.parseDayKey(C.localDayKey());
  const todayIdx = today.getDay();
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  document.getElementById('weekGrid').innerHTML = names.map((name, i) => {
    const date = C.addDays(today, i - todayIdx);
    const mins = minsOf(C.dayTotals(stats, C.localDayKey(date)).secs);
    return `<div class="week-day ${i === todayIdx ? 'today' : ''}">
      <div class="week-day-label">${name}</div>
      <div class="week-day-num">${date.getDate()}</div>
      <div class="week-day-bar" title="${mins}m focused">
        <div class="week-day-fill" style="height:${Math.min(100, Math.round((mins / 120) * 100))}%;background:var(--accent);opacity:0.8"></div>
      </div>
      <div class="week-day-val">${mins ? mins + 'm' : ''}</div>
    </div>`;
  }).join('');
}

function renderHeatmap() {
  const stats = D().stats;
  const today = C.parseDayKey(C.localDayKey());
  let start = C.addDays(today, -371);
  start = C.addDays(start, -start.getDay());
  const cells = [];
  for (let i = 0; i < 371; i++) {
    const d = C.addDays(start, i);
    const k = C.localDayKey(d);
    const mins = minsOf(C.dayTotals(stats, k).secs);
    let intensity = mins > 180 ? 5 : mins > 120 ? 4 : mins > 60 ? 3 : mins > 30 ? 2 : mins > 0 ? 1 : 0;
    if (d > today) intensity = -1;
    cells.push({ d, k, intensity, mins });
  }
  document.getElementById('heatmapGrid').innerHTML = cells.map((c) => (c.intensity === -1
    ? '<div class="heatmap-cell" style="background:transparent"></div>'
    : `<div class="heatmap-cell heatmap-${c.intensity}" title="${c.k}: ${c.mins}m"></div>`)).join('');
  const monthEl = document.getElementById('heatmapMonths');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  monthEl.style.cssText = 'display:flex;gap:0;margin-bottom:4px;font-size:10px;color:var(--text3);';
  const seen = new Set();
  monthEl.innerHTML = cells.filter((_, i) => i % 7 === 0).map((c) => {
    const m = c.d.getMonth();
    const label = seen.has(m) ? '' : months[m];
    seen.add(m);
    return `<span style="flex:1;min-width:0">${label}</span>`;
  }).join('');
}

function renderWeekBar() {
  const stats = D().stats;
  const today = C.parseDayKey(C.localDayKey());
  const todayIdx = today.getDay();
  const data = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label, i) => ({
    label, mins: minsOf(C.dayTotals(stats, C.localDayKey(C.addDays(today, i - todayIdx))).secs), isToday: i === todayIdx
  }));
  const maxMins = Math.max(...data.map((d) => d.mins), 1);
  document.getElementById('weekBarChart').innerHTML = data.map((d) => `
    <div class="bar-col">
      <div class="bar-val">${d.mins ? d.mins + 'm' : ''}</div>
      <div class="bar-wrap">
        <div class="bar" style="height:${Math.max(4, (d.mins / maxMins) * 140)}px;background:${d.isToday ? 'var(--accent)' : 'var(--surface2)'}" title="${d.label}: ${d.mins}m"></div>
      </div>
      <div class="bar-label" style="${d.isToday ? 'color:var(--accent2)' : ''}">${d.label}</div>
    </div>`).join('');
}

function renderFocusScore() {
  const stats = D().stats;
  const life = C.lifetimeTotals(stats);
  const todayMins = minsOf(C.dayTotals(stats, C.localDayKey()).secs);
  const streak = C.computeStreak(stats, Date.now()).current;
  const parts = [
    { label: 'Sessions', val: Math.min(40, (life.sessions / 10) * 40), max: 40, color: 'var(--accent)' },
    { label: "Today's focus", val: Math.min(30, (todayMins / 120) * 30), max: 30, color: 'var(--green)' },
    { label: 'Tasks done', val: Math.min(20, (D().todos.items.filter((t) => t.completed).length / 5) * 20), max: 20, color: 'var(--orange)' },
    { label: 'Streak bonus', val: Math.min(10, streak * 2), max: 10, color: 'var(--cyan)' }
  ];
  const total = Math.round(parts.reduce((a, p) => a + p.val, 0));
  document.getElementById('focusScoreNum').textContent = total;
  const ring = document.getElementById('focusScoreRing');
  if (ring) ring.style.strokeDashoffset = 314 - 314 * (total / 100);
  document.getElementById('focusScoreBreakdown').innerHTML = parts.map((f) => `<div>
    <div class="flex-row justify-between align-center mb-4">
      <span class="text-xs">${f.label}</span>
      <span class="text-mono text-xs">${Math.round(f.val)}/${f.max}</span>
    </div>
    <div class="progress-bar"><div class="progress-fill" style="width:${(f.val / f.max) * 100}%;background:${f.color}"></div></div>
  </div>`).join('');
}

function renderAchievements() {
  const d = D();
  const life = C.lifetimeTotals(d.stats);
  const streak = C.computeStreak(d.stats, Date.now()).current;
  const trees = d.pomo.garden.filter((g) => !g.abandoned).length;
  const bestDay = Math.max(0, ...Object.keys(d.stats.daily).map((k) => C.dayTotals(d.stats, k).secs));
  const achs = [
    ['🍅', 'First Focus', 'Complete your first Pomodoro', life.sessions >= 1],
    ['🔟', '10 Sessions', 'Complete 10 focus sessions', life.sessions >= 10],
    ['💯', 'Century', 'Complete 100 focus sessions', life.sessions >= 100],
    ['✅', 'Task Master', 'Complete 10 tasks', d.todos.items.filter((t) => t.completed).length >= 10],
    ['📋', 'List Builder', 'Create 3 task lists', d.todos.lists.length >= 3],
    ['🔥', 'On Fire', 'Maintain a 3-day streak', streak >= 3],
    ['🌊', 'Flow State', '7-day streak', streak >= 7],
    ['⚡', 'Unstoppable', '30-day streak', streak >= 30],
    ['🌳', 'Gardener', 'Grow 10 trees', trees >= 10],
    ['🌲', 'Forest', 'Grow 50 trees', trees >= 50],
    ['⏰', 'Time Keeper', 'Log 10 time entries', d.tracking.entries.length >= 10],
    ['🎯', 'Goal Crusher', 'Focus 2+ hours in a day', bestDay >= 7200]
  ];
  document.getElementById('achievementsGrid').innerHTML = achs.map(([icon, title, desc, ok]) => `
    <div class="achievement ${ok ? 'unlocked' : 'locked'}">
      <div class="ach-icon">${icon}</div>
      <div><div class="ach-title">${title}</div><div class="ach-desc">${desc}</div></div>
    </div>`).join('');
}

function renderProductivityReport() {
  const d = D();
  const days = Object.keys(d.stats.daily).map((k) => [k, C.dayTotals(d.stats, k).secs]).filter(([, s]) => s > 0);
  const totalFocus = days.reduce((a, [, s]) => a + s, 0);
  const tracked = d.tracking.entries.reduce((a, e) => a + e.duration, 0);
  const best = days.sort((a, b) => b[1] - a[1])[0];
  const card = (label, value, size) => `<div style="background:var(--bg3);border-radius:10px;padding:14px">
    <div class="text-xs text-mono" style="color:var(--text3)">${label}</div>
    <div class="stat-value text-mono mt-4" style="font-size:${size}px">${esc(value)}</div></div>`;
  document.getElementById('productivityReport').innerHTML = `<div class="grid-4" style="gap:12px;margin-bottom:16px">
    ${card('TOTAL FOCUS TIME', C.formatDuration(totalFocus), 22)}
    ${card('TRACKED TIME', C.formatDuration(tracked), 22)}
    ${card('ACTIVE DAYS', String(days.length), 22)}
    ${card('BEST DAY', best ? best[0].slice(5) + '·' + minsOf(best[1]) + 'm' : '—', 16)}
  </div>`;
}

function downloadJson(obj, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportReport() {
  downloadJson(C.makeBackup(D(), Date.now()), 'zenflow-report.json');
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function hexToRgba(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}
function applyAccent(c, c2) {
  document.documentElement.style.setProperty('--accent', c);
  document.documentElement.style.setProperty('--accent2', c2);
  document.documentElement.style.setProperty('--accent-glow', hexToRgba(c, 0.2));
}
function setAccent(c, c2) {
  if (!/^#[0-9a-fA-F]{6}$/.test(c) || !/^#[0-9a-fA-F]{6}$/.test(c2)) return;
  const now = Date.now();
  C.setScalar(D(), 'settings', 'accent', c, now);
  C.setScalar(D(), 'settings', 'accent2', c2, now);
  applyAccent(c, c2);
  document.querySelectorAll('#colorOptions .color-opt').forEach((o) => o.classList.toggle('selected', o.dataset.c === c));
  commitData();
}
function applyBgStyle(style) {
  const darker = style === 'darker';
  document.documentElement.style.setProperty('--bg', darker ? '#060608' : '#0a0a0f');
  document.documentElement.style.setProperty('--bg2', darker ? '#0c0c10' : '#111118');
}
function applyThemeMode(mode) {
  const light = mode === 'light';
  document.body.classList.toggle('theme-light', light);
  if (!light) applyBgStyle(D().settings.bgStyle);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#f3f6ff' : '#0a0a0f');
  const bgSelect = document.getElementById('bgStyleSelect');
  if (bgSelect) bgSelect.disabled = light;
}
function setThemeMode(mode) {
  C.setScalar(D(), 'settings', 'theme', mode === 'light' ? 'light' : 'dark', Date.now());
  applyThemeMode(D().settings.theme);
  commitData();
}
function setBgStyle(v) {
  C.setScalar(D(), 'settings', 'bgStyle', v === 'darker' ? 'darker' : 'dark', Date.now());
  if (D().settings.theme === 'dark') applyBgStyle(D().settings.bgStyle);
  commitData();
}

// ---------------------------------------------------------------------------
// Ambient audio (device-local preference)
// ---------------------------------------------------------------------------
const AMBIENT_SOUNDS = [
  { id: 'rain', name: 'Rain', label: '🌧️ Rain', desc: 'Steady rainfall' },
  { id: 'forest', name: 'Forest', label: '🌲 Forest', desc: 'Birds & breeze' },
  { id: 'cafe', name: 'Cafe', label: '☕ Cafe', desc: 'Ambient chatter' },
  { id: 'ocean', name: 'Ocean', label: '🌊 Ocean', desc: 'Waves crashing' },
  { id: 'fire', name: 'Fireplace', label: '🔥 Fireplace', desc: 'Crackling fire' },
  { id: 'white', name: 'White Noise', label: '🔊 White Noise', desc: 'Pure white noise' }
];
const AMBIENT_FILES = {
  rain: 'assets/ambient/rain.mp3', forest: 'assets/ambient/forest.mp3', cafe: 'assets/ambient/cafe.mp3',
  ocean: 'assets/ambient/ocean.mp3', fire: 'assets/ambient/fireplace.mp3', white: 'assets/ambient/white_noise.mp3'
};
const ambientPlayer = { audio: null, activeId: null, unlockBound: false, expectPause: false, systemPaused: false };
const getAmbientName = (id) => AMBIENT_SOUNDS.find((s) => s.id === id)?.name || 'Ambient';

function ensureAmbientAudio() {
  if (ambientPlayer.audio) return ambientPlayer.audio;
  const audio = new Audio();
  audio.loop = true;
  audio.preload = 'auto';
  // Distinguish pauses we caused, pauses by the OS while hidden (resume on
  // return) and pauses by the user via system media controls (respect them).
  audio.addEventListener('pause', () => {
    if (ambientPlayer.expectPause) { ambientPlayer.expectPause = false; return; }
    if (document.hidden) { ambientPlayer.systemPaused = true; return; }
    if (PF().ambientPlaying) {
      PF().ambientPlaying = false;
      commitPrefs();
      updateAmbientBadge(false);
      renderSettings();
    }
  });
  audio.addEventListener('error', () => log.warn('ambient audio failed to load', { id: ambientPlayer.activeId }));
  ambientPlayer.audio = audio;
  return audio;
}
function updateAmbientVolume() {
  if (ambientPlayer.audio) ambientPlayer.audio.volume = D().settings.volume / 100;
}

async function playAmbient(id, showErrorToast = false) {
  const src = AMBIENT_FILES[id];
  if (!src) return false;
  const audio = ensureAmbientAudio();
  updateAmbientVolume();
  if (ambientPlayer.activeId !== id || !audio.src.endsWith(src)) {
    audio.src = src;
    ambientPlayer.activeId = id;
  }
  try {
    await audio.play();
    PF().ambient = id;
    PF().ambientPlaying = true;
    commitPrefs();
    updateAmbientBadge(true, getAmbientName(id));
    return true;
  } catch (err) {
    updateAmbientBadge(false);
    if (showErrorToast) toast('The browser blocked playback. Tap Play again to allow ambient audio.', 'info', '🎵');
    return false;
  }
}

function stopAmbientPlayback() {
  if (ambientPlayer.audio && !ambientPlayer.audio.paused) {
    ambientPlayer.expectPause = true;
    ambientPlayer.audio.pause();
  }
  PF().ambient = null;
  PF().ambientPlaying = false;
  ambientPlayer.activeId = null;
  commitPrefs();
  updateAmbientBadge(false);
}

function queueAmbientResumeOnInteraction() {
  if (ambientPlayer.unlockBound || !PF().ambientPlaying) return;
  ambientPlayer.unlockBound = true;
  const events = ['pointerdown', 'keydown', 'touchstart'];
  const resume = () => {
    events.forEach((ev) => document.removeEventListener(ev, resume, true));
    ambientPlayer.unlockBound = false;
    if (PF().ambientPlaying && PF().ambient) playAmbient(PF().ambient, false);
  };
  events.forEach((ev) => document.addEventListener(ev, resume, true));
}

function renderSettings() {
  const pf = PF();
  document.getElementById('ambientSoundsList').innerHTML = AMBIENT_SOUNDS.map((s) => {
    const on = pf.ambient === s.id && pf.ambientPlaying;
    return `<div class="settings-row">
      <div><div class="settings-row-label">${s.label}</div><div class="settings-row-sub">${s.desc}</div></div>
      <button class="btn ${on ? 'btn-primary' : 'btn-ghost'}" data-action="toggle-ambient" data-id="${s.id}">${on ? 'Playing' : 'Play'}</button>
    </div>`;
  }).join('');
}

async function setAmbient(id, forcePlay = false) {
  closeCtxMenu();
  if (!id || !AMBIENT_FILES[id]) {
    stopAmbientPlayback();
  } else if (forcePlay || PF().ambient !== id || !PF().ambientPlaying) {
    if (await playAmbient(id, true)) toast(`Now playing: ${getAmbientName(id)}`, 'info', '🎵');
  } else {
    stopAmbientPlayback();
  }
  renderSettings();
}

function toggleAmbient() {
  const menu = document.getElementById('ctxMenu');
  if (menu && menu.style.display === 'block' && menu.dataset.mode === 'ambient') { closeCtxMenu(); return; }
  openAmbientPicker();
}

function openAmbientPicker() {
  const menu = document.getElementById('ctxMenu');
  const badge = document.getElementById('ambientBadge');
  if (!menu || !badge) return;
  const current = PF().ambientPlaying ? PF().ambient : null;
  menu.dataset.mode = 'ambient';
  menu.innerHTML = AMBIENT_SOUNDS.map((s) => `
    <div class="ctx-item ${current === s.id ? 'active' : ''}" data-action="pick-ambient" data-id="${s.id}">
      <span>${current === s.id ? '✓' : '♪'}</span><span>${s.label}</span>
    </div>`).join('') + '<div class="ctx-divider"></div><div class="ctx-item danger" data-action="pick-ambient" data-id="">Stop Ambient</div>';
  menu.style.display = 'block';
  menu.style.visibility = 'hidden';
  const rect = badge.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.right + window.scrollX - menu.offsetWidth, window.scrollX + window.innerWidth - menu.offsetWidth - 8));
  const top = Math.max(8, Math.min(rect.bottom + window.scrollY + 8, window.scrollY + window.innerHeight - menu.offsetHeight - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.visibility = 'visible';
}

function closeCtxMenu() {
  const menu = document.getElementById('ctxMenu');
  if (!menu) return;
  menu.style.display = 'none';
  menu.style.visibility = 'hidden';
  menu.dataset.mode = '';
}

function updateAmbientBadge(playing, label = '') {
  document.getElementById('ambientBadge').classList.toggle('playing', playing);
  document.getElementById('ambientWave').style.display = playing ? 'flex' : 'none';
  document.getElementById('ambientLabel').textContent = playing ? '🎵 ' + label : '🎵 Ambient';
}

// ---------------------------------------------------------------------------
// Data: export / import / reset
// ---------------------------------------------------------------------------
function exportData() {
  downloadJson(C.makeBackup(D(), Date.now()), 'zenflow-backup.json');
  toast('Data exported', 'success');
}

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
function importData(e) {
  const input = e.target;
  const file = input.files && input.files[0];
  input.value = ''; // allow re-importing the same file
  if (!file) return;
  if (file.size > MAX_IMPORT_BYTES) { toast('That file is too large to be a ZenFlow backup.', 'error'); return; }
  const reader = new FileReader();
  reader.onerror = () => toast('Could not read the file.', 'error');
  reader.onload = () => {
    let imported;
    try {
      imported = C.parseBackup(String(reader.result));
    } catch (err) {
      toast(err instanceof C.ZenError ? err.message : 'Invalid backup file', 'error');
      return;
    }
    const counts = `${imported.todos.items.length} tasks, ${imported.tracking.entries.length} time entries, ${imported.pomo.garden.length} focus sessions`;
    if (!window.confirm(`Import this backup (${counts})?\n\nIt is merged into your current data: nothing you have now is removed, and the backup's settings are applied.`)) return;
    const now = Date.now();
    store.replaceData(C.merge(D(), C.prepareImport(D(), imported, now), now));
    commitData();
    refreshUiFromState();
    toast('Backup imported', 'success');
  };
  reader.readAsText(file);
}

async function confirmReset() {
  const signedIn = isSignedIn();
  const msg = signedIn
    ? 'Delete ALL ZenFlow data?\n\nThis permanently deletes your data on this device AND in your cloud account, then logs you out. This cannot be undone.'
    : 'Delete all ZenFlow data stored on this device? This cannot be undone.';
  if (!window.confirm(msg)) return;
  if (signedIn) {
    try {
      await sync.deleteCloudData(10000);
    } catch (err) {
      toast('Could not delete your cloud data: ' + cloudErrorMessage(S.errCode(err)) + ' Nothing was deleted.', 'error');
      return;
    }
  }
  stopRuntimeTimers();
  stopAmbientPlayback();
  if (signedIn) {
    try { await sync.signOut(); } catch (err) { log.warn('sign-out after reset failed', { code: S.errCode(err) }); }
  }
  store.clearAll(); // ZenFlow keys only; other apps on this origin are untouched
  location.reload();
}

// ---------------------------------------------------------------------------
// Focus mode
// ---------------------------------------------------------------------------
function openFocusMode() { document.getElementById('focusModeOverlay').classList.add('active'); updatePomoDisplay(); }
function closeFocusMode() { document.getElementById('focusModeOverlay').classList.remove('active'); }

// ---------------------------------------------------------------------------
// Home hero
// ---------------------------------------------------------------------------
function renderHomeHero() {
  const stats = D().stats;
  const todayMins = minsOf(C.dayTotals(stats, C.localDayKey()).secs);
  const streak = C.computeStreak(stats, Date.now()).current;
  const titleEl = document.getElementById('heroWelcomeTitle');
  if (titleEl) titleEl.textContent = isSignedIn() ? `Welcome back, ${getDisplayNickname()}. Let's build momentum.` : 'Own your day with calm, intentional focus.';
  const accountBtn = document.getElementById('heroAccountBtn');
  if (accountBtn) accountBtn.style.display = isSignedIn() ? 'none' : 'inline-flex';
  document.getElementById('heroTodayFocus').textContent = `${todayMins}m`;
  document.getElementById('heroTotalSessions').textContent = String(C.lifetimeTotals(stats).sessions);
  document.getElementById('heroStreakDays').textContent = `${streak}d`;
}

// ---------------------------------------------------------------------------
// Whole-UI refresh & runtime restore
// ---------------------------------------------------------------------------
function refreshUiFromState() {
  const s = D().settings;
  applyAccent(s.accent, s.accent2);
  applyThemeMode(s.theme);
  document.getElementById('themeModeSelect').value = s.theme;
  document.getElementById('bgStyleSelect').value = s.bgStyle;
  document.getElementById('soundSelect').value = s.sound;
  document.getElementById('volumeSlider').value = String(s.volume);
  document.querySelectorAll('#colorOptions .color-opt').forEach((o) => o.classList.toggle('selected', o.dataset.c === s.accent));
  renderPomoSettings();
  updatePomoDisplay();
  renderPomoLog();
  renderTodoLists();
  renderTodos();
  renderTimerPresets();
  renderTimer();
  renderStopwatch();
  renderLaps();
  renderTracker();
  populateProjectDropdowns();
  const active = document.querySelector('.page.active');
  if (active && active.id === 'page-tracking') renderTrackingPage();
  if (active && active.id === 'page-forest') renderForest();
  if (active && active.id === 'page-settings') renderSettings();
  updateAmbientVolume();
  if (PF().ambientPlaying && PF().ambient) {
    if (!ambientPlayer.audio || ambientPlayer.audio.paused) {
      updateAmbientBadge(true, getAmbientName(PF().ambient));
      queueAmbientResumeOnInteraction();
    }
  } else if (!ambientPlayer.audio || ambientPlayer.audio.paused) {
    updateAmbientBadge(false);
  }
  updateAuthCorner();
  renderAuthModal();
  updateStorageBanner();
}

// Re-arm timers from persisted runtime (boot, namespace switch, other tab).
// Anything whose deadline passed while the app was closed completes now.
function restoreRuntime() {
  stopRuntimeTimers();
  const rt = RT(), now = Date.now();
  document.getElementById('pomoTask').value = rt.pomo.status !== 'idle' ? rt.pomo.task : document.getElementById('pomoTask').value;
  const tr = rt.tracking;
  if (tr.status === 'running') {
    document.getElementById('trackerDesc').value = tr.current.desc;
    populateProjectDropdowns();
    document.getElementById('trackerProject').value = tr.current.project;
    document.getElementById('trackerPriority').value = tr.current.tag;
  }
  if (C.pomoIsDue(rt.pomo, now)) finishPomodoro(false, true);
  else schedulePomo();
  if (C.timerIsDue(rt.timer, now)) finishTimer(true);
  else scheduleTimer();
  scheduleStopwatch();
  scheduleTracker();
}

// ---------------------------------------------------------------------------
// Delegated actions for dynamically rendered elements
// ---------------------------------------------------------------------------
const ACTIONS = {
  'toggle-todo': (ds) => toggleTodo(ds.id),
  'edit-todo': (ds) => openAddTask(ds.id),
  'pomo-todo': (ds) => startPomoForTask(ds.id),
  'delete-todo': (ds) => deleteTodo(ds.id),
  'select-list': (ds) => selectList(ds.id),
  'filter-tag': (ds) => filterByTag(ds.tag),
  'remove-edit-tag': (ds, e) => {
    e.stopPropagation();
    editState.tags.splice(Number(ds.index), 1);
    renderTagInputArea();
    document.getElementById('tagInputField').focus();
  },
  'apply-preset': (ds) => applyPreset(ds.id),
  'delete-preset': (ds, e) => { e.stopPropagation(); deletePreset(ds.id); },
  'apply-recent': (ds) => applyRecent(Number(ds.total)),
  'delete-entry': (ds) => deleteEntry(ds.id),
  'delete-project': (ds) => deleteProject(ds.id),
  'toggle-ambient': (ds) => setAmbient(ds.id),
  'pick-ambient': (ds) => setAmbient(ds.id, true)
};

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function init() {
  store.boot();
  updateClock();
  setInterval(updateClock, 1000);
  updateViewportHeightVar();
  syncResponsiveLayout();
  window.addEventListener('resize', () => { updateViewportHeightVar(); syncResponsiveLayout(); closeCtxMenu(); });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', updateViewportHeightVar);

  document.querySelectorAll('.modal-overlay').forEach((m) => {
    m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('open'); });
  });

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (el && ACTIONS[el.dataset.action]) ACTIONS[el.dataset.action](el.dataset, e, el);
    const menu = document.getElementById('ctxMenu');
    if (menu && menu.style.display === 'block' && !menu.contains(e.target) && !e.target.closest('#ambientBadge')) closeCtxMenu();
  });
  document.addEventListener('pointerdown', unlockAudio, { capture: true, passive: true });

  refreshUiFromState();
  restoreRuntime();
  initAuthIntegration();

  // Another tab changed our namespace: merge, then re-render.
  window.addEventListener('storage', (e) => {
    // Another tab logged out, reset, or cleared storage. Writing our in-memory
    // copy back would resurrect the removed data, so start over from storage.
    if (e.key === null || (e.key === store.keyFor(store.namespace) && e.newValue === null)) {
      stopRuntimeTimers();
      location.reload();
      return;
    }
    const res = store.applyExternal(e.key, e.newValue);
    if (!res) return;
    if (res.runtimeChanged) restoreRuntime();
    if (res.dataChanged || res.runtimeChanged) refreshUiFromState();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // Push pending edits before the tab may be frozen or closed.
      if (sync && sync.snapshot().pending) sync.flush(4000);
      return;
    }
    tickPomo();
    tickTimer();
    renderTracker();
    if (ambientPlayer.systemPaused && PF().ambientPlaying && PF().ambient) playAmbient(PF().ambient, false);
    ambientPlayer.systemPaused = false;
  });
  window.addEventListener('online', () => { if (sync) sync.onOnline(); });

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') {
      closeFocusMode();
      closeCtxMenu();
      document.querySelectorAll('.modal-overlay').forEach((m) => m.classList.remove('open'));
      return;
    }
    // Space on a focused control activates that control; don't also toggle.
    if (e.target.closest && e.target.closest('input, textarea, select, button, [contenteditable="true"]')) return;
    if (e.code === 'Space' && document.getElementById('page-pomodoro').classList.contains('active')) {
      e.preventDefault();
      togglePomodoro();
    }
  });

  setInterval(() => {
    const p = RT().pomo;
    document.title = p.status === 'running' ? `${C.formatTime(C.pomoRemaining(p, D().pomo, Date.now()))} — ZenFlow` : 'ZenFlow — Focus & Productivity';
  }, 1000);
}

init();
