# Status — Weekly Planner PWA

## Where things stand

**Phase 1: shipped and live.** Deployed, tested, installed on the user's iPhone home
screen, confirmed working. See `spec.md` in this repo for the full build spec (both
phases) — that document is the source of truth for scope and non-negotiables.

- Live: https://suptdayplanner.netlify.app/
- Repo: https://github.com/clinn1997/Day-Planner
- Host: Netlify, connected to GitHub `main` branch, auto-deploys on every push.
  Visitor access is public (intentional — no server-side data exists to protect;
  see reasoning below).
- Storage: IndexedDB (`plannerdb` / store `kv` / key `dayplanner:v1`), replacing the
  original artifact's `window.storage`. `merge()` is already ported and unit-verified
  (whole-weeks, month-boundary, year-rollover date math) but currently unused —
  it's there for Phase 2 to call against whatever Dropbox returns.
- Verified via a Playwright test suite (headless Chromium) against both localhost and
  the live URL: manifest fetch/parse, service worker registration reaching `active`,
  add/edit/delete entries persisting across reload, month-strip click-to-navigate,
  narrow/mobile layout. All green, zero console errors.
- One fix already applied post-deploy: `_headers` file forcing
  `Content-Type: application/manifest+json` on the manifest (Netlify was serving it as
  `application/octet-stream`; worked anyway, but fixed for correctness/Lighthouse).

## Decisions made along the way (so they don't get re-litigated)

- GitHub + Netlify chosen over Cloudflare Pages, specifically because the user had
  neither GitHub nor a host account set up and wanted the simplest free path with
  auto-deploy. Git itself had to be installed via winget (wasn't present).
- Site is public — do not add password/visitor-access protection. It would break the
  PWA: Netlify's access-control gate serves an HTML login page to unauthenticated
  requests, which the service worker would precache as if it were the real app shell.
- Added a 4-month reference calendar strip (not in the original spec) at the user's
  request, styled to match the existing rule/ink visual language, Mon-start weeks for
  internal consistency with the rest of the app, non-blocking tap-to-jump-to-week.
  Shrunk once already for space; if asked again, the CSS lives in the `.monthstrip` /
  `.minical` / `.mc-day` rules near the top of `index.html`'s `<style>` block.

## Phase 2 — switched from OneDrive to Dropbox mid-build

Original plan (personal Microsoft account, MSAL.js, Graph) hit a real blocker: signing
in to the Azure Portal itself (just to create the app registration) repeatedly threw
AADSTS50058, then AADSTS16000 — a tenant-resolution problem in the portal's own
identity flow, unrelated to this app's code, and not something worth continuing to
fight. Pivoted to Dropbox instead. Also caught along the way: Netlify Blobs was briefly
considered as an alternative and rejected — it would require a Netlify Function (a
backend process), which spec.md's non-negotiable #2 explicitly rules out. Dropbox
preserves the original "static files + client-side OAuth directly to the provider, no
backend" architecture.

**Current state: code is written, not yet tested live.**

- `sync.js` fully rewritten for Dropbox: OAuth 2.0 auth-code + PKCE (public client, no
  secret, no library — hand-rolled fetch calls since Dropbox has no browser SDK
  equivalent to MSAL.js), full-page redirect flow (not popup), rev-based optimistic
  concurrency in place of ETags. Same triggers/debounce/merge contract as before —
  `index.html`'s `window.Planner` surface didn't need to change.
- The user registered a Dropbox app (Scoped access, **App folder** type, permissions
  `files.content.write` + `files.content.read`, Development status). App key
  `pxcps9vs1jyzyuv` is already in `sync.js`. Redirect URI registered:
  `https://suptdayplanner.netlify.app/`.
- `lib/msal-browser.min.js` and its LICENSE removed; `sw.js` precache list and cache
  version bumped (`planner-shell-v3`) to drop the stale MSAL reference.
- `spec.md` updated in place: Phase 2 section rewritten for Dropbox, non-negotiable #2
  reworded to say "personal cloud storage (Dropbox...)", and the "Verify rather than
  assume" list swapped to the two open Dropbox questions below.

Not yet done:
1. **Commit and push** — none of the above has been committed yet as of this note.
2. **Live test the actual sign-in flow** — click "Connect Dropbox" on the deployed
   site and confirm the full redirect round-trip (authorize → Dropbox login → redirect
   back with `?code=` → token exchange) actually works. This is the biggest unverified
   assumption: that Dropbox's OAuth token endpoint serves CORS to a pure browser client
   with no backend. Expected to work (it's Dropbox's documented PKCE/public-client
   model) but unconfirmed against the live site.
3. Run the full sync test checklist from `spec.md` once sign-in works: two-device edit
   conflict, delete propagation, offline queue, and — the other open question —
   whether the refresh token survives a multi-week gap between launches on a
   Development-status app.

## Local environment notes

- Git installed via winget at `C:\Program Files\Git\cmd\git.exe` (not on PATH in every
  shell session — use the full path or re-append to `$env:Path` if `git` isn't found).
- Playwright + headless Chromium installed (`pip install playwright`, then
  `python -m playwright install chromium`) — reusable for future test passes, live or
  local. Test script pattern: launch chromium, navigate, assert on DOM/console/
  localStorage-equivalent (IndexedDB via `page.evaluate`), screenshot for visual checks.
