# SYNC-MULTI-DEVICE-CASES.md

**Single- and Multi-Device Use-Case / Edge-Case Map for Questa Sync**

Generated as part of `sync-eventlog-hardening-v2` (T5/C4). All `file:line` citations verified against the codebase at time of writing.

---

## 1. Device Model & Identity

| # | Scenario | Current Behavior (`file:line`) | Risk | Gap | Status |
|---|----------|-------------------------------|------|-----|--------|
| 1.1 | Device identity (`deviceId`) stored in localStorage `questa.sync.v1` | `sync.js:59-67` (`syncDeviceId`) | If localStorage wiped, new `deviceId` minted; old device's month files become "other device" files | Identity survival matrix (see 1.3) | Documented |
| 1.2 | Per-device month files in Dropbox: `<deviceId>-<YYYYMM>.json` | `sync.js:1765` (`dbxUploadText` path) | Single-writer assumption; no rev handshake | No concurrency protocol | Documented |
| 1.3 | **Identity-survival matrix (K2)** — localStorage intact + IDB lost = own-file skip blocks recovery (C1 applies); localStorage wiped = new id, old files import via normal path, C1 is no-op | `sync.js:59-67`, `sync.js:1826` | Partial gap leaves non-empty store, so emptiness test never notices | C1 (push shrink guard) addresses the ratchet; recovery pull deferred | Documented |
| 1.4 | Dropbox conflict copies `" (1)"` deliberately unparsed | `sync.js:1605-1616` (`evtParseFileName`) | Browser/OS download-collision pattern, not Dropbox's `(conflicted copy)` | Unparsed files silently skipped | Documented |

---

## 2. Single-Device Flows

| # | Scenario | Current Behavior (`file:line`) | Risk | Gap | Status |
|---|----------|-------------------------------|------|-----|--------|
| 2.1 | Normal save → scheduleSync → syncNow → push+pull | `sync.js:1928-1933`, `sync.js:1014` | — | — | Working |
| 2.2 | Reconnect after offline (online/visibilitychange) | `sync.js:2087-2091` | — | — | Working |
| 2.3 | Restore from backup (snapshot) | `app.js:5970-6002` | `clearAllEvents` + `bulkAddEvents` used to destroy local events not in backup (fixed by union-insert) | Fixed in T3 (honest reporting) | Fixed |
| 2.4 | Boot recovery (NEW, T1) — once per 24h, `includeOwn` pull | `sync.js:2092` (2s boot sync), `sync.js:4000` (4s recovery hook) | Push runs before recovery (N1); purge race (M4) | Push-block ordering gate added; `_evtPurgeInFlight` flag | Fixed |
| 2.5 | Force push (state only) | `sync.js:1975-2000` (`confirmForcePush`) | Only pushes state, not events | Event force-push added in T1 (`syncEventsForcePush`) | Fixed |
| 2.6 | Force pull (state + events) | `sync.js:1253-1274` (`_syncForcePullAttempt`) | Passes `force:true` only; now also `includeOwn:true` (R2) | — | Fixed |
| 2.7 | Reset local (disconnect + clear) | `sync.js:188-194` (`syncHandleRedirect`) | Deletes own month files via `syncEventsDeleteDevice` | Purge race with recovery (M4) | Documented |

---

## 3. Multi-Device Flows

