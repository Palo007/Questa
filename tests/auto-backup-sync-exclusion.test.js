// auto-backup-sync-exclusion.test.js -- plan todo #18
// Tests:
//   A1: freshState() returns prefs.autoBackupEnabled with all 4 tiers defaulting to false
//   A2: migrate() on a state WITHOUT autoBackupEnabled populates it from exportIntervalDays
//   A3: migrate() on a state WITH autoBackupEnabled does NOT overwrite it
//   A4: syncSubset() never includes prefs (prefs are sync-excluded by construction)
//
// Run: node tests/auto-backup-sync-exclusion.test.js
//      (also run by `node tests/run.js`)
const fs = require('fs'), path = require('path'), vm = require('vm');

// ─── In-memory IndexedDB shim (same as snapshot-gfs.test.js) ──────────────
function createIDBShim() {
  const dbData = {};
  function ensure(name) {
    if (!dbData[name]) dbData[name] = { data: [], autoId: 1, indexes: {} };
    return dbData[name];
  }
  ['events', 'backups', 'syncmeta', 'state'].forEach(ensure);

  const tick = function(fn) { return Promise.resolve().then(fn); };
  function makeReq() { return { result: undefined, onsuccess: null, onerror: null }; }
  function fireOK(req, val) { req.result = val; tick(function() { if (req.onsuccess) req.onsuccess(); }); }
  function makeStore(name) {
    var s = ensure(name);
    return {
      indexNames: { contains: function(n) { return n in s.indexes; } },
      createIndex: function() {},
      add: function(rec) { var r = makeReq(); s.data.push(Object.assign({}, rec, { id: s.autoId++ })); fireOK(r, s.data[s.data.length-1].id); return r; },
      get: function(id) { var r = makeReq(); var found = s.data.find(function(x){return x.id===id;}); fireOK(r, found); return r; },
      put: function(rec) { var r = makeReq(); var idx = s.data.findIndex(function(x){return x.id===rec.id;}); if(idx>=0) s.data[idx]=rec; else s.data.push(rec); fireOK(r, rec.id); return r; },
      delete: function(id) { var r = makeReq(); s.data = s.data.filter(function(x){return x.id!==id;}); fireOK(r, undefined); return r; },
      count: function() { var r = makeReq(); fireOK(r, s.data.length); return r; },
      clear: function() { s.data = []; var r = makeReq(); fireOK(r, undefined); return r; },
      openCursor: function() { var r = makeReq(); r.result = null; tick(function(){if(r.onsuccess)r.onsuccess();}); return r; },
      index: function() { return { openCursor: function() { var r = makeReq(); r.result = null; tick(function(){if(r.onsuccess)r.onsuccess();}); return r; } }; }
    };
  }
  return {
    open: function() {
      Object.keys(dbData).forEach(function(k) { dbData[k].data = []; dbData[k].autoId = 1; });
      var db = {
        objectStoreNames: { contains: function(n) { return n in dbData; } },
        createObjectStore: function(n) { ensure(n); return makeStore(n); },
        transaction: function(storeNames, mode) {
          var names = typeof storeNames === 'string' ? [storeNames] : Array.from(storeNames);
          var stores = {};
          names.forEach(function(n) { stores[n] = makeStore(n); });
          var _oc = null, fired = false;
          var tx = {
            objectStore: function(n) { return stores[n]; },
            onerror: null, onabort: null
          };
          Object.defineProperty(tx, 'oncomplete', {
            get: function() { return _oc; },
            set: function(fn) { _oc = fn; if (fn && !fired) { fired = true; tick(function() { if (_oc) _oc(); }); } },
            configurable: true
          });
          return tx;
        }
      };
      var req = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      req.transaction = { objectStore: function(n) { return makeStore(n); } };
      tick(function() { req.result = db; if (req.onupgradeneeded) req.onupgradeneeded(); tick(function() { if (req.onsuccess) req.onsuccess(); }); });
      return req;
    }
  };
}

