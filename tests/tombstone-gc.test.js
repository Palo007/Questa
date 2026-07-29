// tombstone-gc.test.js -- tests for tombstone garbage collection (plan step #6)
// Aged tombstones (>180d) are dropped from merged.deletions at merge time to
// bound S.deletions growth. Residual: a device offline >180d may resurrect a
// deleted entity — accepted per plan.
//
// Run: node tests/tombstone-gc.test.js   (also run by `node tests/run.js`)
const fs = require('fs'), path = require('path'), vm = require('vm');

// Load sync.js into a vm sandbox. Strip boot gate + trailing syncInit().
let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');
src = src.replace(/\bsyncInit\(\)\s*;?\s*$/, '');

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
try { vm.runInContext(src, sandbox); } catch(e) { /* QuestaSync assigned before boot code */ }
const Q = sandbox.window.QuestaSync;
if (!Q || typeof Q.merge !== 'function') { console.error('FAIL: QuestaSync.merge not found'); process.exit(1); }

let failures = 0;
function assert(desc, cond){ if(cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }

// Helpers
function subset(tasks, deletions){
  return { tasks: tasks||[], rewards: [], tags: [], devices: [], an: {views:[],metrics:[]},
    history: [], charHistory: [], monthlyBackups: [], lastCron: 0, char: {}, deletions: deletions||[] };
}
function T(id, updatedAt){ return { id:id, type:'todo', title:id, updatedAt:updatedAt }; }
function has(arr, id){ return (arr||[]).some(function(t){ return t.id===id; }); }
function delHas(arr, id){ return (arr||[]).some(function(d){ return d.id===id; }); }

const NOW = Date.now();
const DAY = 86400000;
const AGE_180 = 180 * DAY;
const AGE_200 = 200 * DAY;  // well beyond 180d threshold
const AGE_30  = 30  * DAY;  // well within 180d threshold

// GC1: tombstone older than 180d is DROPPED from merged.deletions
(function(){
  const base = subset([T('t1', NOW - AGE_200)]);
  const local = subset([], [{id:'t1', at: NOW - AGE_200}]);
  const remote = subset([]);
  const m = Q.merge(base, local, remote, NOW, NOW);
  assert('GC1a: aged tombstone (>180d) dropped from merged.deletions', !delHas(m.deletions, 't1'));
  // Because tombstone is GC'd from the map before mergeCollection overlay,
  // the entity from base should survive.
  assert('GC1b: entity whose tombstone aged out is preserved in tasks', has(m.tasks, 't1'));
})();

// GC2: tombstone within 180d is KEPT
(function(){
  const base = subset([T('t2', NOW - AGE_200)]);
  const local = subset([], [{id:'t2', at: NOW - AGE_30}]);
  const remote = subset([]);
  const m = Q.merge(base, local, remote, NOW, NOW);
  assert('GC2a: recent tombstone (<180d) kept in merged.deletions', delHas(m.deletions, 't2'));
  // Tombstone overlay should suppress the entity
  assert('GC2b: entity with recent tombstone is deleted from tasks', !has(m.tasks, 't2'));
})();

// GC3: mixed — one aged, one fresh — only fresh survives
(function(){
  const base = subset([T('t3', NOW - AGE_200), T('t4', NOW - AGE_200)]);
  const local = subset([], [
    {id:'t3', at: NOW - AGE_200},  // aged → GC'd
    {id:'t4', at: NOW - AGE_30}    // fresh → kept
  ]);
  const remote = subset([]);
  const m = Q.merge(base, local, remote, NOW, NOW);
  assert('GC3a: aged tombstone t3 dropped', !delHas(m.deletions, 't3'));
  assert('GC3b: fresh tombstone t4 kept', delHas(m.deletions, 't4'));
  assert('GC3c: t3 entity survives (tombstone aged out)', has(m.tasks, 't3'));
  assert('GC3d: t4 entity deleted (recent tombstone)', !has(m.tasks, 't4'));
})();

// GC4: tombstone JUST inside 180d boundary is KEPT (+1ms to offset test-to-merge timing)
//       `Date.now() - at > TOMBSTONE_MAX_AGE_MS` means == is NOT dropped.
(function(){
  const boundaryAt = NOW - AGE_180 + 10000;  // +10s buffer for test-to-merge timing drift
  const base = subset([T('t5', NOW - AGE_200)]);
  const local = subset([], [{id:'t5', at: boundaryAt}]);
  const remote = subset([]);
  const m = Q.merge(base, local, remote, NOW, NOW);
  assert('GC4a: tombstone just inside 180d boundary is KEPT', delHas(m.deletions, 't5'));
  assert('GC4b: entity deleted by boundary tombstone', !has(m.tasks, 't5'));
})();

// GC5: old tombstone across all three sources — all GC'd
(function(){
  const base = subset([], [{id:'t6', at: NOW - AGE_200}]);
  const local = subset([], [{id:'t6', at: NOW - AGE_200}]);
  const remote = subset([], [{id:'t6', at: NOW - AGE_200}]);
  const m = Q.merge(base, local, remote, NOW, NOW);
  assert('GC5: old tombstone present in all three sources is GC\'d', !delHas(m.deletions, 't6'));
})();

// GC6: boundary sanity — 179d tombstone is KEPT (just under threshold)
(function(){
  const age_179 = 179 * DAY;
  const base = subset([T('t7', NOW - AGE_200)]);
  const local = subset([], [{id:'t7', at: NOW - age_179}]);
  const remote = subset([]);
  const m = Q.merge(base, local, remote, NOW, NOW);
  assert('GC6a: 179d tombstone kept (under threshold)', delHas(m.deletions, 't7'));
  assert('GC6b: entity deleted by 179d tombstone', !has(m.tasks, 't7'));
})();

// GC7: 181d tombstone is DROPPED (just over threshold)
(function(){
  const age_181 = 181 * DAY;
  const base = subset([T('t8', NOW - AGE_200)]);
  const local = subset([], [{id:'t8', at: NOW - age_181}]);
  const remote = subset([]);
  const m = Q.merge(base, local, remote, NOW, NOW);
  assert('GC7a: 181d tombstone dropped (over threshold)', !delHas(m.deletions, 't8'));
  assert('GC7b: entity with aged-out tombstone survives', has(m.tasks, 't8'));
})();

if(failures > 0){ console.error(failures + ' tombstone-gc test(s) failed.'); process.exit(1); }
console.log('All tombstone-gc tests passed!');
process.exit(0);
