// multi-tab.test.js -- #10 Multi-tab clobber protection
//
// 2026-07-13 P0-1 REWRITE: save() was changed from an async
// navigator.locks.request()-wrapped commit to a fully SYNCHRONOUS commit
// (the lock-based design deferred the actual localStorage write into the
// lock callback, so save() returned before anything persisted -- an OS kill
// between pagehide and lock grant lost the edit on Android). Web Locks are
// gone from save() entirely; multi-tab clobber detection now uses a tiny
// companion key (STORE_KEY + ".seq") that's cheap to read on every save
// without parsing the full stored blob, falling back to a full parse only
// in the rare case where another tab already wrote a higher seq.
//
// This file no longer hand-rolls a mock of the lock-based algorithm (that
// mock could -- and did -- silently drift from what app.js actually does).
// It now extracts and executes the LIVE save() straight out of app.js via
// the BEGIN/END_DURABLE_STATE_HELPERS marker block, the same technique
// archive/tests/lifecycle-event-filter-tests.js uses for its T4.
//
// Run: node tests/multi-tab.test.js   (also run by `node tests/run.js`)
'use strict';
const fs = require('fs'), path = require('path');

let failures = 0;
function assert(d, c) {
  if (c) console.log('[PASS] ' + d);
  else { console.error('[FAIL] ' + d); failures++; }
}
function assertEq(d, got, want) {
  if (got === want) console.log('[PASS] ' + d);
  else { console.error('[FAIL] ' + d + ' -- got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; }
}

const appCode = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const durableMatch = appCode.match(/\/\* BEGIN_DURABLE_STATE_HELPERS \*\/([\s\S]*?)\/\* END_DURABLE_STATE_HELPERS \*\//);
if (!durableMatch) { console.error('FAIL: could not find BEGIN/END_DURABLE_STATE_HELPERS block in app.js'); process.exit(1); }

// ── Mock localStorage (key-value store, synchronous like the real thing) ──
function makeLocalStorage() {
  var store = {};
  return {
    getItem: function(k) { return (k in store) ? store[k] : null; },
    setItem: function(k, v) { store[k] = String(v); },
    removeItem: function(k) { delete store[k]; },
    _store: store
  };
}

// ── Fake IDB used only for the fire-and-forget durable mirror; the
// synchronous contract under test never depends on this resolving. ────────
function makeFakeIdbOpen() {
  return function() {
    return Promise.resolve({
      transaction: function() {
        var tx = { oncomplete: null, onerror: null, onabort: null };
        tx.objectStore = function() { return { put: function() { setTimeout(function(){ if (tx.oncomplete) tx.oncomplete(); }, 0); } }; };
        return tx;
      }
    });
  };
}

// Loads a fresh copy of the live save()/_saveCommit/storage-listener code
// from app.js into an isolated sandbox for each test, so tests can't leak
// state (S, listeners) into one another.
function loadSaveHelpers(initialS) {
  var listeners = [];
  var fakeWindow = { addEventListener: function(type, fn) { if (type === 'storage') listeners.push(fn); } };
  var ls = makeLocalStorage();
  var renders = 0;
  var events = [];
  var scheduleSyncCalls = 0;
  var toasts = [];

  var body =
    'let S = globals.S;\n' +
    'let IS_DIRTY = false;\n' +
    'const STORE_KEY = globals.STORE_KEY;\n' +
    'const localStorage = globals.localStorage;\n' +
    'const window = globals.window;\n' +
    'const migrate = function(x){ return x; };\n' +
    'const render = globals.render;\n' +
    'const logEvent = globals.logEvent;\n' +
    'const toast = globals.toast;\n' +
    'const syncIsApplying = function(){ return false; };\n' +
    'const scheduleSync = globals.scheduleSync;\n' +
    'const idbOpen = globals.idbOpen;\n' +
    'const now = function(){ return Date.now(); };\n' +
    'let _prevCharSig = null;\n' +
    'function _charSig(c){ if(!c) return ""; var o={}; for(var k in c){ if(k!=="updatedAt") o[k]=c[k]; } try{ return JSON.stringify(o); }catch(e){ return ""; } }\n' +
    durableMatch[1] + '\n' +
    'return { save: save, getS: function(){ return S; } };';

  var fn = new Function('globals', body);
  var helpers = fn({
    S: initialS,
    STORE_KEY: 'questa.save.v1',
    localStorage: ls,
    window: fakeWindow,
    render: function() { renders++; },
    logEvent: function(ev) { events.push(ev); },
    toast: function(msg) { toasts.push(msg); },
    scheduleSync: function() { scheduleSyncCalls++; },
    idbOpen: makeFakeIdbOpen()
  });

  return {
    save: helpers.save,
    getS: helpers.getS,
    localStorage: ls,
    getRenders: function() { return renders; },
    getEvents: function() { return events; },
    getScheduleSyncCalls: function() { return scheduleSyncCalls; },
    getToasts: function() { return toasts; },
    storageListeners: listeners
  };
}

// ═══════════════════════════════════════════════════════════════════════

// ── T-SYNC: THE regression test for the Android kill-path data-loss bug.
// save() must leave localStorage already updated the instant it returns --
// no awaiting a lock, no next microtask/tick required. ────────────────────
{
  var h = loadSaveHelpers({ tasks: [{ id: 't1' }], char: {}, __seq: 0 });
  h.save();
  // No await, no setTimeout -- read localStorage synchronously right after
  // save() returns, in the same JS turn.
  var stored = JSON.parse(h.localStorage.getItem('questa.save.v1'));
  assertEq('T-SYNC a: localStorage reflects new state synchronously after save() returns', stored.__seq, 1);
  assertEq('T-SYNC b: localStorage carries the saved task', stored.tasks[0].id, 't1');
  assertEq('T-SYNC c: scheduleSync was invoked (not deferred behind a lock)', h.getScheduleSyncCalls(), 1);
}

// ── T-COMPANION: companion seq key is written alongside the state key ────
{
  var h = loadSaveHelpers({ tasks: [], char: {}, __seq: 0 });
  h.save();
  assertEq('T-COMPANION a: companion key written after first save', h.localStorage.getItem('questa.save.v1.seq'), '1');
  h.save();
  assertEq('T-COMPANION b: companion key advances on second save', h.localStorage.getItem('questa.save.v1.seq'), '2');
}

// ── T-CLOBBER: pre-seeded companion key with a higher seq + a valid stored
// state → save() adopts the stored state, logs multiTabClobberAvoided, and
// does NOT overwrite it with the (older) in-memory write. ────────────────
{
  var h = loadSaveHelpers({ tasks: [{ id: 'mine' }], char: {}, __seq: 2 });
  var otherTabState = { tasks: [{ id: 'other-tab' }], char: {}, __seq: 5, __savedAt: 12345 };
  h.localStorage.setItem('questa.save.v1', JSON.stringify(otherTabState));
  h.localStorage.setItem('questa.save.v1.seq', '5');

  h.save();

  var stored = JSON.parse(h.localStorage.getItem('questa.save.v1'));
  assertEq('T-CLOBBER a: stored state is untouched (still the other tab\'s write)', stored.tasks[0].id, 'other-tab');
  assertEq('T-CLOBBER b: stored seq unchanged at 5', stored.__seq, 5);
  assertEq('T-CLOBBER c: in-memory S adopted the stored (newer) state', h.getS().tasks[0].id, 'other-tab');
  var clobber = h.getEvents().filter(function(e) { return e.kind === 'multiTabClobberAvoided'; });
  assertEq('T-CLOBBER d: exactly one clobber event logged', clobber.length, 1);
  assertEq('T-CLOBBER e: event carries preBumpSeq', clobber[0].preBumpSeq, 2);
  assertEq('T-CLOBBER f: event carries storedSeq', clobber[0].storedSeq, 5);
  assertEq('T-CLOBBER g: render() called once for the adoption', h.getRenders(), 1);
}

// ── T-LEGACY: companion key absent (first run / pre-upgrade localStorage)
// → skip the check, commit normally. ──────────────────────────────────────
{
  var h = loadSaveHelpers({ tasks: [{ id: 't1' }], char: {}, __seq: 4 });
  assertEq('T-LEGACY setup: no companion key present yet', h.localStorage.getItem('questa.save.v1.seq'), null);
  h.save();
  var stored = JSON.parse(h.localStorage.getItem('questa.save.v1'));
  assertEq('T-LEGACY a: commit proceeds normally with no companion key', stored.__seq, 5);
  assertEq('T-LEGACY b: no clobber event fired', h.getEvents().filter(function(e) { return e.kind === 'multiTabClobberAvoided'; }).length, 0);
}

// ── T-SEQUENTIAL: same-tab repeated saves never self-clobber ─────────────
{
  var h = loadSaveHelpers({ tasks: [{ id: 't1' }], char: {}, __seq: 0 });
  h.save();
  assertEq('T-SEQUENTIAL a: first save -> seq 1', h.getS().__seq, 1);
  h.getS().tasks.push({ id: 't2' });
  h.save();
  assertEq('T-SEQUENTIAL b: second save -> seq 2', h.getS().__seq, 2);
  var stored = JSON.parse(h.localStorage.getItem('questa.save.v1'));
  assertEq('T-SEQUENTIAL c: two tasks in final stored state', stored.tasks.length, 2);
  assertEq('T-SEQUENTIAL d: zero clobber events across sequential same-tab saves', h.getEvents().filter(function(e) { return e.kind === 'multiTabClobberAvoided'; }).length, 0);
}

// ── T-STORAGE-LISTENER: layer (b), the cross-tab storage event listener,
// still adopts a higher-seq incoming write and ignores a stale/equal one.
// (save() registers this listener as a side effect of loading the module;
// we invoke the captured handler directly, the way a real 'storage' event
// would, since Node has no cross-tab storage events to fire for real.) ───
{
  var h = loadSaveHelpers({ tasks: [{ id: 'old' }], char: {}, __seq: 3 });
  assert('T-STORAGE-LISTENER setup: listener was registered', h.storageListeners.length === 1);

  var incomingHigher = { tasks: [{ id: 'new' }], __seq: 5 };
  h.storageListeners[0]({ key: 'questa.save.v1', newValue: JSON.stringify(incomingHigher) });
  assertEq('T-STORAGE-LISTENER a: higher-seq incoming state adopted', h.getS().__seq, 5);
  assertEq('T-STORAGE-LISTENER b: adopted tasks reflect incoming', h.getS().tasks[0].id, 'new');
  assertEq('T-STORAGE-LISTENER c: render() called for the adoption', h.getRenders(), 1);

  var incomingStale = { tasks: [{ id: 'stale' }], __seq: 2 };
  h.storageListeners[0]({ key: 'questa.save.v1', newValue: JSON.stringify(incomingStale) });
  assertEq('T-STORAGE-LISTENER d: stale/lower-seq incoming state ignored', h.getS().__seq, 5);
  assertEq('T-STORAGE-LISTENER e: no extra render on ignored stale event', h.getRenders(), 1);

  h.storageListeners[0]({ key: 'some.other.key', newValue: JSON.stringify({ __seq: 99 }) });
  assertEq('T-STORAGE-LISTENER f: unrelated storage key ignored', h.getS().__seq, 5);
}

// ── Run + Exit ────────────────────────────────────────────────────────
if (failures > 0) { console.error(failures + ' multi-tab test(s) failed.'); process.exit(1); }
console.log('All multi-tab tests passed!');
process.exit(0);