| # | Scenario | Current Behavior (`file:line`) | Risk | Gap | Status |
|---|----------|-------------------------------|------|-----|--------|
| 3.1 | 2 devices, same account, simultaneous edits | `sync.js:681` (`mergeCollection`), `sync.js:905` (`merge`) | Recency guard (`_ua`/`_ca`) with 120s skew clamp | Skew clamp bypassed at 8 sites (P10a) | Backlog |
| 3.2 | N devices, same account | Same as 3.1 | — | — | Working |
| 3.3 | Device replacement (old device reset, new device added) | `sync.js:1901-1908` (`syncEventsDeleteDevice`) | Old device's files deleted; new device gets new `deviceId` | — | Working |
| 3.4 | Device deletion/reset | `sync.js:188-194` | `pendingPurgeDev` stashed; on reconnect, own files deleted | Recovery could race purge (M4) | `_evtPurgeInFlight` flag added |
| 3.5 | Timezone/day-stamp travel | `sync.js:1672` (`evtMonthOlderThan`), `app.js:1403` (`runCron`) | Day-stamp based on local calendar day | Cross-TZ day boundaries can cause missed resets | Documented |
| 3.6 | Shared `deviceId` (two devices, same id) | `sync.js:1749-1765` | Both `mode:overwrite` same `<dev>-<YYYYMM>.json`; last writer wins | No detection/handling | Backlog |

---

## 4. Edge-Case Table (≥15 rows)

