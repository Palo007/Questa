# Questa — History & Analytics Tracking Reference

Last updated: 2026-06-24 (app version v2026.06.24-2054). This documents **what data
the app persists for later analysis**, **which function writes it**, and **what is
still not tracked**. All persisted state lives in `localStorage` (see `S` in `app.js`);
there is no backend.

## How history works (one-point-per-day model)

Each task carries its own `history` array. A history **point** is a dated snapshot.
The single writer is `logHistory(t, patch)`. It enforces **one point per calendar day
per task**: if the most recent point is from today, the patch is *merged* into it;
otherwise a new point is pushed.

```
logHistory(t, patch)
  ├─ same day as last point?  → merge patch into existing point
  └─ new day?                 → push {date: now, ...patch}
```

Consequence: within a day, multiple events on the same task collapse into one point.
Counters (`scoredUp`, `scoredDown`, `reps`) accumulate on merge; flags
(`completed`, `repCounted`, `scored`) latch; `reward` and `checklist` are overwritten
by the latest value.

Analytics never read raw `history` directly — they go through `anAllEvents()`, which
flattens every task's history into uniform **event** objects and back-fills sensible
defaults for old/imported points that predate a field.

## Fields tracked per history point

| Field | Type | Written by (function) | When | Description |
|---|---|---|---|---|
| `date` | ms epoch | `logHistory` | every write | Timestamp of the (latest) event that day. Collapsed to one per day. |
| `value` | number | `completeTask`, `scoreHabit`, `runCron`, `unlogToday` | on any score/complete/miss | Habitica internal score for the task. Trend signal, **not** a count. |
| `completed` | bool | `completeTask` (daily/todo), `runCron` (miss→false), `unlogToday` (undo→false) | complete / cron miss / uncheck | Real completion flag for dailies & todos. |
| `isDue` | bool | `completeTask` (daily), `runCron` (daily miss) | daily complete or miss | Marks the point as a scheduled-daily event (vs. a habit tap). |
| `scoredUp` | int | `scoreHabit` (+) | habit + tap | Count of positive taps that day (accumulates on merge). |
| `scoredDown` | int | `scoreHabit` (−) | habit − tap | Count of negative taps that day (accumulates on merge). |
| `reps` | int | `scoreHabit` (+), `completeTask` (merge) | habit + tap | **NEW.** Exact reps for that tap (`repsPerTap` or title number), frozen at event time so later renames/overrides don't rewrite history. Accumulates on merge. |
| `repCounted` | bool | `scoreHabit` (+) | habit + tap | **NEW.** True when the point carries an exact rep count (vs. inferred). |
| `scored` | bool | `scoreHabit` (+) | habit + tap | **NEW.** True when the day had real recorded activity. |
| `reward` | `{xp,gold,mp,delta}` | `completeTask` (daily & todo) | on completion | **NEW.** Exact XP/gold/MP/value-delta granted by that completion (snapshot of `t._gr`). Lets a dashboard chart earnings per day. Overwritten on same-day re-complete. |
| `checklist` | `[{text,done}]` | `completeTask` (daily) | on daily completion | **NEW.** Snapshot of which subtasks were checked at completion. Only present when the daily has subtasks. |

Old/imported points without the new fields are handled by `anAllEvents()` defaults:
`reps` falls back to `repsPerTap × scoredUp`; `repCounted`/`scored` are inferred from
`scoredUp`/`completed`; `reward`/`checklist` default to `null`.

## Functions that write or read history

