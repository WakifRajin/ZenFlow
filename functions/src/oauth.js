'use strict';
// Google OAuth 2.0 (authorization-code flow with offline access) helpers.
const crypto = require('crypto');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar'];
const STATE_TTL_MS = 10 * 60000;

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

class OAuthError extends Error {
  constructor(code, message) { super(message); this.name = 'OAuthError'; this.code = code; }
}

// Signed, expiring state binds the callback to the user and origin that
// started the flow (CSRF protection; the uid never comes from the browser).
function signState(payload, secret, now = Date.now()) {
  const body = b64u(JSON.stringify(Object.assign({}, payload, { exp: now + STATE_TTL_MS, n: crypto.randomBytes(12).toString('hex') })));
  const sig = b64u(crypto.createHmac('sha256', secret).update(body).digest());
  return body + '.' + sig;
}
function verifyState(state, secret, now = Date.now()) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig) throw new OAuthError('bad-state', 'Missing state');
  const expected = b64u(crypto.createHmac('sha256', secret).update(body).digest());
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new OAuthError('bad-state', 'State signature mismatch');
  let payload;
  try { payload = JSON.parse(fromB64u(body).toString('utf8')); } catch (_) { throw new OAuthError('bad-state', 'Unreadable state'); }
  if (!payload.exp || payload.exp < now) throw new OAuthError('expired-state', 'The sign-in link expired. Please try again.');
  return payload;
}

function authUrl({ clientId, redirectUri, state, loginHint }) {
  const u = new URL(AUTH_URL);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPES.join(' '));
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('state', state);
  if (loginHint) u.searchParams.set('login_hint', loginHint);
  return u.toString();
}

async function postForm(fetch, url, params) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new OAuthError(json.error || `http-${res.status}`, json.error_description || `Google OAuth returned ${res.status}`);
  return json;
}

async function exchangeCode({ fetch, code, clientId, clientSecret, redirectUri }) {
  const t = await postForm(fetch, TOKEN_URL, { code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  if (!t.refresh_token) throw new OAuthError('no-refresh-token', 'Google did not grant offline access. Remove ZenFlow from your Google account permissions and connect again.');
  const scopes = String(t.scope || '').split(' ');
  if (!scopes.includes('https://www.googleapis.com/auth/calendar')) throw new OAuthError('scope-denied', 'Calendar access was not granted.');
  return t;
}

// Cached access tokens per refresh token (per function instance).
function createTokenSource({ fetch, clientId, clientSecret, refreshToken, now = Date.now }) {
  let token = null, expires = 0;
  return async function getAccessToken() {
    if (token && now() < expires - 60000) return token;
    const t = await postForm(fetch, TOKEN_URL, { refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' });
    token = t.access_token;
    expires = now() + (t.expires_in || 3600) * 1000;
    return token;
  };
}

async function revoke({ fetch, token }) {
  try { await fetch(REVOKE_URL + '?token=' + encodeURIComponent(token), { method: 'POST' }); } catch (_) { /* best effort */ }
}

// Email from the ID token returned directly by Google's token endpoint over
// TLS (not from the browser), so decoding without signature check is safe.
function emailFromIdToken(idToken) {
  try { return JSON.parse(fromB64u(String(idToken).split('.')[1]).toString('utf8')).email || ''; } catch (_) { return ''; }
}

module.exports = { SCOPES, OAuthError, signState, verifyState, authUrl, exchangeCode, createTokenSource, revoke, emailFromIdToken };
