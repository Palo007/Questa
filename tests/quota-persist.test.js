// quota-persist.test.js -- #11a Quota failure resilience + #11b navigator.storage.persist()
//
// Q1..Q5 extract the REAL save() from app.js (via _extract's extractFunction)
// and run it in a vm sandbox, with every free identifier it reads or assigns
// either declared as a mutable sandbox binding or supplied as a stub/spy (see
// buildSave() below). They exercise the shipped quota/mirror/companion-key
// logic directly -- not a hand-written reimplementation of it.
//
// HISTORY (why P6 still exists): app.js deleted a deferred-write design on
// 2026-07-13 (P0-1): save() must be fully SYNCHRONOUS, because deferring the
// localStorage write meant save() returned before anything persisted and the
// pagehide flush lost data on an Android kill. Before this rewrite, the Q1..
// Q4 equivalents here were a hand-written model of save() that wrapped its
// commit in env.locks.request('questa-sync', ...) -- exactly the forbidden
// deferred-write shape P0-1 removed -- so a real regression of P0-1 could
// have shipped while these tests stayed green, because they tested the
// model, not app.js. P6 was added as the only assertion in this file that
// touched the real app.js, specifically to catch that drift.
// Now that Q1..Q5 load and run the real save(), P6 remains anyway as a
// second, cheap, static guard: even if a future edit changes save()'s shape
// enough that extraction starts failing loudly, P6 alone still catches a
// reintroduced live navigator.locks.request(...) call.
//
// P1..P5 are unchanged by this rewrite: they test the navigator.storage.
// persist() boot guard in isolation (a few lines of inline glue code, not
// save()) and still load nothing from app.js.
//
// Run: node tests/quota-persist.test.js   (also run by `node tests/run.js`)
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { extractFunction } = require('./_extract');

