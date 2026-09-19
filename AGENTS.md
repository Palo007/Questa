# Questa — agent rules

Rules for any coding agent working in this repo (Claude Code, opencode, Cursor,
Codex, …). Tool-agnostic: rules are stated as **outcomes to verify**, not as
"use tool X". Nothing here depends on which editor tool you have.

---

## 1. What this project is

Single-page PWA (HTML + JS + service worker). **No backend.** State lives in
`localStorage` + IndexedDB. Cross-device sync goes through Dropbox (`sync.js`).
Ships from this directory via GitHub Pages — so **paths must stay relative**
(`./app.js`, `manifest.json`), and whatever is committed here is what users get.

| File | Role |
|---|---|
| `index.html` | Markup + **all** CSS. Ends with exactly two script tags: `app.js` then `sync.js`. No inline app JS. |
| `app.js` | All application logic (~6.4k lines). `APP_VERSION` is at the top. |
| `sync.js` | Dropbox sync engine. Loads **after** app.js and uses its globals (`S`, `save`, `uid`, `idbOpen`, `toast`, `render`, `esc`, `STORE_KEY`). |
| `sw.js` | Service worker / offline cache. `CACHE` + `ASSETS` at the top. |
| `manifest.json`, `icon*` | PWA install assets. |
| `tests/`, `archive/tests/` | Node test suite (§4). |
| `tools/join_exports.py` | Export-merge tool. Mirrors the state schema (§6). |
| `archive/`, `_to_delete/`, `Temp/` | Scratch and old versions. Not shipped. |

Every call from `app.js` into `sync.js` is guarded with
`typeof fn === "function"`, so a missing or broken `sync.js` never breaks the app.
Keep that guard when you add new cross-file calls.

---

## 2. Editing the three big files (`app.js`, `sync.js`, `index.html`)

### Read this before following any older note

Earlier versions of this file said **"never use the Edit/Write tools — they
silently truncate."** That was real, but it was a bug in one specific sandbox
(Claude Cowork, network-mounted filesystem), **not** a property of these files.
Do not carry that ban into other environments.

**Measured 2026-08-14, Claude Code on Windows local disk:**

| Edit | Expected byte change | Actual byte change | Result |
|---|---|---|---|
| `app.js` (6380 lines, 341 KB) | 5 | **5** | byte-exact, `node --check` passes |
| `index.html` (1076 lines, 55 KB) | 2 | **2** | byte-exact, still ends `</html>` |

So: **use your environment's normal edit tool.** It is the safest option here.

### The real hazard now is the shell, not the editor

These files use **CRLF** line endings. Git Bash `sed`/`awk` rewrite them to LF.
That is not a truncation, but it turns a one-line change into a 6380-line diff,
which makes review impossible and hides real mistakes. During this evaluation a
`sed` round-trip corrupted the file where the edit tool did not.

If you must use the shell (an environment where in-place editing is unavailable
or proven broken):
- Prefer `python3` with explicit `newline=""` over `sed`/`awk`.
- Build into `file.new`, verify, then atomic `mv file.new file`.
- Note: the `node --check` CLI rejects non-`.js` filenames with
  `ERR_UNKNOWN_FILE_EXTENSION`. Check a `.js`-suffixed copy, or check **after**
  the `mv`, not the `.new` intermediate.

### Verify after every write — whatever tool you used

This is the part that actually matters, and it is unconditional:

1. `node --check app.js` and `node --check sync.js` — both must pass.
2. Line count only moved the way you intended. `wc -l` should **grow** for an
   additive change, never shrink unexpectedly.
   `tail -1 app.js` is **not** a truncation check — the backup/snapshot feature
   legitimately appends code after the service-worker registration, so the true
   last line is something like `}, 5000);`.
3. `index.html` ends with `</body></html>` and contains **exactly one**
   `<script src="app.js"></script>` followed by **exactly one**
   `<script src="sync.js"></script>`.
