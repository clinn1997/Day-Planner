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
2. **No server to maintain.** Static files plus personal OneDrive as the sync backend. If
   the design
   starts requiring a backend process, stop and flag it.
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

## Phase 2 — OneDrive sync

Use a **personal** Microsoft account, not the HCGC work tenant. Rationale: no app
registration approval from company IT, no corporate retention policy over the user's own
working notes, and the data does not disappear if he leaves the company. If a work account
is used instead, the only code difference is the authority URL, but expect to need admin
consent.

- Microsoft Graph API for file read/write.
- **MSAL.js** browser library, **auth code flow with PKCE** (public client, no secret).
- Register the app in Azure Portal → App registrations as a **single-page application**.
  Set the redirect URI to the deployed origin. For a personal account, choose the
  "personal Microsoft accounts" supported-account-type.
- Request the **narrowest scope that works**: `Files.ReadWrite.AppFolder` if it is
  available for this account type, which confines the app to its own folder. Fall back to
  `Files.ReadWrite` only if necessary, and note in the README that this grants broader
  access than the app needs. Plus `offline_access` for a refresh token.
- Store one file: `planner.json`.
- Persist the refresh token via MSAL's cache; handle expiry by re-prompting, not by
  failing silently.

### Sync triggers

- On launch, after local state loads and renders (never block first paint on sync)
- On `visibilitychange` → visible
- On `online`
- After a local mutation, debounced ~2s

### Write protocol — optimistic concurrency

Graph uses ETags where Dropbox uses revision IDs. Same idea.

1. `GET` the file, keep its `eTag`.
2. `PUT` the content with an `if-match: <eTag>` header.
3. On `412 Precondition Failed`, re-`GET`, merge, retry. Cap retries.
4. Never `PUT` without `if-match`. That is how a week silently disappears.

Note: Graph occasionally returns a changed ETag for an unchanged file, so treat a 412 as
"re-merge and retry", never as an error to surface to the user.

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
- Whether `Files.ReadWrite.AppFolder` is grantable for a personal Microsoft account, or
  whether the broader `Files.ReadWrite` is unavoidable.
- MSAL refresh token lifetime for a SPA public client, and whether silent renewal survives
  an app that goes weeks between launches.

## Test checklist

- [ ] Airplane mode: add, edit, complete, delete entries; relaunch; all persist
- [ ] Add on phone offline, add on desktop, both come online → both sets survive
- [ ] Same entry edited on both devices → later edit wins, no duplicate
- [ ] Delete on phone, sync, confirm it does not return from desktop
- [ ] Entry that wraps to three lines stays on the rule grid
- [ ] Unfinished Friday entry appears on Monday with `↳3d`
- [ ] Force-quit mid-typing → the entry is not lost
- [ ] Export, wipe local storage, import → identical state
- [ ] Cold launch with no network renders instantly from cache