| Function | Role | Notes |
|---|---|---|
| `logHistory(t, patch)` | **Sole writer.** Merge-or-push one point per day. | All accumulation/latching rules live here. |
| `completeTask(t)` | Marks a daily/todo done; logs `completed`, `value`, `reward`, and (daily) `checklist`/`isDue`. | Computes reward via `completionReward`, stores it transiently on `t._gr`, then snapshots it into history. |
| `scoreHabit(id, dir)` | Habit ± tap; logs `value`, `scoredUp`/`scoredDown`, and (on +) `reps`/`repCounted`/`scored`. | `reps` frozen at tap time. |
| `runCron()` | Daily reset. On a missed due daily logs `{value, completed:false, isDue:true}`. Resets `t.done` and clears `checklist[].done`. | Runs once per calendar day on first load. |
| `uncompleteDaily` / `uncompleteTodo` → `unlogToday(t)` | Undo a same-day completion: clears `completed`, or drops the point if it carried no other signal. | Only affects *today's* point. |
| `reverseGrant(t)` | Reverses the reward applied by `completeTask` (uses `t._gr`). | Touches `S.char`, not history. |
| `anAllEvents()` | **Sole reader.** Flattens all `history` into uniform events with back-filled defaults. | Every analytics function consumes this. |
| `anAllEvents` consumers | `anCumulativeReps`, `anRepsSeries`, `anValueSeries`, `anActivitySeries`, `anRollup`, `anAdherenceSeries`, `anIntensity`, `anStreaks` | Reps totals, value trend, activity days, monthly/yearly rollups, daily adherence %, intensity heatmap, streaks. |

## Live (non-historical) state — current value only, no time series

These exist on the task or character but are **not** logged per day, so they cannot be
charted historically from saved data.

| State | Where | Logged over time? | Note |
|---|---|---|---|
| `S.char.hp / xp / mp / gold / lvl` | character | **No** | Current values only. No progression/death/damage time series. |
| `t.streak` | per daily | **No** (only current) | A broken streak leaves no record of its prior length. |
| `t.cUp` / `t.cDown` | per habit | **No** | Period counters, reset by `runCron`. Tap *events* are in history; these aggregates are not. |
| `t.repeat[]` (schedule) | per daily | **No** | If you edit the schedule, past `isDue` points can't be re-explained. |
| `t._gr` | per task | Now snapshotted into `reward` on completion | Transient otherwise; cleared on uncomplete. |

## Known gaps / decisions deferred

These are intentional non-changes, surfaced so a future dashboard isn't built on
assumptions that don't hold:

- **Intraday granularity is gone.** The one-point-per-day merge means time-of-day
  patterns (e.g. morning vs. night completion, tap spacing) cannot be recovered.
  Changing this requires an append-only event log, which conflicts with the project's
  "keep localStorage small" constraint — a real tradeoff to decide before building.
- **Partial dailies aren't logged.** Subtask progress is only captured *at completion*
  (or as a `completed:false` point on a cron miss). A daily left partially done but
  not completed records nothing.
- **Todo aging is not reconstructable.** Todos log only completion; no created-vs-
  completed timestamps, so time-to-complete analytics are impossible.
- **Historical character/HP/XP/gold and streak history are not retained.** Only the
  current values exist. If progression charts are wanted, that logging must be added.
- **Past completions before this change have no `reward`/`checklist`/exact-`reps`
  data** — those fields begin accumulating from v2026.06.24-2054 onward and cannot be
  backfilled.

## Append-only event log — IndexedDB-backed (SPLIT architecture)

The per-day `history` model above is intentionally lossy (one merged point/day). To
close the intraday / per-subtask gaps, there is a **second, append-only store** of
events that are **never merged** — every meaningful action is its own timestamped
record. This is the layer the detailed analytics dashboard reads for time-of-day and
per-subtask behavior.

**As of v2026.06.25 this event log lives in IndexedDB, not localStorage.** This is a
deliberate *split*, not a full migration:

- **Everything else stays in localStorage** via `save()`/`load()` (`STORE_KEY =
  "questa.save.v1"`): tasks, character, prefs, per-day `history` arrays, and
  `charHistory`. None of that path changed.
- **Only the append-only event log moved to IndexedDB.** It started **empty** on the
  switch (there were no real users, so no localStorage→IDB migration was written —
  a clean start was chosen over preserving any events then in localStorage).
- `history` and all existing `anAllEvents()` analytics are untouched, so nothing that
  worked before can regress. The event-driven dashboard view is **added on top**.

### IDB schema

- **Database:** `questa` (version 1).
- **Object store:** `events`, `keyPath: "id"`, `autoIncrement: true`.
- **Indexes:** `ts` (time), `kind` (event type), `taskId` (per-task). The `ts` index
  backs windowed queries so a date-range read never loads the whole store; `kind` and
  `taskId` narrow without a full scan.

### Writer — `logEvent(ev)` (fire-and-forget)

