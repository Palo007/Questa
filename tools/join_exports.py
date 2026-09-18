#!/usr/bin/env python3
"""join_exports.py — deterministically join multiple Questa exports into one
most-current, fully-merged state.

Why this is safe as a pure script: every Questa collection carries its own
merge key + timestamp, so a "newest-wins per id/key" join is conflict-free by
construction. Verified against real exports: tasks/rewards/devices/char have
`updatedAt`, charHistory has `date`, deletions have `at`, events have unique
`id`s, and the top level carries `__seq`/`__savedAt`/`__hlcLast`.

Rules (mirror of the app state schema — keep in sync with AGENTS.md):
  tasks/rewards/devices : key=id,      ts=updatedAt  -> newest wins
  char                  : singleton,   ts=updatedAt  -> newest wins
    char.abs (K3, 2026-09-11): {deviceId: {ua,xp,gold,mp}} -- the per-device
      "already absorbed" record sync.js writes when it accumulates earnings
      (sync.js _charAccumulate). It is UNIONED across all inputs by
      (ua, xp, gold, mp) instead of riding along with the newest char, because
      dropping a peer's entry would let a later merge count that peer's
      earnings a second time. LIMITATION: the scalars (lvl/xp/gold/mp) stay
      whole-object newest-wins here -- a join has no common ancestor, so it
      cannot reproduce the app's three-way accumulate.
      NOT tokenized: `abs` must never get an _EXPORT_FIELD_MAP code in app.js
      (a new-build backup would become unimportable by an older build).
  charHistory           : key=date,    ts=date       -> union, de-dup by date
  deletions (tombstone) : key=id,      ts=at         -> union, newest at wins
  events                : key=id,      ts=ts         -> union by id (disjoint epochs)
    New fields on conflictResolved events (2026-08-02 sync-eventlog-hardening-v2):
      winnerDev, loserDev, reason  (device-relative, preferred over legacy
      winner/loser). These are just additional properties — union-by-id keeps them.
    New diagnostic event kinds:
      evtWatermarkRepaired, evtPushBlocked, evtPushShrinkBlocked
  prefs                 : key=pref key,ts=__savedAt  -> union, newest export wins
    prefs.autoBackupEnabled : 4-tier backup toggle {fourHour,daily,weekly,monthly}
      (boolean per tier). Added 2026-07-23. Sync-excluded (prefs never sync via
      syncSubset()). Handled generically by the prefs dict merge — no special rule.
      Legacy prefs.exportIntervalDays is preserved for backward compat but unused.
    prefs.hideConflictDecisions : boolean (default false). Added 2026-08-02.
      Toggles visibility of conflictResolved events in Activity Feed. Independent
      of hideSyncDiag. Handled generically by prefs dict merge.
    prefs.hideSyncDiag : boolean (default true). Toggles visibility of lifecycle/
      storagePersist/diagnostic events in Activity Feed. Handled generically.
  habiticaHistory       : present-in-any              -> kept
  monthlyBackups        : union of strings
  top meta __seq/__savedAt/__hlcLast/version : max across inputs

Conflicts (same id, divergent content/value) are NEVER silently dropped: they
are recorded in out["_joinConflicts"] and printed. Resolution for a conflict
defaults to "newest timestamp wins" but the record is surfaced for the user.

CLI:
  python tools/join_exports.py OUT.json A.json B.json [C.json ...]
"""

import json
import sys
import os
import time
from datetime import datetime, timezone


# --- local-day semantics (mirror app.js dayStamp / sync.js dayStampOf) --------
# dayStampOf: LOCAL calendar YYYYMMDD from an ms epoch. Cross-TZ correctness is
# the same as the app/sync layer (verified in tests/daystamp.test.js). Used by
# normalize_daily_resets below to decide whether a completed daily belongs to a
# day already rolled over by the newest export's lastCron.
def day_stamp_of(ms):
    if not ms:
        return 0
    # Local calendar day: app.js dayStamp() uses getFullYear/getMonth/getDate
    # (device-local), sync.js dayStampOf() matches it. time.localtime mirrors
    # that device-local intent so the joined reset overlay agrees with the app.
    lt = time.localtime(ms / 1000.0)
    return lt.tm_year * 10000 + (lt.tm_mon) * 100 + lt.tm_mday


