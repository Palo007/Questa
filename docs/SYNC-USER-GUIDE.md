# Questa Sync — User Guide

Questa can keep your progress the same across multiple devices (e.g. desktop and phone) using **your own Dropbox account** as the go-between. There is no Questa server — your data goes straight from your browser to a small folder Dropbox creates for the app in your account, and back down to your other device.

---

## TL;DR

- **Setup:** Settings → **Connect Dropbox** → log in and approve once. Do this on every device you want kept in sync. *(Running your own copy of Questa? One extra one-time step first — see [Setting it up](#setting-it-up).)*
- **Day to day:** you don't do anything. It syncs automatically a few seconds after any change, when you switch tabs/apps, and when you come back online.
- **To sync right now:** Settings → **Sync now**.
- **To stop syncing this device:** Settings → **Disconnect**. Your local data is untouched.
- **"Force push" / "Force pull" / "Force Push Events"** are emergency/one-time tools, not normal buttons — see their own sections below before you touch either.
- **Want a full backup copy in Dropbox too** (not just the lean sync data)? Settings → **Auto-backup to Dropbox** → pick a schedule, or use **Export → Save to Dropbox** any time. See "Automatic full backups to Dropbox" below.

---

## What syncs, and what doesn't

| Synced | Not synced |
|---|---|
| Tasks, habits, dailies (and their history) | Device display settings (width, card size, haptics…) |
| Rewards | Local backup snapshots (Settings → Restore Snapshot) — those stay per-device on purpose |
| Tags | |
| Custom analytics views & metrics | |
| Character stats (level, XP, gold, HP) | |
| The detailed tap/completion event log (from 2026-07-10 onward — see "Event log sync" below) | |

If you only use Questa on one device, none of this matters — sync is entirely opt-in and off by default.

The items in "Not synced" above aren't unbacked-up, though — see "Automatic full backups to Dropbox" below for a way to get everything (including those) into Dropbox too, just on a slower schedule and without merging.

### Why the Dropbox file is much smaller than an export file

If you compare `state.json` in Dropbox to a file from Settings → **Export**, the export is usually several times bigger. That's expected — the export is a *complete* backup, sync is a *lean* one, and they're deliberately built for different jobs:

- **The export still carries the full tap/completion/subtask event log, but so does sync now (see "Event log sync" below).** The export bundles it as one big file rebuilt from your device's own IndexedDB each time; sync instead trickles it in per-device, per-month, so the export remains the bigger file even though both eventually contain the same events.
- **The export also includes your device display settings** (width, card size, haptics, drag speed, etc.) — sync deliberately leaves these device-local, since you may want, say, a wider layout on your desktop and a compact one on your phone.
- **The export is formatted for human readability** (indented JSON); the sync file is compact. This adds some size but isn't the main factor.

None of this means sync is "missing" anything that matters for keeping your tasks/rewards/tags/character/analytics-views in step across devices — those are exactly what syncs. It just isn't trying to be your full backup; keep doing periodic exports (or rely on the automatic local snapshots) for that, per `BACKUP-USER-GUIDE.md`.

---

## Setting it up

> **Running your own copy of Questa?** Do the one-time step in
> [INSTALL.md → Self-hosting and Dropbox sync](../INSTALL.md#self-hosting-and-dropbox-sync)
> **first**. The Dropbox app key shipped in this repository is registered for the
> original deployment's web address only, and Dropbox refuses any login whose
> return address is not registered on that app. On your own address — a fork on
> GitHub Pages, a different host, or `localhost` — step 1 below sends you to
> Dropbox and the approval simply never comes back. Registering your own Dropbox
> app takes about two minutes and fixes it. If you are using the original
> deployment, ignore this and carry on.

1. Open **Settings** and tap **Connect Dropbox**.
2. You'll be sent to Dropbox's own login/approval page. Log in and tap **Allow**. Nothing about your password ever passes through Questa.
3. You're brought back to Questa. Settings should now show **Sync now** / **Disconnect** and a "Last sync" time.
4. Repeat on your other device(s), **using the same Dropbox account** each time. Devices only sync with each other if they're pointed at the same Dropbox account.

> **Nuance:** the very first sync just uploads whatever is on that device — nothing to merge with yet. The **second** device you connect is the interesting one: it downloads what device 1 uploaded and blends it with whatever's already on device 2 (see "How merging works" below).

---

## How merging works (in plain terms)

Questa never blindly overwrites one device with another during a normal sync — it merges, item by item:

- **If only one device changed something** (say you completed a task on your phone, and nothing changed on your desktop), that change simply carries over. Nothing is lost either side.
- **If both devices changed the *same* task/reward/tag/view**, the more recently edited version wins. The other edit is discarded — this is the one case where a real edit can be lost, and only if it collided with a *newer* edit to the exact same item.
- **If one device deleted something and the other edited it**, the edit wins — Questa "resurrects" the item rather than silently losing edited data to a deletion.
- **If one device deleted something and the other device never touched it**, the deletion goes through everywhere.
- **New items** (a task added on either device) always come through as an addition — merging is a union, not a pick-one.

### Worked example

You add "Buy groceries" on your phone while offline. Meanwhile, on your desktop (also offline), you rename an existing habit and complete a daily. Once both come back online and sync:
- "Buy groceries" appears on both devices (it's new, no conflict).
- The habit's new name appears on both (only the desktop touched it).
- The daily's completion appears on both (only the desktop touched it).
Nothing collided, so nothing was lost — this is the common case.

### Where it can lose a little data (by design, not a bug)

- **Character stats (level/XP/gold/HP):** if you score a habit on *both* devices before either has had a chance to sync, whichever device syncs second "wins" for your stats — you might lose a few XP/gold from the other device's tap. Your tasks and history are unaffected; this is purely the character numbers.
- **Task list order:** if you reordered your habits/tasks list by dragging on one device while adding a new task on another, the new task lands at the end of the list rather than exactly where it "should" be. A quick manual drag fixes it. (This is about the order of your *list of tasks* — for the order of *subtasks within one task*, see "Subtask and checklist merging" below, which works a little differently.)
- **Both devices offline overnight:** if both devices are offline when the daily reset happens and both come online and run their own reset before syncing, a missed daily's HP damage could in rare cases apply twice. Staying online (or syncing before/after the day rolls over) avoids this.

None of these can corrupt your data or lose a whole task/reward — at worst they're small, self-correcting inconsistencies.

---

## Subtask and checklist merging

As of 2026-07-11, checking off, adding, editing, or deleting subtasks (checklist items) merges correctly item-by-item — even if you did it on two different devices before either had synced. Older versions of Questa could not do this (see the historical note at the end of this section); this is the current, fixed behavior.

- **Checking different subtasks on the same task, on two unsynced devices** — both check-marks survive.
- **Adding a new subtask on one device while checking or editing an existing one on another** — both survive: the new subtask appears, and the existing one keeps whatever you changed on it.
- **Deleting a subtask on one device while checking or editing a *different* subtask on the same task, on another device** — the deletion goes through, and the other subtask's change survives too.
- **Deleting a subtask on one device while editing that *same* subtask's text on another** — the edit wins. The subtask survives with its new text rather than vanishing, on the reasoning that an edit is stronger evidence of "still wanted" than a deletion made without seeing that edit.
- **Editing the exact same subtask's text differently on two devices** — the one genuine subtask-level conflict Questa can't resolve for you: whichever edit happened more recently wins for that one line. It has no effect on any other subtask on the same list.
- **Checking the exact same subtask "done" on both devices** — not actually a conflict (you both said the same thing); it just stays done.

### Worked example

You're at the store with your phone (offline): you check off "milk" and "eggs" on a shared shopping-list task, and add "bread" as a new subtask. Meanwhile, on the tablet (also offline, hasn't seen your changes yet), your partner checks off "bananas" on the same task and renames "eggs" to "eggs (dozen)". Once both devices come back online and sync:
- milk and bananas are both checked
- bread is on the list (your addition)
- the item is now called "eggs (dozen)" (their rename) *and* still shows checked (your tick) — your check and their rename touched different parts of the same item, so both stick.

Nothing from either device is lost.

### The one thing that still doesn't merge: subtask *order*

If you drag-reorder a task's subtasks on one device, and don't make any other change to that same task anywhere else before syncing, your new order carries over cleanly — this is the common case and works fine. But if you reorder subtasks on one device *while* another device also edits or checks something on that same task before either syncs, the final order follows whichever device's edit to the task counts as more recent overall — your reorder can be silently reverted even though every check-mark and text edit involved is still correctly merged in, nothing is deleted. A quick manual drag afterward fixes the order if this happens.

*(Historical note: earlier versions of this guide warned that editing the same task's subtasks on two unsynced devices could silently drop one entire side's checklist changes — ticks and additions alike. That was fixed on 2026-07-11; subtask merging is now per-item, as described above, and that old warning no longer applies.)*

---

## Event log sync

The detailed tap/subtask/completion event log (used by the Analytics → Event log detail view) syncs too, but differently from the rest: each device publishes only its own events, and every device downloads and merges in everyone else's. A few things follow from that shape:

- **Nothing is ever overwritten or three-way-merged here** — it's a pure union. Every event that ever happened on any synced device eventually shows up on all of them.
- **Deleting or clearing the event log on one device does not delete it anywhere else.** There are no "tombstones" for events — a clear is local-only, and the same events will simply reappear from other devices (or from Dropbox) on the next sync.
- **Events from before 2026-07-10, and the synthetic events created by Habitica import, stay on the device that made them, permanently, by design.** They were never stamped with the per-device ID this feature relies on, so there's nothing to sync them by.
- **Events older than about 18 months age out** and are not re-fetched from other devices once they do — same retention window your device already applies to its own event log.
- **The log can end up disagreeing with the task itself.** If the "editing the same task on two unsynced devices" case above discarded one device's checklist ticks, those taps still show up in the Activity Feed / Event log detail forever — event sync never discards anything. So you may see a subtask logged as checked off at a time when the task now shows it unchecked. That's expected: the log records what was tapped, not what "won" the merge.
- **Each event now shows which device it came from.** Settings has a **Device name** field (next to "Sync now") — give a device a name like "Phone" or "Laptop" and it'll show up next to that device's events in the Activity Feed. Leave it blank and the event just shows the device's short ID instead (the same one shown in Settings), so events are still distinguishable even before you name anything. Device names sync the same way tasks do, so once you name a device, every other synced device shows that name too. Renaming a device also writes one small "device name" event of its own, recording the id→name mapping at that moment — handy for tracing old events back to a device if you rename it again later or it gets wiped.
- **Conflict decisions have their own category and toggle.** Conflicts resolved during sync (where the same item was edited on two devices and a winner was picked) are now shown in a separate **Conflict** category in the Activity Feed, independent of the "Hide sync & diagnostic events" toggle. Settings → **Hide conflict decisions** (default **Off**) controls their visibility. Turn it On to declutter the feed; leave it Off to see every merge decision for debugging.
- **Conflict entries now carry device-relative labels.** A conflict entry records `winnerDev` / `loserDev` / `reason` so it reads *"kept Phone's copy"* on *both* devices — not reversed on the loser's side.
- **Conflict logs are throttled.** Only one `conflictResolved` entry is emitted per (kind, entityId) per sync round, even if retries occur. No more log spam from conflict retry loops.

---

## Conflict decisions in the Activity Feed

When a sync merges two versions of the same task/reward/tag/view, a **Conflict** event is logged. You'll see it in the Analytics → Event log detail view (and the Activity Feed) as a row with a ⚖️ icon and a **Conflict** badge.

| Field | What it means |
|---|---|
| **Winner** | The device whose edit was kept (e.g. "kept Phone's copy"). This is *device-relative*: it reads the same way on both devices. |
| **Loser** | The device whose edit was discarded. |
| **Reason** | Why the winner won (e.g. "newer edit", "device id tiebreak"). |

These entries are **not** controlled by "Hide sync & diagnostic events". They have their own toggle: Settings → **Hide conflict decisions** (default **Off**).

---

## "Force push" — overwriting Dropbox on purpose

**What it's for:** occasionally the copy of your data sitting in Dropbox is *wrong* in a way merging can't fix — most commonly, it's test/placeholder data from setting things up, and you want a freshly-connected real device to become the source of truth instead of blending with that placeholder data.

**What it does:** Settings → **Force push (overwrite Dropbox)** replaces the contents of Dropbox's `state.json` — tasks, rewards, tags, character stats, analytics views, the lean "what syncs" subset — with whatever is on the device you press it on. It does **not** merge — anything in that state file that this device doesn't already have is gone, permanently, the moment the push succeeds. That includes changes any *other* device made that haven't synced yet. **It never touches the event log**, though: the per-device event files in Dropbox are left exactly as they are, so a force push cannot overwrite or lose event history, however old this device's own data is.

**Before you press it, ask:** "Does any other device have data I still need, that isn't already on this device?" If yes, sync that device first so nothing is lost.

You'll be asked to confirm once before anything happens — there's no accidental version of this button. The confirmation dialog also shows this device's local event count, with a note if it's under 50 that this may not be the most up-to-date device — that's a hint about *this* device's own history, not a claim that events are at risk in Dropbox, since (as above) force push never touches the event log either way.

### Worked example (the scenario this was built for)

You set up sync on a test/throwaway device while getting things working, and it pushed a handful of test tasks to Dropbox. Now you're ready to connect your real phone, and you don't want that test data anywhere near your real tasks.
1. On your real phone, connect Dropbox as usual.
2. Settings → **Force push** → confirm.
3. Dropbox now has exactly your phone's real data, nothing else.
4. If you reconnect the old test device later, it will pull down your phone's real data on its next ordinary sync (that's normal — every device converges to the same state going forward).

---

## "Force pull" — overwriting this device on purpose

This is the mirror image of Force push, for the opposite situation: **this** device has the wrong/empty/test data, and Dropbox already has the real data (usually because another device just did a Force push, or because this is a fresh device you haven't used yet).

**What it does:** Settings → **Force pull (overwrite this device)** replaces this device's state (tasks, rewards, tags, character stats, analytics views — the same "what syncs" subset Force push writes) with whatever is currently in Dropbox. That part is still a full overwrite, not a merge: anything on this device that hasn't synced yet is gone, permanently, the moment the state pull completes. The event log is handled differently, though: right after the state overwrite, Force pull also pulls in every other device's events and merges them in additively — same as ordinary sync's event handling (see "Event log sync" above) — bypassing the usual rev cache and 60-second throttle so it catches up in one shot rather than trickling in. If that event pull happens to fail, it's recorded as an error but does **not** undo or fail the state pull — your state has already been safely overwritten by the time it runs.

**Before you press it, ask:** "Have I made any changes on this device I still need?" If yes, and you're not sure they're already in Dropbox, don't force pull — do a normal Sync now first and check.

Also asks for confirmation once before doing anything, same as Force push.

### Worked example

Your desktop has your real, long-running data. You set up Questa fresh on a new phone and connect it to the same Dropbox account — an ordinary sync would already pull your desktop's data down correctly in this case, so you'd only reach for Force pull if, say, you'd tapped a couple of things on the new phone first (creating a small local task or two) and want to be certain none of that gets merged in — you just want the phone to become an exact copy of what's in Dropbox.
1. On the new phone: Settings → **Force pull** → confirm.
2. The phone's data becomes byte-for-byte whatever was in Dropbox, discarding anything the phone had that wasn't already synced there.

> **Reminder:** in the *ordinary* case — a brand-new device with nothing on it yet, or a device that hasn't touched its data since its last sync — you don't need Force pull at all. A normal **Sync now** already takes everything from Dropbox with nothing to conflict against. Force pull is only for making sure, when this device might have some unsynced changes you want to discard on purpose.

---

## "Force Push Events" — overriding the shrink guard

**What it's for:** Questa now tracks how many events you have per month in Dropbox. If your local event count for a month is *smaller* than what Dropbox already has (and it's not just old events aging out), the push for that month is **blocked** to prevent accidental data loss. You'll see a toast: *"Sync blocked: N month file(s) would shrink. Use 'Force Push Events' in Settings to override."*

This can happen if:
- Your local IndexedDB was corrupted or partially wiped
- A bug caused events to be dropped locally but not in Dropbox
- You're intentionally trying to push a smaller set (rare)

**What it does:** Settings → **Force Push Events** ignores the shrink check and pushes whatever you have locally, overwriting the month files in Dropbox. It also does a **full re-push** (ignores the upload watermark, pushes all months). Use this only if you're sure your local copy is the one you want in Dropbox.

**Before you press it, ask:** "Is my local event log definitely the correct, complete one?" If another device has events you don't, those will be lost in Dropbox for the affected months.

---

## Automatic full backups to Dropbox

This is a **separate feature from ordinary sync above** — easy to conflate since both use Dropbox, so here's the distinction up front:

| | Ordinary sync (`state.json`) | Auto-backup (files in `/questa-backups/`) |
|---|---|---|
| What it contains | Tasks/rewards/tags/character/analytics — the lean, mergeable subset (see "What syncs" above) | **Everything** — the exact same file Settings → **Export** produces: your entire on-device state (including device-local UI settings) plus the full tap/completion event log |
| When it runs | Continuously, a few seconds after any change | On each cadence you switch on — up to four independent ones |
| How it's written | Merged with whatever's already there | Written as a new dated file into a rotating set of slots — each snapshot stands alone, nothing is merged |
| What it's for | Keeping devices in step | A safety-net copy of a full backup living somewhere other than "this device's downloads folder" |

**Turning it on:** Settings → (once Dropbox is connected) **Auto-backup to Dropbox** → tick any combination of four independent cadences. All four are off by default; nothing is uploaded until you tick at least one.

| Cadence | Fires | How many kept |
|---|---|---|
| **4-hourly** | at most once per sync, ~4h apart | last 10 |
| **Daily** | first sync after local midnight | last 7 |
| **Weekly** | first sync after Monday midnight | last 4 |
| **Monthly** | first sync after the 1st of the month | last 4 |

They're independent, not a single "how often" dial — ticking Daily *and* Monthly gives you both a rolling week of daily copies and four months of monthly ones. Each tier keeps its own separate rotating window, so a busy tier can't push out your older, coarser snapshots. Missed windows don't stack: if Questa sat closed for three weeks, you get one catch-up backup per tier, not twenty.

**Ticking a cadence backs up straight away.** A tier that has never run is treated as due, so you get a first snapshot on the next sync rather than waiting up to a month to find out whether it works. After that it settles into the cadence above.

**These tick-boxes are per device, on purpose.** They are deliberately excluded from what syncs, so your phone and your desktop can have different cadences — and enabling Monthly on your desktop does *not* silently turn it on everywhere. The flip side: set them once on each device you want backing up.

**Manually, any time:** Settings → **Export** now has a fourth option, **Save to Dropbox**, alongside Share / Save to this device / Cancel. It only appears once Dropbox is connected, and uploads immediately rather than waiting for a cadence. This one still writes the single `/export-backup.json` file, separate from the rotating tier files below.

**Where it goes:** a `/questa-backups/` folder in your Dropbox app folder, alongside `state.json`. Filenames look like `daily-123456-03-20260729-2041.json` — cadence, a short device id, the slot number it's rotating through, then the date and time. Because the device id is in the name, two devices backing up to the same Dropbox never overwrite each other's copies. Within one tier the slots cycle, so the oldest copy is the one that eventually gets replaced.

**"Last export" is one shared indicator.** The "Last export" line in Settings (Backup & transfer) updates from *any* of: a local Share, a local Save to this device, a manual Save to Dropbox, or an automatic Dropbox backup — whichever happened most recently. Note it's only a display of "something was backed up recently"; each cadence tracks its own last run separately, so a manual export no longer delays your scheduled ones.

**How the schedule is checked:** there's no separate clock running in the background. The check rides along with your normal sync — which already runs on every change, tab switch, and reconnect — so a backup fires shortly after its window opens, not at the exact stroke of midnight. If you leave Questa closed for a while, anything overdue runs the next time you open it and a sync succeeds.

> **If you had this switched on before 29 July 2026, please check your Dropbox.** Until then, only the **4-hourly** cadence actually worked. Daily, Weekly and Monthly could be ticked and looked enabled, but a scheduling bug meant they never fired — if those were your only ticked cadences, no automatic backups were ever uploaded. Fixed in `v2026.07.29-2041`. Worth opening `/questa-backups/` once to confirm files are now appearing for each cadence you use.

**Upgrading from the old "every N days" setting:** earlier versions had a single Auto-backup interval (Daily / Every 3 days / Weekly / Every 2 weeks / Monthly). Your old choice was carried over automatically — 1 or 3 days became **Daily**, 7 days became **Weekly**, 14 or 30 days became **Monthly**. Nothing was silently switched off, but it's worth a look to confirm the cadences you ended up with are the ones you want.

---

## Troubleshooting

Settings always shows the most recent problem, if any, right under "Last sync." A few you might see:

- **"reconnect required"** — Dropbox revoked access (e.g. you removed the app's permission on dropbox.com). Disconnect, then Connect again.
- **A message mentioning `missing_scope`** — the Dropbox app itself isn't set up with file access permissions yet. This is a one-time setup issue, not something day-to-day use can trigger.
- **"sync conflict — retry later"** — two devices tried to write at the exact same moment. It retries automatically; if you still see this after a minute, tap Sync now.
- **Anything mentioning a numeric error code (401/409/429/5xx)** — transient network/Dropbox issues retry automatically. If it persists, check you still have internet, then Sync now.
- **"auto backup failed"** or **"Dropbox backup failed"** — a full-backup upload hit a problem (shown with the underlying reason appended, and naming which cadence failed). This is about the backup files — `/questa-backups/…` for the automatic cadences, `export-backup.json` for the manual button — not ordinary sync; `state.json` sync can keep working fine even if this fails. Try the manual **Save to Dropbox** button once you're back online to confirm it's resolved. Each cadence fails independently, so one failing tier doesn't stop the others.
- **"Sync blocked: N month file(s) would shrink"** — the push shrink guard detected that your local event count for one or more months is smaller than what Dropbox already has. Tap **Force Push Events** in Settings to override and push anyway, or investigate why events were lost locally first.

If Settings still just shows **Connect Dropbox** after you thought you connected: the connection attempt didn't complete. Try again, and make sure you don't close or reload the tab in the few seconds right after Dropbox's approval page sends you back.

If it keeps failing on **every** attempt, and you are running your own copy of Questa rather than the original deployment, the cause is almost certainly the unregistered redirect address described at the top of [Setting it up](#setting-it-up). Dropbox will not send the approval back to an address that is not listed on the app the key belongs to, so no amount of retrying helps — register your own Dropbox app instead ([INSTALL.md](../INSTALL.md#self-hosting-and-dropbox-sync)).

**Double-checking that event sync is actually keeping up:** the diagnostic overlay (Settings → tap the version number 5× within 3 seconds) includes a per-device event divergence readout — this device's local event count for every known device, next to what the last Dropbox pull cached for that device's files. A device showing zero local events while its file still exists in Dropbox is flagged in red — that combination means this device's copy of that device's history hasn't actually arrived, even if ordinary sync otherwise looks healthy.

**Watermark self-heal:** if the app detects that the upload watermark (`evtLastUploadTs`) is in the future (caused by a device clock skew), it automatically resets it to your latest local event timestamp on boot, shows a toast, and writes a persistent note in Settings. This prevents the "stuck upload" failure mode where a future-dated watermark silently stops all uploads.

**24-hour full re-push:** once per day, the event push ignores the watermark and pushes all months from scratch. This self-heals any month that got skipped or blocked.

---

## Good to know

- Your Dropbox login credentials never touch Questa or any Questa-related server — only Dropbox's own login page sees them.
- Data lives in a Dropbox **App folder** dedicated to Questa, not your general Dropbox files.
- Disconnecting a device stops it syncing but keeps its local data exactly as-is.
- Sync is per-browser-profile, same as the rest of Questa's data — a different browser or profile on the same physical device is a separate "device" as far as sync is concerned.