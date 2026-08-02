# Weekly planner PWA — build spec

## Context

Replace a paper At-A-Glance DayMinder G590 weekly planner with an offline-first web app,
installable to an iPhone home screen, syncing with a desktop browser.

The user is a construction project manager / estimator. He has used the same paper planner
format for 5+ years. It works for him. The **only** thing it fails at is running out of
physical space on the page. This app must not "improve" the format into a project
management tool — the frictionlessness is the feature.

A working single-file reference implementation exists: `weekly_planner.html`. It has the
correct layout, carryover logic, job tagging, merge algorithm, and export. **Port it.
Do not redesign it.** It currently runs as a Claude artifact using `window.storage`, which
is desktop/web only — that limitation is the entire reason for this project.

## Non-negotiables

1. **Local-first.** Every write goes to IndexedDB on the device, synchronously from the
   user's perspective. The UI reads only local state. It must never await the network
   before showing an entry. Full functionality with the radio off.
2. **No server to maintain.** Static files plus personal cloud storage (Dropbox, originally
   spec'd as OneDrive — see Phase 2) as the sync backend. If the design starts requiring a
   backend process, stop and flag it.
3. **Installable.** Home screen icon, standalone display, no browser chrome.
4. **No data loss, ever.** Prefer a duplicate entry over a lost one. Deletion is the only
   destructive act and it is always user-initiated.

## Phase 1 — offline PWA, no sync

Ship this first and let the user live on it for a week before starting phase 2.

- Port `weekly_planner.html` layout and behaviour verbatim.
- Swap `window.storage` for IndexedDB (use `idb-keyval` or a thin wrapper; a single
  key holding the whole planner object is fine at this data size).
- Add `manifest.webmanifest`: `display: standalone`, portrait, name, icons at 192/512px.
- Add a service worker that precaches the app shell so it loads with no network.
- Call `navigator.storage.persist()` on first run to reduce eviction risk.
- Deploy to Netlify / Cloudflare Pages. HTTPS is required for install and service workers.

Phase 1 acceptance: airplane mode on, launch from home screen, add entries, force-quit,
relaunch, entries are still there.

## Phase 2 — Dropbox sync

Originally spec'd against OneDrive/Microsoft Graph. Switched to Dropbox after hitting
repeated Azure AD tenant-resolution errors (AADSTS50058, then AADSTS16000) trying to sign
in to the Azure Portal itself to create the app registration — a portal-level identity
problem, not something in this app's control, and not worth continuing to fight. Dropbox
has no tenant concept for personal accounts, so this class of error can't recur. Everything
else about the architecture (client-side only, no backend, PKCE public client, whole-
document optimistic concurrency) carries over unchanged — only the provider and its APIs
differ.

- Dropbox HTTP API (`content.dropboxapi.com` / `api.dropboxapi.com`) for file read/write,
  called directly from the browser. No SDK library — hand-rolled fetch calls, since
  Dropbox doesn't ship a browser bundle the way MSAL.js does for Graph.
- **OAuth 2.0 auth-code flow with PKCE** (public client, no secret), full-page redirect
  (not a popup) since there's no library managing the popup/iframe handshake for us.
  Code verifier/state kept in `localStorage` across the redirect.
- Register the app at the Dropbox App Console (dropbox.com/developers/apps) as
  **Scoped access**, **App folder** type — this is the equivalent of Graph's
  `Files.ReadWrite.AppFolder` and, unlike that scope, isn't in question for personal
  accounts; it's the standard option.
- Permissions: `files.content.write` and `files.content.read`. Request
  `token_access_type=offline` at authorize time to get a refresh token back.
- App stays in Dropbox's "Development" status — supports up to 500 authorizing users,
  no review needed for single-user use.
- Store one file: `/planner.json`, resolved automatically under the app's own
  `Apps/<app name>/` folder because of the App-folder access type.
- Persist the refresh token in `localStorage`; handle expiry by re-prompting (clearing
  local tokens and flipping the connect button back to "Connect Dropbox"), not by
  failing silently.

### Sync triggers

- On launch, after local state loads and renders (never block first paint on sync)
- On `visibilitychange` → visible
- On `online`
- After a local mutation, debounced ~2s

### Write protocol — optimistic concurrency

Dropbox uses a `rev` field where Graph used ETags. Same idea.

1. `POST /files/download`, keep the `rev` from the `Dropbox-API-Result` header.
2. `POST /files/upload` with `mode: {".tag": "update", "update": "<rev>"}`.
3. On `409` (rev mismatch / conflict), re-download, merge, retry. Cap retries.
4. Never upload with `mode: "add"` once a file exists — only for the very first write,
   when there's no rev yet. That is how a week silently disappears.

### Offline queue

If a write fails for network reasons, mark state dirty and retry on the next trigger.
Local state stays authoritative in the meantime. Do not queue individual operations —
the whole-document merge makes that unnecessary.

## Data model

```js
{
  items:   [ { id, text, job, done, date, mod, origin? } ],  // day-column entries
  waiting: [ { id, text, job, done, created, mod } ],         // waiting-on list
  memo:    [ { id, text, job, done, created, mod } ],         // running memo
  dead:    { [id]: timestamp }                                // tombstones
}
```

- `id` — short random string, generated client-side
- `date` — `YYYY-MM-DD`, day-column entries only
- `mod` — ms epoch, set on every mutation. Drives conflict resolution.
- `origin` — the original date of an entry that has been carried forward, set once
- `job` — free text, optional
- `dead` — deletions, so a delete on one device is not resurrected by the other

## Merge algorithm

Already implemented and unit-tested in the reference file. Port as-is.

```
merge(a, b):
  dead = union of a.dead and b.dead, keeping the later timestamp per id
  for each list in [items, waiting, memo]:
    group all entries from both sides by id
    keep the copy with the higher mod
    drop any entry where dead[id] >= entry.mod
  return merged
```

Consequences worth preserving: a later edit intentionally beats an earlier delete
(recovering a mistaken deletion), and merging an empty local state with remote is
lossless.

Known limitation: conflicts are resolved by device clock, so clock skew picks the wrong
winner. Acceptable for a single-user planner. Do not build a vector clock for this.

## Layout spec

Replicating the G590 two-page weekly spread. All of this is implemented in the reference
file; the constants matter and were arrived at by fixing a real alignment bug.

- **Rule pitch 28px.** Every element occupying a slot — entries, add-fields, subheadings,
  empty states — must be a whole multiple of it. Entry `line-height` equals the pitch, so
  wrapped lines land on the next rule instead of drifting.
- **Rules sit at 18px within each band**, not at the band edge, so text rests on the line
  the way ink does on paper.
- **Seven day columns**, Mon–Sun, no time slots. Saturday full width, **Sunday condensed
  to ~0.62**, matching the printed page.
- **Binding gutter between Thursday and Friday** with punched-hole detailing — this is
  where the real book's page break falls.
- **Columns grow unbounded.** This is the single thing paper cannot do and the reason the
  app exists.
- **Memo block below the spread**, persistent across weeks, two sections:
  - *Waiting on* — flat list, job shown as a chip on the line. Deliberately not nested;
    it is scanned while making phone calls.
  - *Memo* — grouped under job subheadings that appear when a job is first tagged and
    disappear when the last entry under them clears. Untagged entries sit ungrouped.
- **Job tagging**: the last `#` in the input splits the line — text before, job after.
  So `chase brake metal #Milton Clinic` handles multi-word jobs with no extra fields.
- **Carryover**: on launch, unfinished day entries dated before today move to today,
  `origin` is stamped once, and a red `↳4d` marker shows how long it has been riding.
  Completed entries stay on their original date as the record.
- **Julian day numbers** in each day header, and day-of-year with days-remaining in the
  top bar. The printed planner has these; the user is used to them.
- **Visual language**: cool stationery white (not cream), near-black printed day bars,
  pale blue-steel rules, ballpoint-blue entry text, redline red for carried markers.

## Mobile behaviour

Below ~720px wide: collapse to a single day column with a seven-day pill strip for
navigation. A dot on a pill indicates unfinished entries that day. Tap targets ≥ 44px.

## Also port

- **Export** — plain text of the whole week, clipboard with a file-download fallback.
- **Import** — new in this build. Paste or load an exported file and merge it in.
  This is the manual escape hatch if sync ever breaks, and it is why export must round-trip.
- **Save status indicator** — must reflect reality. The artifact version once reported
  "Saved" against a storage call that silently did nothing. Show the last successful
  *persisted* write, and show sync state separately from local save state.

## Explicit non-goals

Time slots. Recurring tasks. Subtasks. Priorities. Assignees. Multi-user anything.
Calendar integration. Attachments. A settings screen. Themes. Every one of these makes
entry slower, and entry speed is the whole product.

## Verify rather than assume

- Whether an installed iOS PWA is exempt from Safari's 7-day storage eviction, and
  whether `navigator.storage.persist()` is honoured there.
- Current iOS support for web push from an installed PWA, if due-date reminders are
  wanted later.
- Whether Dropbox's OAuth token endpoint (`api.dropboxapi.com/oauth2/token`) actually
  serves CORS for a pure browser client with no backend — expected to work (this is
  Dropbox's documented public-client/PKCE model) but not yet confirmed against the live
  site.
- Dropbox refresh token lifetime for a Development-status app, and whether it survives an
  app that goes weeks between launches.

## Test checklist

- [ ] Airplane mode: add, edit, complete, delete entries; relaunch; all persist
- [x] Add on phone offline, add on desktop, both come online → both sets survive
      (verified 2026-08-01 against live Dropbox sync)
- [x] Same entry edited on both devices → later edit wins, no duplicate
      (verified 2026-08-01)
- [x] Delete on phone, sync, confirm it does not return from desktop
      (verified 2026-08-01 — took a second sync cycle to fully propagate, worth
      keeping an eye on if it ever feels slow to catch up in daily use)
- [ ] Entry that wraps to three lines stays on the rule grid
- [ ] Unfinished Friday entry appears on Monday with `↳3d`
- [ ] Force-quit mid-typing → the entry is not lost
- [ ] Export, wipe local storage, import → identical state
- [ ] Cold launch with no network renders instantly from cache