# --- schema-2 (tokenized) export support -----------------------------------
# Mirrors app.js _detokenizeSnapshot / _detokenizeEvents. Tokenized exports
# (schema>=2) store the snapshot field-names short (map in FM) and events as
# short-keyed arrays of objects with K/SRC/TID/TT dictionaries. Expand them to
# the legacy shape so the rest of the join logic (which expects long keys +
# top-level `events`) is unchanged. See .kilo/plans/1784185676821-*.
def _detok_deep(o, rmap):
    if isinstance(o, list):
        return [_detok_deep(x, rmap) for x in o]
    if isinstance(o, dict):
        return {rmap.get(k, k): _detok_deep(v, rmap) for k, v in o.items()}
    return o


def _detok_events(env):
    e = env.get("E")
    if not isinstance(e, list):
        return []
    K = env.get("K", []) or []
    SRC = env.get("SRC", []) or []
    TID = env.get("TID", []) or []
    TT = env.get("TT", []) or []
    SHORT = {
        "t": "ts", "u": "uid", "d": "dev", "k": "kind", "n": "taskTitle",
        "no": "notes", "i": "id", "ty": "taskType", "ti": "taskId",
        "st": "streak", "rw": "reward", "rp": "repeat", "cl": "checklist",
        "ch": "changes", "si": "subId", "sx": "subText", "do": "done",
        "cb": "clawback", "di": "deviceId", "dn": "deviceName",
        "pn": "prevDeviceName", "ca": "createdAt", "co": "completedAt",
        "dr": "dir", "rs": "reps", "v": "value", "dg": "dmg", "ct": "cost",
        "ef": "effect", "cr": "counter", "ps": "preBumpSeq", "ss": "storedSeq",
        "gr": "granted", "lg": "log", "dt": "detail", "vs": "visibilityState",
        "hd": "hidden", "dy": "dirty", "fd": "found", "is": "idbSeq",
        "ls": "liveSeq", "wn": "winner", "lo": "loser", "ctt": "charTitle",
        "dyy": "day", "lt": "late", "o": "source", "sy": "synthetic",
        "rc": "repCounted", "in": "inferred",
        "wd": "winnerDev", "ld": "loserDev", "rn": "reason",
    }
    out = []
    for o in e:
        if not isinstance(o, dict):
            out.append(o)
            continue
        ev = {}
        for sk, v in o.items():
            if sk in ("u", "d", "i"):
                ev[sk] = v
                continue
            f = SHORT.get(sk, sk)
            if sk == "k":
                ev["kind"] = K[v] if isinstance(v, int) and 0 <= v < len(K) else v
            elif sk == "o":
                ev["source"] = SRC[v] if isinstance(v, int) and 0 <= v < len(SRC) else v
            elif sk == "ti":
                ev["taskId"] = TID[v] if isinstance(v, int) and 0 <= v < len(TID) else v
            elif sk == "n":
                ev["taskTitle"] = TT[v] if isinstance(v, int) and 0 <= v < len(TT) else v
            elif sk in ("sy", "rc", "in", "do"):
                ev[f] = bool(v)
            else:
                ev[f] = v
        out.append(ev)
    return out


def _detokenize_export(data):
    """Expand a schema-2 tokenized export to legacy shape. No-op for schema-1."""
    if not isinstance(data, dict):
        return data
    meta = data.get("_backup") or {}
    if not (isinstance(meta, dict) and meta.get("schema") == 2):
        return data
    fm = data.get("FM", {}) or {}
    rmap = {v: k for k, v in fm.items()}
    snap = _detok_deep(data.get("S", {}), rmap)
    snap["events"] = _detok_events(data)
    # carry schema + appVersion so downstream consumers can tell, but the
    # merged output is emitted as legacy schema-1 (long keys) for compatibility.
    return snap


