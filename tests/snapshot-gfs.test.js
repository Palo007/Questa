// snapshot-gfs.test.js -- tests for the Grandfather-Father-Son snapshot mechanism
// in app.js. Exercises: snapshotBoundaryKeys, migrate GFS markers, writeSnapshot
// tier, takeSnapshot promotion, rotateSnapshots GFS logic, chain integrity, and
// a regression test that FAILS against the OLD rotateSnapshots.
//
// Run: node tests/snapshot-gfs.test.js   (also run by `node tests/run.js`)
const fs = require('fs'), path = require('path'), vm = require('vm');

// ─── In-memory IndexedDB shim ───────────────────────────────────────────────
function createIDBShim() {
  const dbData = {};
  function ensure(name) {
    if (!dbData[name]) dbData[name] = { data: [], autoId: 1, indexes: {} };
    return dbData[name];
  }
  ['events', 'backups', 'syncmeta', 'state'].forEach(ensure);

  const tick = function(fn) { return Promise.resolve().then(fn); };

  function makeReq() { return { result: undefined, onsuccess: null, onerror: null }; }
  function fireOK(req, val) {
    req.result = val;
    tick(function() { if (req.onsuccess) req.onsuccess(); });
  }

  function runCursor(data, req) {
    var i = 0;
    (function step() {
      if (i >= data.length) { req.result = null; }
      else {
        var v = data[i];
        req.result = { value: v, continue: function() { i++; step(); } };
      }
      tick(function() { if (req.onsuccess) req.onsuccess(); });
    })();
  }

  function makeStore(name) {
    var s = ensure(name);
    return {
      indexNames: { contains: function(n) { return n in s.indexes; } },
      createIndex: function(n, kp) { s.indexes[n] = kp; },
      add: function(rec) {
        var id = s.autoId++;
        s.data.push(Object.assign({}, rec, { id: id }));
        var r = makeReq(); fireOK(r, id); return r;
      },
      get: function(id) {
        var r = makeReq();
        var found = undefined;
        for (var j = 0; j < s.data.length; j++) {
          if (s.data[j].id === id) { found = s.data[j]; break; }
        }
        fireOK(r, found);
        return r;
      },
      put: function(rec) {
        var idx = -1;
        for (var j = 0; j < s.data.length; j++) {
          if (s.data[j].id === rec.id) { idx = j; break; }
        }
        if (idx >= 0) s.data[idx] = rec; else s.data.push(rec);
        var r = makeReq(); fireOK(r, rec.id); return r;
      },
      delete: function(id) {
        s.data = s.data.filter(function(x) { return x.id !== id; });
        var r = makeReq(); fireOK(r, undefined); return r;
      },
      count: function() {
        var r = makeReq(); fireOK(r, s.data.length); return r;
      },
      clear: function() {
        s.data = [];
        var r = makeReq(); fireOK(r, undefined); return r;
      },
      openCursor: function() {
        var r = makeReq(); runCursor(s.data.slice(), r); return r;
      },
      index: function(idxName) {
        return {
          openCursor: function(range) {
            var kp = s.indexes[idxName] || idxName;
            var data = s.data.slice().sort(function(a, b) { return (a[kp] || 0) - (b[kp] || 0); });
            if (range) {
              if (range.lower !== undefined) {
                data = range.excludeLower
                  ? data.filter(function(r) { return r[kp] > range.lower; })
                  : data.filter(function(r) { return r[kp] >= range.lower; });
              }
              if (range.upper !== undefined) {
                data = range.excludeUpper
                  ? data.filter(function(r) { return r[kp] < range.upper; })
                  : data.filter(function(r) { return r[kp] <= range.upper; });
              }
            }
            var r = makeReq(); runCursor(data, r); return r;
          }
        };
      }
    };
  }

  return {
    open: function() {
      // Reset all store data for fresh state
      Object.keys(dbData).forEach(function(k) {
        dbData[k].data = [];
        dbData[k].autoId = 1;
      });
      var db = {
        objectStoreNames: {
          contains: function(n) { return n in dbData; }
        },
        createObjectStore: function(n) { ensure(n); return makeStore(n); },
        transaction: function(storeNames, mode) {
          var names = typeof storeNames === 'string' ? [storeNames] : Array.from(storeNames);
          var stores = {};
          names.forEach(function(n) { stores[n] = makeStore(n); });
          var _oc = null, fired = false;
          var tx = {
            objectStore: function(n) { return stores[n]; },
            onerror: null,
            onabort: null
          };
          Object.defineProperty(tx, 'oncomplete', {
            get: function() { return _oc; },
            set: function(fn) {
              _oc = fn;
              if (fn && !fired) { fired = true; tick(function() { if (_oc) _oc(); }); }
            },
            configurable: true
          });
          return tx;
        }
      };
      var req = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      req.transaction = { objectStore: function(n) { return makeStore(n); } };
      tick(function() {
        req.result = db;
        if (req.onupgradeneeded) req.onupgradeneeded();
        tick(function() { if (req.onsuccess) req.onsuccess(); });
      });
      return req;
    }
  };
}

