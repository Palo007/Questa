#!/usr/bin/env python3
"""splice_events_jul28.py -- add the reconstructed 2026-07-28 events into a
schema-2 Questa backup, in tokenized form, without touching the state snapshot.

Why this exists
---------------
`questa-backup-20260729-1023.json` is a schema-2 export: its event log lives
tokenized under top-level `E`, with dictionary arrays `K` (kind), `SRC`
(source), `TID` (taskId) and `TT` (taskTitle). The 20 reconstructed events in
`tools/out/reconstructed_events_jul28.json` are plain objects. They cannot just
be appended -- they must be tokenized against the SAME dictionaries.

This script touches ONLY `E` / `K` / `SRC` / `TID` / `TT`. The snapshot (`S`)
and its field map (`FM`) are copied through byte-identically, because the
2026-07-28 loss was event-log-only: state sync worked that day, which is
precisely why reconstruction from `doneAt` / `history[]` was possible at all
(see tools/reconstruct_events_jul28.md, "Why this exists").

Reference implementations mirrored here (read from app.js, not modified):
  _EXPORT_FIELD_MAP   app.js:5542
  _tokenizeEvents()   app.js:5554
  _detokenizeEvents() app.js:5578
  eventMergeSig()     app.js:1083

Usage
-----
    python tools/splice_events_jul28.py \
        --backup questa-backup-20260729-1023.json \
        --events tools/out/reconstructed_events_jul28.json \
        --output questa-backup-20260729-1023-merged.json

All three flags default to the paths above. Add --mode rebuild to re-tokenize
the whole log from scratch (ts-sorted, fresh dictionaries) instead of the
default minimal append.

The script verifies itself and exits non-zero rather than write a bad file.
Every existing event must round-trip byte-identically through the merged
dictionaries; if even one does not, nothing is written.
"""

import argparse
import json
import sys

# --- app.js:5542 _EXPORT_FIELD_MAP (verbatim) --------------------------------
EXPORT_FIELD_MAP = {
    "ts": "t", "uid": "u", "dev": "d", "kind": "k", "taskTitle": "n",
    "notes": "no", "id": "i", "taskType": "ty", "taskId": "ti",
    "streak": "st", "reward": "rw", "repeat": "rp", "checklist": "cl",
    "changes": "ch", "subId": "si", "subText": "sx", "done": "do",
    "clawback": "cb", "deviceId": "di", "deviceName": "dn",
    "prevDeviceName": "pn", "createdAt": "ca", "completedAt": "co",
    "dir": "dr", "reps": "rs", "value": "v", "dmg": "dg", "cost": "ct",
    "effect": "ef", "counter": "cr", "preBumpSeq": "ps", "storedSeq": "ss",
    "granted": "gr", "log": "lg", "detail": "dt", "visibilityState": "vs",
    "hidden": "hd", "dirty": "dy", "found": "fd", "idbSeq": "is",
    "liveSeq": "ls", "winner": "wn", "loser": "lo", "charTitle": "ctt",
    "day": "dyy", "late": "lt", "source": "o", "synthetic": "sy",
    "repCounted": "rc", "inferred": "in",
}
REVERSE_FIELD_MAP = {v: k for k, v in EXPORT_FIELD_MAP.items()}

PASSTHROUGH = ("uid", "dev", "id")          # app.js:5563 / :5586
BOOL_CODES = ("sy", "rc", "in", "do")       # app.js:5592
DICT_FIELDS = {"kind": "K", "source": "SRC", "taskId": "TID", "taskTitle": "TT"}


def die(msg):
    print("ABORT: " + msg, file=sys.stderr)
    sys.exit(1)