let failures = 0;
function assert(d, c) {
  if (c) console.log('[PASS] ' + d);
  else { console.error('[FAIL] ' + d); failures++; }
}
function assertEq(d, got, want) {
  if (got === want) console.log('[PASS] ' + d);
  else { console.error('[FAIL] ' + d + ' -- got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; }
}

// ═══════════════════════════════════════════════════════════════════════
// Q1..Q5 — the REAL save() from app.js, run in a vm sandbox.
// ═══════════════════════════════════════════════════════════════════════

const STORE_KEY = 'questa.save.v1';
const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

// The extracted save(), plus two accessors so tests can observe what it did
// to its free variables. save()'s companion-key adopt path (near the end of
// the function) does `S = migrate(storedObj)` -- a wholesale REASSIGNMENT,
// not a mutation of the object passed in -- so reading S back through a
// closure (getS) is required; a passed-in object's own properties alone
// would not show that. _stateWritePromise is likewise a plain reassigned
// binding, not an object property, so it gets the same treatment.
const saveCode = [
  extractFunction(appSrc, /^function save\(\)\{/, 'save'),
  'return { save: save, getS: function(){ return S; }, getStateWritePromise: function(){ return _stateWritePromise; } };'
].join('\n');

// Mock localStorage. `failKeys` (a Set) makes setItem throw a
// QuotaExceededError for the listed keys; every other key behaves like a
// plain synchronous store, INCLUDING the STORE_KEY + ".seq" companion key
// save() checks before it commits. Getting that companion key right is the
// crux of this file: if it silently stays absent or stale, save()'s own
// clobber check (which reads it BEFORE committing) never fires and Q1-Q4
// would pass while testing nothing, or fires when it shouldn't and every
// save takes the adopt-and-return path instead of committing at all.
function makeLocalStorage(opts) {
  opts = opts || {};
  var store = Object.assign({}, opts.initial || {});
  var failKeys = opts.failKeys || null;
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) {
      if (failKeys && failKeys.has(k)) {
        var err = new Error("Failed to execute 'setItem': exceeded the quota");
        err.name = 'QuotaExceededError';
        throw err;
      }
      store[k] = String(v);
    },
    removeItem: function (k) { delete store[k]; }
  };
}

// Builds a fresh sandbox and runs saveCode in it (same vm.Script(...)
// .runInNewContext(sb) shape the other app.js slice tests use, e.g.
// tests/cron-day-rewind.test.js), returning { save, getS,
// getStateWritePromise, calls }. The typeof-guarded identifiers in save()
// (logEvent, toast, scheduleSync, _adoptStateStamps, render, _qDiagPush) are
// wired up as spies here, rather than omitted, so Q1-Q5 can assert on them;
// `calls` collects what each spy saw.
function buildSave(overrides) {
  overrides = overrides || {};
  var calls = { logEvent: [], toast: [], scheduleSync: 0, adoptStateStamps: 0, render: 0, qDiagPush: [] };
  var sb = {
    S: overrides.S,
    _charSig: overrides._charSig || function () { return 'sig'; },
    _prevCharSig: null,
    now: overrides.now || function () { return Date.now(); },
    IS_DIRTY: false,
    STORE_KEY: STORE_KEY,
    localStorage: overrides.localStorage,
    _idbWriteState: overrides._idbWriteState,
    _stateWritePromise: undefined,
    migrate: overrides.migrate || function (x) { return x; },
    JSON: JSON, Number: Number, Date: Date,
    syncIsApplying: overrides.syncIsApplying,
    logEvent: function (ev) { calls.logEvent.push(ev); },
    toast: function (msg) { calls.toast.push(msg); },
    scheduleSync: function () { calls.scheduleSync++; },
    _adoptStateStamps: function () { calls.adoptStateStamps++; },
    render: function () { calls.render++; },
    _qDiagPush: function (kind, detail) { calls.qDiagPush.push({ kind: kind, detail: detail }); }
  };
  var names = Object.keys(sb);
  var f = new vm.Script('(function(' + names.join(',') + '){ "use strict";\n' + saveCode + '\n})')
    .runInNewContext(sb);
  var result = f.apply(null, names.map(function (n) { return sb[n]; }));
  result.calls = calls;
  return result;
}

// Calls the real save() and, if it kicked off the fire-and-forget IDB mirror
// write, waits for that promise to settle -- the quota-toast and
// mirror-failure reporting both happen in its .then/.catch, not inline.
async function runSave(h) {
  h.save();
  var p = h.getStateWritePromise();
  if (p) await p;
}

// 2026-09-19 (round 3): parse-or-null. An assertion must never be the thing
// that throws -- see the header note about aborted runs hiding later sections.
function jparse(s){ try{ return JSON.parse(s); }catch(e){ return null; } }
function at(arr, i){ return (arr && arr[i]) || {}; }

async function main() {

// ── Q1: QuotaExceededError on localStorage.setItem → IDB mirror still
//        written, error surfaced (logEvent quotaError + toast), __seq still
//        advanced, companion .seq key left untouched.
{
  var ls = makeLocalStorage({ failKeys: new Set([STORE_KEY]) });
  var idbWrites = [];
  var h = buildSave({
    S: { tasks: [{ id: 't1', title: 'Test' }], __seq: 4 },
    localStorage: ls,
    _idbWriteState: function (json) { idbWrites.push(json); return Promise.resolve(); }
  });

  await runSave(h);
  var s = h.getS();

  assertEq('Q1a: __seq advanced despite quota error', s.__seq, 5);
  assert('Q1b: IDB mirror write was attempted', idbWrites.length === 1);
  assertEq('Q1c: IDB write contains the bumped state', (jparse(idbWrites[0]) || {}).__seq, 5);
  assertEq('Q1d: toast called with quota message', h.calls.toast.length, 1);
  assert('Q1e: toast message mentions quota', h.calls.toast[0].toLowerCase().indexOf('quota') >= 0);
  assert('Q1f: logEvent quotaError fired', h.calls.logEvent.some(function (e) { return e.kind === 'quotaError'; }));
  assertEq('Q1g: scheduleSync was called', h.calls.scheduleSync, 1);
  assertEq('Q1h: companion .seq key was not written (setItem threw before reaching it)', ls.getItem(STORE_KEY + '.seq'), null);
}

// ── Q2: normal write (no quota error) → localStorage written, companion
//        .seq key kept in sync, IDB mirror written, no quota toast.
{
  var ls = makeLocalStorage();
  var idbWrites = [];
  var h = buildSave({
    S: { tasks: [{ id: 't1' }], __seq: 4 },
    localStorage: ls,
    _idbWriteState: function (json) { idbWrites.push(json); return Promise.resolve(); }
  });

  await runSave(h);
  var s = h.getS();

  assertEq('Q2a: __seq advanced normally', s.__seq, 5);
  assert('Q2b: localStorage was written', ls.getItem(STORE_KEY) !== null);
  assertEq('Q2c: companion .seq key matches __seq', ls.getItem(STORE_KEY + '.seq'), '5');
  assertEq('Q2d: IDB mirror written', idbWrites.length, 1);
  assertEq('Q2e: no toast on success', h.calls.toast.length, 0);
  assertEq('Q2f: no quotaError event', h.calls.logEvent.filter(function (e) { return e.kind === 'quotaError'; }).length, 0);
  assertEq('Q2g: scheduleSync called', h.calls.scheduleSync, 1);
}

// ── Q3: multiple saves, all hitting the quota error → __seq still
//        progresses correctly across calls (the in-memory bump does not
//        depend on localStorage.setItem succeeding).
{
  var ls = makeLocalStorage({ failKeys: new Set([STORE_KEY]) });
  var idbWrites = [];
  var h = buildSave({
    S: { tasks: [], __seq: 0 },
    localStorage: ls,
    _idbWriteState: function (json) { idbWrites.push(json); return Promise.resolve(); }
  });

  await runSave(h);
  assertEq('Q3a: first save seq is 1', h.getS().__seq, 1);

  h.getS().tasks.push({ id: 't1' });
  await runSave(h);
  assertEq('Q3b: second save seq is 2', h.getS().__seq, 2);

  h.getS().tasks.push({ id: 't2' });
  await runSave(h);
  assertEq('Q3c: third save seq is 3', h.getS().__seq, 3);
  assertEq('Q3d: three IDB writes despite all quota failures', idbWrites.length, 3);
  assertEq('Q3e: last IDB write has seq 3', (jparse(idbWrites[2]) || {}).__seq, 3);
}

// ── Q4: the quotaError logEvent has the right shape.
{
  var ls = makeLocalStorage({ failKeys: new Set([STORE_KEY]) });
  var h = buildSave({
    S: { tasks: [], __seq: 7 },
    localStorage: ls,
    _idbWriteState: function () { return Promise.resolve(); }
  });

  await runSave(h);

  var qe = h.calls.logEvent.filter(function (e) { return e.kind === 'quotaError'; });
  assertEq('Q4a: exactly one quotaError event', qe.length, 1);
  assert('Q4b: event has message field', typeof at(qe, 0).message === 'string');
  assert('Q4c: message mentions quota', String(at(qe, 0).message || '').toLowerCase().indexOf('quota') >= 0);
}

// ── Q5 (new): a newer companion .seq key (as if another tab already
//        committed) makes save() ADOPT the stored state and return WITHOUT
//        committing this tab's edit. This is the fast synchronous check
//        that replaced the old Web-Locks read-check-write (see the history
//        note above P6) and it was completely untested before this rewrite.
{
  var storedState = { tasks: [{ id: 'from-other-tab' }], __seq: 10, __savedAt: 999 };
  var ls = makeLocalStorage();
  ls.setItem(STORE_KEY, JSON.stringify(storedState));
  ls.setItem(STORE_KEY + '.seq', '10');

  var idbWrites = [];
  var h = buildSave({
    S: { tasks: [{ id: 'local-unsaved' }], __seq: 4 },
    localStorage: ls,
    _idbWriteState: function (json) { idbWrites.push(json); return Promise.resolve(); }
  });

  await runSave(h);
  var s = h.getS();

  assertEq('Q5a: adopted the stored state instead of keeping the local edit', s.tasks[0].id, 'from-other-tab');
  assertEq('Q5b: adopted __seq matches the stored seq', s.__seq, 10);
  assert('Q5c: multiTabClobberAvoided logEvent fired', h.calls.logEvent.some(function (e) { return e.kind === 'multiTabClobberAvoided'; }));
  var clobberEv = h.calls.logEvent.filter(function (e) { return e.kind === 'multiTabClobberAvoided'; })[0];
  assertEq('Q5d: clobber event carries the pre-bump seq', clobberEv.preBumpSeq, 4);
  assertEq('Q5e: clobber event carries the stored seq', clobberEv.storedSeq, 10);
  assertEq('Q5f: _adoptStateStamps was called', h.calls.adoptStateStamps, 1);
  assertEq('Q5g: render was called', h.calls.render, 1);
  assert('Q5h: toast warns the local change was not kept', h.calls.toast.some(function (t) { return t.toLowerCase().indexOf('not kept') >= 0; }));
  assertEq('Q5i: _idbWriteState was NOT called (adopt path returns before _saveCommit)', idbWrites.length, 0);
  assertEq('Q5j: nothing new was committed to localStorage', (jparse(ls.getItem(STORE_KEY)) || {}).__seq, 10);
}

// ═══════════════════════════════════════════════════════════════════════
// #11b — navigator.storage.persist() at boot
// ═══════════════════════════════════════════════════════════════════════

// ── P1: persist() called → logEvent with granted=true ─────────────────
{
  var persistCalled = false;
  var grantedValue = null;
  var events = [];

  var navigator = {
    storage: {
      persist: function() {
        persistCalled = true;
        return Promise.resolve(true);
      }
    }
  };

  var logEvent = function(ev) { events.push(ev); };

  // Simulate the boot-time persist guard (exactly as shipped):
  try{ if(navigator&&navigator.storage&&typeof navigator.storage.persist==='function'){ navigator.storage.persist().then(function(granted){ if(typeof logEvent==='function') logEvent({kind:'storagePersist', granted:!!granted}); }).catch(function(){}); } }catch(_){}

  // persist is async, wait for it
  await new Promise(function(r) { setTimeout(r, 10); });

  assert('P1a: persist() was called', persistCalled);
  assertEq('P1b: logEvent has storagePersist kind', events.length, 1);
  assertEq('P1c: logEvent granted is true', at(events, 0).granted, true);
}

// ── P2: persist() denied → logEvent with granted=false ────────────────
{
  var persistCalled = false;
  var events = [];

  var navigator = {
    storage: {
      persist: function() {
        persistCalled = true;
        return Promise.resolve(false);
      }
    }
  };

  var logEvent = function(ev) { events.push(ev); };

  try{ if(navigator&&navigator.storage&&typeof navigator.storage.persist==='function'){ navigator.storage.persist().then(function(granted){ if(typeof logEvent==='function') logEvent({kind:'storagePersist', granted:!!granted}); }).catch(function(){}); } }catch(_){}

  await new Promise(function(r) { setTimeout(r, 10); });

  assert('P2a: persist() was called even when denied', persistCalled);
  assertEq('P2b: logEvent granted is false', at(events, 0).granted, false);
}

// ── P3: navigator.storage missing → no throw, no crash ────────────────
{
  var events = [];
  var navigator = {};  // no storage
  var logEvent = function(ev) { events.push(ev); };

  // Should NOT throw
  try{ if(navigator&&navigator.storage&&typeof navigator.storage.persist==='function'){ navigator.storage.persist().then(function(granted){ if(typeof logEvent==='function') logEvent({kind:'storagePersist', granted:!!granted}); }).catch(function(){}); } }catch(_){}

  await new Promise(function(r) { setTimeout(r, 10); });
  assertEq('P3a: no logEvent when storage unavailable', events.length, 0);
}

// ── P4: navigator.storage.persist throws → no crash, catch swallows ──
{
  var events = [];
  var navigator = {
    storage: {
      persist: function() { return Promise.reject(new Error('not allowed')); }
    }
  };
  var logEvent = function(ev) { events.push(ev); };

  // Should NOT throw
  try{ if(navigator&&navigator.storage&&typeof navigator.storage.persist==='function'){ navigator.storage.persist().then(function(granted){ if(typeof logEvent==='function') logEvent({kind:'storagePersist', granted:!!granted}); }).catch(function(){}); } }catch(_){}

  await new Promise(function(r) { setTimeout(r, 10); });
  assertEq('P4a: no logEvent when persist rejects', events.length, 0);
}

// ── P5: navigator entirely missing (older env) → no throw ─────────────
{
  var events = [];
  // No navigator at all (simulated by undefined)
  var navigator;  // undefined
  var logEvent = function(ev) { events.push(ev); };

  try{ if(navigator&&navigator.storage&&typeof navigator.storage.persist==='function'){ navigator.storage.persist().then(function(granted){ if(typeof logEvent==='function') logEvent({kind:'storagePersist', granted:!!granted}); }).catch(function(){}); } }catch(_){}

  await new Promise(function(r) { setTimeout(r, 10); });
  assertEq('P5a: no logEvent when navigator undefined', events.length, 0);
}

// ── P6: the real app.js save() must stay synchronous ──────────────────
// The only assertion here that touches the shipped file. If someone
// reintroduces the deferred navigator.locks write that P0-1 removed, every
// other test in this file keeps passing -- this one does not.
function p6_realAppSaveIsSynchronous(){
  var fs = require('fs'), path = require('path');
  var src = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  // Crude but sufficient: strip // line comments, then look for a LIVE call.
  // String.fromCharCode(10) rather than an escape so this line survives being
  // moved through shells and generators.
  var NL = String.fromCharCode(10);
  var code = src.split(NL).map(function(line){
    var i = line.indexOf('//');
    return i === -1 ? line : line.slice(0, i);
  }).join(NL);
  var live = (code.match(/locks\s*\.\s*request\s*\(/g) || []).length;
  assertEq('P6a: app.js has NO live navigator.locks.request() call (P0-1 stays fixed)', live, 0);
  // ...and the reason is still written down for the next reader.
  assert('P6b: app.js still documents why save() is synchronous',
    src.indexOf('save() must be fully SYNCHRONOUS') !== -1);
}
p6_realAppSaveIsSynchronous();

} // end main

// ── Run + Exit ────────────────────────────────────────────────────────
main().then(function() {
  if (failures > 0) { console.error(failures + ' quota-persist test(s) failed.'); process.exit(1); }
  console.log('All quota-persist tests passed!');
  process.exit(0);
}, function(err) {
  console.error('quota-persist test error:', err);
  process.exit(1);
});
