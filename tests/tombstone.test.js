// tombstone.test.js -- unit tests for the 2026-07-12 tombstone-deletion model
// added to sync.js (S.deletions + tombstone overlay in mergeCollection). Root
// cause it guards: a task present in `base` but absent from a stale/partial
// remote snapshot was silently deleted (lost 500+ day dailies). Deletion is now
// driven ONLY by explicit tombstones.
//
// Run: node tests/tombstone.test.js   (also run by `node tests/run.js`)
const fs = require('fs'), path = require('path'), vm = require('vm');

// Load sync.js into a vm sandbox. Strip the boot gate so no DOM/idb is touched
// at load; window.QuestaSync is assigned BEFORE the boot gate, so it survives.
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
try { vm.runInContext(src, sandbox); } catch(e) { /* QuestaSync is assigned before any throwable boot code */ }
const Q = sandbox.window.QuestaSync;
if (!Q || typeof Q.merge !== 'function') { console.error('FAIL: QuestaSync.merge not found in sync.js'); process.exit(1); }

let failures = 0;
function assert(desc, cond){ if(cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }

// Build a full subset object varying only tasks + deletions.
function subset(tasks, deletions){
  return { tasks: tasks||[], rewards: [], tags: [], devices: [], an: {views:[],metrics:[]},
    history: [], charHistory: [], monthlyBackups: [], lastCron: 0, char: {}, deletions: deletions||[] };
}
const NOW = Date.now();
function T(id, updatedAt, extra){ return Object.assign({ id:id, type:'todo', title:id, updatedAt:updatedAt }, extra||{}); }
function has(arr, id){ return (arr||[]).some(function(t){ return t.id===id; }); }
function delHas(arr, id){ return (arr||[]).some(function(d){ return d.id===id; }); }

// TEST 1 -- THE BUG: base+local have t1, remote lacks it (stale remote), no tombstone.
(function(){
  const base = subset([T('t1', NOW - 2000)]);
  const local = subset([T('t1', NOW - 2000)]);
  const remote = subset([]); // remote dropped it
  const m = Q.merge(base, local, remote, NOW, NOW - 500); // remoteSavedAt newer than task
  assert('T1 stale-remote absence does NOT delete an untouched task (the original bug)', has(m.tasks,'t1'));
})();

// TEST 2 -- real deletion via tombstone (at > task.updatedAt).
(function(){
  const base = subset([T('t1', NOW - 2000)]);
  const local = subset([], [{id:'t1', at: NOW - 1000}]); // deleted locally + tombstone
  const remote = subset([T('t1', NOW - 2000)]);          // remote still has it
  const m = Q.merge(base, local, remote, NOW, NOW - 500);
  assert('T2 tombstone (at>updatedAt) deletes the task', !has(m.tasks,'t1'));
  assert('T2 tombstone propagates into merged.deletions', delHas(m.deletions,'t1'));
})();

// TEST 3 -- tombstone present but surviving copy edited AFTER the delete -> resurrect.
(function(){
  const base = subset([T('t1', NOW - 2000)]);
  const local = subset([T('t1', NOW - 500)], [{id:'t1', at: NOW - 1000}]); // edited recently, tombstone older
  const remote = subset([T('t1', NOW - 2000)]);
  const m = Q.merge(base, local, remote, NOW, NOW - 500);
  assert('T3 edit newer than tombstone resurrects the task', has(m.tasks,'t1'));
})();

// TEST 4 -- tombstone propagation when both sides lack the task.
(function(){
  const base = subset([T('t1', NOW - 2000)]);
  const local = subset([], [{id:'t1', at: NOW - 1000}]);
  const remote = subset([]);
  const m = Q.merge(base, local, remote, NOW, NOW - 500);
  assert('T4 both-absent + tombstone -> stays deleted', !has(m.tasks,'t1'));
  assert('T4 both-absent tombstone recorded in merged.deletions', delHas(m.deletions,'t1'));
})();

// TEST 5 -- unrelated unchanged task kept; genuine remote-only add kept.
(function(){
  const base = subset([T('t2', NOW - 2000)]);
  const local = subset([T('t2', NOW - 2000)]);
  const remote = subset([T('t2', NOW - 2000), T('t3', NOW - 1500)]); // t3 is a real new add
  const m = Q.merge(base, local, remote, NOW, NOW - 500);
  assert('T5 unchanged task t2 preserved', has(m.tasks,'t2'));
  assert('T5 genuine remote-only add t3 preserved', has(m.tasks,'t3'));
})();

// TEST 6 -- regression: daily with differing done/doneAt on both sides, no tombstone -> survives.
(function(){
  const d1l = { id:'d1', type:'daily', title:'d1', updatedAt:NOW - 2000, done:true,  doneAt:NOW - 1000 };
  const d1r = { id:'d1', type:'daily', title:'d1', updatedAt:NOW - 2000, done:false, missedOn:20260712 };
  const base = subset([{ id:'d1', type:'daily', title:'d1', updatedAt:NOW - 2000, done:false }]);
  const local = subset([d1l]);
  const remote = subset([d1r]);
  const m = Q.merge(base, local, remote, NOW, NOW - 500);
  assert('T6 daily both-changed conflict still resolves to a surviving task', has(m.tasks,'d1'));
})();

if(failures>0){ console.error(failures + ' tombstone test(s) failed.'); process.exit(1); }
console.log('All tombstone tests passed!');
process.exit(0);