# --- app.js:5578 _detokenizeEvents ------------------------------------------
def detokenize_events(env):
    E = env.get("E")
    if not isinstance(E, list):
        return []
    K = env.get("K") or []
    SRC = env.get("SRC") or []
    TID = env.get("TID") or []
    TT = env.get("TT") or []

    def lookup(arr, i):
        # JS `arr[v]` yields undefined for -1 / out-of-range; undefined keys are
        # dropped by JSON.stringify, so None is the faithful equivalent.
        if not isinstance(i, int) or i < 0 or i >= len(arr):
            return None
        return arr[i]

    out = []
    for o in E:
        e = {}
        for sk, v in o.items():
            if sk in PASSTHROUGH:
                e[sk] = v
                continue
            f = REVERSE_FIELD_MAP.get(sk, sk)
            if sk == "k":
                e["kind"] = lookup(K, v)
            elif sk == "o":
                e["source"] = lookup(SRC, v)
            elif sk == "ti":
                e["taskId"] = lookup(TID, v)
            elif sk == "n":
                e["taskTitle"] = lookup(TT, v)
            elif sk in BOOL_CODES:
                e[f] = bool(v)
            else:
                e[f] = v
        out.append(e)
    return out


# --- app.js:5554 _tokenizeEvents, but against PRE-EXISTING dictionaries -----
class Dicts:
    """Append-only index arrays, seeded from the backup's existing ones."""

    def __init__(self, env):
        self.arrays = {name: list(env.get(name) or []) for name in
                       ("K", "SRC", "TID", "TT")}
        self.index = {name: {v: i for i, v in enumerate(arr)}
                      for name, arr in self.arrays.items()}
        self.added = {name: 0 for name in self.arrays}

    def idx(self, name, v):
        # app.js:5558 -- `if(v==null) return -1;`
        if v is None:
            return -1
        arr, idx = self.arrays[name], self.index[name]
        if v not in idx:
            idx[v] = len(arr)
            arr.append(v)
            self.added[name] += 1
        return idx[v]


def tokenize_event(e, dicts):
    o = {}
    for f, v in e.items():
        if f in PASSTHROUGH:
            o[f] = v
            continue
        sk = EXPORT_FIELD_MAP.get(f)
        if not sk:
            o[f] = v                      # app.js:5565 unknown field passthrough
            continue
        if f in DICT_FIELDS:
            o[sk] = dicts.idx(DICT_FIELDS[f], v)
        elif f in ("synthetic", "repCounted", "inferred", "done"):
            o[sk] = 1 if v else 0         # app.js:5570
        else:
            o[sk] = v
    return o


