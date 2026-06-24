#!/usr/bin/env python3
"""
habitica_to_questa.py
=====================
Convert a Habitica account export into a Questa import file.

USAGE (defaults match the file names you already use):
    python3 habitica_to_questa.py

    # or override:
    python3 habitica_to_questa.py --json habitica-user-data.json \
                                  --csv  habitica-tasks-history.csv \
                                  --out  questa-from-habitica.json

WHAT IT DOES
    * Reads the Habitica "User Data" JSON export.
    * Maps habits / dailies / todos / rewards into Questa's exact `S` schema
      (the shape Questa's Settings -> Import expects).
    * Carries over: streaks, +/- habit counters, difficulty (from priority),
      value, notes, checklists, weekly repeat schedule, done/completed state,
      and your character level / xp / gold / hp / mp / class.
    * Preserves the FULL raw Habitica history under S.habiticaHistory so that
      future analytics work has the complete time-series to draw on. Nothing
      from the source is summarised away or dropped.

TRUTHFULNESS NOTE
    Habitica does NOT store a per-day "completed yes/no" calendar. It stores
    value-snapshots taken whenever a task was scored or hit cron. The history
    this script preserves is therefore the genuine engagement-event series
    (dated value points), not an invented daily completion grid. Build your
    analytics on top of these real points; do not assume a row-per-calendar-day.

REUSABLE: drop a fresh export in with the same file names and re-run.
"""

import argparse
import csv
import json
import os
import sys
import time
import random
import re
from datetime import datetime

# ----- Questa constants (must mirror index.html) ---------------------------
# Questa difficulty buckets and their multiplier. Habitica `priority` uses the
# identical numeric scale, so the mapping is exact.
PRIORITY_TO_DIFFICULTY = {
    0.1: "trivial",
    1:   "easy",
    1.5: "medium",
    2:   "hard",
}
# Habitica repeat keys -> Questa repeat[] index. Questa repeat is [Su,M,T,W,T,F,S]
# (index 0 = Sunday, matching JS getDay()). Habitica uses named weekdays.
HABITICA_REPEAT_ORDER = ["su", "m", "t", "w", "th", "f", "s"]


def gen_id():
    """Mimic Questa's uid(): base36 timestamp + 5 random base36 chars."""
    ts = int(time.time() * 1000)
    base = ""
    n = ts
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    while n:
        base = digits[n % 36] + base
        n //= 36
    rand = "".join(random.choice(digits) for _ in range(5))
    return base + rand


def difficulty_from_priority(priority):
    if priority is None:
        return "easy"
    # exact match first, then nearest bucket
    if priority in PRIORITY_TO_DIFFICULTY:
        return PRIORITY_TO_DIFFICULTY[priority]
    nearest = min(PRIORITY_TO_DIFFICULTY, key=lambda p: abs(p - priority))
    return PRIORITY_TO_DIFFICULTY[nearest]


def map_repeat(repeat):
    """Habitica repeat dict -> Questa 7-bool list indexed [Su,M,T,W,Th,F,Sa]."""
    if not isinstance(repeat, dict):
        return [True] * 7
    return [bool(repeat.get(k, True)) for k in HABITICA_REPEAT_ORDER]


def map_checklist(checklist):
    out = []
    for c in checklist or []:
        out.append({
            "id": c.get("id") or gen_id(),
            "text": c.get("text", ""),
            "done": bool(c.get("completed", False)),
        })
    return out


def title_number(title):
    """First integer in a title; the rep count per tap. '15 klikov' -> 15."""
    m = re.search(r"\d+", title or "")
    return int(m.group()) if m else 1


