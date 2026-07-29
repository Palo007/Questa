# Questa — Automated Backup Design Proposal

Status: implemented (Tier 1 automated snapshots + local restore). Target platform: Android Chrome installed PWA.
Author context: replaces the single manual "Export" button in Settings.

> **Superseded in part, 2026-07-29 — read this before trusting §2 or §3.** This document
> predates Dropbox integration (sync shipped 2026-07-10, scheduled Dropbox backups
> 2026-07-22) and describes a **two-tier** system only. A **Tier 3** now exists: the full
> Tier 2 export file, uploaded to the user's own Dropbox on up to four independent
> cadences (4-hourly / daily / weekly / monthly), each with its own rotating slot window,
> under `/questa-backups/<cadence>-<device6>-<slot>-<stamp>.json`. Implementation lives in
> `sync.js` (`BK_TIERS`, `_bkPath`, `_bkNextBoundary`, `_bkFire`, `syncMaybeAutoExport`);
> UI in `app.js` (`openOpt('autoBackup')`); user-facing docs in `BACKUP-USER-GUIDE.md`
> (Tier 3) and `SYNC-USER-GUIDE.md`.
>
> Consequences for this document, specifically:
>
> - **§2's conclusion is no longer the platform ceiling.** "The final send is one tap" was
>   true of the paths considered here (File System Access, Web Share, Periodic Background
>   Sync). It stopped being true once an authenticated HTTP upload to a third-party API
>   became an option: Dropbox's REST API needs no user gesture, so off-device backup *is*
>   now zero-touch while the app is open. The genuine remaining limit is narrower than §2
>   states — nothing can back up while the app is **closed**, because `localStorage` is
>   unreachable from the Service Worker. §2's individual bullets all still hold.
> - **§3's "two tiers" framing is incomplete**, as is §8's build order.
> - Tier 3 is *not* the same thing as ordinary Dropbox sync (`state.json`, lean mergeable
>   subset). Tier 3 uploads whole standalone snapshots that are never merged.
> - **Known history:** Tier 3's daily/weekly/monthly cadences were non-functional from
>   2026-07-22 until `v2026.07.29-2041` — `_bkNextBoundary` computed boundaries from the
>   current instant instead of the tier's last-fired timestamp, so only the 4-hourly
>   cadence ever fired. Post-mortem and the fix:
>   `.kilo/plans/1785344033093-dropbox-cycling-backups-review.md`.
>
> The rest of this document is retained as the accurate design record for Tiers 1 and 2.

## 1. The problem, stated precisely

Today `exportData()` builds one file = full `S` (localStorage state) + the entire
IndexedDB event log embedded under `events`, ~2 MB. It is complete but (a) manual and
(b) too large to keep one full copy per day (2 MB/day ≈ 730 MB/year).

Two facts from the current code drive the whole design:

- **`S` is tiny and holds everything you care about keeping exactly.** Settings
  (`prefs`), custom analytics views (`prefs.an.views`), and manual card ordering (the
  order of the `tasks` array) all live inside `S`. Serialized, `S` is on the order of
  tens of KB. It changes meaningfully day to day and is cheap to store in full.
- **The event log is the 2 MB, and it is append-only.** Events live in IndexedDB,
  auto-increment keyed, never mutated after write, only appended (and old ones pruned
  from the tail). That means the only thing that changes between two backups is *new
  events with a higher id than last time.*

So the backup does not need to be re-copied in full. It needs to copy small full state
+ only the new events. That is the entire size fix.

## 2. Platform ceiling (what "automated" can and cannot mean here)

Android Chrome, installed PWA. Being exact about the limits so nothing is over-promised:

- **No File System Access API on Android.** `showSaveFilePicker` / `showDirectoryPicker`
  are Chromium-desktop only. There is no way to silently write a `.json` file to the
  device filesystem or a synced folder on a timer.
- **No backend.** The app is static GitHub Pages. There is no server to push a backup
  to, so no server-side scheduled copy is possible.
- **Periodic Background Sync** *is* available to an installed Android PWA. It can wake
  the service worker roughly once a day (the browser decides timing, not us) and run
  code — enough to take an in-storage snapshot. It cannot write files off-device.
- **Web Share API with files** (`navigator.share({files:[...]})`) works on Android
  Chrome and can hand a backup file to Drive / Dropbox / Files — but it requires a user
  gesture (a tap). This is the realistic off-device path.
- A Cowork scheduled task cannot reach this app's IndexedDB/localStorage (different
  origin/sandbox), so it cannot perform the backup itself. It can only ever help manage
  files *after* they have been exported into a folder Cowork can see.

Conclusion: **Tier 1 (same-device) can be fully zero-touch. Tier 2 (off-device) can be
automatically prepared and reminded, but the final send is one tap.** The design makes
that tap infrequent (e.g. weekly) and verified.

## 3. Architecture: two tiers, incremental core