4. Line endings unchanged: `grep -c $'\r' app.js` must equal `wc -l app.js`.

Back up to `archive/old-versions/` before any risky change, and `diff` against
that backup to confirm every changed line was intentional.

---

## 3. Mandatory on every edit that touches shipped files

1. **Bump `APP_VERSION`** — top of `app.js`:
   `const APP_VERSION = "vYYYY.MM.DD-HHMM";`. Generate with `date +v%Y.%m.%d-%H%M`.
   It renders at the bottom of Settings (`.appVersion`) so the user can see which
   build they are on. GitHub Pages strips file dates, so this stamp is the only
   version signal. It must change on **every** edit.
2. **Bump the SW cache** — `sw.js` line 3, `const CACHE = "questa-vN";` →
   increment `N`. Without this, existing installs keep the old files.
3. **Added or renamed a shipped file?** Add it to `ASSETS` in `sw.js` **and** to
   the network-first "shell" condition in the fetch handler, so updates appear on
   next launch instead of serving stale cache.
4. **`node --check` both JS files** (§2).
5. **`node tests/run.js`** — the whole suite must pass. Hard deploy gate (§4).
6. **`index.html` integrity check** (§2).
7. **Schema change? Update `tools/join_exports.py` in the same edit** (§6).

---

## 4. Test suite — required gate, and keep it current

One command runs everything:

```bash
node tests/run.js     # or: npm test
```

It executes every `tests/*.test.js` and `archive/tests/*-tests.js`, aggregates
PASS/FAIL, and exits non-zero if any file fails. No framework, no dependencies.
**Baseline as of 2026-09-19 (round-1 findings 5 and 10): 101 test files, all passing.** Never
commit or deploy with a red suite. The count only ever goes up.

**Caveat on what a green count proves.** This used to say the runner judged only by
exit code, so a file that only `console.log`ged counted as a pass — and named
`tests/debug-pager.test.js` as exactly that. Both are **out of date as of
2026-09-19**: `tests/run.js` now requires assertion evidence in stdout (`[PASS] ` for
`tests/*.test.js`, a bare `PASS ` line for `archive/tests/*-tests.js`) and fails a
file with neither, and `debug-pager` has 20 assertions. A green count still proves
only that each file asserted *something*. Read the assertions, not the total.

The count only ever goes **up**. It was 59 on 2026-08-14, 70 before the wave-2 ship
on 2026-08-19, and 75 after it. `tests/run.js` auto-discovers by `readdirSync`, so a
new test file needs no wiring. As of 2026-08-19 that 75 is **68 + 7**: 68 from
`tests/*.test.js` and 7 from `archive/tests/*-tests.js`. Do not sanity-check the total
with a single glob — `ls tests/*.test.js` returns **69**, because the runner excludes
`_tmp*` (there is one such file) and the glob misses `archive/tests/` entirely. If the
runner reports **fewer** than the figure above, a test file was lost; find it, do not
"fix" the baseline.

### How the tests reach live code

The suite loads the **real** `app.js`/`sync.js`, not copies:
- `sync.js` via its `window.QuestaSync` registry in a `vm` sandbox (boot gate stripped).
- `app.js` helpers via `BEGIN/END_*_HELPERS` marker slices **and** anchor-based
  extraction with `tests/_extract.js`.

**Prefer `tests/_extract.js` for anything outside a marker block.** It locates
code by *declaration text* + brace balance, so it survives arbitrary line shifts.
Before 2026-07-23 the tests used hardcoded `grab(lineStart, lineEnd)` ranges and
every insertion into `app.js` silently broke them.

Exports: `extractLine`, `extractFunction`, `extractSpan`, `functionEndLineIndex`.
Canonical usage example: `tests/feed-hide-sync.test.js` lines 13-39.

### Lockstep rule

Tests change in the **same edit** as the code:

| Change | Required test work |
|---|---|
| New behavior | Add a test |
| Changed behavior | Update the assertions encoding the old behavior, and comment why |
| Bug fix | Add a regression test that fails before the fix, passes after |

