/* Phase 2 — Dropbox sync via OAuth 2.0 auth-code + PKCE (public client, no
   secret, no backend) and the Dropbox HTTP API. Never touches state/
   IndexedDB directly — only through the window.Planner surface exposed by
   index.html's inline script.

   File lives in the app's own "App folder" (Dropbox scopes every path to
   /Apps/<app name>/ automatically, because the app was registered with
   "App folder" access) as /planner.json. Whole-document optimistic
   concurrency via Dropbox's rev field — it plays the role ETag played for
   OneDrive/Graph, matching the write protocol in spec.md. */
(function () {
  const CLIENT_ID = 'pxcps9vs1jyzyuv';
  const REDIRECT_URI = window.location.origin + '/';
  const SCOPES = 'files.content.write files.content.read';

  const AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
  const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
  const REVOKE_URL = 'https://api.dropboxapi.com/2/auth/token/revoke';
  const DOWNLOAD_URL = 'https://content.dropboxapi.com/2/files/download';
  const UPLOAD_URL = 'https://content.dropboxapi.com/2/files/upload';
  const FILE_PATH = '/planner.json';

  const LS_VERIFIER = 'dp_verifier';
  const LS_STATE = 'dp_state';
  const LS_REFRESH = 'dp_refresh_token';
  const LS_ACCESS = 'dp_access_token';
  const LS_EXPIRES = 'dp_expires_at';

  let accessToken = localStorage.getItem(LS_ACCESS) || null;
  let refreshToken = localStorage.getItem(LS_REFRESH) || null;
  let expiresAt = Number(localStorage.getItem(LS_EXPIRES) || 0);
  let lastRev = null;
  let syncing = false;
  let pendingSync = false;
  let debounceTimer = null;

  const $ = id => document.getElementById(id);
  function hhmm(d) {
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const ap = h < 12 ? 'am' : 'pm';
    h = h % 12 || 12;
    return h + ':' + m + ap;
  }
  function setSyncUI(text, bad) {
    if (window.Planner && window.Planner.setSyncStatus) window.Planner.setSyncStatus(text, bad);
  }
  function updateConnectButton() {
    const btn = $('connect');
    if (!btn) return;
    btn.textContent = refreshToken ? 'Disconnect' : 'Connect Dropbox';
  }

  function b64url(bytes) {
    if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
    let str = '';
    for (const b of bytes) str += String.fromCharCode(b);
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function randomString(len) {
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return b64url(arr).slice(0, len);
  }
  async function sha256b64url(str) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return b64url(digest);
  }

  async function beginSignIn() {
    const verifier = randomString(64);
    const state = randomString(32);
    localStorage.setItem(LS_VERIFIER, verifier);
    localStorage.setItem(LS_STATE, state);
    const challenge = await sha256b64url(verifier);
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      token_access_type: 'offline', // request a refresh token, per spec
      scope: SCOPES,
      state: state,
    });
    window.location.href = AUTHORIZE_URL + '?' + params.toString();
  }

  async function completeSignIn(code) {
    const verifier = localStorage.getItem(LS_VERIFIER);
    localStorage.removeItem(LS_VERIFIER);
    localStorage.removeItem(LS_STATE);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!r.ok) throw new Error('token exchange failed ' + r.status);
    const json = await r.json();
    accessToken = json.access_token;
    refreshToken = json.refresh_token;
    expiresAt = Date.now() + (json.expires_in - 60) * 1000; // refresh a minute early
    localStorage.setItem(LS_REFRESH, refreshToken);
    localStorage.setItem(LS_ACCESS, accessToken);
    localStorage.setItem(LS_EXPIRES, String(expiresAt));
  }

  function signOutLocal() {
    accessToken = null;
    refreshToken = null;
    expiresAt = 0;
    lastRev = null;
    localStorage.removeItem(LS_REFRESH);
    localStorage.removeItem(LS_ACCESS);
    localStorage.removeItem(LS_EXPIRES);
    updateConnectButton();
    setSyncUI('');
  }

  async function refreshAccessToken() {
    if (!refreshToken) return null;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    });
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!r.ok) {
      // Refresh token itself was rejected (revoked/expired) — re-prompt
      // rather than fail silently, per spec.
      signOutLocal();
      setSyncUI('Sign-in expired — reconnect', true);
      return null;
    }
    const json = await r.json();
    accessToken = json.access_token;
    expiresAt = Date.now() + (json.expires_in - 60) * 1000;
    localStorage.setItem(LS_ACCESS, accessToken);
    localStorage.setItem(LS_EXPIRES, String(expiresAt));
    return accessToken;
  }

  async function getToken() {
    if (!refreshToken) return null;
    if (accessToken && Date.now() < expiresAt) return accessToken;
    return refreshAccessToken();
  }

  async function signOut() {
    const token = accessToken;
    signOutLocal();
    if (token) {
      try {
        await fetch(REVOKE_URL, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      } catch (e) { /* best-effort */ }
    }
  }

  async function dropboxDownload(token) {
    const r = await fetch(DOWNLOAD_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Dropbox-API-Arg': JSON.stringify({ path: FILE_PATH }),
      },
    });
    if (r.status === 409) return { data: null, rev: null }; // not_found — no file yet
    if (!r.ok) throw new Error('dropbox download ' + r.status);
    const resultHeader = r.headers.get('dropbox-api-result');
    const meta = resultHeader ? JSON.parse(resultHeader) : {};
    const data = await r.json();
    return { data, rev: meta.rev || null };
  }

  async function dropboxUpload(token, obj, rev) {
    // Never upload without a matching rev once a file exists — mode "add" only
    // for the very first write, mode "update" (rev-checked) after that. That's
    // how a week silently disappears, per spec.md's write protocol.
    const mode = rev ? { '.tag': 'update', update: rev } : { '.tag': 'add' };
    const r = await fetch(UPLOAD_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Dropbox-API-Arg': JSON.stringify({ path: FILE_PATH, mode: mode, mute: true }),
        'Content-Type': 'application/octet-stream',
      },
      body: JSON.stringify(obj),
    });
    if (r.status === 409) return { conflict: true };
    if (!r.ok) throw new Error('dropbox upload ' + r.status);
    const meta = await r.json();
    return { conflict: false, rev: meta.rev || null };
  }

  async function pullAndMerge(token) {
    const { data, rev } = await dropboxDownload(token);
    lastRev = rev;
    if (data) window.Planner.applyRemote(data);
  }

  // A 409 conflict means someone else wrote first (rev didn't match) —
  // re-pull, merge, retry. Capped so a persistent conflict can't loop forever.
  async function pushOnce(token) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = window.Planner.getState();
      const res = await dropboxUpload(token, state, lastRev);
      if (!res.conflict) { lastRev = res.rev; return true; }
      const { data, rev } = await dropboxDownload(token);
      lastRev = rev;
      if (data) window.Planner.applyRemote(data);
    }
    return false;
  }

  async function pushThenPull() {
    if (syncing) { pendingSync = true; return; }
    syncing = true;
    setSyncUI('Syncing…');
    try {
      const token = await getToken();
      if (!token) {
        setSyncUI(refreshToken ? 'Sign-in expired — reconnect' : 'Not connected', !!refreshToken);
      } else {
        await pullAndMerge(token);
        const ok = await pushOnce(token);
        if (ok) {
          window.Planner.markPushed();
          setSyncUI('Synced ' + hhmm(new Date()));
        } else {
          setSyncUI('Sync pending — will retry', true);
        }
      }
    } catch (e) {
      setSyncUI('Sync failed — will retry', true);
    }
    syncing = false;
    if (pendingSync) { pendingSync = false; pushThenPull(); }
  }

  function scheduleDebouncedPush() {
    if (!refreshToken) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(pushThenPull, 2000);
  }

  function wire() {
    const btn = $('connect');
    if (btn) btn.onclick = () => { refreshToken ? signOut() : beginSignIn(); };

    window.addEventListener('online', () => { if (refreshToken) pushThenPull(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && refreshToken) pushThenPull();
    });
    if (window.Planner) window.Planner.onLocalChange(scheduleDebouncedPush);
  }

  (async function init() {
    wire();
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    if (code) {
      history.replaceState(null, '', window.location.pathname);
      const expectedState = localStorage.getItem(LS_STATE);
      if (state && expectedState && state === expectedState) {
        setSyncUI('Connecting…');
        try {
          await completeSignIn(code);
        } catch (e) {
          setSyncUI('Sign-in failed', true);
        }
      }
    }
    updateConnectButton();
    if (refreshToken) {
      setSyncUI('Connected');
      // Sync after first paint — never block the offline-first render on network.
      setTimeout(pushThenPull, 300);
    }
  })();
})();
