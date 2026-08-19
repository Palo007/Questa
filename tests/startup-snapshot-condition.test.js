// startup-snapshot-condition.test.js -- F6 regression: the startup snapshot
// fired 5s after every app open (app.js:6377-6379, the very last statement in
// the file) is UNCONDITIONAL today:
//
//   setTimeout(()=>{
//     if(!_flushPromise){ _flushPromise = takeSnapshot().catch(()=>{}).finally(()=>{ _flushPromise=null; }); }
//   }, 5000);
//
// docs/BACKUP-USER-GUIDE.md:30-34 documents the INTENDED behaviour: snapshot
// on startup only if there are no snapshots yet, or the newest snapshot is
// older than 12 hours. The fix introduces a new top-level predicate,
// _shouldStartupSnapshot(), which the startup setTimeout must consult before
// calling takeSnapshot(). This file tests ONLY that new predicate in
// isolation (not the setTimeout call site, which is out of scope here).
//
// Predicate contract this file assumes (see report for the exact regex):
//   async function _shouldStartupSnapshot(){ ... }
//   - takes no arguments
//   - reads the module-level `IS_DIRTY` (app.js:231) as a free variable, not
//     a parameter
//   - returns a Promise<boolean>: true if a startup snapshot should be taken
//   - fires when ANY of: IS_DIRTY is true; no snapshots exist; the newest
//     snapshot's `ts` is more than 12h old
//   - reads the newest snapshot's ts via a REVERSE cursor
//     (store.openCursor(null, "prev") on the "backups" store), resolving on
//     the FIRST cursor.value.ts WITHOUT ever calling cursor.continue() --
//     the backups store (app.js:807) has no index, and listSnapshots()
//     (app.js:1280-1293) walks + deserialises every record, which would be
//     wasteful just to read one timestamp on every boot.
//
// Run: node tests/startup-snapshot-condition.test.js (also run by node tests/run.js)

const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

let failures = 0, passes = 0;
function assert(label, cond) {
  if (cond) { passes++; console.log('[PASS] ' + label); }
  else { failures++; console.log('[FAIL] ' + label); }
}