# --- collections merged by (key_field, timestamp_field) ---------------------
# (collection, key, ts) — ts None means "use __savedAt of the whole export".
ROW_MERGED = [
    ("tasks", "id", "updatedAt"),
    ("rewards", "id", "updatedAt"),
    # 2026-09-18: tags were missing entirely. They are a first-class synced
    # collection with exactly the tasks/rewards/devices shape — syncSubset()
    # whitelists them, syncApply() writes them back, and sync.js merges them with
    # mergeCollection(base.tags, local.tags, remote.tags, ...) by id + updatedAt.
    # Without this row the join emitted no "tags" key at all, so migrate() reset it
    # to [] on import and every tag in every source export was lost, taking each
    # task's tag references with it. AGENTS.md §6 calls a stale join script a red
    # deploy gate; this was one.
    ("tags", "id", "updatedAt"),
    ("devices", "id", "updatedAt"),
    ("char", None, "updatedAt"),          # singleton: pick newest updatedAt
]

TS_KEY_FALLBACK = "__savedAt"             # used for prefs (dict, no per-key ts)


def _is_default(v):
    """True for 'empty' values we should let a sibling non-default override.

    2026-09-18: `False == 0` is True in Python, so a boolean False used to be
    classified as "empty". In the equal-ts field merge that made False always
    lose to True and never the reverse, in either argument order -- so the
    device reporting `done: False` for a daily could never be heard, and the
    joined file marked it complete. False is a real value here (done, paused,
    subtask done, hidden, synthetic), not an absent one.
    """
    if isinstance(v, bool):
        return False
    return v is None or v == 0 or v == "" or v == [] or v == {}


def normalize_daily_resets(tasks, merged_last_cron):
    """Mirror sync.js normalizeDailyResets(tasks, mergedLastCron).

    A daily completed on a day that the newest export has already rolled past
    (mergedLastCron > dayStampOf(doneAt)) must be reset to done:false, because
    the other export's cron already transitioned that calendar day. This is the
    authoritative current-day task state — the whole-row updatedAt last-write-
    wins rule CANNOT see it, because runCron intentionally does not bump
    updatedAt (app.js F3). Applied here so a joined export already carries the
    correct start-of-day state (no re-penalisation on import). Pure: no mutate.
    """
    if not isinstance(tasks, list):
        return tasks
    if not merged_last_cron:
        return tasks
    out = []
    for t in tasks:
        if not isinstance(t, dict) or t.get("type") != "daily" or not t.get("done"):
            out.append(t)
            continue
        # 2026-09-18: mirror sync.js doneDayOf(). completeTask/creditYesterday now
        # freeze the completion day (t.doneDay) in the RECORDING device's timezone,
        # exactly as runCron freezes t.missedOn. day_stamp_of(doneAt) re-derives it
        # in whatever timezone this script happens to run in, which is a different
        # frame from merged_last_cron and silently un-ticked still-current dailies.
        # Records from older builds carry no doneDay, so fall back to the old
        # derivation for them. (AGENTS.md §6: schema change, same edit.)
        _done_day = t.get("doneDay") or day_stamp_of(t.get("doneAt") or 0)
        if _done_day < merged_last_cron:
            nt = dict(t)
            nt["done"] = False
            if isinstance(t.get("checklist"), list):
                nt["checklist"] = [dict(c, done=False) if isinstance(c, dict) else c
                                   for c in t["checklist"]]
            out.append(nt)
        else:
            out.append(t)
    return out