`logEvent` appends `{ts: Date.now(), ...ev}` to IDB. It is **fire-and-forget**: it
returns synchronously and handles the async write + all failure internally, so callers
(`toggleSub`, `scoreHabit`, `completeTask`, `runCron`, `creditYesterday`) stay
synchronous and never `await`. If IDB is unavailable (e.g. private browsing) the write
is silently skipped — scoring never breaks. The DB is opened lazily and the open
promise is cached (`_idbPromise`).

### Read API — `getEvents({from, to, kind, taskId})` → Promise

Resolves to the events in `[from, to]` (ms, inclusive), optionally filtered by `kind`
and/or `taskId`, using the `ts` index range. Returns `[]` on any failure (never
throws). `countEvents()` returns the stored count. Because reads are async and the
app's `load()`/`render()` path is synchronous, the app still boots and paints from
localStorage immediately; the event-driven dashboard section renders a **loading
state first, then fills in** once the read resolves — it never blocks first paint.

### Prune policy

The old count-based `EVENT_CAP = 50000` (localStorage splice) is **gone**. Replaced by,
run once per session on DB open (`schedulePrune`/`pruneEvents`):

1. **Age-based prune** — a `ts`-index cursor deletes everything older than
   `EVENT_AGE_LIMIT_MS` (~18 months).
2. **Hard-count backstop** — if still over `EVENT_HARD_CAP` (200,000), delete oldest
   by `ts` until under.

Rationale: IndexedDB origin storage is typically hundreds of MB to GB, so the old
~5 MB localStorage quota no longer applies to events. We can keep a long, high-fidelity
window and prune only to stay tidy, rather than trimming aggressively for space.

### Dashboard views that read from IDB

`refreshAnalytics()` renders all existing history-based charts synchronously
(unchanged), then appends an **"Event log detail (live)"** section that calls
`renderEventDetail(from, to)`. That function reads `getEvents({from, to})` once, builds a **dropdown of every task
that has events in the window** (default "Kliky - aspoň 50"), and for the selected task
shows, per day in the window (paginated, 14 days/page): whether it completed or was
missed, habit tap-days, and — where `subtask` events exist — **which subtasks were
checked and at what time of day**. It degrades gracefully to a "no events yet" note on a fresh
install and to an "IDB unavailable" note in private browsing.

### Event backfill (synthesized from Habitica) — for usable dashboards on import

Habitica never recorded per-tap / per-subtask events with times, so a pure import
would leave the live event view empty. To make the dashboards usable immediately, the
importer (`habitica_to_questa.py`) emits a **separate** file,
`questa-events-backfill.json`: a flat array of events synthesized from the same real,
dated history the charts use.

Truthfulness contract:

- The **day** of every backfilled event is real (from a real Habitica history point).
  Completion / miss / which-subtasks come from the enriched history.
- The **time-of-day is invented** (Habitica has only dates). Subtasks get plausible
  fixed times by name (`doobeda` → 09:00, `poobede` → 15:00, etc.); dailies complete
  ~20:30; misses ~23:59; habit taps ~18:00.
- Every synthesized event carries `synthetic: true` and `source: "habitica-backfill"`,
  and propagates `inferred: true` when the underlying completion was reconstructed
  (value-rise) rather than confirmed. The dashboard surfaces this as a `~ backfill`
  (and `· inferred`) marker per day and a count in the section header — nothing
  pretends to be a real live tap.

Loading (current): the importer **embeds these events directly in the single import
file** under an `events` key (Questa export shape), so the normal **Settings → Import**
restores them into IndexedDB along with tasks/char/history — no separate step. On import,
`importData` captures the `events` array before `migrate()` strips it from localStorage,
then merges the events additively into the IDB event log — union-insert deduplicated on
`uid` and a content signature `(ts, kind, taskId, dir, reps)` via `reparentEventsForImport`
+ `eventMergeFilter` — so a re-import never duplicates and existing local-only events are
preserved. (Prior to 2026-07-29 this step instead replaced the log wholesale via
`clearAllEvents` → `bulkAddEvents`, which also produced a duplicate-free re-import but did
so by wiping any local events absent from the import file first — see the 2026-07-29
superseded note under "Export now includes events" below for the production incident that
prompted the change.) (The older standalone `importEventsBackfill` loader is retained in
code but no longer has a Settings button.)