// ─── Extraction (must survive a RED run) ───────────────────────────────────
// _shouldStartupSnapshot does not exist in app.js yet -- extractFunction
// THROWS on a missing anchor rather than failing an assertion. Catch that and
// turn it into one clearly-labeled failed assertion instead of letting an
// unhandled exception crash the whole file with a stack trace.
const PREDICATE_DECL_RE = /^async function _shouldStartupSnapshot\(\)\{/;
let predicateSrc = null;
let extractError = null;
try {
  predicateSrc = extractFunction(appSrc, PREDICATE_DECL_RE, '_shouldStartupSnapshot');
} catch (e) {
  extractError = e;
}
assert(
  '_shouldStartupSnapshot() exists in app.js as `async function _shouldStartupSnapshot(){`' +
    (extractError ? ' -- extraction failed: ' + extractError.message : ''),
  !!predicateSrc
);

// ─── Local "backups" store IDB shim (direction-honouring, read-counting) ───
// Existing repo shims do NOT honour the openCursor() direction argument:
//   - tests/auto-backup-tiers.test.js:34 and
//     tests/auto-backup-sync-exclusion.test.js:35 both have an openCursor()
//     that ignores all arguments and always returns an empty cursor.
//   - tests/snapshot-gfs.test.js:76-78 walks s.data in INSERTION order
//     (oldest-first) and also ignores the direction argument.
// Trusting any of those would let a wrong (or absent) reverse-cursor silently
// pass. This shim is local to this file, actually honours
// direction === "prev" (newest-first traversal), and records how many values
// were yielded plus whether continue() was ever called, so the COST
// assertion (T5) has real signal instead of a call-count on a mock.
function makeBackupsShim(records) {
  let reads = 0;
  let continued = false;
  function makeReq() { return { result: undefined, onsuccess: null, onerror: null }; }
  function fire(req) {
    Promise.resolve().then(function () { if (req.onsuccess) req.onsuccess(); });
  }
  const store = {
    openCursor: function (query, direction) {
      const ordered = records.slice().sort(function (a, b) {
        return direction === 'prev' ? (b.ts - a.ts) : (a.ts - b.ts);
      });
      let i = 0;
      const req = makeReq();
      (function step() {
        if (i >= ordered.length) {
          req.result = null;
        } else {
          const rec = ordered[i];
          reads++;
          req.result = {
            value: rec,
            continue: function () { continued = true; i++; step(); }
          };
        }
        fire(req);
      })();
      return req;
    }
  };
  return { store: store, stats: function () { return { reads: reads, continued: continued }; } };
}

function makeIdbOpen(records) {
  const shim = makeBackupsShim(records);
  const db = {
    transaction: function (storeNames) {
      return {
        objectStore: function (name) {
          if (name !== 'backups') throw new Error('unexpected store requested in test: ' + name);
          return shim.store;
        }
      };
    }
  };
  return { idbOpen: function () { return Promise.resolve(db); }, stats: shim.stats };
}

// ─── Sandbox runner ─────────────────────────────────────────────────────────
// IS_DIRTY is spliced in as a `let` binding ahead of the extracted predicate
// source (same idiom as tests/feed-hide-sync.test.js's evStubs), so the
// predicate picks it up as a free variable exactly as it does in app.js
// (app.js:231 `let IS_DIRTY = false;`). idbOpen is passed in as a closure
// parameter of the wrapping IIFE, matching the general pattern in
// tests/feed-hide-sync.test.js's buildApiWithEvents.
async function callPredicate(isDirty, records) {
  if (!predicateSrc) {
    return { result: undefined, reads: 0, continued: false, threw: new Error('predicate not extracted') };
  }
  const built = makeIdbOpen(records);
  const code =
    'let IS_DIRTY = ' + (isDirty ? 'true' : 'false') + ';\n' +
    predicateSrc + '\n' +
    'return _shouldStartupSnapshot();';
  const fn = new vm.Script(
    '(function(idbOpen){ "use strict";\n' + code + '\n})'
  ).runInNewContext({});
  try {
    const result = await fn(built.idbOpen);
    return Object.assign({ result: result, threw: null }, built.stats());
  } catch (e) {
    return Object.assign({ result: undefined, threw: e }, built.stats());
  }
}

const HOUR = 3600000;
const now = Date.now();

(async function main() {
  // T1: no-op open -- not dirty, a snapshot exists, newest is 1h old -> false.
  {
    const r = await callPredicate(false, [{ id: 1, ts: now - 1 * HOUR }]);
    assert('T1 no-op open (clean, newest snapshot 1h old) returns false', !r.threw && r.result === false);
  }

  // T2: dirty open, recent snapshot exists -> true.
  {
    const r = await callPredicate(true, [{ id: 1, ts: now - 1 * HOUR }]);
    assert('T2 dirty open (IS_DIRTY=true, recent snapshot) returns true', !r.threw && r.result === true);
  }

  // T3: empty backups store, not dirty -> true (once-per-session backstop for
  // browsers where visibilitychange/pagehide never fire, AGENTS.md §5).
  {
    const r = await callPredicate(false, []);
    assert('T3 empty backups store (not dirty) returns true', !r.threw && r.result === true);
  }

  // T4: stale open -- not dirty, newest snapshot is 13h old -> true.
  {
    const r = await callPredicate(false, [{ id: 1, ts: now - 13 * HOUR }]);
    assert('T4 stale open (newest snapshot 13h old) returns true', !r.threw && r.result === true);
  }

  // T5: COST -- the newest-ts read must touch EXACTLY ONE record via the
  // reverse cursor, and must never call continue(). Store holds several
  // records, deliberately out of ts order, none of them the first inserted.
  {
    const records = [
      { id: 1, ts: now - 30 * HOUR },
      { id: 2, ts: now - 1 * HOUR },   // newest -- must be the only one read
      { id: 3, ts: now - 20 * HOUR },
      { id: 4, ts: now - 5 * HOUR },
    ];
    const r = await callPredicate(false, records);
    assert('T5 COST: exactly one backups record read (got ' + r.reads + ')', !r.threw && r.reads === 1);
    assert('T5 COST: cursor.continue() is never called', !r.threw && r.continued === false);
    // With a correct reverse cursor the single record read must be the
    // newest (1h old), so the "stale" branch must NOT fire here.
    assert('T5 COST: correct record read yields false (newest is 1h old, not stale)', !r.threw && r.result === false);
  }

  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures > 0 ? 1 : 0);
})();