### Tier 1 — silent rolling snapshot ring (IndexedDB)

A new IndexedDB object store `backups` (separate DB or a new store in the existing
`questa` DB, but **never** the live `events` store — writing a backup must never touch
live data). Each record is one of:

- **`full` baseline** — `{stateSnapshot: <full S>, eventFromId, eventToId, ...}`. The
  state snapshot is a deep copy of `S`. Events are NOT embedded in the baseline record
  itself beyond the id range marker; the events are reconstructable because they still
  live in `events`. (For an *exportable* full file we do embed them — see Tier 2.)
- **`delta`** — `{stateSnapshot: <full S>, events: [only records with id > lastToId],
  baseId, fromEventId, toEventId, ...}`. State is small so we just re-snapshot it in
  full every time (simpler and safer than diffing state); only the events are
  incremental.

Why re-snapshot full `S` on every delta instead of diffing it: `S` is tiny, and a full
copy removes any chance of a broken diff chain corrupting settings/ordering/views. We
pay a few KB to eliminate a class of bugs. Only the genuinely large, genuinely
append-only part (events) is treated incrementally.

**When Tier 1 fires (all best-effort, debounced):**

- On app open, if > N hours since the last snapshot.
- On `openSettings()` if state is "dirty" (`IS_DIRTY` is true — a task was reordered, a
  setting changed, a view was edited). This is the primary auto-flush trigger: the
  settings panel calls `listSnapshots()` then `writeSnapshot(hasBaseline ? "delta" : "full")`,
  tracks the write in a global `_flushPromise`, and only clears `IS_DIRTY` if the write
  returned a truthy snapshot ID. The promise is nullified in `.finally()`.
- Once/day via Periodic Background Sync if the permission is granted.

**Implementation detail — race-condition guard:** `openRestorePicker()` wraps its logic in
an async IIFE that awaits `_flushPromise` before calling `listSnapshots()`. This ensures
the snapshot list shown in the restore dialog is never empty — the in-flight flush
completes and verifies before the picker reads the store.

> **Implementation detail — transaction lifecycle fix:** `writeSnapshot()` was initially
> written with the IndexedDB transaction created early and `store.add()` called after an
> `await`. IndexedDB auto-commits a readwrite transaction when control returns to the event
> loop before the first request is issued, causing every snapshot write to silently fail with
> `TransactionInactiveError`. The fix: the `readwrite` transaction is created immediately
> before `store.add()`, and the verification step (re-read, hash check, put/delete) uses a
> **fresh** transaction. This is what makes Tier 1 snapshots actually persist.

**Rotation (grandfather–father–son)** to bound space:

- keep the last 7 daily snapshots,
- promote 1/week to a weekly baseline, keep 4,
- promote 1/month to a monthly baseline, keep 6.

Total footprint stays in the low single-digit MB even after a year, versus ~730 MB for
naive daily fulls. IndexedDB origin quota on Android is hundreds of MB+, so this is
comfortable.

**Consolidation:** when deltas since the last baseline exceed a threshold (e.g. 7), fold
baseline + deltas into a fresh `full` baseline, verify it (§4), then delete the old
baseline and its deltas. Keeps the restore chain short.

Tier 1 protects against: accidental deletion, a bad in-app edit, state corruption from a
partial write. It does **not** protect against: losing the device, or the user clearing
the site's storage. That is Tier 2's job.

### Tier 2 — off-device export (one tap, auto-prepared, verified)

Periodically the app builds a single self-verifying full backup file (same shape as
today's export: full `S` + full embedded `events`, plus a manifest, §4) and offers it via
`navigator.share` (to a synced Drive/Dropbox/Files location) with a `<a download>`
fallback.

Automation possible on Android:

- The **file is built automatically** in the background and held ready.
- If it has been > 7 days since the last confirmed off-device export, Settings shows a
  one-tap "Back up off-device" button with a badge, and (optionally) a Notification via
  the SW nudges you. One tap sends the pre-built, pre-verified file.

This is the only step that cannot be silent on Android, and the design's job is to make
it rare, obvious, and impossible to send a corrupt file.

> **Note (implemented reminder):** The actual Tier 2 staleness signal is a blinking red gear icon — CSS `#gearBtn.stale` with a `gearStale` 2s infinite animation — when `S.prefs.lastExportTs` is missing or older than 7 days, driven by `checkExportStaleness()`. After a successful export, `exportData()` sets `S.prefs.lastExportTs = Date.now()`, and the gear stops blinking. The footer now also shows a **"Last export: [date & time]"** line (mirroring the "Last full backup" line) so you can see both dates at a glance — distinct from the Tier 1 snapshot date.

## 4. Corruption robustness (the explicit priority)

The guiding rule mirrors this project's own hard-won lesson (build → verify → atomic
swap, never trust a write): **a backup is not "good" until it has been read back and
verified, and we never destroy the last known-good copy before a new one is verified.**