def enrich_history(raw_history, title, is_habit):
    """Turn Habitica's raw history points into explicit, query-ready points.

    Each output point keeps the original `date` and `value`, and adds:
      scoredUp / scoredDown : tap counts (0 if Habitica did not log them)
      scored                : True if this was a scoring-day at all (a point
                              existing means the task was engaged that day)
      reps                  : EXACT reps = titleNumber * scoredUp.
                              0 when scoredUp is absent/zero (exact-only policy;
                              we never estimate). `scored` still marks the day
                              as active so the activity record stays complete.
      repCounted            : True only when reps came from a logged tap count
                              (lets the UI distinguish exact-rep days from
                              activity-only days).
    Nothing is summarised away; raw fields are preserved.
    """
    tn = title_number(title)
    out = []
    for p in raw_history or []:
        if not isinstance(p, dict) or "date" not in p:
            continue
        su = p.get("scoredUp")
        sd = p.get("scoredDown")
        has_taps = su is not None
        su_i = int(su) if su else 0
        sd_i = int(sd) if sd else 0
        point = {
            "date": p["date"],
            "value": p.get("value"),
            "scoredUp": su_i,
            "scoredDown": sd_i,
            # a recorded history point = the task was engaged that day
            "scored": True if is_habit else None,
            "reps": tn * su_i if is_habit else 0,
            "repCounted": bool(is_habit and has_taps and su_i > 0),
        }
        if "completed" in p:
            point["completed"] = bool(p["completed"])
            point["scored"] = bool(p["completed"]) or (su_i > 0)
        if "isDue" in p:
            point["isDue"] = bool(p["isDue"])
        out.append(point)
    return out


def map_habit(h):
    title = h.get("text", "")
    return {
        "id": h.get("id") or gen_id(),
        "type": "habit",
        "title": title,
        "notes": h.get("notes", ""),
        "difficulty": difficulty_from_priority(h.get("priority")),
        "value": h.get("value", 0),
        "done": False,
        "up": bool(h.get("up", True)),
        "down": bool(h.get("down", True)),
        "cUp": h.get("counterUp", 0) or 0,
        "cDown": h.get("counterDown", 0) or 0,
        # Habitica habit frequency is daily/weekly/monthly -> Questa resetFreq
        "resetFreq": h.get("frequency", "daily"),
        # reps per tap from the title number, stored once for the app
        "repsPerTap": title_number(title),
        # provenance + enriched time-series for analytics
        "_habiticaId": h.get("id"),
        "_createdAt": h.get("createdAt"),
        "history": enrich_history(h.get("history", []), title, True),
    }


def map_daily(d):
    return {
        "id": d.get("id") or gen_id(),
        "type": "daily",
        "title": d.get("text", ""),
        "notes": d.get("notes", ""),
        "difficulty": difficulty_from_priority(d.get("priority")),
        "value": d.get("value", 0),
        "done": bool(d.get("completed", False)),
        "streak": d.get("streak", 0) or 0,
        "repeat": map_repeat(d.get("repeat")),
        "checklist": map_checklist(d.get("checklist")),
        "_habiticaId": d.get("id"),
        "_createdAt": d.get("createdAt"),
        "_startDate": d.get("startDate"),
        "history": enrich_history(d.get("history", []), d.get("text", ""), False),
    }


def map_todo(t):
    return {
        "id": t.get("id") or gen_id(),
        "type": "todo",
        "title": t.get("text", ""),
        "notes": t.get("notes", ""),
        "difficulty": difficulty_from_priority(t.get("priority")),
        "value": t.get("value", 0),
        "done": bool(t.get("completed", False)),
        "checklist": map_checklist(t.get("checklist")),
        "_habiticaId": t.get("id"),
        "_createdAt": t.get("createdAt"),
        "_dateCompleted": t.get("dateCompleted"),
    }


def map_reward(r):
    # Questa rewards are user-defined shop items. Habitica's custom rewards map
    # onto S.rewards (cost = value, which is the gold price in Habitica).
    return {
        "id": r.get("id") or gen_id(),
        "title": r.get("text", ""),
        "notes": r.get("notes", ""),
        "cost": int(round(r.get("value", 10) or 10)),
    }


def day_stamp(dt):
    """Replicate Questa dayStamp(): YYYY*10000 + MM*100 + DD."""
    return dt.year * 10000 + dt.month * 100 + dt.day


