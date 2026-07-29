#!/usr/bin/env python3
"""reconstruct_events_jul28.py — rebuild the 2026-07-28 event-log gap from the
surviving state snapshot.

Background (see tools/reconstruct_events_jul28.md for the full writeup): on
2026-07-28 the device's IndexedDB event log lost 14 daily completions and 6
habit taps. The originals were searched across every Dropbox month file, the
phone's live IDB dump, the backup, and Dropbox version history -- they do not
exist anywhere. Recovery is impossible; this script reconstructs faithful
replacement events from the *state* snapshot instead, which survived intact
(state sync worked even though event sync did not). `doneAt` on dailies and
`history[]` on habits are complete and internally consistent, so this is a
reconstruction, not a guess.

Two separate tokenization schemes are involved and must not be conflated:

  - Events (top-level `E`) use dictionaries `K`/`SRC`/`TID`/`TT` and
    abbreviated field keys (`t`->ts, `k`->kind, `ti`->taskId index, ...).
    This script does not touch `E` at all -- the lost events never made it
    into that log to begin with.
  - The state snapshot (top-level `S`) uses a single per-export field map at
    top-level `FM` (long-name -> short-code), applied recursively. This is
    what `_detokenizeSnapshot()` (app.js:5293) reverses, and what this script
    reverses too (see `detokenize_snapshot` below).

What gets emitted:
  1. Exactly 14 `complete` events -- one per daily task whose `doneAt` lands
     on 2026-07-28 (UTC). A daily's `history[]` is NOT used for this: on
     dailies that array is a cron/due-state rollover log, not a completion
     log (only `doneAt` records an actual completion).
  2. Exactly 6 `habitTap` events -- one per habit `history[]` entry dated
     2026-07-28 with `scored:true`. Entries with `scored:false` are passive
     day-rollover records (no `scoredUp`/`scoredDown`) and are excluded.
  3. Every emitted event is `synthetic:true` with `uid` left UNSET. The
     in-app loader's `reparentEventsForImport()` (app.js:808-823) assigns a
     deterministic `rep-`+FNV-1a uid via `eventUidOf()` (app.js:771-800) on
     import, which is idempotent across re-imports and lives in a uid
     namespace (`rep-*`) disjoint from live device taps
     (`syncEventUid()` = `<deviceId>-<base36 ts>-<base36 random>`,
     sync.js:66-68), so collision with a real tap is structurally impossible.
     Because that hash is only 32 bits, this script replicates it locally
     (see `event_uid_of` below) and asserts the 20 outputs would hash unique
     before writing anything.

Nothing here is guessed: every id/title is looked up in the detokenized
snapshot. The two anchor ids below are asserted, never used to derive data:
  28c5f43b-bfa8-481f-8b6e-06d6bef397fc == "20 klikov" (type:"habit")
  c9cfe1b2-d3be-432d-a6cd-c1b1143712f1 == "15 klikov" (type:"habit")

CLI:
  python tools/reconstruct_events_jul28.py [--input BACKUP.json] [--output OUT.json]
"""

import argparse
import json
import os
import sys
from datetime import date, datetime, timezone

DEFAULT_INPUT = "questa-backup-20260729-1023.json"
DEFAULT_OUTPUT = "tools/out/reconstructed_events_jul28.json"
TARGET_DATE = date(2026, 7, 28)

ANCHOR_IDS = {
    "28c5f43b-bfa8-481f-8b6e-06d6bef397fc": "20 klikov",
    "c9cfe1b2-d3be-432d-a6cd-c1b1143712f1": "15 klikov",
}


# --- schema-2 snapshot detokenization (mirrors app.js _detokenizeSnapshot) --
def _detok_deep(o, rmap):
    if isinstance(o, list):
        return [_detok_deep(x, rmap) for x in o]
    if isinstance(o, dict):
        return {rmap.get(k, k): _detok_deep(v, rmap) for k, v in o.items()}
    return o