**A green suite that still asserts behavior you changed is a FAILURE, not a pass.**

### Assert on observable effects, not on call counts

A 2026-07-29 scheduler bug shipped behind a green suite because
`auto-backup-rotation.test.js` R4 asserted only that the blob builder was called
once — true whether or not the tier under test actually fired. If a test's
subject is "X happened", mock the boundary X crosses (upload path, written
record) and assert on what it recorded.

**Corollary:** any function that alone gates whether a feature runs deserves a
direct unit test of its return value, not just coverage of its caller.

### Known coverage gaps

Fill these when you touch the area:

- the event-log pruning/age path — `pruneEvents` / `schedulePrune` have **zero**
  references in any test file. (The hard-cap double-count listed here until
  2026-09-19 is **fixed**: `pruneEvents` now counts from `tx.oncomplete`, after
  the age pass, in a second transaction. The gap is the missing test, not a live
  bug.)
- `tests/auto-backup-cycling.test.js` (slot modulo cycling / lazy self-heal —
  still unwritten, tracked as P2 in
  `.kilo/plans/1785344033093-dropbox-cycling-backups-review.md`).

`mergeDayArray` and `runCron` were listed here until 2026-09-18 but both now have
substantive direct coverage (`tests/daystamp.test.js` M1-M6,
`tests/earnings-accumulate.test.js` K3-J1, `tests/pause-tracking.test.js`,
`tests/cron-day-rewind.test.js`).

---

## 5. What cannot be tested in a sandbox

Confirm these on a **real device**; a headless environment cannot reproduce them:
- Touch and gesture behavior — drag-and-drop, `touch-action`, scroll-vs-drag
  arbitration. This is a touch-first mobile PWA.
- Dropbox OAuth — PKCE redirect + login needs a real browser.
- Multi-device conflict behavior end-to-end.

Merge/sync **logic** can and must be unit-tested in Node. On-device checklist:
`.omo/plans/2026-07-10-dropbox-sync.md` §8.

To force a fresh load after deploy: the SW is network-first for the shell +
`app.js` + `sync.js`, so a normal reload usually suffices. A hard refresh or
clearing site cache guarantees it.

---

## 6. Export schema ↔ `join_exports.py` must stay in sync

`tools/join_exports.py` reconstructs the most-current joined state from multiple
Questa exports (rules in `tools/join_exports.md`). Its merge logic mirrors the app
state schema.

On **any** schema change — a new top-level key; a renamed or retyped field in
`tasks` / `char` / `rewards` / `devices` / `deletions` / `events` / `prefs`; a new
merge or timestamp field; a changed tombstone shape — update the matching rule in
`join_exports.py` **in the same edit**, then re-run it on
`questa-RECOVERED-20260712.json` + `questa-backup-20260716-0912.json` and confirm:

```
events == 4566,  tasks == 127,  conflicts >= 0     # no data loss
```

**A stale join script is a red deploy gate.**

### Export format is tokenized (schema 2)

Handover doc: `.kilo/plans/1784185676821-tokenized-export-archiving-handover.md`.

- `buildBackupFile` (app.js) writes a tokenized envelope: `_backup.schema: 2`,
  `K`/`SRC`/`TID`/`TT`/`FM` dictionaries, short-keyed `E` events, deep-tokenized
  `S` snapshot.
- `importData` detokenizes schema-2 files **before** the `_backup.hash` check and
  **before** `migrate()`.
- The integrity hash is computed on the **detokenized (legacy)** object, so old
  schema-1 backups stay valid and re-exports are hash-stable.
- `join_exports.py` detokenizes schema-2 inputs (`_detokenize_export`) and emits
  legacy schema-1 output.

On any change to the tokenization (field maps, dictionary shape, `E` tuple),
update **both** `app.js` and `join_exports.py` in the same edit, then re-run the
red gate on a schema-2 fixture too. Regression test:
`tests/tokenized-export.test.js`.