For the sample export this produces ~4,272 events (complete/habitTap/miss/subtask),
including 142 Kliky subtask checks with morning/afternoon times.

| `kind` | Written by | Fields (beyond `ts`) | Captures |
|---|---|---|---|
| `subtask` | `toggleSub` | `taskId, taskTitle, taskType, subId, subText, done` | **Exact subtask, by name, checked/unchecked, at a precise time.** This is the core ask: not "2 of 4" but *which* subtask and *when*. |
| `habitTap` | `scoreHabit` | `dir(+1/−1), taskId, taskTitle, reps(+only), value` | Every individual habit tap with timestamp → intraday rhythm, not a daily bucket. |
| `complete` (daily) | `completeTask` | `taskType:'daily', taskId, taskTitle, streak, reward, repeat[], checklist[{id,text,done}]` | Completion moment + full subtask end-state + schedule snapshot. |
| `complete` (todo) | `completeTask` | `taskType:'todo', taskId, taskTitle, reward, createdAt, completedAt` | Completion moment + timestamps for aging analytics. |
| `miss` | `runCron` | `taskType:'daily', taskId, taskTitle, repeat[], checklist[{id,text,done}]` | A missed daily at reset, **including which subtasks had been partially done** before reset cleared them. Closes the partial-daily gap. |

### Character progression (`S.charHistory[]`) — NEW

Writer: `logCharSnapshot()`, called once per day inside `runCron`. Appends
`{date, hp, maxHp, xp, mp, gold, lvl}`. ~1 point/day → progression charts (level-ups,
gold curve, HP/damage trend) become possible. Bounded growth.

### Todo timestamps — NEW

`saveTask` stamps `createdAt` on new task creation; `completeTask` stamps
`completedAt` on todos. Enables time-to-complete / aging. Pre-existing todos have
`createdAt = null` (not backfillable).

### Schedule snapshot — NEW

Daily `complete` and `miss` history points (and events) now carry `repeat[]` (the
7-day schedule at that moment), so past `isDue` data stays explainable after you edit
a daily's schedule.

---

## RISK ANALYSIS — storage & the localStorage/IDB split

**Update (v2026.06.25):** the event log moved to IndexedDB, which **removes the
localStorage quota risk for events** — the single biggest risk in the original
analysis below. The `S` blob written to localStorage on every `save()` no longer
contains `events[]`, so per-tap activity no longer inflates the ~5 MB-capped blob or
the whole-blob rewrite cost. **But IndexedDB introduces its own, different failure
modes** (see "New risks introduced by IDB" below). The original localStorage analysis
is kept for the parts of `S` that still live there (tasks, history, charHistory, prefs)
and for historical honesty.

### New risks introduced by IndexedDB (current)

1. **Async writes can fail silently (medium).** `logEvent` is fire-and-forget and
   swallows errors by design (so scoring never breaks). The cost: if an IDB write
   fails — transaction abort, disk pressure, quota — that event is simply lost with
   **no user-visible signal**. History-based charts are unaffected (they read
   `history`, which is still written synchronously to localStorage), but the
   event-detail view will be missing that record. This is an accepted trade: the
   fidelity layer is best-effort.
2. **Private browsing / disabled IDB (medium).** In some browsers `indexedDB.open`
   fails or storage is ephemeral in private mode. `logEvent` then skips logging and
   `getEvents` resolves `[]`; the dashboard shows an "event log unavailable" note. No
   crash, but no event analytics in that context.
3. **Eviction under storage pressure (low–medium).** Origin storage (without a
   persistence grant) can be evicted by the browser under pressure, independent of our
   prune. Events are device-local fidelity data, not core progress, so this is
   tolerable — but it means the event log is **not a guaranteed-durable** record.
4. **Two stores can drift (low).** localStorage (`S`) and IDB (events) are written in
   separate operations. A crash between a synchronous `save()` and the async event add
   can leave a completion recorded in `history` but not in events (or vice-versa). The
   dashboard treats events as additive detail, not the source of truth for totals, so
   drift degrades detail rather than corrupting counts.