def detokenize_snapshot(data):
    """Reverse the per-export field map (top-level FM) over top-level S.
    Mirrors app.js _detokenizeSnapshot() (app.js:5293) exactly: FM maps
    long-name -> short-code, so we reverse it into short->long and walk S
    recursively. Distinct from event detokenization (K/SRC/TID/TT + E),
    which this script never needs -- the lost events aren't in E."""
    fm = data.get("FM") or {}
    rmap = {v: k for k, v in fm.items()}
    return _detok_deep(data.get("S") or {}, rmap)


def load_backup(path):
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    meta = data.get("_backup") or {}
    if meta.get("schema") != 2:
        raise SystemExit(
            "expected a schema-2 tokenized backup (_backup.schema==2), got: %r"
            % meta.get("schema")
        )
    return data


def utc_date_of(ms):
    """UTC calendar date for an epoch-ms timestamp. The task's timestamps
    cluster near 12:40 and 20:17-20:19 UTC on 2026-07-28 (and clearly on
    other dates for the excluded rows) -- no midnight-boundary ambiguity
    under either UTC or UTC+2, so a single UTC-date comparison is unambiguous
    here (do not read this as a general TZ-handling pattern elsewhere)."""
    if not isinstance(ms, (int, float)) or not ms:
        return None
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).date()


# --- FNV-1a uid hash, mirrors app.js eventUidOf() (app.js:771-800) ----------
def event_uid_of(rec, idx):
    """Replicates eventUidOf's content hash over the same field list, in the
    same order, so we can assert our own synthetic events would hash to
    distinct 'rep-'+hex uids before ever writing them out. Not used to set
    `uid` on the output events (uid is left unset per spec) -- purely a
    pre-write collision assertion, run over the same field order as the
    real function: [ts, kind, taskId, taskTitle, dir, dev, uid, value, reps,
    source, subId, subText, notes, id, idx]."""
    ts = rec.get("ts") if isinstance(rec.get("ts"), (int, float)) else 0
    kind = rec.get("kind") or ""
    task_id = rec.get("taskId") or ""
    task_title = rec.get("taskTitle") or ""
    dir_ = rec.get("dir") or ""
    dev = rec.get("dev") or ""
    uid = rec.get("uid") or ""
    value = rec.get("value") if isinstance(rec.get("value"), (int, float)) else ""
    reps = rec.get("reps") if isinstance(rec.get("reps"), (int, float)) else ""
    src = rec.get("source") or ""
    sub_id = rec.get("subId") or ""
    sub_text = rec.get("subText") or ""
    notes = rec.get("notes") or ""
    orig_id = rec.get("id") or ""
    pos = idx if isinstance(idx, int) else -1
    parts = [ts, kind, task_id, task_title, dir_, dev, uid, value, reps,
              src, sub_id, sub_text, notes, orig_id, pos]
    s = "".join(str(p) for p in parts)
    h = 0x811C9DC5
    for ch in s:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF  # mirrors JS Math.imul truncation
    return "rep-" + format(h & 0xFFFFFFFF, "x")


def find_daily_completions(tasks):
    """14 `complete` events: dailies whose doneAt lands on TARGET_DATE.
    Deliberately ignores history[] -- on a daily that array is the
    cron/due-state rollover log, not a completion log; doneAt is the only
    field that records an actual completion timestamp."""
    out = []
    for t in tasks:
        if not isinstance(t, dict) or t.get("type") != "daily":
            continue
        done_at = t.get("doneAt")
        if not done_at or utc_date_of(done_at) != TARGET_DATE:
            continue
        out.append({
            "ts": int(done_at),
            "kind": "complete",
            "taskType": "daily",
            "taskId": t.get("id"),
            "taskTitle": t.get("title"),
            "synthetic": True,
        })
    return out