// ─── DOM / browser stubs ────────────────────────────────────────────────────
function noop() {}
var sandbox = {
  window: { addEventListener: noop },
  document: {
    addEventListener: noop,
    getElementById: function() {
      return { onclick: null, classList: { contains: function() { return false; }, add: noop, remove: noop },
        dataset: {}, closest: function() { return null; }, style: {} };
    },
    querySelector: function() { return null; },
    querySelectorAll: function() { return { forEach: noop }; },
    createElement: function() { return { style: {}, appendChild: noop, setAttribute: noop, click: noop }; },
    body: { appendChild: noop, removeChild: noop },
    documentElement: { style: { setProperty: noop } },
    hidden: false, visibilityState: 'visible'
  },
  navigator: { onLine: true, serviceWorker: { register: function() { return Promise.resolve(); } },
    storage: { persist: function() { return Promise.resolve(true); } } },
  localStorage: { getItem: function() { return null; }, setItem: noop, removeItem: noop,
    key: function() { return null; }, length: 0 },
  indexedDB: createIDBShim(),
  IDBKeyRange: {
    bound: function(a, b) { return { lower: a, upper: b }; },
    lowerBound: function(a, opts) { return { lower: a, excludeLower: !!(opts && (opts.excludeLower || opts === true)) }; },
    upperBound: function(b, opts) { return { upper: b, excludeUpper: !!(opts && (opts.excludeUpper || opts === true)) }; }
  },
  setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
  console: console, JSON: JSON, Math: Math, Date: Date, Map: Map, Set: Set, WeakSet: WeakSet,
  Array: Array, Object: Object, Number: Number, String: String, Boolean: Boolean, Promise: Promise,
  RegExp: RegExp, Error: Error, TypeError: TypeError,
  parseInt: parseInt, parseFloat: parseFloat, isNaN: isNaN, isFinite: isFinite
};
sandbox.self = sandbox.window;
sandbox.globalThis = sandbox;

// ─── Load app.js with transforms ────────────────────────────────────────────
var src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

// Strip boot tail (applyWidth through EOF) so top-level side-effects don't run
src = src.replace(/\napplyWidth\(\);[\s\S]*$/, '');

// Top-level let → var so sandbox can access them
src = src.replace(/^let S = load\(\);/m, 'var S = load();');
src = src.replace(/^let IS_DIRTY = false;/m, 'var IS_DIRTY = false;');
src = src.replace(/^let _flushPromise = null;/m, 'var _flushPromise = null;');
src = src.replace(/^let _idbPromise = null;/m, 'var _idbPromise = null;');

vm.createContext(sandbox);
try { vm.runInContext(src, sandbox); } catch (e) {
  console.error('FAIL: app.js threw during sandbox evaluation:', e.message);
  process.exit(1);
}

// ─── Validate sandbox loaded correctly ──────────────────────────────────────
var ctx = sandbox;
var requiredFns = ['snapshotBoundaryKeys', 'migrate', 'writeSnapshot', 'rotateSnapshots', 'listSnapshots', 'takeSnapshot'];
for (var ri = 0; ri < requiredFns.length; ri++) {
  if (typeof ctx[requiredFns[ri]] !== 'function') {
    console.error('FAIL: ' + requiredFns[ri] + ' not found in sandbox — app.js may not have GFS changes yet');
    process.exit(1);
  }
}

// ─── Assertion helpers ──────────────────────────────────────────────────────
var failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}
function assertEq(desc, got, want) {
  if (got === want) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc + ' — got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; }
}

// ─── Test helpers ───────────────────────────────────────────────────────────
function resetIDB() { ctx._idbPromise = null; }