// ─── Load app.js into sandbox ─────────────────────────────────────────────
var noop = function(){};
var sandbox = {
  window: { addEventListener: noop },
  document: {
    addEventListener: noop,
    getElementById: function() { return { onclick: null, classList: { contains: function(){return false;}, add: noop, remove: noop }, dataset: {}, closest: function(){return null;}, style: {} }; },
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
  IDBKeyRange: { bound: function(a,b){return{lower:a,upper:b};}, lowerBound: function(a,o){return{lower:a,excludeLower:!!(o&&(o.excludeLower||o===true))};}, upperBound: function(b,o){return{upper:b,excludeUpper:!!(o&&(o.excludeUpper||o===true))};} },
  setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
  console: console, JSON: JSON, Math: Math, Date: Date, Map: Map, Set: Set, WeakSet: WeakSet,
  Array: Array, Object: Object, Number: Number, String: String, Boolean: Boolean, Promise: Promise,
  RegExp: RegExp, Error: Error, TypeError: TypeError,
  parseInt: parseInt, parseFloat: parseFloat, isNaN: isNaN, isFinite: isFinite
};
sandbox.self = sandbox.window;
sandbox.globalThis = sandbox;

var src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
src = src.replace(/\napplyWidth\(\);[\s\S]*$/, '');
src = src.replace(/^let S = load\(\);/m, 'var S = load();');
src = src.replace(/^let IS_DIRTY = false;/m, 'var IS_DIRTY = false;');
src = src.replace(/^let _flushPromise = null;/m, 'var _flushPromise = null;');
src = src.replace(/^let _idbPromise = null;/m, 'var _idbPromise = null;');

vm.createContext(sandbox);
try { vm.runInContext(src, sandbox); } catch (e) {
  console.error('FAIL: app.js threw during sandbox evaluation:', e.message);
  process.exit(1);
}

// ─── Load sync.js into a separate sandbox (for syncSubset) ────────────────
var syncSandbox = {
  window: {}, navigator: { onLine: true },
  document: { addEventListener: noop, getElementById: function(){return null;},
    createElement: function(){return {style:{},appendChild:noop,setAttribute:noop,click:noop};},
    body: { appendChild: noop, removeChild: noop } },
  localStorage: { getItem: function(){return null;}, setItem: noop, removeItem: noop,
    key: function(){return null;}, length: 0 },
  indexedDB: { open: function(){ return {}; } },
  setTimeout: noop, clearTimeout: noop, setInterval: function(){return 0;}, clearInterval: noop,
  console: console, JSON: JSON, Math: Math, Date: Date, Map: Map, Set: Set, WeakSet: WeakSet,
  Array: Array, Object: Object, Number: Number, String: String, Boolean: Boolean, Promise: Promise,
  logEvent: noop, toast: noop, render: noop, esc: function(x){return x;}, save: noop,
  uid: function(){return 'test-uid';}, idbOpen: function(){return Promise.resolve(null);}
};
syncSandbox.self = syncSandbox.window;
syncSandbox.globalThis = syncSandbox;

var syncSrc = fs.readFileSync(path.join(__dirname, '..', 'sync.js'), 'utf8');
syncSrc = syncSrc.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');
syncSrc = syncSrc.replace(/\bsyncInit\(\)\s*;?\s*$/, '');

vm.createContext(syncSandbox);
try { vm.runInContext(syncSrc, syncSandbox); } catch(e) { /* some init errors OK */ }

// ─── Validate sandbox loaded correctly ────────────────────────────────────
if (typeof sandbox.freshState !== 'function') {
  console.error('FAIL: freshState not found in app.js sandbox');
  process.exit(1);
}
if (typeof sandbox.migrate !== 'function') {
  console.error('FAIL: migrate not found in app.js sandbox');
  process.exit(1);
}

// ─── Assertion helpers ────────────────────────────────────────────────────
var failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}
function assertEq(desc, got, want) {
  if (got === want) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc + ' — got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; }
}

// =====================================================================
// A1: freshState() returns prefs.autoBackupEnabled with all 4 tiers defaulting to false
// =====================================================================
(function(){
  var s = sandbox.freshState();
  var ab = s.prefs && s.prefs.autoBackupEnabled;

  assert('A1a: freshState() has prefs.autoBackupEnabled', ab !== null && ab !== undefined && typeof ab === 'object');
  assertEq('A1b: autoBackupEnabled.fourHour defaults to false', ab.fourHour, false);
  assertEq('A1c: autoBackupEnabled.daily defaults to false', ab.daily, false);
  assertEq('A1d: autoBackupEnabled.weekly defaults to false', ab.weekly, false);
  assertEq('A1e: autoBackupEnabled.monthly defaults to false', ab.monthly, false);
})();

