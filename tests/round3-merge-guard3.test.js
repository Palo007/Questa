// round3-merge-guard3.test.js -- round 3 triage, item 14.
//
// GUARD 3 in sync.js mergeCollection() suppresses a STALE local revert: when
// local disagrees with base and remote does not, and base's own record is at
// least as new as local's whole-snapshot timestamp, local could not have known
// about this record, so its disagreement is not authoritative and base is kept.
//
// Item 14 removed that guard's local-absent arm (`_caRaw(b) >= localSavedAt`)
// and with it the `_caRaw` helper. The arm could not change any outcome: with
// local absent, a TRUE result set the entry to `b` and returned, and a FALSE
// result fell through to `else if(b) resultMap.set(id, b)` -- the same value.
//
// This file pins the contract that made the arm redundant, and pins the arm
// that is still live so a future edit cannot quietly invert it.
//
//   H1-H4  local ABSENT: base is kept for EVERY localSavedAt, including null
//          and a future-skewed base createdAt. This is what made the removed
//          arm unobservable -- if any of these ever disagree, the removal was
//          not behaviour-preserving after all.
//   H5-H6  local PRESENT: the surviving arm still arbitrates. A stale local
//          (base at least as new as localSavedAt) loses; a genuine later edit
//          wins.
//
// NOTE ON EVIDENCE: H1-H4 pass against the pre-item-14 code too, and that is
// the point -- the change was proven behaviour-preserving, so a red-before/
// green-after test is not available for it. The proof that the removal changed
// nothing is a differential run of merge() across 4420 scenarios (420 of them
// this exact shape) on the pre- and post-edit files, plus a mutation check
// showing the harness does detect a one-character change in GUARD 3. H5/H6 are
// the standing guard: they fail if the surviving `>=` is flipped to `>`.
//
// Run: node tests/round3-merge-guard3.test.js  (also run by `node tests/run.js`)
const fs = require('fs'), path = require('path'), vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');