function seedBackup(rec) {
  return ctx.idbOpen().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction('backups', 'readwrite');
      var store = tx.objectStore('backups');
      var req = store.add(rec);
      req.onsuccess = function() { resolve(req.result); };
      req.onerror = function() { reject(req.error); };
    });
  });
}

function makeFull(ts, tier) {
  return { type: 'full', tier: tier || null, ts: ts,
    payload: JSON.stringify({ stateSnapshot: {}, events: [] }),
    hash: 'h' + ts, appVersion: 'test', verified: true,
    counts: { tasks: 0, rewards: 0, tags: 0, views: 0, events: 0 } };
}
function makeDelta(ts) {
  return { type: 'delta', tier: null, ts: ts,
    payload: JSON.stringify({ stateSnapshot: {}, events: [] }),
    hash: 'h' + ts, appVersion: 'test', verified: true,
    counts: { tasks: 0, rewards: 0, tags: 0, views: 0, events: 0 } };
}

// ─── Test suite ─────────────────────────────────────────────────────────────
// DESIGN NOTES (why this file is shaped this way):
//   * takeSnapshot() reads the WALL CLOCK (Date.now()) internally and it is not
//     injectable. So promotion tests must be DATE-INDEPENDENT: instead of picking
//     "yesterday" (which crosses an ISO-week/month boundary on some weekdays and
//     silently changes the expected tier), we seed S.prefs.gfs so that EXACTLY ONE
//     boundary key mismatches today's — forcing a single, known tier every run.
//   * ALL IndexedDB-touching tests run in ONE strictly-sequential promise chain.
//     The in-memory shim shares a single backing store and open() wipes it, so any
//     two overlapping tests would clobber each other. (A prior version leaked an
//     un-chained T4 IIFE that raced T5's resetIDB — that race is gone here.)
//   * rotateSnapshots keeps 7 daily + 4 weekly + 6 monthly *distinct-boundary*
//     fulls. A run of consecutive daily fulls therefore legitimately retains MORE
//     than 7 fulls (older week/month baselines survive too). Assertions check the
//     documented invariants, not a single hard count that depends on today's weekday.
function run() {
  var DAY = 86400000;
  var now = Date.now();

  // ── T1: app.js loaded in sandbox ──────────────────────────────────────
  assert('app.js loaded in sandbox without throwing', ctx.S && ctx.S.tasks !== undefined);

  // ── T2: snapshotBoundaryKeys (W1.1) — fixed calendar dates, date-independent ──
  (function() {
    var k = ctx.snapshotBoundaryKeys(now);
    assert('snapshotBoundaryKeys returns {day,week,month}',
      typeof k.day === 'number' && typeof k.week === 'number' && typeof k.month === 'number');

    // Mon 2026-07-06 and Sun 2026-07-12 are in the same ISO week.
    var kMon = ctx.snapshotBoundaryKeys(new Date(2026, 6, 6).getTime());
    var kSun = ctx.snapshotBoundaryKeys(new Date(2026, 6, 12).getTime());
    assertEq('Mon and Sun of one ISO week → same week key', kMon.week, kSun.week);

    // The following Monday (2026-07-13) starts a new ISO week.
    var kNextMon = ctx.snapshotBoundaryKeys(new Date(2026, 6, 13).getTime());
    assert('next Monday → new ISO week key', kNextMon.week !== kMon.week);

    // Month key is year*12+month; Dec→Jan increments by 1 across the year boundary.
    var kDec = ctx.snapshotBoundaryKeys(new Date(2025, 11, 31).getTime());
    var kJan = ctx.snapshotBoundaryKeys(new Date(2026, 0, 1).getTime());
    assertEq('Dec→Jan month key increments by 1', kJan.month - kDec.month, 1);
  })();

  // ── T3: migrate initializes GFS markers (W1.2) ───────────────────────
  (function() {
    var fresh = ctx.migrate({});
    assert('migrate({}) creates prefs.gfs', fresh.prefs && typeof fresh.prefs.gfs === 'object');
    assertEq('gfs.daily defaults to 0', fresh.prefs.gfs.daily, 0);
    assertEq('gfs corrupt string becomes defaults',
      ctx.migrate({ prefs: { gfs: 'abc' } }).prefs.gfs.weekly, 0);
  })();

  // Everything below touches the shared in-memory IDB → ONE sequential chain.
  var chain = Promise.resolve();

  // ── T4: writeSnapshot tier field (W1.3) ───────────────────────────────
  chain = chain.then(function() {
    resetIDB();
    return ctx.writeSnapshot('full', 'weekly').then(function(fullId) {
      assert('writeSnapshot("full","weekly") returns id', fullId !== null && fullId !== undefined);
      return ctx.listSnapshots();
    }).then(function(snaps) {
      var rec = snaps.find(function(s) { return s.tier === 'weekly'; });
      assertEq('full record has tier "weekly"', rec && rec.tier, 'weekly');
      return ctx.writeSnapshot('delta');
    }).then(function(deltaId) {
      return ctx.listSnapshots().then(function(snaps2) {
        var deltaRec = snaps2.find(function(s) { return s.id === deltaId; });
        assertEq('delta record has tier null (not undefined)', deltaRec && deltaRec.tier, null);
      });
    });
  });

  // ── T5: takeSnapshot promotion — one differing boundary → one known tier ──
  // T5a: only the DAY marker mismatches → tier "daily"; a second same-day call → delta.
  chain = chain.then(function() {
    resetIDB();
    ctx.S = ctx.migrate(ctx.S);
    var k = ctx.snapshotBoundaryKeys(now);
    ctx.S.prefs.gfs = { daily: -1, weekly: k.week, monthly: k.month };
    return ctx.takeSnapshot().then(function(id) {
      assert('takeSnapshot writes a snapshot on daily boundary cross', id !== null);
      return ctx.listSnapshots().then(function(snaps) {
        var rec = snaps.find(function(s) { return s.id === id; });
        assertEq('daily-only boundary → tier "daily"', rec && rec.tier, 'daily');
        assertEq('GFS daily marker advanced to today', ctx.S.prefs.gfs.daily, k.day);
        return ctx.takeSnapshot().then(function(id2) {
          return ctx.listSnapshots().then(function(snaps2) {
            var rec2 = snaps2.find(function(s) { return s.id === id2; });
            assertEq('same-day second takeSnapshot → delta', rec2 && rec2.type, 'delta');
            assertEq('same-day delta has tier null', rec2 && rec2.tier, null);
          });
        });
      });
    });
  });

  // T5b: only the WEEK marker mismatches → tier "weekly".
  chain = chain.then(function() {
    resetIDB();
    ctx.S = ctx.migrate(ctx.S);
    var k = ctx.snapshotBoundaryKeys(now);
    ctx.S.prefs.gfs = { daily: k.day, weekly: -1, monthly: k.month };
    return ctx.takeSnapshot().then(function(id) {
      return ctx.listSnapshots().then(function(snaps) {
        var rec = snaps.find(function(s) { return s.id === id; });
        assertEq('week-only boundary → tier "weekly"', rec && rec.tier, 'weekly');
      });
    });
  });

  // T5c: the MONTH marker mismatches → tier "monthly" (checked first, highest tier).
  chain = chain.then(function() {
    resetIDB();
    ctx.S = ctx.migrate(ctx.S);
    var k = ctx.snapshotBoundaryKeys(now);
    ctx.S.prefs.gfs = { daily: k.day, weekly: k.week, monthly: -1 };
    return ctx.takeSnapshot().then(function(id) {
      return ctx.listSnapshots().then(function(snaps) {
        var rec = snaps.find(function(s) { return s.id === id; });
        assertEq('month boundary → tier "monthly"', rec && rec.tier, 'monthly');
      });
    });
  });

  // ── T6: takeSnapshot failure doesn't advance markers (W2.1 F2) ──
  chain = chain.then(function() {
    resetIDB();
    ctx.S = ctx.migrate(ctx.S);
    var k = ctx.snapshotBoundaryKeys(now);
    ctx.S.prefs.gfs = { daily: -1, weekly: k.week, monthly: k.month }; // daily boundary pending
    var orig = ctx.writeSnapshot;
    ctx.writeSnapshot = function() { return Promise.resolve(null); }; // simulate IDB failure
    return ctx.takeSnapshot().then(function(id) {
      assert('takeSnapshot returns null on writeSnapshot failure', id === null);
      assertEq('GFS markers NOT advanced after failure', ctx.S.prefs.gfs.daily, -1);
      ctx.writeSnapshot = orig; // restore
      return ctx.takeSnapshot().then(function(id2) {
        assert('takeSnapshot succeeds after writeSnapshot restored', id2 !== null);
        assertEq('GFS marker advanced only after a successful write', ctx.S.prefs.gfs.daily, k.day);
      });
    });
  });

  // ── T7: rotateSnapshots daily retention (W2.2) ──
  // Seed 10 consecutive daily fulls (idx 0 = oldest … idx 9 = newest) + 2 son-window
  // deltas. The 7 NEWEST distinct-day fulls must all survive; older fulls are pruned
  // down to the GFS tiers (7 daily, plus any distinct week/month baselines), so the
  // total is fewer than 10 but at least 7 — never a hard 7 (weekday-dependent).
  chain = chain.then(function() {
    resetIDB();
    var ids = [];
    var p = Promise.resolve();
    for (var i = 0; i < 10; i++) {
      (function(idx) {
        p = p.then(function() {
          return seedBackup(makeFull(now - (9 - idx) * DAY, 'daily')).then(function(id) { ids[idx] = id; });
        });
      })(i);
    }
    p = p.then(function() { return seedBackup(makeDelta(now - 0.5 * DAY)); })
         .then(function() { return seedBackup(makeDelta(now - 1.5 * DAY)); });
    return p.then(function() {
      return ctx.rotateSnapshots();
    }).then(function() {
      return ctx.listSnapshots();
    }).then(function(remaining) {
      var rids = {};
      remaining.forEach(function(s) { rids[s.id] = true; });
      var fulls = remaining.filter(function(s) { return s.type === 'full'; });
      var newest7Kept = [3, 4, 5, 6, 7, 8, 9].every(function(i) { return rids[ids[i]]; });
      assert('7 newest distinct-day fulls all kept', newest7Kept);
      assert('oldest full pruned (rotation actually deleted something)', !rids[ids[0]]);
      assert('fulls kept is between 7 and 10 (GFS tiers, not a hard 7)',
        fulls.length >= 7 && fulls.length < 10);
      var deltasKept = remaining.filter(function(s) { return s.type === 'delta'; }).length;
      assertEq('both son-window deltas kept', deltasKept, 2);
    });
  });

  // ── T8: chain integrity (W2.2) ──
  chain = chain.then(function() {
    resetIDB();
    var fullTs = now - 1 * DAY;
    var fullId, deltaId;
    return seedBackup(makeFull(fullTs, 'daily')).then(function(id) {
      fullId = id;
      return seedBackup(makeDelta(fullTs + 1000));
    }).then(function(id) {
      deltaId = id;
      var p = Promise.resolve();
      for (var i = 2; i <= 7; i++) {
        (function(idx) {
          p = p.then(function() { return seedBackup(makeFull(now - idx * DAY, 'daily')); });
        })(i);
      }
      return p;
    }).then(function() {
      return ctx.rotateSnapshots();
    }).then(function() {
      return ctx.listSnapshots();
    }).then(function(remaining) {
      var rids = {};
      remaining.forEach(function(s) { rids[s.id] = true; });
      assert('delta within son window is kept', rids[deltaId]);
      assert('baseline full of kept delta preserved (chain integrity)', rids[fullId]);
    });
  });

  // ── T9: regression — a same-day delta must NOT evict that day's full (W2.2) ──
  // The OLD rotation kept the newest snapshot per day (usually a delta) and dropped
  // the full. This asserts the full survives even with 5 newer same-day deltas.
  chain = chain.then(function() {
    resetIDB();
    var day0 = now - 6 * DAY;
    var fullId;
    return seedBackup(makeFull(day0, 'daily')).then(function(id) {
      fullId = id;
      var p = Promise.resolve();
      for (var i = 1; i <= 5; i++) {
        (function(idx) {
          p = p.then(function() { return seedBackup(makeDelta(day0 + idx * 1000)); });
        })(i);
      }
      return p;
    }).then(function() {
      var p = Promise.resolve();
      for (var i = 1; i <= 6; i++) {
        (function(idx) {
          p = p.then(function() { return seedBackup(makeFull(now - (6 - idx) * DAY, 'daily')); });
        })(i);
      }
      return p;
    }).then(function() {
      return ctx.rotateSnapshots();
    }).then(function() {
      return ctx.listSnapshots();
    }).then(function(remaining) {
      var rids = {};
      remaining.forEach(function(s) { rids[s.id] = true; });
      assert('Regression: daily full NOT evicted in favor of same-day deltas', !!rids[fullId]);
    });
  });

  // ── T10: son-window FLOOR is the oldest DAILY full, NOT an older monthly full (W2.2) ──
  // Seed 7 daily fulls (now-6d…now), an old monthly full (now-40d), and a delta at
  // now-20d. The delta sits between the monthly full and the oldest daily full.
  // Under the FIXED rotation the floor is the daily full (now-6d), so the delta is
  // pruned. If the floor were the monthly full, the delta would survive — so this
  // fails against that regression.
  chain = chain.then(function() {
    resetIDB();
    var monthlyId, deltaId;
    var p = Promise.resolve();
    for (var i = 0; i < 7; i++) {
      (function(idx) {
        p = p.then(function() { return seedBackup(makeFull(now - idx * DAY, 'daily')); });
      })(i);
    }
    p = p.then(function() {
      return seedBackup(makeFull(now - 40 * DAY, 'monthly')).then(function(id) { monthlyId = id; });
    }).then(function() {
      return seedBackup(makeDelta(now - 20 * DAY)).then(function(id) { deltaId = id; });
    });
    return p.then(function() {
      return ctx.rotateSnapshots();
    }).then(function() {
      return ctx.listSnapshots();
    }).then(function(remaining) {
      var rids = {};
      remaining.forEach(function(s) { rids[s.id] = true; });
      assert('old monthly full retained (week/month baseline)', rids[monthlyId]);
      assert('delta outside 7-day son window pruned (floor is daily full, not monthly)', !rids[deltaId]);
    });
  });

  // ── T11: restore chain integrity under GFS (W3.2) ──
  // confirmRestore is unchanged; it warns only when a delta has NO baseline full
  // (ts < delta.ts). We drive the real function with stubbed UI side-effects and
  // check the warning fires exactly when expected. Guards the promise that a kept
  // delta always has its retained baseline (no spurious warning).
  chain = chain.then(function() {
    var origCD = ctx.confirmDialog, origAD = ctx.alertDialog, origToast = ctx.toast,
        origRender = ctx.render, origClose = ctx.closeSheet,
        origAW = ctx.applyWidth, origAC = ctx.applyCardThick;
    var dialogTitles = [];
    ctx.confirmDialog = function(title) { dialogTitles.push(title); return Promise.resolve(true); };
    ctx.alertDialog = function(title) { dialogTitles.push('ALERT:' + title); };
    ctx.toast = noop; ctx.render = noop; ctx.closeSheet = noop;
    ctx.applyWidth = noop; ctx.applyCardThick = noop;
    var validPayload = JSON.stringify({
      stateSnapshot: { char: { lvl: 1, xp: 0, hp: 50, gold: 0 }, tasks: [], prefs: {} },
      events: []
    });
    function fullRec(ts) { return { type: 'full', tier: 'daily', ts: ts, payload: validPayload, hash: 'h', verified: true, counts: {} }; }
    function deltaRec(ts) { return { type: 'delta', tier: null, ts: ts, payload: validPayload, hash: 'h', verified: true, counts: {} }; }
    function restoreOriginals() {
      ctx.confirmDialog = origCD; ctx.alertDialog = origAD; ctx.toast = origToast;
      ctx.render = origRender; ctx.closeSheet = origClose;
      ctx.applyWidth = origAW; ctx.applyCardThick = origAC;
    }
    resetIDB();
    return seedBackup(fullRec(now - 2 * DAY)).then(function() {
      return seedBackup(deltaRec(now - 1 * DAY));
    }).then(function(deltaId) {
      dialogTitles = [];
      return ctx.confirmRestore(deltaId).then(function() {
        assert('restore delta WITH baseline: no "Warning" dialog', dialogTitles.indexOf('Warning') === -1);
        assert('restore delta WITH baseline: confirm dialog shown', dialogTitles.indexOf('Confirm Restore') !== -1);
      });
    }).then(function() {
      resetIDB();
      return seedBackup(deltaRec(now - 1 * DAY)); // orphan: no baseline full
    }).then(function(orphanId) {
      dialogTitles = [];
      return ctx.confirmRestore(orphanId).then(function() {
        assert('restore ORPHAN delta: "Warning" dialog fired', dialogTitles.indexOf('Warning') !== -1);
      });
    }).then(function() {
      restoreOriginals();
    }, function(e) {
      restoreOriginals();
      throw e;
    });
  });

  return chain;
}

// ─── Execute ────────────────────────────────────────────────────────────────
run().then(function() {
  if (failures > 0) { console.error(failures + ' snapshot-gfs test(s) failed.'); process.exit(1); }
  console.log('All snapshot-gfs tests passed!');
  process.exit(0);
}).catch(function(e) { console.error('FATAL:', e); process.exit(1); });