// =====================================================================
// A2: migrate() on a state WITHOUT autoBackupEnabled populates it from exportIntervalDays
// =====================================================================
(function(){
  // A2a: exportIntervalDays=7 → weekly=true, rest false
  var state2a = { prefs: { exportIntervalDays: 7 } };
  var out2a = sandbox.migrate(state2a);
  assert('A2a: migrate({exportIntervalDays:7}) produces autoBackupEnabled', out2a.prefs.autoBackupEnabled !== undefined);
  assertEq('A2b: exportIntervalDays=7 → weekly=true', out2a.prefs.autoBackupEnabled.weekly, true);
  assertEq('A2c: exportIntervalDays=7 → daily=false', out2a.prefs.autoBackupEnabled.daily, false);
  assertEq('A2d: exportIntervalDays=7 → monthly=false', out2a.prefs.autoBackupEnabled.monthly, false);
  assertEq('A2e: exportIntervalDays=7 → fourHour=false', out2a.prefs.autoBackupEnabled.fourHour, false);

  // A2f: exportIntervalDays=1 → daily=true
  var state2f = { prefs: { exportIntervalDays: 1 } };
  var out2f = sandbox.migrate(state2f);
  assertEq('A2f: exportIntervalDays=1 → daily=true', out2f.prefs.autoBackupEnabled.daily, true);

  // A2g: exportIntervalDays=30 → monthly=true
  var state2g = { prefs: { exportIntervalDays: 30 } };
  var out2g = sandbox.migrate(state2g);
  assertEq('A2g: exportIntervalDays=30 → monthly=true', out2g.prefs.autoBackupEnabled.monthly, true);

  // A2h: no exportIntervalDays → all false
  var state2h = { prefs: {} };
  var out2h = sandbox.migrate(state2h);
  assertEq('A2h: no exportIntervalDays → all false', out2h.prefs.autoBackupEnabled.weekly, false);
  assertEq('A2i: no exportIntervalDays → fourHour false', out2h.prefs.autoBackupEnabled.fourHour, false);
})();

// =====================================================================
// A3: migrate() on a state WITH autoBackupEnabled does NOT overwrite it
// =====================================================================
(function(){
  var existing = { fourHour: true, daily: false, weekly: false, monthly: false };
  var state3 = { prefs: { autoBackupEnabled: existing } };
  var out3 = sandbox.migrate(state3);

  assert('A3a: existing autoBackupEnabled preserved', out3.prefs.autoBackupEnabled === existing);
  assertEq('A3b: fourHour still true (not overwritten)', out3.prefs.autoBackupEnabled.fourHour, true);
  assertEq('A3c: daily still false (not overwritten)', out3.prefs.autoBackupEnabled.daily, false);
  assertEq('A3d: weekly still false (not overwritten)', out3.prefs.autoBackupEnabled.weekly, false);
  assertEq('A3e: monthly still false (not overwritten)', out3.prefs.autoBackupEnabled.monthly, false);

  // Also test with all-true (no overwriting even when all tiers are enabled)
  var allTrue = { fourHour: true, daily: true, weekly: true, monthly: true };
  var state3b = { prefs: { autoBackupEnabled: allTrue } };
  var out3b = sandbox.migrate(state3b);
  assert('A3f: all-true autoBackupEnabled preserved', out3b.prefs.autoBackupEnabled === allTrue);
  assertEq('A3g: all-true daily preserved', out3b.prefs.autoBackupEnabled.daily, true);
})();

// =====================================================================
// A4: syncSubset() never includes prefs (prefs are sync-excluded)
// =====================================================================
(function(){
  // Set up sandbox.S with prefs.autoBackupEnabled set
  var origS = syncSandbox.S;
  syncSandbox.S = {
    char: { name: 'Test', lvl: 1 },
    tasks: [{ id: 't1', title: 'Task1' }],
    rewards: [], tags: [], devices: [],
    an: { views: [], metrics: [] },
    history: [], charHistory: [], monthlyBackups: [],
    lastCron: 0, deletions: [],
    prefs: { autoBackupEnabled: { fourHour: true, daily: true, weekly: true, monthly: true } }
  };

  var sub = syncSandbox.syncSubset();

  assert('A4a: syncSubset() returns an object', sub !== null && typeof sub === 'object');
  assert('A4b: syncSubset() does NOT contain prefs key', !('prefs' in sub));
  assert('A4c: syncSubset() does NOT contain autoBackupEnabled key', !('autoBackupEnabled' in sub));

  // Verify sync subset still has the expected keys
  assert('A4d: syncSubset() has char', 'char' in sub);
  assert('A4e: syncSubset() has tasks', 'tasks' in sub);
  assert('A4f: syncSubset() has rewards', 'rewards' in sub);
  assert('A4g: syncSubset() has tags', 'tags' in sub);

  syncSandbox.S = origS;
})();

// ─── Final summary ────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(failures + ' auto-backup-sync-exclusion test(s) failed.');
  process.exit(1);
}
console.log('All auto-backup-sync-exclusion tests passed!');
process.exit(0);