5. **Export now includes events (RESOLVED v2026.06.25-1556).** `exportData()` is now
   async: it reads the full IDB event log via `getEvents({})` and embeds it under an
   `events` key in the backup file, so **one file is a complete backup**. `importData`
   captures `data.events` *before* `migrate()` (which still strips `events` from `S`,
   keeping localStorage lean), then does a full restore of the event log
   (`clearAllEvents` → `bulkAddEvents`) — idempotent, so re-importing never duplicates.
   If IDB is unavailable, export falls back to an S-only file rather than failing.

   > **Superseded, 2026-07-29.** `importData` no longer does a full restore of the event
   > log. `clearAllEvents` → `bulkAddEvents` wiped every local event absent from the
   > imported file — destroying independent per-device event history — and this fired
   > repeatedly in production, wiping two devices' event logs. `importData` (and
   > `confirmRestore`) now merge events additively instead: union-insert deduplicated on
   > `uid` **and** a content signature `(ts, kind, taskId, dir, reps)` — see
   > `eventMergeSig`/`eventMergeFilter` in `app.js`. Re-importing the same file twice still
   > adds nothing the second time, but now because of dedup, not because the log was
   > cleared first. `reparentEventsForImport()` also now preserves `origDev` (the record's
   > pre-reparent originating device) for provenance.

### Storage budget (localStorage — for the parts that still live there)

Browsers cap `localStorage` at roughly **5 MB per origin** (string length, UTF-16 —
so effectively ~2.5M chars; treat 5 MB as the hard ceiling). The entire `S` object is
serialized to one key on **every** `save()`.

| Store | Per record | Realistic volume | Annual size |
|---|---|---|---|
| `events` — subtask | ~90 B | depends on subtask toggling | — |
| `events` — habitTap | ~70 B | heavy day = 50 taps | ~3.5 KB/day → ~1.3 MB/yr |
| `events` — complete/miss | ~150–400 B (grows with subtask count) | ~1–30/day | ~50–500 KB/yr |
| `charHistory` | ~70 B | 1/day | ~26 KB/yr |
| **All events combined (heavy use)** | — | — | **~1.5–2 MB/yr** |

*(Historical — events no longer live in localStorage.)* The old `EVENT_CAP = 50000`
localStorage splice was too high to be a real safety net (50000 events ≈ the whole
quota). It has been **removed**; events now live in IDB with an age-based prune +
high-count backstop (see the IndexedDB section above).

### Risks (ranked)