### Granular export / import (partial files)

Export and import are section-scoped. `IO_SECTIONS` in `app.js`
(`BEGIN/END_GRANULAR_IO_HELPERS`) is the **single** registry driving both picker
dialogs, the counts they show, `sliceStateForExport()`, `detectExportSections()`
and `applySectionsToState()`. Add a section there and it appears in both dialogs.

Two envelope keys are new, and only on a **partial** file:

- `_backup.partial: true`
- `_backup.sections: [...]` — the manifest, authoritative on import.

A partial file is named `questa-partial-*.json`, not `questa-backup-*.json`.

Rules that must not be broken:

1. **An unselected key is OMITTED, never written as `[]`.** Absence means "this
   file says nothing about that data"; an empty array means "replace it with
   nothing". Confusing the two is silent deletion.
2. **`buildBackupFile` hashes and tokenizes the same source** (`src`, the slice —
   not `S`). Tokenizing `S` while hashing the slice yields a file that fails its
   own integrity gate and is refused as "corrupted or tampered with".
3. **Merge never lets a missing timestamp lose.** `_ioRecTs()` scores an absent
   stamp 0 and the comparison is strictly-greater, so an unstamped incoming
   record can never evict a local one. Same polarity rule as the `sync.js` merge
   sites.
4. **Events are append-only on both paths.** `clearAllEvents()` must stay
   unreachable from `applyImportSections()`.
5. Full selection must stay byte-shape identical to the historic full backup, so
   nothing already reading these files has to change.

`join_exports.py` reads the manifest and must treat an absent section as "not
stated", never as "deleted". Regression tests:
`tests/granular-export-import.test.js` (registry, slicing, detection, merge
polarity, full round trip through the hash gate) and
`tests/import-data-merge.test.js` (the import pipeline end to end).

---

## 7. Asking the user for on-device diagnostic data

**Default: don't.** Most bugs are diagnosable from the code, a stack trace, or a
sandbox repro. In those cases read the code or write a failing test.

Request the full export (Settings → tap the version 5x → **Download All** →
`questa-fulldiag-*.json`) **only** when the bug is state- or device-dependent and
not reproducible from code:

- sync / merge / cross-device data loss or reverts;
- persistence / durable-state / stale-localStorage issues;
- streak or state anomalies not reproducible from a fresh state;
- stale-app / service-worker-update problems (needs SW + cache + appVersion);
- crashes with no repro — the export's error ring buffer captures them.

The file is monolithic and can be multi-MB. **Slice it with jq/python; never load
it whole into context.** Layout + a "what to look for" playbook:
`docs/DIAGNOSTIC-FORMAT.md`.

---

## 8. CSS / layout quick reference

All styles live in the `<style>` block in `index.html`. Rendered HTML is built in
`app.js`.

| Element | Selector |
|---|---|
| Sticky filter toolbar | `.stickyControls` |
| Task card | `.task` |
| Filter buttons | `.filterBar button`, `.filterBar button.on` |
| Nav bar | `nav` |
| Header | `header` |
| Bottom sheet / modal | `.sheet` |

`--line` = `#5b3a86` — the purple border color used throughout.

---

## 9. Context discipline (large files)

`app.js` is ~341 KB and diagnostic exports are multi-MB. Reading them whole
wastes the budget you need for the actual work.

- Locate first with grep/glob, then read only the matching region with an
  offset/limit.
- Process logs, CSVs, and diagnostic JSON with a script that prints a summary —
  do not dump raw content into the conversation.
- Prefer a targeted grep over opening a file "to have a look".

---

## 10. Environment-specific notes

Running under **opencode** against the NVIDIA-hosted model? Proxy setup, rate-limit
handling, and `opencode.json` gotchas are in **`docs/OPENCODE-NVIDIA.md`**. That is
local tooling, not project rules — ignore it otherwise.
