# join_exports.py — merge multiple Questa exports into one

A dependency-free (Python stdlib only) tool that takes any number of Questa
export/backup JSON files and produces a single export containing the
**most-current, fully-joined** state.

## Why this works without manual analysis

Every Questa collection carries its own merge key + timestamp, so the join is
deterministic — no guessing required:

| Collection | Merge key | Timestamp | Rule |
|---|---|---|---|
| `tasks` | `id` | `updatedAt` | newest `updatedAt` wins (whole row) |
| `tags` | `id` | `updatedAt` | newest wins |
| `rewards` | `id` | `updatedAt` | newest wins |
| `devices` | `id` | `updatedAt` | newest wins |
| `char` | (singleton) | `updatedAt` | newest wins |
| `charHistory` | `date` | `date` | union, de-dup by `date` |
| `deletions` (tombstones) | `id` | `at` | union, newest `at` wins |
| `events` | `id` | `ts` | **union by id** (disjoint epochs) |
| `prefs` | pref key | `__savedAt` | union, newest export wins per key |
| `prefs.an.views` | `id` | `updatedAt` | newest wins per view, union of distinct ids |
| `prefs.an.metrics` | `id` | `updatedAt` | newest wins per metric, union of distinct ids |
| `prefs.an.*` (other) | sub-key | `__savedAt` | newest export wins per sub-key |
| `habiticaHistory` | — | — | kept if present in any input |
| `monthlyBackups` | — | — | union of strings |
| `__seq` / `__savedAt` / `__hlcLast` / `version` | — | — | max |

### Task fields this script reads directly (2026-09-18)

Most task fields ride along inside the winning row and need no rule of their own.
Two are read by name and must stay in step with `app.js`:

- **`doneDay`** — the local day stamp frozen by `completeTask`/`creditYesterday`,
  the completion-side twin of `missedOn`. `normalize_daily_resets` prefers it over
  `day_stamp_of(doneAt)`, because re-deriving the day from `doneAt` computes it in
  whatever timezone this script happens to run in, which is a different frame from
  `lastCron`. Rows from older builds carry no `doneDay` and fall back.
- **`cResetOn`** — the local day stamp `runCron` writes when it zeroes a habit's
  `cUp`/`cDown`. This script has no counter-accumulation rule (it picks a whole
  winning row), so there is nothing to compute here — but the field must survive
  the join untouched, or `sync.js`'s `_accumCounters` loses its anchor on the next
  device sync and silently falls back to the old below-base heuristic.
- **`cAbs`** — `{deviceId: {ua, cUp, cDown}}`, the per-device absorbed watermark
  that stops a conflict retry re-adding a peer's taps. The counter twin of
  `char.abs`. Same deal as `cResetOn`: nothing to compute, but it must ride along
  intact. A row that loses its `cAbs` reverts to double-counting on the next 409.
- **`quickLog`** (2026-09-22) — boolean UI curation flag on habit rows; rides along with the newest row like every unlisted field; no join_exports.py rule needed (tasks merge by id/updatedAt, equal-ts field-merge is generic).

## Usage

```bash
python tools/join_exports.py OUT.json A.json B.json [C.json ...]
```

- At least **two** path args are required: the output path, then 1+ input exports.
- Every input must be a valid Questa export (has a top-level `version`); otherwise
  the tool aborts with `NOT A QUESTA EXPORT`.
- A single input is allowed (clean passthrough / re-serialization).
- Output is written with `ensure_ascii=False` and 1-space indent.

## Reading the result

The merged file is a normal Questa export — import it via the app
(**Settings → Import**) like any other. It also carries audit trail fields:

- `_joinedFrom` — list of input filenames.
- `_joinedAt` — UTC epoch ms when the join ran.
- `_joinConflicts` — list of every case where two inputs disagreed. Each entry:
  `{collection, id, exports:[{file,updatedAt,value}], resolution}`.

Conflicts are **reported, never silently dropped**. Two kinds occur:

1. **`equal ts, field-merged`** — two rows share the newest `updatedAt` but differ.
   Fields are merged, preferring any non-default (non-zero/non-empty) value over a
   zeroed/default twin, so a live counter (e.g. `cUp`) is not clobbered.
2. **`equal ts, kept first-seen`** (older code path) — both rows equally informative;
   the first-processed wins. Listed for transparency.

Real divergence across *different* timestamps is not a conflict: newest-wins is the
defined, expected behavior.

## Verification before trusting an output

Run it on the known three exports and assert:

```
events == 4566
tasks  == 127
conflicts == 40   (all equal-ts field-merges / newest-export-wins, no data loss)
char.xp == 3533, char.hp == 50
"habiticaHistory" present
"exportIntervalDays" in prefs, "gfs" in prefs
  (`exportIntervalDays` is the LEGACY auto-backup interval, retained for
   migration; the current key is `prefs.autoBackupEnabled` — see below)
"autoBackupEnabled" in prefs when any input carries it (4-tier object:
  {fourHour,daily,weekly,monthly}; per-device, excluded from sync, so inputs
  from different devices may legitimately disagree and newest-export-wins)
prefs.an.views == 22   (per-id union; no silent drop of non-newest export's views)
prefs.an.metrics == 12
all event ids unique
```

## Keeping it in sync

The merge rules mirror the app state schema. If the schema changes, update
`tools/join_exports.py` accordingly — see the **"Export join tool — keep in sync"**
section in `AGENTS.md`. A stale join script can mis-merge, so it is treated as a
red deploy gate.

## Known limitations

- `task.history` (per-day snapshots) and other array fields follow newest-wins;
  the authoritative time-series history is the `events` log, which is unioned
  perfectly. If you need history-by-date merging too, extend the equal-ts branch.
- Deletions (tombstones) win over live tasks: a task id present in `deletions` is
  excluded from the output even if another export carries it as live. Confirm
  intended deletions before importing.
- `prefs.an.views` and `prefs.an.metrics` are keyed-merged per `id` (newest
  `updatedAt` wins, union of distinct ids) so a non-newest export's views/metrics
  are not dropped wholesale. View **array order** follows the newest-`__savedAt`
  export, with ids unique to other exports appended. `activeView` follows the
  newest export; if it no longer matches a surviving view the app falls back to
  the first view on import.
