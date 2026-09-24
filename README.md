# ⚔️ Questa — Gamified Habit Tracker RPG

**Questa** is an offline-first habit and productivity tracker styled after
classic fantasy RPGs. Habits, daily quests and to-dos earn XP, gold and levels;
missed dailies cost health. It is a single static web page — no build step, no
account, no backend.

**[→ How to install and run it](./INSTALL.md)**

Quick version: serve the repository folder over http(s) and open it. Opening
`index.html` straight from your file system will *not* work — the service worker
needs a real origin.

```bash
python3 -m http.server 8080    # then open http://localhost:8080
```

---

## 🎮 RPG mechanics

- **Levels & stats**: start at level 1 and grow your level, health and mana.
  - ❤️ **HP** — failing a scheduled Daily deals damage. Buy potions in the Shop
    before a death wipes your gold and levels.
  - 💛 **XP** — earned from Habits, Dailies and To-Dos.
  - 🪙 **Gold** — earned for work done, spent in the built-in Shop on potions or
    on rewards you define yourself.
- **Customizable avatar** with real-time visual face updates.
- **Daily upkeep**: a morning resolution page summarising yesterday's missed
  dailies, checking off active streaks and applying health loss.

---

## 📊 Analytics and custom views

- **Bento-style dashboards** — responsive grids of visual metrics.
- **Sparklines & charts** — custom responsive SVG, no chart library.
- **Heatmaps** — activity intensity over 7d, 30d, 90d, 180d, 1y or all time.
- **Custom view creator** — filter by task, habit, daily or to-do; group by day,
  week, month, tag or type; render as list, bar, line or heatmap; clone, edit
  and delete.

---

## 📱 Mobile-first design

- Scroll-lock modal sheets that fit any screen and scroll independently.
- High-contrast tap targets, rounded segments and micro-animations.
- Drag-and-drop reordering built for touch.

---

## ☁️ Optional Dropbox sync

Questa can keep **two or more devices** in sync through your own Dropbox app
folder. It is **off by default** and entirely optional — the app is fully
functional without it, and without any account.

What it does:

- Syncs your character, tasks, settings and event history between devices.
- Merges field by field rather than last-write-wins, so two devices editing
  different things both keep their edits.
- Records conflict decisions in the Activity Feed so you can see what it chose.
- Can take automatic rolling backups into the same folder.

What it means for your data: with sync enabled, your data is stored in **your
Dropbox account**, in an app folder scoped to Questa alone. There is still no
Questa server, no analytics and no telemetry — but "no external server" stops
being true the moment you switch it on, and that is your call to make.

Read before enabling it:

- [docs/SYNC-USER-GUIDE.md](./docs/SYNC-USER-GUIDE.md) — what syncs, how merging
  works, force push/pull, troubleshooting.
- [docs/SYNC-MULTI-DEVICE-CASES.md](./docs/SYNC-MULTI-DEVICE-CASES.md) — the
  multi-device scenarios and how each resolves.
- [docs/BACKUP-USER-GUIDE.md](./docs/BACKUP-USER-GUIDE.md) — snapshots, exports
  and restoring.

**Running your own copy?** The Dropbox app key in this repository is registered
for the original deployment's address only, so login will fail on your fork
until you register your own Dropbox app. It takes about two minutes —
[instructions are in INSTALL.md](./INSTALL.md#self-hosting-and-dropbox-sync).

---

## ⚙️ Architecture and privacy

- **Client-side only.** No login, no tracking, no analytics, no Questa server.
  State lives in `localStorage`; the event history lives in IndexedDB.
- **Offline-first.** A service worker caches the app shell network-first, so
  updates land on the next launch and the app still opens with no connection.
- **Data portability.** Full JSON export and import, plus local snapshots.
- **The one exception** to "nothing leaves this device" is Dropbox sync, above.
  Leave it off and nothing ever does.

---

## 🛠️ Development

```bash
node tests/run.js
```

No framework, no dependencies. The suite is the deploy gate — never ship it red.
Design notes for the sync engine, backup format, event log and diagnostics
bundle are in [`docs/`](./docs/). Questa also ships as a sideloaded Android
app — see [`docs/ANDROID-APP.md`](./docs/ANDROID-APP.md) for the PWA side of
that contract.

---

## 📄 Licence

[MIT](./LICENSE). Fork it, change it, ship it.
