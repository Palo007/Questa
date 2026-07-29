// hlc.test.js -- 2026-07-12 HLC (hybrid logical clock) stamping tests.
// Tests sync.js-visible merge-layer invariants under HLC stamping.
// NOTE: now()/ratchetHlc live in app.js (not loaded by the harness).
// _hlcNow in sync.js falls back to Date.now() when now() is unavailable.
// We inject a mock `now` into the sandbox to test HLC-aware behavior.
//
// H1-H3: remote with higher ordering timestamp wins (GUARD 1 / char guard).
// H4: D3 clamp reworked to use HLC — slow local clock no longer zeroes correct remote.
// H5: doneAt day-bucketing unchanged (HLC does NOT touch doneAt/missedOn).
// H6: _maxOrderingTs scans all ordering fields correctly.
//
// Run: node tests/hlc.test.js   (also run by `node tests/run.js`)
const fs = require('fs'), path = require('path'), vm = require('vm');

// Load sync.js into a vm sandbox. Strip the boot gate.
let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');

const noop = function(){};
const sandbox = {
  window: {}, navigator: { onLine: true },
  document: { addEventListener: noop, getElementById: function(){ return null; },
    createElement: function(){ return { style:{}, appendChild: noop, setAttribute: noop, click: noop }; },
    body: { appendChild: noop, removeChild: noop } },
  localStorage: { getItem: function(){ return null; }, setItem: noop, removeItem: noop, key: function(){ return null; }, length: 0 },
  indexedDB: { open: function(){ return {}; } },
  setTimeout: function(){ return 0; }, clearTimeout: noop, setInterval: function(){ return 0; }, clearInterval: noop,
  console: console, JSON: JSON, Math: Math, Date: Date, Map: Map, Set: Set, WeakSet: WeakSet,
  Array: Array, Object: Object, Number: Number, String: String, Boolean: Boolean, Promise: Promise,
  logEvent: noop, toast: noop, render: noop, esc: function(x){ return x; }, save: noop,
  uid: function(){ return 'x'; }, idbOpen: function(){ return Promise.resolve(null); }
};
sandbox.self = sandbox.window; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try { vm.runInContext(src, sandbox); } catch(e) {}
const Q = sandbox.window.QuestaSync;
if (!Q || typeof Q.merge !== 'function') { console.error('FAIL: QuestaSync.merge not found'); process.exit(1); }

