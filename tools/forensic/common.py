import json, sys
from datetime import datetime, timezone
from collections import Counter, defaultdict

def iso(ms):
    if ms is None:
        return None
    try:
        ms = float(ms)
    except Exception:
        return None
    return datetime.fromtimestamp(ms/1000.0, tz=timezone.utc).isoformat().replace("+00:00","Z")

def day_utc(ms):
    if ms is None:
        return None
    return datetime.fromtimestamp(float(ms)/1000.0, tz=timezone.utc).strftime("%Y-%m-%d")

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
}

def detok_events(env):
    e = env.get("E")
    if not isinstance(e, list):
        return []
    K = env.get("K", []) or []
    SRC = env.get("SRC", []) or []
    TID = env.get("TID", []) or []
    TT = env.get("TT", []) or []
    out = []
    for o in e:
        if not isinstance(o, dict):
            out.append(o)
            continue
        ev = {}
        for sk, v in o.items():
            if sk in ("u", "d", "i"):
                ev[SHORT.get(sk,sk)] = v
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

def detok_deep(o, rmap):
    if isinstance(o, list):
        return [detok_deep(x, rmap) for x in o]
    if isinstance(o, dict):
        return {rmap.get(k, k): detok_deep(v, rmap) for k, v in o.items()}
    return o

def load_schema2(path):
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    fm = data.get("FM", {}) or {}
    rmap = {v: k for k, v in fm.items()}
    snap = detok_deep(data.get("S", {}), rmap)
    events = detok_events(data)
    return data, snap, events