Every backup record and every exported file carries a **manifest**:

```
{
  ts, appVersion,
  type: "full" | "delta",
  baseId,                // which baseline a delta extends
  fromEventId, toEventId,// event id range covered
  counts: { tasks, rewards, tags, views, events },
  hash,                  // cheap deterministic hash (e.g. FNV-1a) of the serialized payload
  byteLength
}
```

Robustness mechanisms:

1. **Write-then-verify.** After writing a snapshot, re-read it, `JSON.parse` it,
   recompute `hash`, and check `counts`. Only if all match is the record flagged
   `verified:true`. An unverified record is treated as absent.
2. **Never overwrite last-known-good in place.** New snapshot is a new record; the old
   one is pruned only *after* the new one verifies. At least two verified generations are
   always retained, so a single bad write is never fatal.
3. **Chain continuity check.** On restore, deltas must form an unbroken id chain from the
   baseline (`delta.fromEventId === previous.toEventId + 1`). A gap → refuse that chain,
   fall back to the newest fully-verified baseline.
4. **Self-heal on startup.** Validate the newest snapshot; if it fails, mark it bad and
   surface the previous good one. Silent corruption never propagates unnoticed.
5. **Isolation.** Backups live in a store separate from live `events`; taking a backup
   cannot corrupt live data, and vice-versa.
6. **Verified import.** Extend `importData()` — today it only checks `char` exists and
   `tasks` is an array. Add: parse manifest, recompute hash, compare counts, and refuse
   with a clear message if the file is corrupt or truncated, *before* replacing live
   data. This closes the current risk of importing a half-written file.

## 5. Restore flow

1. Choose a generation (default: newest verified). Same-device restores read from the
   `backups` store; off-device restores read the shared file.
2. Reconstruct `S` from the chosen baseline/delta's `stateSnapshot` (full copy — settings,
   analytics views, and card ordering come back exactly).
3. Rebuild events: `clearAllEvents()` then bulk-add baseline events + each verified delta
   in id order. (Re-uses existing `clearAllEvents` / `bulkAddEvents`.)

   > **Superseded, 2026-07-29.** Restore no longer clears the event log this way.
   > `clearAllEvents()` followed by bulk-add used to destroy every local event absent from
   > the restored snapshot, wiping independent per-device history — it fired repeatedly in
   > production. `confirmRestore()` now merges events additively instead: union-insert
   > deduplicated on `uid` **and** a content signature `(ts, kind, taskId, dir, reps)` — see
   > `eventMergeSig`/`eventMergeFilter` in `app.js` — leaving existing local events
   > untouched and adding only genuinely new ones from the snapshot.
4. Verify post-restore counts against the manifest before committing the UI refresh.

**UI:** The Settings button that triggers the restore picker is labeled **"Restore Local
Snapshot"**. Below it, the Settings footer shows a `<div id="lastFullBackupDate">`
populated by `updateLastFullBackupText()` displaying **"Last full backup: [date &
time]"** (or "None" if no fully verified full snapshot exists).

## 6. Space outcome

- Full state snapshot per backup: ~tens of KB.
- Event delta per day: typically a few KB (only that day's new taps/toggles/completions).
- Daily cost drops from ~2 MB to roughly tens of KB — about a 50–100× reduction.
- With grandfather-father-son rotation, total stored backups stay in the low single-digit
  MB indefinitely.

## 7. Honest open items / decisions still needed

- **Off-device cannot be zero-touch on Android.** Accept a rare one-tap send, or plan a
  future desktop-Chrome path (File System Access API) / a lightweight cloud connector
  (needs a backend) if truly unattended off-device backup is required.
- **Periodic Background Sync timing is browser-controlled**, not guaranteed daily. Treat
  it as a bonus on top of open/close snapshots, not the primary trigger.
- **Storage eviction:** Android can evict site data under pressure. Request persistent
  storage (`navigator.storage.persist()`) to make Tier 1 durable; if denied, Tier 2's
  off-device copy is the backstop — another reason to keep the one-tap export healthy.
- Consolidation threshold, retention counts, and the "nudge after N days" value are
  tunable; the numbers above (7 daily / 4 weekly / 6 monthly, nudge at 7 days) are
  starting defaults, not fixed.

## 8. Suggested build order

1. `backups` store + manifest + hash helper + write-then-verify wrapper.
2. Tier 1 snapshot-on-open/close with dirty tracking and rotation.
3. Verified `importData()` upgrade (immediate safety win, independent of the rest).
4. Tier 2 pre-built file + one-tap `navigator.share` export + staleness nudge.
5. Restore UI (pick generation, chain check, post-restore verification).
6. Periodic Background Sync + `navigator.storage.persist()` as best-effort add-ons.

Step 3 is worth doing first on its own: it hardens the backup you already have against
corrupt/truncated imports with no dependency on the new system.