# --- app.js:1083 eventMergeSig ----------------------------------------------
def merge_sig(r):
    return "|".join([
        str(r.get("ts")),
        str(r.get("kind")),
        str(r.get("taskId") or ""),
        str(r.get("dir") or 0),
        str(r.get("reps") or 0),
    ])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backup", default="questa-backup-20260729-1023.json")
    ap.add_argument("--events", default="tools/out/reconstructed_events_jul28.json")
    ap.add_argument("--output", default="questa-backup-20260729-1023-merged.json")
    ap.add_argument("--mode", choices=("append", "rebuild"), default="append",
                    help="append: extend dictionaries, append new events (minimal "
                         "diff, default). rebuild: re-tokenize the whole ts-sorted "
                         "log with fresh dictionaries.")
    ap.add_argument("--kinds", default="complete",
                    help="Comma-separated event kinds to splice. Default "
                         "'complete' restores ONLY the 14 daily completions and "
                         "excludes the 6 habitTap records, whose source "
                         "history[] entries already survived in the snapshot. "
                         "Use 'complete,habitTap' to restore all 20.")
    ap.add_argument("--keep-synthetic", action="store_true",
                    help="Keep synthetic:true on the spliced events. NOT "
                         "recommended: !e.synthetic is an UNCONDITIONAL term in "
                         "evtUploadable()/evtOwnMonthRecords() (sync.js:1640,1649), "
                         "so these events could then never be force-pushed.")
    args = ap.parse_args()

    try:
        with open(args.backup, encoding="utf-8") as fh:
            env = json.load(fh)
    except Exception as exc:
        die("cannot read backup %r: %s" % (args.backup, exc))

    try:
        with open(args.events, encoding="utf-8") as fh:
            newblob = json.load(fh)
    except Exception as exc:
        die("cannot read events %r: %s" % (args.events, exc))

    # ---- gate: must be a tokenized schema-2 export --------------------------
    bk = env.get("_backup") or {}
    if bk.get("schema") != 2:
        die("backup is not schema 2 (_backup.schema=%r). This script only "
            "handles the tokenized export format." % bk.get("schema"))
    if not isinstance(env.get("E"), list):
        die("backup has no tokenized event array `E`.")
    if not isinstance(env.get("S"), dict) or not isinstance(env.get("FM"), dict):
        die("backup is missing `S`/`FM`; refusing to touch a file whose "
            "snapshot cannot be verified as intact.")

    incoming = newblob.get("events") if isinstance(newblob, dict) else newblob
    if not isinstance(incoming, list):
        die("events file has no `events` array.")

    # ---- baseline ----------------------------------------------------------
    before = detokenize_events(env)
    before_json = [json.dumps(e, sort_keys=True, ensure_ascii=False) for e in before]
    existing_sigs = {merge_sig(e) for e in before}
    print("backup:  %d events, %d tasks" % (len(before), len(env["S"].get(env["FM"].get("tasks", "tasks"), []) or [])))
    print("events:  %d incoming" % len(incoming))

    kinds = {}
    for e in incoming:
        kinds[e.get("kind")] = kinds.get(e.get("kind"), 0) + 1
    print("kinds:   " + ", ".join("%s=%d" % kv for kv in sorted(kinds.items())))
    if kinds != {"complete": 14, "habitTap": 6}:
        print("WARNING: expected {'complete': 14, 'habitTap': 6} per "
              "tools/reconstruct_events_jul28.md:90 -- got %r" % kinds,
              file=sys.stderr)

    # ---- kind filter -------------------------------------------------------
    want_kinds = {k.strip() for k in args.kinds.split(",") if k.strip()}
    unknown = {e.get("kind") for e in incoming} - want_kinds
    incoming = [e for e in incoming if e.get("kind") in want_kinds]
    print("kinds:   splicing %s" % ", ".join(sorted(want_kinds)))
    if unknown:
        print("EXCLUDED by --kinds: %s" % ", ".join(sorted(str(k) for k in unknown)))
        print("   Their source history[] entries remain in the snapshot, so the")
        print("   habit charts/counters are unaffected -- but the EVENT LOG will")
        print("   stay permanently short of those real taps. Pass")
        print("   --kinds complete,habitTap if you want them after all.")
    if not incoming:
        die("--kinds %r excluded every incoming event." % args.kinds)

    # ---- prepare the spliced records ---------------------------------------
    prepared, dupes = [], []
    for e in sorted(incoming, key=lambda r: r.get("ts") or 0):
        if not isinstance(e, dict) or not isinstance(e.get("ts"), int):
            die("incoming record lacks an integer ts: %r" % (e,))
        r = dict(e)
        if not args.keep_synthetic:
            # Strip `synthetic` and record provenance as `inferred` instead.
            # `!e.synthetic` is unconditional in both upload gates, so leaving
            # it set would make these events permanently unpushable; `inferred`
            # is a first-class field that no sync gate filters on.
            r.pop("synthetic", None)
            r["inferred"] = True
        sig = merge_sig(r)
        if sig in existing_sigs:
            dupes.append(sig)
            continue
        existing_sigs.add(sig)
        prepared.append(r)

    if dupes:
        print("skipped %d already present (signature match):" % len(dupes))
        for s in dupes:
            print("   " + s)
    if not prepared:
        die("nothing to add -- all %d incoming events are already in the "
            "backup. The file is already up to date." % len(incoming))

    # ---- splice ------------------------------------------------------------
    if args.mode == "rebuild":
        merged = sorted(before + prepared, key=lambda r: r.get("ts") or 0)
        blank = {"E": [], "K": [], "SRC": [], "TID": [], "TT": []}
        dicts = Dicts(blank)
        newE = [tokenize_event(e, dicts) for e in merged]
    else:
        dicts = Dicts(env)
        newE = list(env["E"]) + [tokenize_event(e, dicts) for e in prepared]
        merged = before + prepared

    out = dict(env)                      # S / FM / _backup carried through as-is
    out["E"] = newE
    out["K"] = dicts.arrays["K"]
    out["SRC"] = dicts.arrays["SRC"]
    out["TID"] = dicts.arrays["TID"]
    out["TT"] = dicts.arrays["TT"]

    # ---- VERIFY: the merged file must detokenize back to exactly `merged` ---
    check = detokenize_events(out)
    if len(check) != len(merged):
        die("round-trip count mismatch: %d != %d" % (len(check), len(merged)))

    check_json = [json.dumps(e, sort_keys=True, ensure_ascii=False) for e in check]
    want_json = [json.dumps(e, sort_keys=True, ensure_ascii=False) for e in merged]
    for i, (got, want) in enumerate(zip(check_json, want_json)):
        if got != want:
            die("round-trip mismatch at index %d\n  got:  %s\n  want: %s"
                % (i, got, want))

    if args.mode == "append":
        # Every pre-existing event must be untouched, in its original position.
        if check_json[:len(before_json)] != before_json:
            die("append mode altered a pre-existing event -- refusing to write.")

    sigs = [merge_sig(e) for e in check]
    if len(set(sigs)) != len(sigs):
        dup = [s for s in set(sigs) if sigs.count(s) > 1]
        die("duplicate event signatures after merge: %r" % dup[:5])

    if out["S"] is not env["S"] and out["S"] != env["S"]:
        die("snapshot changed -- refusing to write.")
    if out["FM"] != env["FM"]:
        die("snapshot field map changed -- refusing to write.")

    # ---- write -------------------------------------------------------------
    out["_splicedFrom"] = args.events
    out["_splicedCount"] = len(prepared)
    try:
        with open(args.output, "w", encoding="utf-8") as fh:
            json.dump(out, fh, ensure_ascii=False, indent=2)
    except Exception as exc:
        die("cannot write %r: %s" % (args.output, exc))

    # Re-read from disk and re-verify: never trust a write.
    try:
        with open(args.output, encoding="utf-8") as fh:
            back = json.load(fh)
    except Exception as exc:
        die("wrote %r but cannot read it back: %s" % (args.output, exc))
    if len(detokenize_events(back)) != len(merged):
        die("file on disk does not round-trip -- write was truncated or corrupt.")

    print()
    print("OK  wrote %s" % args.output)
    print("    events %d -> %d  (+%d spliced)"
          % (len(before), len(merged), len(prepared)))
    print("    dictionary growth: " + ", ".join(
        "%s +%d" % (n, dicts.added[n]) for n in ("K", "SRC", "TID", "TT")))
    print("    snapshot S / FM: unchanged, verified")
    print("    every pre-existing event round-trips byte-identically")
    print()
    print("Spliced records:")
    for e in prepared:
        print("    %s  %-9s %s" % (e["ts"], e.get("kind"), e.get("taskTitle")))
    print()
    print("NEXT STEPS -- read before importing:")
    print("  1. Fresh reset, then Settings -> Import this file.")
    print("     Do NOT use the diagnostic 'Load reconstructed events' button:")
    print("     it re-stamps synthetic=true (app.js:1426) and !e.synthetic is")
    print("     unconditional in both upload gates, so those records could")
    print("     never be pushed.")
    print("  2. Connect Dropbox.")
    print("  3. Diagnostic overlay -> 'Republish Imported Events'. REQUIRED:")
    print("     Settings->Import sets imported=true on every record")
    print("     (app.js:1158) and evtOwnMonthRecords() -- the force-push set --")
    print("     filters on (!e.imported || e.republish) (sync.js:1649). Without")
    print("     this step a force push uploads ZERO events.")
    print("  4. Force push, then verify the Dropbox month files are non-empty.")


if __name__ == "__main__":
    main()