| # | Scenario | Current Behavior (`file:line`) | Risk | Gap | Status |
|---|----------|-------------------------------|------|-----|--------|
| 4.1 | Own-file skip in pull | `sync.js:1826` (`parsed.dev === myDev`) | Blocks recovery of own events if local store truncated | C1 (push shrink guard) addresses ratchet; recovery pull deferred | Documented |
| 4.2 | `evtIncomingFilter` own-reject | `sync.js:1662` (`if(r.dev === myDev) return;`) | Same as 4.1 | — | Documented |
| 4.3 | Age-gate clock skew | `sync.js:1663` (`nowMs - r.ts > ageLimitMs`) | Device clock wildly wrong → age gate rejects everything | Recovery silently does nothing; manual force-pull fallback | Documented |
| 4.4 | ~18-month hard limit | `sync.js:1802` (fallback), `sync.js:1672` (`evtMonthOlderThan`) | Events older than ~18 months never synced | By design; documented in C4 | Documented |
| 4.5 | **2026-07-28 UPLOAD gap** — events never reached Dropbox, unrecoverable, cause unknown | `tools/reconstruct_events_jul28.md:9-16` | **Explicitly NOT fixed by T1** — upload-side loss | Tracked in `.omo/plans/sync-event-push-gap.md` | **NOT FIXED** |
| 4.6 | Dropbox `" (1)"` unparsed | `sync.js:1605-1616` | Conflict copies silently skipped | Browser/OS pattern, not Dropbox's | Documented |
| 4.7 | Shared-deviceId race | `sync.js:1749-1765` | Two devices, same id, both overwrite same file; last writer wins | No detection | Backlog |
| 4.8 | `uid` index `{unique:false}` | `app.js:802` | Dedup is pre-insert only; duplicates from lost race never repaired | Backlog row in C4 | Backlog |
| 4.9 | `conflictResolved` log volume | `sync.js:778, 986, 996, 999` | One entry per merge invocation; re-invoked by `_pushWithConflictRetry` | T4 throttles to one per (kind, entityId) per round | **Fixed by T4** |
| 4.10 | Window-floor clamp (incl. `snap==='all'`) | `app.js:2533-2534` | Feed clamped to earliest task date; "All" range still clamped | T2 adds `noFloor` to `anWindow` | **Fixed by T2** |
| 4.11 | `bulkAddEvents` false success (incl. outer catch) | `app.js:1229-1231` | Returns bare number on all 4 failure paths; callers show false success | T3 returns `{added, failed, aborted}` on all paths | **Fixed by T3** |
| 4.12 | Tokenized export schema 2 | `app.js:1213` (`buildBackupFile`), `tools/join_exports.py` | Schema 2 envelope with tokenization; `join_exports.py` detokenizes to schema 1 | Untouched this round | Documented |
| 4.13 | 60s pull throttle | `sync.js:1790` (`EVT_PULL_MIN_INTERVAL_MS`) | Pulls throttled to 60s; `force:true` bypasses | — | Working |
| 4.14 | Rev-cache wedging | `sync.js:1803-1815` | Stale/corrupt rev pins file out of pull forever | 24h full re-scan ignores rev cache (self-heals) | Working |
| 4.15 | `resetEverything` deletes own files + `pendingPurgeDev` vs recovery ordering | `app.js:5287-5305` → `sync.js:188-192` → `sync.js:1901-1908` | Recovery could re-download files mid-deletion (M4) | `_evtPurgeInFlight` flag added in T1 | **Fixed** |
| 4.16 | Push-after-reimport idempotence | `sync.js:1765`, commit `b3371bb` | Re-imported own events re-push next cycle, idempotent | — | Working |
| 4.17 | Upload watermark poisoning (P1) | `sync.js:1766-1768` | Wrong-clock event pins `evtLastUploadTs` in future; upload stops silently | T0 clamps watermark, self-heals at boot, adds 24h full re-push | **Fixed by T0** |
| 4.18 | Sub-watermark invisibility (P2) | `sync.js:1756` (`from: since + 1`) | Events below watermark never uploadable; no push-side full re-scan | T0 adds 24h full re-push mirroring pull side | **Fixed by T0** |
| 4.19 | Two-store durability split (P3) | `sync.js:45-57` (localStorage) vs `app.js:795-810` (IDB) | `deviceId`, watermark, rev cache, refresh token in localStorage; events in IDB | Four roll-back combos possible; C1's baseline read is load-bearing | Documented |
| 4.20 | Count-vs-content loss detector (P4) | C1 design (count comparison only) | Equal counts hide equal-sized swaps (5 lost, 5 gained) | T1 stores sorted-uid hash beside count | **Fixed by T1** |
| 4.21 | Device-relative conflict labels (P5) | `sync.js:778/986/996/999` → `app.js:3833` | `winner:'local'|'remote'` reads as opposite on other devices | T4/T7: entries carry `winnerDev`/`loserDev`/`reason`; renderer resolves relative to reading device | **Fixed by T4/T7** |
| 4.22 | Same conflict logged twice (P6) | Both devices merge independently | Mirror-image labels; feed appears to contradict itself | T4: emit only from device where `authorDev === winnerDev` | **Fixed by T4** |
| 4.23 | Conflict entries from pure merge for discarded outcomes (P7) | `sync.js:1134-1162` (`_pushWithConflictRetry` re-merges) | Log records decisions that were discarded | T4: `merge()` returns decisions; caller emits once after commit | **Fixed by T4** |
| 4.24 | `conflictResolved` classified as feed noise (P8) | `app.js:3568` (`isFeedNoise`), `app.js:3635` (`hideSyncDiag`) | Hidden when `hideSyncDiag` on; default value of `hideSyncDiag` is `true` | T7: separate `hideConflictDecisions` default `false` | **Fixed by T7** |
| 4.25 | No per-device event sequence (P9) | `app.js:825-827` (record shape) | Gaps undetectable by construction; every loss silent | Highest-value G2 item for next round | Backlog |
| 4.26 | Merge skew clamp bypassed at 8 sites (P10a) | `sync.js:558-559, 620, 631, 642, 656-658, 763-765, 985` | Device stuck in future wins every conflict | `.omo/plans/merge-hardening-v1.md` | Backlog |
| 4.27 | Subtask deletion inferred from absence (P10b) | `sync.js:593-671`, `app.js:132` (`delMark`) | `tombstoneMap` never given to `mergeChecklist`; `touchedAt===0` dropped | `.omo/plans/merge-hardening-v1.md` | Backlog |
| 4.28 | Char merges as whole-object LWW (P10c) | `sync.js:955-1001` | Two devices earning xp/gold offline lose one side's rewards | `.omo/plans/merge-hardening-v1.md` | Backlog |
| 4.29 | Rev cache written only after successful insert (P11) | `sync.js:1867` | Corrupt payloads go to `evtBadRevs` sentinel | Confirmed sound | Documented |
| 4.30 | `evtBadRevs` never pins a file (P11) | `sync.js:1869-1875` | Slower retry, never pins | Confirmed sound | Documented |
| 4.31 | 24h full re-scan self-heals cache skips (P11) | `sync.js:1813-1815` + `1890-1891` | Ignores rev cache once/day | Confirmed sound | Documented |
| 4.32 | `navigator.storage.persist()` requested (P11) | `app.js:6163` | — | Confirmed sound | Documented |