def find_habit_taps(tasks):
    """6 `habitTap` events: habit history[] entries dated TARGET_DATE with
    scored:true. scored:false entries are passive day-rollover records (no
    scoredUp/scoredDown) and MUST be excluded -- filtering on scored is
    mandatory, not an optimization."""
    out = []
    for t in tasks:
        if not isinstance(t, dict) or t.get("type") != "habit":
            continue
        for h in (t.get("history") or []):
            if not isinstance(h, dict):
                continue
            if utc_date_of(h.get("date")) != TARGET_DATE:
                continue
            if h.get("scored") is not True:
                continue
            if "scoredUp" in h:
                dir_ = 1
            elif "scoredDown" in h:
                dir_ = -1
            else:
                # scored:true always carries one of these in the app's own
                # scoring path; refuse to guess a direction if it doesn't.
                raise SystemExit(
                    "habit history entry scored:true but neither scoredUp "
                    "nor scoredDown present for task %r: %r" % (t.get("id"), h)
                )
            out.append({
                "ts": int(h["date"]),
                "kind": "habitTap",
                "taskId": t.get("id"),
                "taskTitle": t.get("title"),
                "dir": dir_,
                "reps": h.get("reps"),
                "value": h.get("value"),
                "synthetic": True,
            })
    return out


def build_events(snapshot):
    tasks = snapshot.get("tasks") or []
    by_id = {t["id"]: t for t in tasks if isinstance(t, dict) and t.get("id")}

    for anchor_id, expected_title in ANCHOR_IDS.items():
        t = by_id.get(anchor_id)
        if not t or t.get("type") != "habit" or t.get("title") != expected_title:
            raise SystemExit(
                "anchor assertion failed for %s: expected habit %r, got %r"
                % (anchor_id, expected_title, t)
            )

    completions = find_daily_completions(tasks)
    taps = find_habit_taps(tasks)

    if len(completions) != 14:
        raise SystemExit("expected 14 daily completions, found %d" % len(completions))
    if len(taps) != 6:
        raise SystemExit("expected 6 habit taps, found %d" % len(taps))

    events = sorted(completions + taps, key=lambda e: e["ts"])

    # Every taskId must resolve to a real task in the snapshot.
    for e in events:
        if e["taskId"] not in by_id:
            raise SystemExit("event references unknown taskId: %r" % e)

    # Pre-write uid-collision assertion: hash each event the way
    # reparentEventsForImport() will (idx = position in THIS list, since
    # that's the array it will be called on at import time).
    uids = [event_uid_of(e, i) for i, e in enumerate(events)]
    if len(set(uids)) != len(uids):
        dupes = [u for u in uids if uids.count(u) > 1]
        raise SystemExit("synthetic uid collision detected: %r" % dupes)

    return events


def print_summary(events):
    for e in events:
        iso = datetime.fromtimestamp(e["ts"] / 1000.0, tz=timezone.utc).isoformat()
        print("  %-10s %s  %s" % (e["kind"], iso, e["taskTitle"]))
    n_complete = sum(1 for e in events if e["kind"] == "complete")
    n_tap = sum(1 for e in events if e["kind"] == "habitTap")
    print("--")
    print("complete   : %d" % n_complete)
    print("habitTap   : %d" % n_tap)
    print("total      : %d" % len(events))


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--input", default=DEFAULT_INPUT,
                     help="schema-2 tokenized Questa backup JSON (default: %(default)s)")
    ap.add_argument("--output", default=DEFAULT_OUTPUT,
                     help="path to write {\"events\": [...]} to (default: %(default)s)")
    args = ap.parse_args(argv[1:])

    data = load_backup(args.input)
    snapshot = detokenize_snapshot(data)
    events = build_events(snapshot)

    out_dir = os.path.dirname(args.output)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump({"events": events}, f, ensure_ascii=False, indent=1)

    print("Reconstructed %d events -> %s" % (len(events), args.output))
    print_summary(events)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