def merge_an_subarray(inputs, subkey, conflicts):
    """Merge a keyed sub-array inside prefs.an (e.g. `views`, `metrics`), each
    element carrying `id` + `updatedAt`. Mirrors the tasks/rewards rule: newest
    `updatedAt` wins per id, union of distinct ids, equal-ts divergences are
    field-merged (preferring non-default values) and recorded as conflicts.

    Order: the newest-`__savedAt` input's array order is preserved first, then ids
    unique to other inputs are appended (deterministic; keeps the most-recently
    edited layout's ordering). Without this, prefs.an is merged atomically and the
    whole views/metrics layout of every non-newest export is silently dropped.
    """
    primary = max(inputs, key=lambda p: int(p[1].get("__savedAt", 0) or 0))
    order = []
    for v in (primary[1].get("prefs", {}).get("an", {}) or {}).get(subkey, []) or []:
        if isinstance(v, dict) and v.get("id"):
            order.append(v["id"])
    by_id = {}
    for (fn, d) in inputs:
        arr = (d.get("prefs", {}).get("an", {}) or {}).get(subkey, []) or []
        if not isinstance(arr, list):
            continue
        for v in arr:
            if not isinstance(v, dict) or not v.get("id"):
                continue
            i = v["id"]
            ts = int(v.get("updatedAt") or 0)
            cur = by_id.get(i)
            if cur is None or ts > cur["ts"]:
                by_id[i] = {"ts": ts, "value": v}
            elif ts == cur["ts"] and v != cur["value"]:
                merged = dict(cur["value"])
                for fld, val in v.items():
                    if fld == "id":
                        continue
                    cv = merged.get(fld)
                    if _is_default(cv) and not _is_default(val):
                        merged[fld] = val
                    elif _is_default(val) and not _is_default(cv):
                        pass
                    elif val != cv:
                        merged[fld] = val
                conflicts.append(_conflict("prefs.an." + subkey, i,
                                           [cur, {"file": fn, "ts": ts, "value": v}],
                                           "equal ts, field-merged"))
                by_id[i] = {"ts": ts, "value": merged}
    out = []
    for i in order:
        if i in by_id:
            out.append(by_id.pop(i)["value"])
    for i in by_id:
        out.append(by_id[i]["value"])
    return out


def _load(path):
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    # Expand schema-2 (tokenized) exports to the legacy shape; for schema-1 this
    # is a no-op. Either way the result must carry a top-level `version`.
    data = _detokenize_export(data)
    if not isinstance(data, dict) or "version" not in data:
        raise SystemExit("NOT A QUESTA EXPORT (no 'version'): %s" % path)
    return data


def _ts_of(row, ts_field, export_meta):
    """Return an integer timestamp for ordering/conflict; never None."""
    if ts_field is None:
        return int(export_meta.get(TS_KEY_FALLBACK, 0) or 0)
    v = row.get(ts_field) if isinstance(row, dict) else None
    return int(v if isinstance(v, (int, float)) else 0)


def _conflict(collection, key, winners, resolution):
    return {
        "collection": collection,
        "id": key,
        "exports": [
            {"file": w["file"], "updatedAt": w["ts"], "value": w["value"]}
            for w in winners
        ],
        "resolution": resolution,
    }


