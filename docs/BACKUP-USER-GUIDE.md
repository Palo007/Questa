# Questa Backups — User Guide

Questa protects your progress with a three-tier backup system. **Tier 1** keeps rolling local snapshots on your device automatically. **Tier 2** lets you export a portable file off-device (e.g. to Google Drive or Files) with one tap. **Tier 3** (added 2026-07-22, requires Dropbox to be connected) uploads that same full export to Dropbox on a schedule, unattended. This guide explains how each works, what to expect, and how to recover your data.

---

## TL;DR

- **You don't have to do anything for Tier 1.** Snapshots are created automatically when you open Settings after making changes, or when you leave the app or close the tab.
- **For real safety, also do a Tier 2 export** periodically (Settings → Export). It shares a file off your device.
- **Best of all, connect Dropbox and tick a Tier 3 cadence** (Settings → Auto-backup to Dropbox). It's the only tier that gets a copy off your device without you remembering to do anything.
- **To recover:** Settings → "Restore Local Snapshot" (Tier 1), or Settings → Import for a Tier 2 file or any Tier 3 file downloaded from Dropbox (they're the same format).

---

## Tier 1 — Automatic Local Snapshots

### What it is
Questa stores rolling backups inside your browser's **IndexedDB** (a local database on your device). These are separate from your live `localStorage` state, so a corrupted edit or a bad day's damage can be rolled back.

### When a snapshot is created
A snapshot is written automatically when **all** of these are true:
1. You **changed something** (added a task, checked a habit, completed a daily, etc.). The app tracks this with an internal "dirty" flag set on every save.
2. The app detects you are leaving — either the tab becomes hidden (`visibilitychange`) or the page is being unloaded (`pagehide`).

Opening **Settings** also triggers a snapshot if you have unsaved changes, so you can create one intentionally without leaving the page.

Additionally, on app **startup**:
- If there are **no snapshots yet**, a full snapshot is created ~5 seconds after load.
- If the **newest snapshot is older than 12 hours**, a full snapshot is created.

> **Nuance:** Snapshots are only written when you actually changed data. If you just opened and closed the app without editing, no new snapshot is made (the dirty flag stays false). This avoids useless duplicates.

### Full vs. Delta snapshots
- **Full snapshot** — contains your complete app state **plus the entire event history** (all analytics events). Created when no baseline exists yet, or as a fallback.
- **Delta snapshot** — contains your current state **plus only the events since the last full snapshot**. Smaller and faster.

> **Why events are embedded:** Questa prunes old live events after 18 months. By embedding the event list inside each snapshot, backups stay self-contained and are **not corrupted** when the live app prunes old events. A full snapshot is a complete standalone archive; a delta is a partial archive that needs its baseline to be fully meaningful.

### Write-then-verify integrity
Every snapshot is checked immediately after writing:
1. The record is written to IndexedDB.
2. It is read back and its SHA-256 hash is recomputed.
3. If the hash matches → the snapshot is marked **verified** (`✅`).
4. If the hash does **not** match (storage glitch) → the bad record is **deleted** and an error is logged.

Only **verified** snapshots appear in the restore picker.

### GFS rotation (automatic cleanup)
To bound storage space, old snapshots are pruned on app startup using a **Grandfather-Father-Son** scheme:
- Keep the **newest 7 daily** snapshots (one per calendar day).
- Keep up to **4 weekly** snapshots.
- Keep up to **6 monthly** snapshots.
- Everything else is deleted.

The single newest snapshot is always kept regardless of age.

> **Nuance:** Rotation only deletes snapshots that don't fit the retention windows. Your most recent backup is never pruned.

### Where the data lives
IndexedDB store named `backups`, inside the same browser/profile where you use Questa. It is **device-local and browser-local** — clearing site data or using a different browser/profile will not have these snapshots.

---

## Tier 2 — Off-Device Export

### What it is
A manual export that produces a single `.json` file you can save anywhere (Google Drive, Files app, email to yourself). This is your safety net against device loss or clearing browser data.

### How to export
1. Open **Settings** (gear icon).
2. Tap **Export**.
3. On supported mobile browsers, the native **Share sheet** opens (share to Drive, Files, etc.).
4. If sharing isn't available, the file downloads automatically (`questa-backup-YYYYMMDD-HHMM.json`).

### What the export file contains
- Your full app state (`S`).
- All analytics events (`events` array).
- A `_backup` block with metadata: `exportedAt`, `appVersion`, `eventCount`, item counts, and `lastActivityAt`.
- A **SHA-256 hash** of the file contents (computed before the hash field is added, then injected).

### Staleness nudge
The Settings gear icon (⚙) blinks red when your last off-device export is more than 7 days old (or you've never exported). There is no text label — the red blink is the reminder. After a successful Export, the app records the export timestamp and the gear stops blinking.

Settings also shows a **"Last full backup: [date & time]"** line in the footer (or "None" if no full snapshot exists yet) — this is the date of your last **Tier 1 snapshot** (local backup), not your last off-device export. This tells you exactly when your last complete baseline was made, separate from the delta snapshots that happen daily. A **"Last export: [date & time]"** line (or "None") appears right alongside it — this tracks your last Tier 2 off-device export, so you can see both dates at a glance.

> **Nuance:** The nudge is driven by Tier 1 snapshots, not by your last export. If you export weekly but don't trigger new snapshots, the nudge still reflects snapshot age. Treat "export at least every 7 days" as the rule of thumb.

---

## Tier 3 — Scheduled Dropbox Backups

### What it is
The same full export as Tier 2, uploaded to Dropbox automatically on cadences you choose — so an off-device copy exists even in the weeks you forget to tap Export. Requires Dropbox to be connected (Settings → Connect Dropbox). Off by default.

This is a **different feature from ordinary Dropbox sync**, which keeps devices in step by merging a lean subset of your data into `state.json`. Tier 3 uploads complete, standalone snapshots that are never merged. See `SYNC-USER-GUIDE.md` for sync itself.

### How to turn it on
Settings → **Auto-backup to Dropbox** → tick any combination of four independent cadences:

| Cadence | Fires | How many kept |
|---|---|---|
| **4-hourly** | at most once per sync, ~4h apart | last 10 |
| **Daily** | first sync after local midnight | last 7 |
| **Weekly** | first sync after Monday midnight | last 4 |
| **Monthly** | first sync after the 1st of the month | last 4 |

They stack rather than override: Daily + Monthly gives you a rolling week of dailies *and* four months of monthlies, each in its own rotating window, so the frequent tier can't crowd out the coarse one. Ticking a cadence uploads a first backup on the next sync rather than waiting for the window to come round.

### Where the files go
A `/questa-backups/` folder in your Dropbox app folder, named `<cadence>-<device>-<slot>-<date>-<time>.json`, e.g. `daily-123456-03-20260729-2041.json`. The device id in the name means several devices can back up to one Dropbox without overwriting each other. Within a cadence the slot numbers cycle, so the oldest copy is the one eventually replaced.

### Nuances worth knowing
- **The tick-boxes are per device and are deliberately not synced.** Enabling Monthly on your desktop does not enable it on your phone — set them on each device you want backing up.
- **There's no background clock.** The check rides along with ordinary sync (which runs on change, tab switch, and reconnect), so a backup fires shortly after its window opens, not at the stroke of midnight. If Questa was closed, overdue backups run next time you open it and a sync succeeds.
- **Missed windows don't stack.** Three weeks closed gives you one catch-up backup per cadence, not twenty.
- **Each cadence fails independently**, and errors appear under "Last sync" in Settings naming the cadence that failed.

> **If you switched this on before 29 July 2026, check your Dropbox.** Only the **4-hourly** cadence actually worked until then. Daily, Weekly and Monthly could be ticked and appeared enabled, but a scheduling bug meant they never fired — if those were your only ticked cadences, nothing was ever uploaded. Fixed in `v2026.07.29-2041`. Open `/questa-backups/` once to confirm files are now appearing.

### Recovering from a Tier 3 file
Download any file from `/questa-backups/` and use Settings → **Import**. The format is identical to a Tier 2 export, hash verification included — see Option B below.

---

## Restoring Your Data

### Option A — Restore from a local Tier 1 snapshot
1. Settings → **Restore Local Snapshot**.
2. A list of **verified** snapshots appears, each showing date/time, type (Full/Delta), event count, and size.
3. Tap **Restore** on the one you want.
4. Confirm the warning — this **replaces your app state** (tasks, character, rewards, prefs).
5. The app reloads with that state; the snapshot's events are merged into your local event log rather than replacing it — local-only events are kept (see the nuance under Option B, and the 2026-07-29 note there).

**Delta-snapshot behavior:** If you restore a **delta** snapshot and its **full baseline is missing** (e.g. it was rotated away), you'll get a warning that only partial data may be restored. You can still proceed or cancel.

> **Nuance:** Only verified snapshots are offered. If you see "No verified local snapshots found," you haven't triggered any yet — make an edit, then open Settings (which creates one) and tap Restore.

### Option B — Import a Tier 2 export file
1. Settings → **Import**.
2. Choose your `questa-backup-*.json` file.
3. Questa **validates the hash**: it recomputes the SHA-256 over the file (excluding the hash field) and compares it to the stored hash.
   - **Match** → you're asked to confirm; on confirm, your app state is replaced and the embedded events are merged into your local event log (not replaced — see the nuance below).
   - **Mismatch** → import is **cancelled** with a "corrupted or tampered" error. The current state is untouched.
4. If the file has **no hash** (older/foreign format), it imports without verification.

> **Nuance:** Your app state (tasks, character, rewards, prefs) always replaces current progress after confirmation — there is no merge for state, so export first if you want to keep what's currently on this device. **As of 2026-07-29 (`v2026.07.29-2041`), events are the exception:** imported/restored events are merged additively into your local event log, deduplicated so re-importing the same file twice adds nothing new the second time, and any events that exist only on this device are kept. Before this fix, both Restore and Import wiped every local event not present in the file being loaded — this is no longer the case.

> **Nuance (events-only files):** A file containing only reconstructed/backfilled events (no `char`/`tasks`) cannot go through Settings → Import — Import requires both fields and will reject it. Those files load instead through the debug overlay's **"Load reconstructed events (device-local, backfill)"** control (tap the version number in Settings 5× within 3 seconds to reveal it). Events loaded that way are marked `synthetic`, shown with a **~ backfill** badge in the Activity Feed, and are device-local only — they never sync to another device.

---

## Integrity & Security Notes

- **Hashing:** SHA-256 via the browser's Web Crypto API. If Web Crypto is unavailable (e.g. opened over insecure HTTP), a deterministic fallback hash is used and exports still proceed (marked less securely).
- **Tamper detection:** Both import and snapshot verification detect altered files/content via hash mismatch.
- **No Questa server:** there is no Questa-operated backend. Tiers 1 and 2 are entirely client-side. Tier 3 and ordinary sync upload to **your own Dropbox account** via Dropbox's API, into a Dropbox App folder dedicated to Questa — your Dropbox credentials are only ever seen by Dropbox's own login page. Nothing is uploaded anywhere until you connect Dropbox yourself. *(Corrected 2026-07-29: this bullet previously read "Questa never uploads your data," which stopped being true when Dropbox sync shipped on 2026-07-10.)*
- **No backups while the app is closed:** because app state lives in `localStorage` (inaccessible to the Service Worker while the app is closed), nothing is backed up when Questa isn't open. Tier 1 fires while the app is active and you leave it; Tier 2 is manual; Tier 3 rides along with sync, which also only runs while the app is open — an overdue Tier 3 backup fires shortly after you next open it, not while it's shut.

---

## Examples

### Example 1 — Normal daily use (zero effort)
You check off habits, complete dailies, add a todo. You switch to another app. Questa writes a **delta** snapshot (your state + today's new events). Tomorrow the same happens. You never touch Settings. If you later botch an edit, you open Settings → Restore and pick yesterday's snapshot.

### Example 2 — First run creates a baseline
Fresh install, you add your first task, then close the tab. No baseline exists, so Questa writes a **full** snapshot (state + all events). All future snapshots are deltas referencing it.

### Example 3 — Weekly off-device backup
Every Sunday you open Settings, tap **Export**, and share to Google Drive. The file `questa-backup-20260709-1430.json` lands in Drive with a SHA-256 hash. If your phone is wiped, you reinstall Questa, Import that file, and everything returns exactly.

### Example 4 — Corrupted file blocked
Someone edits your backup `.json` to change a task name but leaves the hash unchanged. On Import, Questa recomputes the hash, sees it doesn't match, and **refuses** with a tamper warning. Your live data is safe.

### Example 5 — Delta without baseline
You restore a delta from 20 days ago, but the weekly/monthly rotation already deleted its full baseline. Questa warns "only partial data may be restored" — you proceed knowing analytics history before that delta may be incomplete, or you cancel and pick a full snapshot instead.

### Example 6 — Staleness reminder
You haven't exported in 9 days. The Settings gear icon (⚙) blinks red. You tap Export, share to Files, and the gear stops blinking.

---

## Quick Reference

| Action | Where | Automatic? | Off-device? |
|--------|-------|-----------|-------------|
| Tier 1 snapshot (full/delta) | IndexedDB `backups` | Yes, on leave/edit | No (device-local) |
| Tier 2 export | Shared/downloaded `.json` | No (tap Export) | Yes |
| Tier 3 scheduled backup | Dropbox `/questa-backups/` | Yes, on your ticked cadences | Yes |
| Manual Save to Dropbox | Dropbox `/export-backup.json` | No (tap Export → Save to Dropbox) | Yes |
| Restore Local Snapshot | Settings → Restore Local Snapshot | No | No |
| Import file | Settings → Import | No | Yes (from your file, incl. any Tier 3 file) |

**Golden rule:** Tier 1 protects against bad edits. Tier 2 protects against device loss. Tier 3 protects against *forgetting* to do Tier 2. Use all three.
