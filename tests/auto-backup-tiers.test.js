// auto-backup-tiers.test.js -- plan todo #14: defaults, migration map, setter
// Tests:
//   T1: freshState() defaults — autoBackupEnabled has all 4 tiers false
//   T2: migrate() migration map — 7 cases of exportIntervalDays → autoBackupEnabled
//   T3: setAutoBackupTiers(patch) — merges patch, calls save()
//
// Run: node tests/auto-backup-tiers.test.js
//      (also run by `node tests/run.js`)
const fs = require('fs'), path = require('path'), vm = require('vm');

// ─── In-memory IndexedDB shim ─────────────────────────────────────────────
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

// ─── Validate sandbox loaded correctly ────────────────────────────────────
if (typeof sandbox.freshState !== 'function') {
  console.error('FAIL: freshState not found in app.js sandbox');
  process.exit(1);
}
if (typeof sandbox.migrate !== 'function') {
  console.error('FAIL: migrate not found in app.js sandbox');
  process.exit(1);
}
if (typeof sandbox.setAutoBackupTiers !== 'function') {
  console.error('FAIL: setAutoBackupTiers not found in app.js sandbox');
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
// T1: freshState() defaults — all 4 tiers default to false
// =====================================================================
(function(){
  var s = sandbox.freshState();
  var ab = s.prefs && s.prefs.autoBackupEnabled;

  assert('T1a: freshState() has prefs.autoBackupEnabled', ab !== null && ab !== undefined && typeof ab === 'object');
  assertEq('T1b: autoBackupEnabled.fourHour defaults to false', ab.fourHour, false);
  assertEq('T1c: autoBackupEnabled.daily defaults to false', ab.daily, false);
  assertEq('T1d: autoBackupEnabled.weekly defaults to false', ab.weekly, false);
  assertEq('T1e: autoBackupEnabled.monthly defaults to false', ab.monthly, false);
})();

// =====================================================================
// T2: migrate() migration map — all 7 exportIntervalDays cases
// =====================================================================
(function(){
  // T2a: exportIntervalDays=1 → daily=true, others false
  var s1 = { prefs: { exportIntervalDays: 1 } };
  var o1 = sandbox.migrate(s1);
  assert('T2a: days=1 produces autoBackupEnabled', o1.prefs.autoBackupEnabled !== undefined);
  assertEq('T2b: days=1 → daily=true', o1.prefs.autoBackupEnabled.daily, true);
  assertEq('T2c: days=1 → fourHour=false', o1.prefs.autoBackupEnabled.fourHour, false);
  assertEq('T2d: days=1 → weekly=false', o1.prefs.autoBackupEnabled.weekly, false);
  assertEq('T2e: days=1 → monthly=false', o1.prefs.autoBackupEnabled.monthly, false);

  // T2f: exportIntervalDays=3 → daily=true, others false
  var s3 = { prefs: { exportIntervalDays: 3 } };
  var o3 = sandbox.migrate(s3);
  assertEq('T2f: days=3 → daily=true', o3.prefs.autoBackupEnabled.daily, true);
  assertEq('T2g: days=3 → fourHour=false', o3.prefs.autoBackupEnabled.fourHour, false);
  assertEq('T2h: days=3 → weekly=false', o3.prefs.autoBackupEnabled.weekly, false);
  assertEq('T2i: days=3 → monthly=false', o3.prefs.autoBackupEnabled.monthly, false);

  // T2j: exportIntervalDays=7 → weekly=true, others false
  var s7 = { prefs: { exportIntervalDays: 7 } };
  var o7 = sandbox.migrate(s7);
  assertEq('T2j: days=7 → weekly=true', o7.prefs.autoBackupEnabled.weekly, true);
  assertEq('T2k: days=7 → fourHour=false', o7.prefs.autoBackupEnabled.fourHour, false);
  assertEq('T2l: days=7 → daily=false', o7.prefs.autoBackupEnabled.daily, false);
  assertEq('T2m: days=7 → monthly=false', o7.prefs.autoBackupEnabled.monthly, false);

  // T2n: exportIntervalDays=14 → monthly=true, others false + autoBackupMigratedToast=true
  var s14 = { prefs: { exportIntervalDays: 14 } };
  var o14 = sandbox.migrate(s14);
  assertEq('T2n: days=14 → monthly=true', o14.prefs.autoBackupEnabled.monthly, true);
  assertEq('T2o: days=14 → fourHour=false', o14.prefs.autoBackupEnabled.fourHour, false);
  assertEq('T2p: days=14 → daily=false', o14.prefs.autoBackupEnabled.daily, false);
  assertEq('T2q: days=14 → weekly=false', o14.prefs.autoBackupEnabled.weekly, false);
  assertEq('T2r: days=14 → autoBackupMigratedToast=true', o14.prefs.autoBackupMigratedToast, true);

  // T2s: exportIntervalDays=30 → monthly=true, others false
  var s30 = { prefs: { exportIntervalDays: 30 } };
  var o30 = sandbox.migrate(s30);
  assertEq('T2s: days=30 → monthly=true', o30.prefs.autoBackupEnabled.monthly, true);
  assertEq('T2t: days=30 → fourHour=false', o30.prefs.autoBackupEnabled.fourHour, false);
  assertEq('T2u: days=30 → daily=false', o30.prefs.autoBackupEnabled.daily, false);
  assertEq('T2v: days=30 → weekly=false', o30.prefs.autoBackupEnabled.weekly, false);

  // T2w: exportIntervalDays=0 → all false
  var s0 = { prefs: { exportIntervalDays: 0 } };
  var o0 = sandbox.migrate(s0);
  assertEq('T2w: days=0 → all false (fourHour)', o0.prefs.autoBackupEnabled.fourHour, false);
  assertEq('T2x: days=0 → all false (daily)', o0.prefs.autoBackupEnabled.daily, false);
  assertEq('T2y: days=0 → all false (weekly)', o0.prefs.autoBackupEnabled.weekly, false);
  assertEq('T2z: days=0 → all false (monthly)', o0.prefs.autoBackupEnabled.monthly, false);

  // T2aa: absent (no exportIntervalDays) → all false
  var sAbs = { prefs: {} };
  var oAbs = sandbox.migrate(sAbs);
  assertEq('T2aa: absent → all false (fourHour)', oAbs.prefs.autoBackupEnabled.fourHour, false);
  assertEq('T2ab: absent → all false (daily)', oAbs.prefs.autoBackupEnabled.daily, false);
  assertEq('T2ac: absent → all false (weekly)', oAbs.prefs.autoBackupEnabled.weekly, false);
  assertEq('T2ad: absent → all false (monthly)', oAbs.prefs.autoBackupEnabled.monthly, false);
})();

// =====================================================================
// T3: setAutoBackupTiers(patch) — merges patch, saves
// =====================================================================
(function(){
  // Set up S.prefs.autoBackupEnabled with known starting state
  sandbox.S = sandbox.S || {};
  sandbox.S.prefs = sandbox.S.prefs || {};
  sandbox.S.prefs.autoBackupEnabled = { fourHour: false, daily: false, weekly: false, monthly: false };

  // T3a: merge { daily: true } — only daily flips
  try { sandbox.setAutoBackupTiers({ daily: true }); } catch(e) { /* save/closeOpt/openSettings may throw */ }
  assertEq('T3a: patch {daily:true} → daily=true', sandbox.S.prefs.autoBackupEnabled.daily, true);
  assertEq('T3b: patch {daily:true} → fourHour still false', sandbox.S.prefs.autoBackupEnabled.fourHour, false);
  assertEq('T3c: patch {daily:true} → weekly still false', sandbox.S.prefs.autoBackupEnabled.weekly, false);
  assertEq('T3d: patch {daily:true} → monthly still false', sandbox.S.prefs.autoBackupEnabled.monthly, false);

  // T3e: merge { weekly: true, fourHour: true } — two tiers flip
  try { sandbox.setAutoBackupTiers({ weekly: true, fourHour: true }); } catch(e) {}
  assertEq('T3e: patch {weekly:true,fourHour:true} → weekly=true', sandbox.S.prefs.autoBackupEnabled.weekly, true);
  assertEq('T3f: patch → fourHour=true', sandbox.S.prefs.autoBackupEnabled.fourHour, true);
  assertEq('T3g: patch → daily still true from before', sandbox.S.prefs.autoBackupEnabled.daily, true);
  assertEq('T3h: patch → monthly still false', sandbox.S.prefs.autoBackupEnabled.monthly, false);

  // T3i: merge { daily: false } — toggle off, others unchanged
  try { sandbox.setAutoBackupTiers({ daily: false }); } catch(e) {}
  assertEq('T3i: patch {daily:false} → daily=false', sandbox.S.prefs.autoBackupEnabled.daily, false);
  assertEq('T3j: fourHour still true', sandbox.S.prefs.autoBackupEnabled.fourHour, true);
  assertEq('T3k: weekly still true', sandbox.S.prefs.autoBackupEnabled.weekly, true);

  // T3l: fresh start — patch into missing autoBackupEnabled
  sandbox.S.prefs.autoBackupEnabled = undefined;
  try { sandbox.setAutoBackupTiers({ monthly: true }); } catch(e) {}
  assert('T3l: patch into missing autoBackupEnabled creates it', sandbox.S.prefs.autoBackupEnabled !== undefined);
  assertEq('T3m: monthly=true', sandbox.S.prefs.autoBackupEnabled.monthly, true);
  assertEq('T3n: fourHour=false (defaulted)', sandbox.S.prefs.autoBackupEnabled.fourHour, false);
  assertEq('T3o: daily=false (defaulted)', sandbox.S.prefs.autoBackupEnabled.daily, false);
  assertEq('T3p: weekly=false (defaulted)', sandbox.S.prefs.autoBackupEnabled.weekly, false);
})();

// ─── Final summary ────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(failures + ' auto-backup-tiers test(s) failed.');
  process.exit(1);
}
console.log('All auto-backup-tiers tests passed!');
process.exit(0);