def merge_exports(inputs):
    """inputs: list of (filename, dict). Returns (merged_dict, conflicts_list)."""
    conflicts = []
    meta = {}  # per-export meta for prefs fallback

    # 2026-09-18: order by __savedAt, not by argv position. The equal-updatedAt
    # field merge below resolves a conflict with "newest file wins", but it
    # iterated `inputs` in raw command-line order, so two runs over the same
    # recovery set produced different state depending on shell glob order. The
    # prefs block already sorted this way; now every collection does.
    inputs = sorted(inputs, key=lambda p: int(p[1].get(TS_KEY_FALLBACK, 0) or 0))

    # ---- top-level scalars (max) -------------------------------------------
    # lastCron is carried as max (mirrors sync.js mergedLastCron = max of
    # inputs) so the joined export reflects the newest day-rollover that any
    # input had already crossed. This is the key that lets normalize_daily_resets
    # below decide the authoritative current-day daily state.
    top_int_max = ["__seq", "__savedAt", "__hlcLast", "version", "lastCron"]
    out = {}
    for k in top_int_max:
        vals = [int(d.get(k) or 0) for (_, d) in inputs]
        if any(d.get(k) is not None for (_, d) in inputs):
            out[k] = max(vals)
    # K1 (2026-09-11): mirrors the sync.js mergedLastCron rule. A lastCron that
    # lies in the FUTURE carries no authority, because normalize_daily_resets
    # below force-unchecks every daily under it and clears every subtask tick.
    # One input export written by a device with a wrong date would otherwise
    # wipe the done state out of the whole recovered join. Inputs at or behind
    # today keep the plain max, so ordinary archive joins are unaffected.
    if "lastCron" in out:
        _today = int(datetime.now().strftime("%Y%m%d"))  # LOCAL day, matching sync.js dayStampOf()
        _plausible = [v for v in (int(d.get("lastCron") or 0) for (_, d) in inputs) if v <= _today]
        if out["lastCron"] > _today:
            out["lastCron"] = max(_plausible) if _plausible else 0
    # K2 (2026-09-11): __hlcLast is the device hybrid logical clock. It is deliberately
    # NOT in sync.js syncSubset(), so a poisoned clock never spreads over Dropbox --
    # but a plain max() HERE transplants it from a poisoned export into a healthy join,
    # which is the one remaining path by which it does spread. A value beyond
    # now + the fleet tolerance is honoured by no device at all (app.js
    # HLC_RATCHET_TOLERANCE_MS, sync.js MAX_FUTURE_SKEW_MS, and app.js now() now resets
    # through it), so it carries no ordering authority worth joining. Inputs at or
    # inside the ceiling keep the plain max, so ordinary archive joins are unaffected.
    # Same shape as the lastCron cap above. See .omo/plans/K2-hlc-future-lock.md.
    if "__hlcLast" in out:
        _hlc_tol_ms = 120000  # mirrors app.js HLC_RATCHET_TOLERANCE_MS
        _hlc_ceil = int(datetime.now().timestamp() * 1000) + _hlc_tol_ms
        if out["__hlcLast"] > _hlc_ceil:
            _plausible_hlc = [v for v in (int(d.get("__hlcLast") or 0) for (_, d) in inputs) if v <= _hlc_ceil]
            out["__hlcLast"] = max(_plausible_hlc) if _plausible_hlc else 0

    # ---- char (singleton) --------------------------------------------------
    char_winner = None
    for (fn, d) in inputs:
        c = d.get("char")
        if not isinstance(c, dict):
            continue
        ts = _ts_of(c, "updatedAt", d)
        if char_winner is None or ts > char_winner["ts"]:
            char_winner = {"ts": ts, "file": fn, "value": c}
    if char_winner:
        out["char"] = dict(char_winner["value"])  # copy: char.abs is rewritten below
        # K3 (2026-09-11): union char.abs across every input, newest-per-device.
        # Mirrors sync.js _absBetter: strict total order on (ua, xp, gold, mp), so the
        # join is order-independent the same way the merge is.
        _abs = {}
        for (_fn, d) in inputs:
            c = d.get("char")
            if not isinstance(c, dict):
                continue
            a = c.get("abs")
            if not isinstance(a, dict):
                continue
            for dev, e in a.items():
                if not isinstance(e, dict):
                    continue
                def _n(v):
                    try:
                        return float(v or 0)
                    except (TypeError, ValueError):
                        return 0.0
                rank = (_n(e.get("ua")), _n(e.get("xp")), _n(e.get("gold")), _n(e.get("mp")))
                cur = _abs.get(dev)
                if cur is None or rank > cur[0]:
                    _abs[dev] = (rank, e)
        if _abs:
            out["char"]["abs"] = {dev: e for dev, (_r, e) in _abs.items()}

    # ---- row-merged collections (id + updatedAt) ---------------------------
    # Whole-row last-write-wins: the row with the newest `updatedAt` is the
    # authoritative current state for that id; older rows are discarded (their
    # content is superseded). This mirrors the app's current-state semantics.
    # A conflict is logged only when two rows with the SAME newest timestamp
    # differ (ambiguous) — normal newer-wins is not a conflict.
    for (col, key, tsf) in ROW_MERGED:
        if col == "char":
            continue
        by_key = {}  # k -> {"ts","file","value"}
        for (fn, d) in inputs:
            rows = d.get(col)
            if not isinstance(rows, list):
                continue
            for row in rows:
                if not isinstance(row, dict) or key not in row:
                    continue
                k = row[key]
                ts = _ts_of(row, tsf, d)
                cur = by_key.get(k)
                if cur is None or ts > cur["ts"]:
                    by_key[k] = {"ts": ts, "file": fn, "value": row}
                elif ts == cur["ts"] and row != cur["value"]:
                    # Same timestamp, divergent content: merge field-by-field,
                    # preferring the more informative (non-default) value so a
                    # live counter (e.g. cUp) isn't clobbered by a zeroed twin.
                    merged_row = dict(cur["value"])
                    for fld, val in row.items():
                        if fld == key:
                            continue
                        cur_val = merged_row.get(fld, None)
                        if _is_default(cur_val) and not _is_default(val):
                            merged_row[fld] = val
                        elif _is_default(val) and not _is_default(cur_val):
                            pass  # keep cur's informative value
                        elif val != cur_val:
                            merged_row[fld] = val  # both non-default & differ: newest file wins
                    conflicts.append(_conflict(col, k, [cur, {"file": fn, "ts": ts, "value": row}], "equal ts, field-merged"))
                    by_key[k] = {"ts": ts, "file": fn, "value": merged_row}
        rows_out = [v["value"] for v in by_key.values()]
        # After whole-row merge, apply the daily reset overlay keyed to the
        # joined lastCron (mirrors sync.js mergedLastCron -> normalizeDailyResets).
        # This corrects the case where an older, not-yet-cronned export's
        # done:true daily wins an updatedAt tie over a newer reset export.
        if col == "tasks":
            rows_out = normalize_daily_resets(rows_out, out.get("lastCron", 0))
        out[col] = rows_out

    # ---- charHistory (union by LOCAL day, numeric fields max-folded) -------
    # 2026-09-18: mirror sync.js mergeDayArray (K3). This used to key on the raw
    # Date.now() millisecond and `setdefault` -- so a collision kept whichever
    # file was listed FIRST and silently dropped the newer export's xp/gold/hp
    # for that row. Two devices either side of local midnight also produced two
    # unmergeable rows for one day. Bucket by day_stamp_of and fold each numeric
    # field with max, exactly as the app does.
    ch = {}
    for (fn, d) in inputs:
        for row in d.get("charHistory", []) or []:
            if not (isinstance(row, dict) and "date" in row):
                continue
            key = day_stamp_of(row.get("date") or 0)
            cur = ch.get(key)
            if cur is None:
                ch[key] = dict(row)
                continue
            for k, ev in row.items():
                if k == "date":
                    cur["date"] = max(cur.get("date") or 0, row.get("date") or 0)
                    continue
                cv = cur.get(k)
                if isinstance(ev, bool) or isinstance(cv, bool):
                    if k not in cur:
                        cur[k] = ev
                elif isinstance(ev, (int, float)) and isinstance(cv, (int, float)):
                    cur[k] = max(cv, ev)
                elif isinstance(ev, list) and isinstance(cv, list):
                    by_id = {}
                    for x in cv:
                        if isinstance(x, dict) and x.get("id") is not None:
                            by_id[x["id"]] = x
                    for x in ev:
                        if isinstance(x, dict) and x.get("id") is not None:
                            by_id[x["id"]] = x
                    cur[k] = list(by_id.values())
                elif k not in cur:
                    cur[k] = ev
                # else: non-numeric, non-array scalar collision -- keep cur
    out["charHistory"] = sorted(ch.values(), key=lambda r: r.get("date") or 0)

    # ---- deletions (tombstones: union by id, newest at wins) ---------------
    del_by = {}
    for (fn, d) in inputs:
        for row in d.get("deletions", []) or []:
            if isinstance(row, dict) and "id" in row:
                k = row["id"]
                ts = int(row.get("at") or 0)
                cur = del_by.get(k)
                if cur is None or ts > cur["ts"]:
                    del_by[k] = {"ts": ts, "value": row}
    out["deletions"] = [v["value"] for v in del_by.values()]

    # ---- tombstone overlay -------------------------------------------------
    # 2026-09-18: join_exports.md promised "deletions win over live tasks: a task
    # id present in `deletions` is excluded from the output even if another export
    # carries it as live". Nothing applied it: tasks/rewards/tags were the plain
    # id-union of every input, so a task deleted on the newer device came back on
    # import and stayed back until a Dropbox sync happened to run the overlay.
    # Mirror sync.js mergeCollection's rule exactly (sync.js ~1104-1122): remove an
    # id iff the tombstone's `at` is >= the surviving row's own raw edit time, so
    # an edit or re-create made AFTER the delete still resurrects it. Raw on both
    # operands -- never clamp either, per the K1 polarity note in sync.js.
    if del_by:
        for (col, key, tsf) in ROW_MERGED:
            if key is None or col not in out or not isinstance(out[col], list):
                continue
            kept = []
            for row in out[col]:
                rid = row.get(key) if isinstance(row, dict) else None
                tomb = del_by.get(rid)
                if tomb is not None:
                    row_ts = int(row.get("updatedAt") or row.get("createdAt") or 0)
                    if int(tomb["ts"]) >= row_ts:
                        conflicts.append(_conflict(col, rid, [
                            {"file": "(deletions)", "ts": int(tomb["ts"]), "value": tomb["value"]},
                            {"file": "(live row)", "ts": row_ts, "value": row},
                        ], "tombstone applied"))
                        continue
                kept.append(row)
            out[col] = kept

    # ---- events (union by id; disjoint epochs, but guard collisions) -------
    ev_by = {}
    for (fn, d) in inputs:
        for row in d.get("events", []) or []:
            if not isinstance(row, dict) or "id" not in row:
                continue
            k = row["id"]
            ts = int(row.get("ts") or 0)
            cur = ev_by.get(k)
            if cur is None:
                ev_by[k] = {"ts": ts, "value": row}
            else:
                if row != cur["value"]:
                    conflicts.append(_conflict("events", k, [cur, {"file": fn, "ts": ts, "value": row}], "kept newest ts"))
                if ts > cur["ts"]:
                    ev_by[k] = {"ts": ts, "value": row}
    out["events"] = sorted((v["value"] for v in ev_by.values()), key=lambda e: (e.get("ts", 0), e.get("id", 0)))

    # ---- prefs (union; newest export's value wins per key) ------------------
    # Determine per-export ordering by __savedAt for tie-break.
    ordered = sorted(inputs, key=lambda p: int(p[1].get(TS_KEY_FALLBACK, 0) or 0))
    pref_sources = {}  # key -> (file, savedAt, value)
    an_sources = {}    # an sub-key -> (file, savedAt, value)  (newest __savedAt wins)
    for (fn, d) in ordered:
        p = d.get("prefs")
        if not isinstance(p, dict):
            continue
        saved = int(d.get(TS_KEY_FALLBACK, 0) or 0)
        for kk, vv in p.items():
            if kk == "an":
                # Merge prefs.an field-by-field: scalar/string sub-keys take the
                # newest export's value, while `views`/`metrics` are keyed arrays
                # merged per-id (see merge_an_subarray) so a non-newest export's
                # views/metrics are not silently dropped wholesale.
                if not isinstance(vv, dict):
                    continue
                for ak, av in vv.items():
                    if ak in ("views", "metrics"):
                        # Handled by the keyed per-id merge below; skip the
                        # redundant whole-array "newest export wins" conflict.
                        continue
                    cur = an_sources.get(ak)
                    if cur is None or saved > cur[1]:
                        if cur is not None and cur[2] != av:
                            conflicts.append(_conflict("prefs.an", ak, [{"file": cur[0], "ts": cur[1], "value": cur[2]}, {"file": fn, "ts": saved, "value": av}], "newest export wins"))
                        an_sources[ak] = (fn, saved, av)
                continue
            cur = pref_sources.get(kk)
            if cur is None or saved > cur[1]:
                if cur is not None and cur[2] != vv:
                    conflicts.append(_conflict("prefs", kk, [{"file": cur[0], "ts": cur[1], "value": cur[2]}, {"file": fn, "ts": saved, "value": vv}], "newest export wins"))
                pref_sources[kk] = (fn, saved, vv)
    out_prefs = {kk: vv[2] for kk, vv in pref_sources.items()}
    # Build prefs.an with keyed-merged views/metrics, plus the newest-wins scalars.
    an_merged = {ak: av[2] for ak, av in an_sources.items()}
    an_merged["views"] = merge_an_subarray(inputs, "views", conflicts)
    an_merged["metrics"] = merge_an_subarray(inputs, "metrics", conflicts)
    out_prefs["an"] = an_merged
    out["prefs"] = out_prefs

    # ---- habiticaHistory (keep if present in any) --------------------------
    for (fn, d) in inputs:
        if isinstance(d.get("habiticaHistory"), dict):
            out["habiticaHistory"] = d["habiticaHistory"]
            break

    # ---- monthlyBackups (union of strings) ---------------------------------
    mb = {}
    for (fn, d) in inputs:
        for s in d.get("monthlyBackups", []) or []:
            if isinstance(s, str):
                mb[s] = True
    out["monthlyBackups"] = list(mb.keys())

    # ---- traceability -------------------------------------------------------
    now = int(datetime.now(timezone.utc).timestamp() * 1000)
    out["_joinedFrom"] = [fn for (fn, _) in inputs]
    out["_joinedAt"] = now
    out["_joinConflicts"] = conflicts
    return out, conflicts


