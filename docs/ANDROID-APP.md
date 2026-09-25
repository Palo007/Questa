# Android app

Questa also ships as a sideloaded Android app: a Trusted Web Activity (TWA)
shell around this PWA, plus a small amount of native code for two things a
closed browser tab cannot do — fire notifications and log a habit tap while
Questa itself is closed. The shell lives in a separate repo and is **not**
part of this codebase.

**Full guide:** [`Palo007/Palo007.github.io`](https://github.com/Palo007/Palo007.github.io)
— its `README.md` is the authoritative doc for the Android side (build/sign/install,
permissions, troubleshooting, code map). This page only covers the PWA side of
the contract between the two.

## Why two repos

The Android app cannot read this page's `localStorage`/IndexedDB, and this
page cannot fire a notification or log anything while its tab/service-worker
is dead. The two talk only through small JSON files in the same Dropbox app
folder used for sync. Never assume the phone can see PWA state directly.

## The contract (PWA side)

| Path | Who writes | Who reads | PWA functions |
|---|---|---|---|
| `/inbox/<uuid>.json` | phone | PWA | `syncInboxConsume`, `inboxParseRecord` (`sync.js`) |
| `/inbox-claimed/<deviceId>/` | PWA (claims via `move_v2`) | PWA (crash recovery) | `syncInboxConsume`, `dbxMove` (`sync.js`) |
| `/inbox-rejected/` | PWA | — (diagnostics only) | `_inboxReject` (`sync.js`) |
| `/inbox-meta/habits.json` | PWA | phone | `syncInboxWriteMeta` (`sync.js`), `quickLogDirs` (`app.js`) |
| `/inbox-meta/reminders.json` | PWA | phone | `syncInboxWriteReminders` (`sync.js`), `getReminderNotificationPayload` (`app.js`) |
| start URL `?nr=1` | phone | PWA | `parseNativeRemindersParam`, `nativeRemindersActive` (`app.js`) |

Applying a phone-side log to state goes through `applyInboxLog` (`app.js`),
called by `syncInboxConsume` after the pull and before `syncSubset()`, so the
change rides in that same sync round. Idempotency is via `evtHasUid("inbox-"+id)`
— never a new `S.*` field.

Missed-reminder bodies are prefixed `'Missed at ' + r.time + ' - '` by
`getReminderNotificationPayload(t, r, missed=true)` — the Android side parses
this exact prefix back out for notification dedupe.

`nr=1` today is read (`nativeRemindersActive()`) but **not** used to suppress
web reminders: `checkReminders()` still fires both due and missed reminders on
the web regardless, because the phone's copy of the reminder schedule can be
stale. Deduplication of the resulting double-fire happens entirely on the
Android side.

## Rules for changes here that would break the phone

The Android parser code (`HabitList.kt`, `ReminderList.kt`, `InboxRecord.kt`)
is frozen against these exact shapes, and a bad/unrecognized file is designed
to fail safe (`null` → keep the existing menu/alarms, not wipe them) — but
only for a file it fails to *parse*, not one it silently misreads.

- **Do not change any of the file paths above**, or the JSON key names/types
  inside them, without updating the matching Kotlin parser in
  `Questa-Bubblewrap/app/src/main/java/io/github/palo007/twa/quicklog/`.
- **Always keep the `"v"` field** the first thing checked. Every payload is
  versioned (`v:1`); a shape change must bump `v` and the Android parser must
  explicitly handle (or reject) the new version — do not silently reuse `v:1`
  for an incompatible shape.
- **Do not touch the `Missed at HH:MM - ` prefix format** without updating
  `ReminderDedupe.kt`'s `parseMissedTime` on the Android side in the same change.
- **Do not add `S.*` fields or `_EXPORT_FIELD_MAP` export codes** for inbox
  state — it must live only in Dropbox files + the events store (export token
  hash trap: new codes make backups unimportable by older builds).
- Changing `inboxParseRecord`, `syncInboxWriteMeta`, or `syncInboxWriteReminders`
  in `sync.js`, or the reminder payload shape in `app.js`, should be treated as
  a cross-repo change: update this doc and flag the corresponding Kotlin file
  in the Android repo in the same commit series.
- `reminders.json` never holds a `once` reminder without a `date` (CR-PWA-001).
  Items carry no `kind`, and an everyday item is also `date:null, days:null`,
  so a reader must not guess "once" from `date:null`.

## Shared Dropbox app key and duplicate notifications

- The web app, the TWA and the native Kotlin app use **one Dropbox app key**.
  Revoking Questa's access in Dropbox (Settings → Connected apps) logs out all
  three at once. Reconnect each app after a revoke.
- If the web app is also open in a plain Chrome tab on the same phone, one
  reminder can show up to three times: the native alarm, the TWA copy, and the
  Chrome copy. The TWA drops its own web copy of a slot the native alarm already
  showed. A plain Chrome tab is outside the TWA, so its copy is not dropped.
  Close the Chrome tab (or turn off its notifications) to avoid the extra one.

## Moving from the Android TWA to the native app

The TWA keeps its data inside the browser (Chrome or Brave) storage for this
site. It is not in the TWA app itself. If you uninstall the TWA, or clear the
browser's data, before you sync or export, anything not yet synced is lost.

Do the steps in this order:

1. **Final sync.** In the TWA, open Questa online and let it sync to Dropbox.
   Check "last synced" in the sync panel.
2. **Export a file.** In the TWA, run **Export** with all sections. Save the
   JSON outside the browser (Downloads, plus a copy off the phone). This is
   your safety copy.
3. **Stop using the TWA shortcuts** from here on, so no new taps land in
   the inbox mid-switch.
4. **Install the native (Kotlin) app.** Grant notifications and exact alarms.
5. **Bring the data in.** Connect the same Dropbox account and sync, or
   import the JSON from step 2. Do one, check the result, then decide about
   the other.
6. **Verify counts.** Habits, tasks, today's log, character stats and the
   reminder list must match the TWA export.
7. **Uninstall the TWA.** Uninstall it, do not just disable it: uninstalling
   removes its alarms and its home-screen shortcuts, so reminders stop firing
   twice. Leave the browser's site data alone for a while as a fallback.
