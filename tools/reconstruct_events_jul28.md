# reconstruct_events_jul28.py — rebuild the 2026-07-28 event-log gap

A dependency-free (Python stdlib only) tool that reconstructs the 14 daily
completions and 6 habit taps missing from the 2026-07-28 IndexedDB event log,
by reading them back out of the surviving *state* snapshot.

## Why this exists

On 2026-07-28 the device's event log lost 14 daily completions and 6 habit
taps. The originals were searched across four Dropbox month files (5,162
events), the phone's live IDB dump (7,251 events), the backup (7,268 events),
and Dropbox version history. **They do not exist anywhere — recovery is
impossible.** Reconstruction from the state snapshot is the committed
approach, not a fallback: state sync worked that day even though event sync
did not, so `doneAt` on dailies and `history[]` on habits are complete and
internally consistent. That makes this a reconstruction, not a guess.

## Two tokenization schemes — do not conflate them

- **Events** (top-level `E`) use dictionaries `K`/`SRC`/`TID`/`TT` plus
  abbreviated field keys (`t`→ts, `k`→kind, `ti`→taskId index, `n`→taskTitle
  index, `rs`→reps, `v`→value, `dr`→dir, `o`→source, `rc`→repCounted, ...).
  This tool never touches `E` — the lost events were never written there.
- **The state snapshot** (top-level `S`) uses a single per-export field map
  at top-level `FM` (long-name → short-code, e.g. `doneAt`→`bl`, `title`→`v`,
  `type`→`x`, `history`→`bd`), applied recursively. This is what
  `_detokenizeSnapshot()` (app.js:5293) reverses, and what
  `detokenize_snapshot()` in this script reverses too, the same way.

Reference implementations in `app.js` (read, not modified): `_EXPORT_FIELD_MAP`
(5201), `_detokenizeEvents()` (5237), `_buildFieldMap()` (5265),
`_detokenizeSnapshot()` (5293), import wiring (5432-5439), `eventUidOf()`
(771-800).

## What gets emitted

1. **14 `complete` events.** One per daily task whose `doneAt` lands on
   2026-07-28 (UTC). Of the 17 dailies, 16 carry a real `doneAt` (only
   "Režim cvičenia" has none); exactly 14 of those 16 land on 2026-07-28 — the
   other two are 2026-07-24 and 2026-07-16 and are correctly excluded. This is
   unambiguous under both UTC and UTC+2: the timestamps cluster near 12:40 and
   20:17-20:19, no midnight-boundary cases.

   **`history[]` is deliberately NOT used for dailies** — on a daily that
   array is a cron/due-state rollover log, not a completion log. Only
   `doneAt` records an actual completion, and it is used verbatim as `ts`.

2. **6 `habitTap` events.** The snapshot has 11 habit `history[]` entries
   dated 2026-07-28, but only 6 carry `scored:true`; the filter is
   mandatory, not an optimization. The other 5 are `scored:false` with no
   `scoredUp`/`scoredDown` — passive day-rollover records, not taps.
   `dir` is derived per entry (`1` if `scoredUp` present, `-1` if
   `scoredDown` present); `reps`/`value` are copied from the history entry.

3. **`synthetic: true`, `uid` left unset** on every emitted event. The
   in-app loader's `reparentEventsForImport()` (app.js:808-823) assigns a
   deterministic `rep-`+FNV-1a uid via `eventUidOf()` (app.js:771-800) on
   import — idempotent across re-imports, and structurally disjoint from
   real device taps (`syncEventUid()` = `<deviceId>-<base36 ts>-<base36
   random>`, sync.js:66-68). Because that hash is only 32 bits, this script
   replicates it locally (`event_uid_of()`) over the same 15-field list
   (`ts, kind, taskId, taskTitle, dir, dev, uid, value, reps, source, subId,
   subText, notes, id, idx`) and **asserts the 20 outputs hash unique before
   writing anything** — it aborts rather than emit a would-be collision.

Every id/title is looked up in the detokenized snapshot; nothing is
hardcoded. The only hardcoded values are two verified anchor assertions
(never used to derive output, only to sanity-check the detokenization):

```
28c5f43b-bfa8-481f-8b6e-06d6bef397fc == "20 klikov" (type:"habit")
c9cfe1b2-d3be-432d-a6cd-c1b1143712f1 == "15 klikov" (type:"habit")
```

## Usage

```bash
python tools/reconstruct_events_jul28.py \
    --input questa-backup-20260729-1023.json \
    --output tools/out/reconstructed_events_jul28.json
```

Both flags default sensibly (`--input questa-backup-20260729-1023.json`,
`--output tools/out/reconstructed_events_jul28.json`) so the tool is not
hardwired to one specific backup file. `tools/out/` is not committed —
it holds generated data only.

## Output

`{"events": [...]}` — a flat array of 20 event objects (14 `complete` + 6
`habitTap`), sorted by `ts` ascending. A human-readable summary is printed to
stdout: one line per event (`kind`, ISO UTC timestamp, task title), then the
totals.

## Verification before trusting an output

Run it against the known backup and confirm:

```
complete events   == 14
habitTap events    == 6
total              == 20
every taskId       resolves to a real task in the snapshot
no duplicate synthetic uids (event_uid_of pre-write assertion)
anchor ids resolve to "20 klikov" / "15 klikov" (type:"habit")
```

The script itself enforces every one of these with a hard `SystemExit` — a
clean run is itself the verification.

## Importing the result

`tools/out/reconstructed_events_jul28.json`'s `events` array is in the same
shape `reparentEventsForImport()` (app.js:808) expects: it strips any `id`,
reparents `dev`/`uid` to the importing device, assigns the deterministic
`rep-` uid, and drops the `synthetic` flag — exactly like importing any other
schema-1 event list. It is not a full Questa export on its own (no `char`,
`tasks`, etc.) and is meant to be merged into one (e.g. via
`tools/join_exports.py`, or spliced into a real export's `events` array)
before import, not imported standalone.

## Known limitations

- UTC-date bucketing (`utc_date_of`) is safe here only because this
  particular day's timestamps are nowhere near a midnight boundary in either
  UTC or UTC+2 (verified above). It is not a general-purpose local-day
  helper — contrast `day_stamp_of` in `join_exports.py`, which mirrors the
  app's device-local `dayStamp()` for exactly that reason.
- This tool is scoped to the single known 2026-07-28 gap (dailies +
  scored-habit-taps). It does not generalize to reconstructing todos,
  checklist items, or other event kinds — those were not part of this loss
  and are out of scope.