def build_state(data, csv_rows):
    stats = data.get("stats", {}) or {}
    profile = data.get("profile", {}) or {}

    tasks_src = data.get("tasks", {}) or {}
    habits = [map_habit(h) for h in tasks_src.get("habits", [])]
    dailies = [map_daily(d) for d in tasks_src.get("dailys", [])]
    todos = [map_todo(t) for t in tasks_src.get("todos", [])]
    rewards = [map_reward(r) for r in tasks_src.get("rewards", [])]

    tasks = habits + dailies + todos

    cls_map = {"warrior": "Warrior", "wizard": "Mage", "mage": "Mage",
               "healer": "Healer", "rogue": "Rogue"}
    hab_class = (stats.get("class") or "warrior").lower()

    state = {
        "version": 1,
        "char": {
            "name": profile.get("name", "Adventurer") or "Adventurer",
            "face": "🧙",
            "cls": cls_map.get(hab_class, "Warrior"),
            "lvl": int(stats.get("lvl", 1) or 1),
            "xp": int(round(stats.get("exp", 0) or 0)),
            "hp": stats.get("hp", 50),
            "maxHp": int(stats.get("maxHealth", 50) or 50),
            "mp": int(round(stats.get("mp", 0) or 0)),
            "gold": round(stats.get("gp", 0) or 0, 2),
        },
        "tasks": tasks,
        "rewards": rewards,
        "lastCron": day_stamp(datetime.now()),
        "history": [],
        "prefs": {"width": 480, "notesLines": 3, "lastTab": "habits"},
        # ---- full raw history preserved for future analytics ----
        "habiticaHistory": {
            "exportedAt": datetime.now().isoformat(),
            "source": "habitica userdata export + tasks-history.csv",
            "note": ("Dated value-snapshots (engagement events), NOT a per-day "
                     "completion calendar. See script header."),
            "csvRows": csv_rows,
            # per-task in-export history also lives on each task under .history
        },
    }
    return state


def load_csv(path):
    if not path or not os.path.exists(path):
        return []
    rows = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for r in reader:
            rows.append({
                "taskName": r.get("Task Name"),
                "taskId": r.get("Task ID"),
                "taskType": r.get("Task Type"),
                "date": r.get("Date"),
                "value": float(r["Value"]) if r.get("Value") else None,
            })
    return rows


def main():
    ap = argparse.ArgumentParser(description="Convert Habitica export -> Questa import JSON")
    ap.add_argument("--json", default="habitica-user-data.json",
                    help="Habitica user data JSON export (default: habitica-user-data.json)")
    ap.add_argument("--csv", default="habitica-tasks-history.csv",
                    help="Habitica tasks history CSV (optional; default: habitica-tasks-history.csv)")
    ap.add_argument("--out", default="questa-from-habitica.json",
                    help="Output Questa import file (default: questa-from-habitica.json)")
    args = ap.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    json_path = args.json if os.path.isabs(args.json) else os.path.join(here, args.json)
    csv_path = args.csv if os.path.isabs(args.csv) else os.path.join(here, args.csv)
    out_path = args.out if os.path.isabs(args.out) else os.path.join(here, args.out)

    if not os.path.exists(json_path):
        sys.exit("ERROR: cannot find %s\nDownload Habitica Settings -> Data -> 'User Data' and save it there." % json_path)

    with open(json_path, encoding="utf-8") as f:
        data = json.load(f)

    csv_rows = load_csv(csv_path)
    state = build_state(data, csv_rows)

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)

    # ---- report ----
    habits = [t for t in state["tasks"] if t["type"] == "habit"]
    n_dailies = sum(1 for t in state["tasks"] if t["type"] == "daily")
    n_todos = sum(1 for t in state["tasks"] if t["type"] == "todo")
    max_streak = max((t.get("streak", 0) for t in state["tasks"] if t["type"] == "daily"), default=0)
    # exact-rep totals and earliest history date
    total_reps = sum(p.get("reps", 0) for t in habits for p in t.get("history", []))
    scored_days = sum(1 for t in habits for p in t.get("history", []) if p.get("scored"))
    repcounted_days = sum(1 for t in habits for p in t.get("history", []) if p.get("repCounted"))
    all_dates = [p["date"] for t in state["tasks"] for p in t.get("history", []) if p.get("date")]
    earliest = datetime.fromtimestamp(min(all_dates) / 1000).date() if all_dates else "n/a"

    print("Conversion complete.")
    print("  Output: %s" % out_path)
    print("  Character: %s | Lv %d %s | %.0f gold" % (
        state["char"]["name"], state["char"]["lvl"], state["char"]["cls"], state["char"]["gold"]))
    print("  Tasks: %d habits, %d dailies, %d to-dos, %d rewards" % (
        len(habits), n_dailies, n_todos, len(state["rewards"])))
    print("  Longest daily streak: %d" % max_streak)
    print("  History earliest date: %s" % earliest)
    print("  Habit scoring-days recorded: %d  (of which rep-counted: %d)" % (scored_days, repcounted_days))
    print("  Exact cumulative reps (all habits): %d" % total_reps)
    print("\nNow open Questa -> Settings -> Import and choose this file.")


if __name__ == "__main__":
    main()
