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
  it's there for Phase 2 to call against whatever Graph returns.
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

## Phase 2 — not started yet

User wants to live on Phase 1 for a while first (deliberate — spec's own instruction)
before starting OneDrive sync. When picking this back up:

1. Re-read `spec.md`'s "Phase 2" and "Verify rather than assume" sections in full —
   this file is a summary, not a replacement.
2. Biggest known risks, in order of how much they could blow up the timeline:
   - Whether `Files.ReadWrite.AppFolder` is actually grantable for a **personal**
     Microsoft account (spec explicitly wants personal, not the work HCGC tenant).
   - MSAL.js silent token renewal under Safari's ITP, especially surviving multi-week
     gaps between launches on the iPhone — the iframe-based silent renewal path is
     the likely failure point.
3. Rough estimate given to the user: ~3-5 hours of build time, but wall-clock spread
   over 2-3 days because of the Azure app registration step (user-side, ~15-30 min)
   and needing genuine two-device testing for the sync test checklist (same entry
   edited both devices, delete propagation, offline queue).
4. First concrete step when resuming: walk the user through Azure Portal → App
   registrations → new SPA registration, personal-account support type, redirect URI
   set to the Netlify origin.

## Local environment notes

- Git installed via winget at `C:\Program Files\Git\cmd\git.exe` (not on PATH in every
  shell session — use the full path or re-append to `$env:Path` if `git` isn't found).
- Playwright + headless Chromium installed (`pip install playwright`, then
  `python -m playwright install chromium`) — reusable for future test passes, live or
  local. Test script pattern: launch chromium, navigate, assert on DOM/console/
  localStorage-equivalent (IndexedDB via `page.evaluate`), screenshot for visual checks.