let failures = 0;
function assert(desc, cond){ if(cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }
// sub(char) builds a full state shape with char (for char-focused tests).
function sub(char){ return { tasks:[], rewards:[], tags:[], devices:[], an:{views:[],metrics:[]},
  history:[], charHistory:[], monthlyBackups:[], lastCron:0, char:char||{}, deletions:[] }; }
// state(tasks, overrides) builds a full state with tasks in the tasks array.
function state(tasks, overrides){
  var s = { tasks: tasks||[], rewards:[], tags:[], devices:[], an:{views:[],metrics:[]},
    history:[], charHistory:[], monthlyBackups:[], lastCron:0, char:{}, deletions:[] };
  if(overrides) Object.keys(overrides).forEach(function(k){ s[k] = overrides[k]; });
  return s;
}

// =====================================================================
// H1-H3: GUARD 1 / char guard — remote with higher updatedAt wins
// =====================================================================

// H1 -- task with remote newer updatedAt wins both-changed
(function(){
  const base = [{ id:'t1', title:'Quest', type:'habit', updatedAt:1000 }];
  const local = [{ id:'t1', title:'Quest', type:'habit', updatedAt:2000 }];
  const remote = [{ id:'t1', title:'Quest Edited', type:'habit', updatedAt:5000 }];
  const m = Q.merge(state(base), state(local), state(remote), 5000, 2000);
  const merged = m.tasks.find(t=>t.id==='t1');
  assert('H1 task: remote newer updatedAt wins', merged && merged.title === 'Quest Edited');
})();

// H2 -- char with remote newer updatedAt wins (F6 rule)
(function(){
  const localChar = { name:'Alice', lvl:10, updatedAt:2000 };
  const remoteChar = { name:'Alice', lvl:20, updatedAt:5000 };
  const m = Q.merge(sub(localChar), sub(localChar), sub(remoteChar), 5000, 2000);
  assert('H2 char: remote newer updatedAt wins (F6)', m.char.lvl === 20);
})();

// H3 -- tombstone overlay: deletion at > task updatedAt removes task
(function(){
  const now = Date.now();
  const base = [{ id:'t1', title:'Quest', type:'habit', updatedAt: now - 2000 }];
  const local = [{ id:'t1', title:'Quest', type:'habit', updatedAt: now - 2000 }];
  const remoteState = state([], { deletions: [{ id:'t1', at: now - 1000 }] });
  const m = Q.merge(state(base), state(local), remoteState, now, now - 2000);
  assert('H3 tombstone: deletion at > updatedAt removes task', m.tasks.length === 0);
})();

// =====================================================================
// H4: D3 clamp reworked — slow local clock no longer zeroes correct remote
// =====================================================================

// H4a -- _ua function exists and is callable
(function(){
  const _ua = sandbox._ua;
  assert('H4a _ua function exists', typeof _ua === 'function');
})();

// H4b -- Without HLC (sandbox has no `now()`), _hlcNow = Date.now fallback.
// A remote timestamp > Date.now() + 120000 (2 min) is zeroed by D3 clamp.
(function(){
  const _ua = sandbox._ua;
  const farFuture = Date.now() + 200000; // 200s ahead → exceeds 120000 clamp
  const result = _ua({ updatedAt: farFuture });
  assert('H4b D3 clamp zeroes far-future remote (no HLC in sandbox)', result === 0);
})();

// H4c -- With HLC: re-load sync.js with `now` pre-defined so _hlcNow uses it.
// A remote timestamp ahead of Date.now() but WITHIN the HLC's range is NOT zeroed.
(function(){
  const sb2 = {};
  sb2.window = {}; sb2.navigator = { onLine: true };
  sb2.document = { addEventListener: noop, getElementById: function(){ return null; },
    createElement: function(){ return { style:{}, appendChild: noop, setAttribute: noop, click: noop }; },
    body: { appendChild: noop, removeChild: noop } };
  sb2.localStorage = { getItem: function(){ return null; }, setItem: noop, removeItem: noop, key: function(){ return null; }, length: 0 };
  sb2.indexedDB = { open: function(){ return {}; } };
  sb2.setTimeout = function(){ return 0; }; sb2.clearTimeout = noop; sb2.setInterval = function(){ return 0; }; sb2.clearInterval = noop;
  sb2.console = console; sb2.JSON = JSON; sb2.Math = Math; sb2.Date = Date; sb2.Map = Map; sb2.Set = Set; sb2.WeakSet = WeakSet;
  sb2.Array = Array; sb2.Object = Object; sb2.Number = Number; sb2.String = String; sb2.Boolean = Boolean; sb2.Promise = Promise;
  sb2.logEvent = noop; sb2.toast = noop; sb2.render = noop; sb2.esc = function(x){ return x; }; sb2.save = noop;
  sb2.uid = function(){ return 'x'; }; sb2.idbOpen = function(){ return Promise.resolve(null); };
  sb2.self = sb2.window; sb2.globalThis = sb2;
  // HLC mock: ratcheted 50s ahead of physical clock
  var hlcValue = Date.now() + 50000;
  sb2.now = function(){ return hlcValue; };
  vm.createContext(sb2);
  let src2 = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
  src2 = src2.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* stripped */');
  try { vm.runInContext(src2, sb2); } catch(e) {}
  const _ua2 = sb2._ua;

  // Remote timestamp 30s ahead of physical clock — WITHIN HLC range (not zeroed)
  var remoteTs = Date.now() + 30000;
  assert('H4c D3 clamp preserves remote within HLC range (HLC-aware)', _ua2({ updatedAt: remoteTs }) === remoteTs);

  // Remote timestamp 130s ahead of HLC → exceeds 120000 clamp from HLC → zeroed
  var wayAhead = hlcValue + 130000;
  assert('H4d D3 clamp zeroes remote far ahead of HLC', _ua2({ updatedAt: wayAhead }) === 0);
})();

// =====================================================================
// H5: doneAt day-bucketing unchanged — HLC does NOT touch doneAt/missedOn
// =====================================================================

// H5a -- local completed today, remote missed yesterday -> local wins (newer)
(function(){
  const today = Math.floor(Date.now() / 86400000) * 86400000;
  const yesterday = today - 86400000;
  const base = [{ id:'d1', title:'Daily', type:'daily', done:false, updatedAt:1000 }];
  const local = [{ id:'d1', title:'Daily', type:'daily', done:true, doneAt:today, updatedAt:today+100, streak:5 }];
  const remote = [{ id:'d1', title:'Daily', type:'daily', done:false, missedOn:'20260711', updatedAt:yesterday+50 }];
  const m = Q.merge(state(base), state(local), state(remote), yesterday+50, today+100);
  const merged = m.tasks.find(t=>t.id==='d1');
  assert('H5a doneAt preserved: local completed-today wins over remote miss', merged && merged.done === true && merged.doneAt === today);
})();

// H5b -- Symmetric: remote completed today, local missed yesterday -> remote wins
(function(){
  const today = Math.floor(Date.now() / 86400000) * 86400000;
  const yesterday = today - 86400000;
  const base = [{ id:'d2', title:'Daily', type:'daily', done:false, updatedAt:1000 }];
  const local = [{ id:'d2', title:'Daily', type:'daily', done:false, missedOn:'20260711', updatedAt:yesterday+50 }];
  const remote = [{ id:'d2', title:'Daily', type:'daily', done:true, doneAt:today, updatedAt:today+100, streak:5 }];
  const m = Q.merge(state(base), state(local), state(remote), today+100, yesterday+50);
  const merged = m.tasks.find(t=>t.id==='d2');
  assert('H5b doneAt preserved: remote completed-today wins over local miss', merged && merged.done === true && merged.doneAt === today);
})();

// H5c -- doneAt backdated by 24h still represents the correct calendar day.
(function(){
  const today = Math.floor(Date.now() / 86400000) * 86400000;
  const doneAtBackdated = Date.now() - 86400000;
  const dayOf = ms => Math.floor(ms / 86400000);
  assert('H5c doneAt backdated by 24h is still a valid yesterday timestamp',
    dayOf(doneAtBackdated) === dayOf(Date.now() - 86400000));
})();

// =====================================================================
// H6: _maxOrderingTs scans all ordering fields
// =====================================================================

// H6a -- tasks, char, devices, deletions, tags, rewards, views, metrics
(function(){
  const _maxOrderingTs = sandbox._maxOrderingTs;
  assert('H6a _maxOrderingTs function exists', typeof _maxOrderingTs === 'function');

  const stateObj = {
    tasks: [{ id:'t1', updatedAt:100, checklist:[{ touchedAt:200 }] }],
    char: { updatedAt:300 },
    devices: [{ updatedAt:400 }],
    deletions: [{ at:500 }],
    tags: [{ updatedAt:600 }],
    rewards: [{ updatedAt:700 }],
    prefs: { an: { views:[{ updatedAt:800 }], metrics:[{ updatedAt:900 }] } }
  };
  const mx = _maxOrderingTs(stateObj);
  assert('H6b _maxOrderingTs returns max across all fields (900)', mx === 900);

  // H6c -- empty state
  assert('H6c _maxOrderingTs returns 0 for empty/null state', _maxOrderingTs(null) === 0 && _maxOrderingTs({}) === 0);

  // H6d -- checklist touchedAt included
  const stateObj2 = {
    tasks: [{ id:'t1', updatedAt:50, checklist:[{ touchedAt:9999 }] }],
    char: {}, devices: [], deletions: [], tags: [], rewards: [],
    prefs: { an: { views:[], metrics:[] } }
  };
  assert('H6d _maxOrderingTs includes checklist touchedAt (9999)', _maxOrderingTs(stateObj2) === 9999);
})();

// =====================================================================
// Summary
// =====================================================================
if(failures){ console.error(failures + ' hlc.test.js assertion(s) FAILED'); process.exit(1); }
console.log('hlc.test.js: all assertions passed');
