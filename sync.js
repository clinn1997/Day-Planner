/* Phase 2 — OneDrive sync via MSAL.js (auth code + PKCE, public client) and
   Microsoft Graph. Never touches state/IndexedDB directly — only through the
   window.Planner surface exposed by index.html's inline script.

   File lives at the app's special "approot" folder (Graph resolves this to
   /Apps/<app display name>/ automatically, scoped to this app's own identity)
   as planner.json. Whole-document optimistic concurrency via ETag / If-Match,
   matching the write protocol in spec.md. */
(function () {
  const CLIENT_ID = 'REPLACE_WITH_AZURE_APPLICATION_CLIENT_ID';
  const REDIRECT_URI = window.location.origin + '/';

  const MSAL_CONFIG = {
    auth: {
      clientId: CLIENT_ID,
      authority: 'https://login.microsoftonline.com/consumers',
      redirectUri: REDIRECT_URI,
      postLogoutRedirectUri: REDIRECT_URI,
    },
    cache: {
      cacheLocation: 'localStorage', // survives relaunch across weeks, per spec
      storeAuthStateInCookie: false,
    },
  };

  // Files.ReadWrite.AppFolder confines this app to its own OneDrive folder.
  // Whether that scope is grantable on a *personal* MSA is an open question
  // per spec.md — fall back to the broader scope once if the narrow one is
  // rejected during sign-in. Both use the same approot-relative Graph path.
  const SCOPES_PRIMARY = ['Files.ReadWrite.AppFolder'];
  const SCOPES_FALLBACK = ['Files.ReadWrite'];
  let activeScopes = SCOPES_PRIMARY;

  const GRAPH = 'https://graph.microsoft.com/v1.0';
  const ITEM_URL = `${GRAPH}/me/drive/special/approot:/planner.json:/content`;

  let msalInstance = null;
  let account = null;
  let lastEtag = null;
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
    btn.textContent = account ? 'Disconnect' : 'Connect OneDrive';
  }

  async function ensureMsal() {
    if (msalInstance) return msalInstance;
    msalInstance = new msal.PublicClientApplication(MSAL_CONFIG);
    await msalInstance.initialize();
    let result = null;
    try { result = await msalInstance.handleRedirectPromise(); } catch (e) { /* no redirect in flight */ }
    if (result && result.account) account = result.account;
    if (!account) {
      const accounts = msalInstance.getAllAccounts();
      if (accounts.length) account = accounts[0];
    }
    return msalInstance;
  }

  async function popupSignIn(scopes) {
    const res = await msalInstance.loginPopup({ scopes });
    account = res.account;
    return res.accessToken;
  }

  async function signIn() {
    await ensureMsal();
    setSyncUI('Connecting…');
    try {
      const token = await popupSignIn(activeScopes);
      updateConnectButton();
      await pushThenPull();
      return token;
    } catch (e) {
      // Narrow scope may not be grantable on this account type — try once more, broader.
      if (activeScopes === SCOPES_PRIMARY) {
        activeScopes = SCOPES_FALLBACK;
        try {
          const token = await popupSignIn(activeScopes);
          updateConnectButton();
          await pushThenPull();
          return token;
        } catch (e2) {
          setSyncUI('Sign-in failed', true);
          return null;
        }
      }
      setSyncUI('Sign-in failed', true);
      return null;
    }
  }

  function signOut() {
    if (!msalInstance || !account) return;
    const acc = account;
    account = null;
    lastEtag = null;
    updateConnectButton();
    setSyncUI('');
    msalInstance.logoutPopup({ account: acc }).catch(() => {});
  }

  async function getToken() {
    await ensureMsal();
    if (!account) return null;
    try {
      const res = await msalInstance.acquireTokenSilent({ scopes: activeScopes, account });
      return res.accessToken;
    } catch (e) {
      // Refresh failed silently (expired/revoked) — re-prompt rather than fail quietly, per spec.
      try {
        const res = await msalInstance.acquireTokenPopup({ scopes: activeScopes });
        account = res.account;
        return res.accessToken;
      } catch (e2) {
        setSyncUI('Sign-in expired — reconnect', true);
        return null;
      }
    }
  }

  async function graphGet(token) {
    const r = await fetch(ITEM_URL, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 404) return { data: null, etag: null };
    if (!r.ok) throw new Error('graph GET ' + r.status);
    const etag = r.headers.get('etag');
    const data = await r.json();
    return { data, etag };
  }

  async function graphPut(token, obj, etag) {
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    if (etag) headers['if-match'] = etag; // never PUT without if-match once a file exists — see spec.md
    const r = await fetch(ITEM_URL, { method: 'PUT', headers, body: JSON.stringify(obj) });
    if (r.status === 412) return { conflict: true };
    if (!r.ok) throw new Error('graph PUT ' + r.status);
    const meta = await r.json();
    return { conflict: false, etag: meta.eTag || null };
  }

  async function pullAndMerge(token) {
    const { data, etag } = await graphGet(token);
    lastEtag = etag;
    if (data) window.Planner.applyRemote(data);
  }

  // 412 means someone else wrote first (or Graph's known stale-etag quirk) —
  // re-pull, merge, retry. Capped so a persistent conflict can't loop forever.
  async function pushOnce(token) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = window.Planner.getState();
      const res = await graphPut(token, state, lastEtag);
      if (!res.conflict) { lastEtag = res.etag; return true; }
      const { data, etag } = await graphGet(token);
      lastEtag = etag;
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
        setSyncUI(account ? 'Sign-in expired — reconnect' : 'Not connected', !!account);
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
    if (!account) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(pushThenPull, 2000);
  }

  function wire() {
    const btn = $('connect');
    if (btn) btn.onclick = () => { account ? signOut() : signIn(); };

    window.addEventListener('online', () => { if (account) pushThenPull(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && account) pushThenPull();
    });
    if (window.Planner) window.Planner.onLocalChange(scheduleDebouncedPush);
  }

  (async function init() {
    wire();
    await ensureMsal();
    updateConnectButton();
    if (account) {
      setSyncUI('Connected');
      // Sync after first paint — never block the offline-first render on network.
      setTimeout(pushThenPull, 300);
    }
  })();
})();
