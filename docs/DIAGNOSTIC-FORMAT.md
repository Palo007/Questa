# Questa full diagnostic — file format & triage guide

This describes the JSON produced by the **Download All** button in the on-device
diagnostic overlay (Settings → tap the version number 5× within 3s → **Download All**).
Filename: `questa-fulldiag-<ISO-timestamp>.json`.

The file is intentionally **monolithic**: one atomic snapshot, captured at a single
instant, that you transfer once off a phone that has no dev tools. It is designed to
be **sliced by code (jq/python), not read whole into an LLM context** — it can be
several MB (the event log and backup snapshots dominate).

## How to process it (for an AI agent)

1. Read the top-level `manifest` first. It gives schema version, per-section byte
   sizes, and record counts — enough to triage without opening the big sections.
2. Slice only the section you need. Examples:
   - `jq '.manifest' file.json`
   - `jq '.meta' file.json`
   - `jq '.localStorage["questa.save.v1"] | fromjson | .tasks | length' file.json`
   - `jq '.indexedDB.questa | keys' file.json` (list stores)
   - `jq '.indexedDB.questa.events | length' file.json`
   - `jq '.errors' file.json`
3. Do **not** `Read` the raw file into context if it is large; use a subagent + jq/python
   and return only the answer.

## Top-level structure

| Key | What it is |
|-----|-----------|
| `manifest` | Schema version, per-section `sizesBytes`, `counts` (tasksByType, deletionsTombstones, localStorageKeys, errors, indexedDB per-store record counts), and `keyDescriptions`. Triage from here. |
| `meta` | Runtime/environment: `appVersion`, `userAgent`, `platform`, `viewport` (w/h/dpr/screen), `displayMode` (`standalone` = installed PWA vs `browser`), `onLine`, `language(s)`, `visibilityState`, `notificationPermission`, `vibrate`. |
| `localStorage` | Every localStorage key → value (strings). Key entries below. |
| `indexedDB` | Every IndexedDB database → store → **all records** (`getAll`). Stores below. |
| `caches` | Cache Storage: cache name → list of cached request URLs. |
| `serviceWorker` | `controller` script URL + `registrations` (`active`/`waiting`/`installing` script URLs, `scope`). |
| `storageEstimate` | `{quota, usage}` in bytes (browser estimate). |
| `errors` | Ring buffer (≤50) of uncaught errors + unhandled promise rejections, newest last: `{t, kind, message/reason, src, line, col, stack}`. |
| `liveS` | The in-memory app state `S` at capture time (may differ from the persisted copy). |

Any section whose API is unavailable on the device serializes as the string `"n/a"`
(e.g. `caches` in a context without Cache Storage). A store that failed to read
serializes as `{ "__error": "..." }`.

## localStorage keys

| Key | Meaning |
|-----|---------|
| `questa.save.v1` | The **full persisted state `S`** (JSON string). Contains `tasks` (each with `type`, `title`, `streak`, `repeat`, `done`, `doneAt`, `updatedAt`, `createdAt`, `checklist`, `tags`), `char`, `rewards`, `tags`, `prefs`, `lastCron`, and `deletions` (tombstones). Parse with `fromjson`. |
| `questa.sync.v1` | Sync config: `enabled`, `refreshToken` (presence only), `lastRev`, `lastSyncAt`, `lastError`, `evtLastUploadTs`, `deviceId`, `deviceName`, `evtFileRevs` (per-file Dropbox rev cache for the event pull — `filename -> rev`, written only after that file's payload is successfully parsed and its events inserted), `evtLastPullAt` (timestamp gating the 60-second event-pull throttle), `evtFullScanAt` (**new 2026-07-29** — watermark for a 24-hour full re-scan that ignores `evtFileRevs`/`evtBadRevs`, so a stale cached rev can no longer pin a file out of the pull permanently), `evtBadRevs` (**new 2026-07-29** — quarantine map `filename -> {rev, at}` for corrupt/failed payloads, retried on a ~15-minute backoff, capped at 200 entries with oldest evicted first). |
| `questa.baseReset.v1` | One-time sync-base-purge marker (`"done"` once run). |

## IndexedDB stores (database `questa`)

| Store | Contents |
|-------|----------|
| `backups` | Tier-1 snapshots: `{id, ts, type:"full"|"delta", verified, hash, payload}` where `payload` is a JSON string of `{stateSnapshot, events}`. Large. |
| `syncmeta` | Sync bookkeeping. Key `"base"` = the last synced baseline subset (JSON string). A `base` that is missing tasks it should have = the poisoning that drove the 2026-07-12 daily loss. |
| events store | Append-only event log: every completion, miss, habit tap, subtask toggle, import/restore, as timestamped records. This is the streak/completion history (analytics source). Never merged/deleted by sync. |
| durable store | Persistence mirror of `S` (Phase-B durable-state fix) with `__seq`/`__savedAt` for reconciliation against the localStorage boot copy. |

## "What to look for" playbook

- **Missing tasks / lost streaks.** Compare `liveS.tasks` (or `localStorage["questa.save.v1"].tasks`)
  against `indexedDB.questa.syncmeta.base` tasks and the latest `backups` snapshot.
  A task present in `base`/snapshot but absent from `liveS` = a deletion. Cross-check
  `liveS.deletions` for a matching tombstone `{id, at}`: **tombstone present** = intentional
  delete; **no tombstone** = the delete-on-absence bug class (should no longer happen
  post-tombstones, v2026.07.12-0832+). Streak values live on the task (`t.streak`).
- **Stale app / update didn't take.** Check `meta.appVersion` and `serviceWorker`
  active/waiting script URLs and `caches` names vs the latest `questa-vNNN`. A `waiting`
  SW or an old cache name = the new build hasn't activated; a hard reload / cache clear
  is needed.
- **Sync failing.** `localStorage["questa.sync.v1"].lastError`, `lastSyncAt`, `lastRev`.
- **Crash / weird behavior with no console.** Read `errors` (newest last) for the stack.
- **Divergence between memory and disk.** Diff `liveS` against `localStorage["questa.save.v1"]`
  (parsed). They should match after a save; a mismatch points at a persistence/timing issue.
- **Quota pressure.** `storageEstimate.usage` near `quota` can cause failed writes.

## Why monolithic (not split files)

Splitting per-section would cost the two things that matter most — a single share action
off a phone, and an atomic same-instant snapshot — while not reducing total size. If the
file ever gets too big to move, the right lever is a size cap or a "lite" export that omits
the `backups` snapshot blobs, not more files.