def main(argv):
    if len(argv) < 3:
        sys.stderr.write("usage: join_exports.py OUT.json A.json [B.json ...]\n")
        return 2
    out_path = argv[1]
    in_paths = argv[2:]
    inputs = []
    for p in in_paths:
        if not os.path.exists(p):
            sys.stderr.write("MISSING: %s\n" % p)
            return 2
        inputs.append((os.path.basename(p), _load(p)))

    merged, conflicts = merge_exports(inputs)

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(merged, f, ensure_ascii=False, indent=1)

    # ---- summary -----------------------------------------------------------
    print("Joined %d exports -> %s" % (len(inputs), out_path))
    print("  tasks        : %d" % len(merged.get("tasks", [])))
    print("  lastCron     : %s" % merged.get("lastCron", "(none)"))
    daily_done = sum(1 for t in merged.get("tasks", []) if t.get("type") == "daily" and t.get("done"))
    print("  dailies done : %d (after normalizeDailyResets overlay)" % daily_done)
    print("  events       : %d" % len(merged.get("events", [])))
    print("  rewards      : %d" % len(merged.get("rewards", [])))
    print("  devices      : %d" % len(merged.get("devices", [])))
    print("  deletions    : %d" % len(merged.get("deletions", [])))
    print("  charHistory  : %d" % len(merged.get("charHistory", [])))
    print("  prefs keys   : %d" % len(merged.get("prefs", {})))
    print("  habiticaHist : %s" % ("yes" if "habiticaHistory" in merged else "no"))
    print("  conflicts    : %d" % len(conflicts))
    for c in conflicts[:20]:
        print("    CONFLICT %s/%s resolved: %s" % (c["collection"], c["id"], c["resolution"]))
    if len(conflicts) > 20:
        print("    ... and %d more" % (len(conflicts) - 20))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