1. **Quota exhaustion from events → RESOLVED for events by the IDB split.**
   Previously `save()` (a bare `localStorage.setItem`, no try/catch) would throw on
   quota exceed, and events were the fastest-growing contributor to the ~5 MB blob.
   With events moved to IndexedDB, **events no longer push localStorage toward quota.**
   The residual localStorage risk is now only the slow-growing parts (`history`,
   `charHistory`) — far below quota for realistic use. `save()` is still an untry-caught
   `setItem`; wrapping it remains a reasonable hardening follow-up, but it is no longer
   the highest risk. The new highest risks are IDB-specific (see "New risks introduced
   by IDB").

2. **Whole-blob rewrite cost (medium).**
   Every `save()` re-serializes and rewrites *all* of `S`, including the full event
   log. As `events` grows to MB scale, each tap triggers a multi-MB
   `JSON.stringify` + write. On low-end mobile this adds latency to every
   interaction. *Mitigation:* the event log would ideally live in IndexedDB (append
   without full rewrite); not done — would be a larger architectural change.

3. **No pruning by age (medium).**
   The cap is count-based, not time-based. There's no "keep last 12 months" policy, so
   old events you no longer analyze still consume quota and rewrite cost.

4. **Subtask toggle noise (low–medium).**
   Every check *and* uncheck logs an event. Indecisive toggling inflates the log with
   low-value records. Acceptable for fidelity, but it's the least information-dense
   source.

5. **Export/backup fragility (low).**
   A larger `S` makes any "export your data" or manual copy heavier, and a corrupted
   single key now loses more. No incremental backup exists.

### Limits of the current analytics

- ~~The new `events[]` is written but not yet read.~~ **Done (v2026.06.25):** the
  event log is now read via `getEvents()` and powers the "Event log detail (live)"
  dashboard section (per-subtask check times + per-day completion for the Kliky daily).
  `anAllEvents()` still reads only `history` for all the pre-existing charts, which are
  unchanged.
- Events and history are two sources of truth. A dashboard joining them must dedupe
  (a daily completion appears in both the day's `history` point and as a `complete`
  event).
- Pre-change data has none of these fields; all new analytics start accumulating from
  the versions below.

### Recommended follow-ups

- ~~Lower `EVENT_CAP` and add quota-safe `save()`.~~ The event-quota driver is gone
  (events are in IDB). Wrapping `save()` in try/catch for the remaining localStorage
  parts is still nice-to-have hardening, but no longer urgent.
- ~~Add an age-based prune.~~ **Done:** ~18-month age prune + 200k backstop on the IDB
  store.
- ~~Consider moving `events[]` to IndexedDB.~~ **Done (v2026.06.25).**
- Still open: a Settings control showing current IDB usage / a "persist storage"
  request (`navigator.storage.persist()`) to reduce eviction risk; an export option
  that includes the IDB event log if cross-device event continuity is ever wanted.

## Recent changes (this session)

| Version | Change |
|---|---|
| v2026.06.24-2050 | Daily completion now snapshots `checklist` (which subtasks were done) into history. |
| v2026.06.24-2054 | Completion now logs `reward` (xp/gold/mp/delta) for dailies & todos; habit + taps now freeze exact `reps`/`repCounted`/`scored` so renames/overrides don't rewrite the past. `anAllEvents` exposes `reward` and `checklist` on events. |
| v2026.06.24-2110 | Added append-only `S.events[]` (subtask/habitTap/complete/miss events with timestamps + subtask names), `S.charHistory[]` daily snapshot, todo `createdAt`/`completedAt`, and `repeat[]` schedule snapshots. localStorage-small constraint overridden by request; see Risk Analysis. |
| v2026.06.25-1652 | **Importer emits ONE export-shaped file; "Load event backfill" button removed.** `habitica_to_questa.py` now embeds the synthesized events inline under an `events` key (+ `_backup` marker), matching Questa's Export shape, so the normal Settings → Import restores tasks/char/history AND the IDB event log in one step. Separate `questa-events-backfill.json` no longer produced. The Settings "Load event backfill" button + `eventsFile` input removed (the `importEventsBackfill` function retained, unwired). sw CACHE → questa-v37. |
| v2026.06.25-1607 | **Event log detail: task picker + pagination.** The view is no longer hardcoded to Kliky — a dropdown lists every task with events in the current window (default Kliky), respects the date-window slider, and pages the per-day breakdown (14 days/page, Newer/Older). Selection + page persist across the async re-render. Habit tap-days now shown too. sw CACHE → questa-v35. |
| v2026.06.25-1556 | **Export is now a complete single-file backup.** `exportData()` made async; embeds the full IDB event log under an `events` key (+ `_backup` metadata). `importData` restores embedded events into IDB (capture-before-migrate so localStorage stays event-free; full clear-then-add restore, idempotent). New `clearAllEvents()` helper. sw CACHE → questa-v34. |
| v2026.06.25-1400 | **Event backfill.** Importer now emits a separate `questa-events-backfill.json` (events synthesized from real history with plausible fixed times-of-day, all flagged `synthetic:true`); app gains Settings → "Load event backfill" (idempotent: clears prior synthetic, keeps live taps) so the event-driven dashboard has data right after import. Event-detail view marks backfilled/inferred days. sw CACHE → questa-v33. |
| v2026.06.25-1337 | **Event log moved to IndexedDB (SPLIT).** New inline IDB wrapper (db `questa`, store `events`, indexes ts/kind/taskId); `logEvent` rewritten fire-and-forget; new async `getEvents()` read API; count-based `EVENT_CAP` replaced by ~18-month age prune + 200k backstop. Dashboard gains an event-driven "Event log detail (live)" section (per-subtask check times for the Kliky daily); all history charts unchanged. Importer no longer emits an `events` key; `migrate()` strips any stray events from import blobs. `charHistory`, tasks, history, char, prefs all still in localStorage. sw CACHE → questa-v32. No localStorage→IDB migration (clean start, no real users). |