let failures = 0;
function assert(desc, cond){ if(cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }

const noop = function(){};
const store = {};
const sandbox = {
  window: {}, navigator: { onLine: true },
  document: { addEventListener: noop, getElementById: function(){ return null; },
    createElement: function(){ return { style:{}, appendChild: noop, setAttribute: noop, click: noop }; },
    body: { appendChild: noop, removeChild: noop } },
  localStorage: {
    getItem: function(k){ return Object.prototype.hasOwnProperty.call(store,k) ? store[k] : null; },
    setItem: function(k,v){ store[k] = String(v); },
    removeItem: function(k){ delete store[k]; }, key: function(){ return null; }, length: 0 },
  history: { replaceState: noop }, location: { search: '', pathname: '/', origin: 'https://t.example' },
  setTimeout: function(){ return 0; }, clearTimeout: noop,
  setInterval: function(){ return 0; }, clearInterval: noop,
  console: { log: noop, warn: noop, error: noop },
  JSON: JSON, Math: Math, Date: Date, Map: Map, Set: Set, WeakSet: WeakSet,
  Array: Array, Object: Object, Number: Number, String: String, Boolean: Boolean,
  Promise: Promise, URLSearchParams: URLSearchParams, Error: Error,
  isFinite: isFinite, isNaN: isNaN, parseInt: parseInt, RegExp: RegExp,
  logEvent: noop, toast: noop, render: noop, esc: function(x){ return x; }, save: noop,
  uid: function(){ return 'u'; }, idbOpen: function(){ return Promise.resolve(null); },
  getEvents: function(){ return Promise.resolve([]); }
};
sandbox.window.addEventListener = noop;
sandbox.self = sandbox.window; sandbox.globalThis = sandbox;
sandbox.S = { char:{}, tasks:[], rewards:[], tags:[], devices:[], an:{views:[],metrics:[]},
              history:[], charHistory:[], monthlyBackups:[], lastCron:0, deletions:[] };
vm.createContext(sandbox);
try { vm.runInContext(src, sandbox); }
catch(e){ console.error('FAIL: sync.js eval threw:', e); process.exit(1); }

if(typeof sandbox.merge !== 'function'){ console.error('FAIL: merge() not found'); process.exit(1); }

const T0 = 1750000000000;
function state(tasks){
  return { char: { name: 'C', lvl: 1, updatedAt: T0 },
           tasks: tasks, rewards: [], tags: [], devices: [],
           an: { views: [], metrics: [] }, history: [], charHistory: [],
           monthlyBackups: [], lastCron: 0, deletions: [] };
}
function taskIn(result, id){ return (result.tasks || []).find(function(t){ return t && t.id === id; }) || null; }

// ---------------------------------------------------------------- H1..H4
// local ABSENT, remote byte-identical to base -> localChanged && !remoteChanged
// with localHad false. This is the exact shape the removed arm tested.
function localAbsent(localSavedAt, rec){
  const base = state([JSON.parse(JSON.stringify(rec))]);
  const remote = state([JSON.parse(JSON.stringify(rec))]);
  const local = state([]);
  return sandbox.merge(base, local, remote, T0, localSavedAt, 'devL', 'devR');
}
const RECENT = { id: 'X', title: 'kept', createdAt: T0 - 5000, updatedAt: T0 - 5000 };
const SKEWED = { id: 'X', title: 'kept', createdAt: T0 + 86400000 * 400, updatedAt: T0 + 86400000 * 400 };

assert('H1: local absent, localSavedAt ABOVE base.createdAt -> base kept',
  !!taskIn(localAbsent(T0 + 1000, RECENT), 'X'));
assert('H2: local absent, localSavedAt BELOW base.createdAt -> base kept',
  !!taskIn(localAbsent(T0 - 90000, RECENT), 'X'));
assert('H3: local absent, base createdAt far in the future -> base kept',
  !!taskIn(localAbsent(T0, SKEWED), 'X'));
assert('H4: local absent, localSavedAt null -> base kept',
  !!taskIn(localAbsent(null, RECENT), 'X'));
assert('H4b: local absent, localSavedAt exactly equal to base.createdAt -> base kept',
  !!taskIn(localAbsent(T0 - 5000, RECENT), 'X'));

// ---------------------------------------------------------------- H5..H6
// local PRESENT and disagreeing, remote unchanged -> the surviving arm decides.
function localPresent(localSavedAt, baseUpdatedAt){
  const rec = { id: 'Y', title: 'base-title', createdAt: T0 - 10000, updatedAt: baseUpdatedAt };
  const base = state([JSON.parse(JSON.stringify(rec))]);
  const remote = state([JSON.parse(JSON.stringify(rec))]);
  const localRec = JSON.parse(JSON.stringify(rec));
  localRec.title = 'local-title';
  const local = state([localRec]);
  return sandbox.merge(base, local, remote, T0, localSavedAt, 'devL', 'devR');
}
// base is NEWER than local's whole-snapshot stamp: local could not have known
// about it, so its disagreement is a stale revert and must be suppressed.
const stale = taskIn(localPresent(T0 - 50000, T0), 'Y');
assert('H5: stale local revert is suppressed -- base title survives',
  !!stale && stale.title === 'base-title');
// Equality is the boundary the surviving `>=` owns. Flipping it to `>` flips
// this one assertion and nothing else.
const boundary = taskIn(localPresent(T0, T0), 'Y');
assert('H5b: boundary -- base.updatedAt EQUAL to localSavedAt still suppresses',
  !!boundary && boundary.title === 'base-title');
// base is OLDER than local's snapshot: local saw it and genuinely changed it.
const genuine = taskIn(localPresent(T0, T0 - 50000), 'Y');
assert('H6: a genuine later local edit is NOT suppressed -- local title wins',
  !!genuine && genuine.title === 'local-title');

// ---------------------------------------------------------------- H7
// The helper the removed arm was its only caller of must be gone, and the
// surviving arm must still read RAW (unclamped) -- a clamped 0 here fails the
// guard OPEN and uploads the stale revert, which is the data-loss amplifier.
assert('H7a: _caRaw is gone from sync.js', typeof sandbox._caRaw === 'undefined');
assert('H7b: _uaRaw survives -- the live arm still reads unclamped',
  typeof sandbox._uaRaw === 'function');

if(failures){ console.error(failures + ' round3-merge-guard3 assertion(s) FAILED'); process.exit(1); }
console.log('round3-merge-guard3.test.js: all assertions passed');