---

## 5. Known-Incidents Chronology

| # | Incident | Description | Root Cause | Status |
|---|----------|-------------|------------|--------|
| 5.1 | 2026-07-28 event-log gap (20 events missing) | Upload-side loss; events never recorded on investigated device; arrived as merged state | Unknown; device that performed completions unidentified (`mrg0grhu3mozs` leads by elimination) | Tracked in `.omo/plans/sync-event-push-gap.md` |
| 5.2 | 2026-07-29 event-feed-empty-pages | Feed showed empty pages due to window-floor clamp in "All" range | `anWindow` clamp at `app.js:2533-2534` applied before `snap==='all'` assignment | Fixed by T2 (`noFloor` bypasses both floors) |
| 5.3 | 2026-07-29 auto-backup tiers dead | `_bkNextBoundary` broken; no snapshots captured | Fixed in commit `798aa4c` | Fixed |
| 5.4 | 2026-07-12 sync-architect review verdict | Incremental, verified behavior stays; no structural merge rework | Respected as guardrail this round | Documented |

---

## 6. Future Recommendations (Backlog — NOT this plan)

| # | Recommendation | Related Plan |
|---|----------------|--------------|
| 6.1 | Upload-side gap investigation (which device lost 2026-07-28 events and why) | `.omo/plans/sync-event-push-gap.md` |
| 6.2 | Duplicate-uid repair / add `unique` constraint to `uid` index | Backlog row in C4 |
| 6.3 | Shared-deviceId handling (detect/prevent two devices with same id) | Backlog row in C4 |
| 6.4 | Event tombstone (to support own-event deletion without resurrection) | Gates T1-DEFERRED (N2) |
| 6.5 | Per-device event sequence number (detect gaps) | P9 — highest-value G2 item for next round |
| 6.6 | Merge-engine fixes: skew clamp at all sites, subtask tombstones, char per-field merge | `.omo/plans/merge-hardening-v1.md` |
| 6.7 | Store `evtFileCounts` in IndexedDB alongside events (mitigate P3 two-store split) | P3 mitigation |
| 6.8 | Rev handshake on upload (replace `mode:overwrite` with conditional write) | Larger design; not this round |

---

## 7. Citation Spot-Check Log (5 random citations)

| # | Citation | Resolved Snippet |
|---|----------|------------------|
| 1 | `sync.js:1826` | `if(parsed.dev === myDev){ _qDiagPush('evtPullSkip', { name: ent.name, reason: 'ownDevice' }); continue; }` |
| 2 | `app.js:2533-2534` | `if(p.snap==='all'){ from=mn; to=now; } if(from<mn) from=mn;` |
| 3 | `sync.js:1766-1768` | `recs.forEach(e => { if(e.ts > maxTs) maxTs = e.ts; }); syncCfgSave({ evtLastUploadTs: maxTs });` |
| 4 | `sync.js:778` | `logEvent({kind:'conflictResolved', taskType:(winner&&winner.type)||'task', taskId:id, taskTitle:(winner&&winner.title)||'', winner:(winner===l)?'local':'remote', loser:(winner===l)?'remote':'local'});` |
| 5 | `app.js:3833` | `desc = 'Sync conflict resolved · ' + _ct + ' · kept ' + (e.winner === 'remote' ? 'remote' : 'local');` |

---

*End of SYNC-MULTI-DEVICE-CASES.md*