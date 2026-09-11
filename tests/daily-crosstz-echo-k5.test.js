// daily-crosstz-echo-k5.test.js -- K5 (2026-09-11): the cross-timezone daily echo.
//
// THE BUG. Device B lives in a later timezone and crosses local midnight first.
// Its merge runs normalizeDailyResets (sync.js), which force-unchecks every daily
// whose dayStampOf(doneAt) is below B's own cron day. That overlay builds
// `Object.assign({}, t, {done:false})` -- it KEEPS doneAt and it never bumps
// updatedAt. B then uploads that record.
//
// Device A is still on the earlier day and genuinely completed the daily today.
// On A's next round mergeCollection sees localChanged === false (A has not touched
// it since the last sync) and remoteChanged === true (done flipped), so the
// one-sided branch fires. GUARD 1 there only rescues local when
// _uaRaw(l) > _uaRaw(r) -- and the echo carries the SAME updatedAt, so the guard is
// false and the echo is applied. A's real completion is erased, along with every
// subtask tick, while A's own day has not rolled over yet.
//
// K1 (2026-09-11) fixed the sibling case -- A destroying its OWN completion via a
// remote lastCron that lies in A's future -- by refusing that lastCron in
// mergedLastCron. It did not stop this echo, which arrives on the record itself.
//
// THE DISCRIMINATOR. A deliberate un-tick is a different shape on disk:
// uncompleteDaily/uncompleteTodo (app.js:1818-1821, 1829-1831) BOTH
// `delete t.doneAt` and `t.updatedAt = now()`. The cron overlay does neither.
// So "same updatedAt on both sides AND doneAt retained AND that doneAt's day is
// not behind this device's own day" identifies the echo and nothing else.
//
// Run: node tests/daily-crosstz-echo-k5.test.js   (also run by `node tests/run.js`)
const fs = require('fs'), path = require('path'), vm = require('vm');

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

// ---- fixture ---------------------------------------------------------------
// Everything is anchored to the REAL current local day, because the code under
// test reads dayStampOf(Date.now()). Never hardcode a YYYYMMDD here.
const NOW = Date.now();
function dayStampOf(ms){ const d = new Date(ms); return d.getFullYear()*10000 + (d.getMonth()+1)*100 + d.getDate(); }
const TODAY = dayStampOf(NOW);
const AHEAD = TODAY + 1;            // device B's later day. Only `> TODAY` matters.
const YESTERDAY_MS = NOW - 86400000;

function subset(tasks, overrides){
  return Object.assign({ tasks: tasks || [], rewards: [], tags: [], devices: [],
    an: {views:[],metrics:[]}, history: [], charHistory: [], monthlyBackups: [],
    lastCron: TODAY, char: {}, deletions: [] }, overrides || {});
}
// A daily device A completed TODAY and already synced. updatedAt is the completion edit.
function doneToday(extra){
  return Object.assign({ id:'d1', type:'daily', title:'d1', repeat:[1,1,1,1,1,1,1],
    done:true, doneAt:NOW, updatedAt:5000 }, extra || {});
}
// What B uploads: the cron overlay's shape -- done flipped, doneAt KEPT, updatedAt UNCHANGED.
function echoOf(t, extra){
  return Object.assign({}, t, { done:false }, extra || {});
}
function taskOut(merged, id){ return (merged.tasks || []).filter(function(t){ return t && t.id === id; })[0]; }

// =========================================================================
// K5-A [K5-NEW] -- the echo must not erase A's still-current completion.
// RED before the fix: the one-sided branch applies `r`, so done === false.
// =========================================================================
(function(){
  const local = doneToday();
  const base  = doneToday();                 // A already synced this exact record
  const remote = echoOf(doneToday());        // B's cron overlay, pushed back
  const merged = Q.merge(subset([base]), subset([local]),
                         subset([remote], { lastCron: AHEAD }),
                         NOW, NOW, 'devA', 'devB');
  const t = taskOut(merged, 'd1');
  assert('K5-A [K5-NEW]: a cross-TZ echo does not un-complete a daily whose day has not rolled over here',
         !!t && t.done === true);
})();

// =========================================================================
// K5-B [K5-NEW] -- the echo also clears the whole checklist. Subtask ticks
// must survive with it. RED before the fix.
// The remote side carries NO real subtask edit here: normalizeDailyResets
// clears the entire checklist whenever it resets, so B's copy is all-false by
// construction and there is nothing on that side worth splicing in.
// =========================================================================
(function(){
  const ck = [{id:'c1', text:'a', done:true, touchedAt:5000}];
  const local = doneToday({ checklist: ck.map(function(c){ return Object.assign({}, c); }) });
  const base  = doneToday({ checklist: ck.map(function(c){ return Object.assign({}, c); }) });
  const remote = echoOf(doneToday(), { checklist: [{id:'c1', text:'a', done:false, touchedAt:5000}] });
  const merged = Q.merge(subset([base]), subset([local]),
                         subset([remote], { lastCron: AHEAD }),
                         NOW, NOW, 'devA', 'devB');
  const t = taskOut(merged, 'd1');
  assert('K5-B [K5-NEW]: the echo does not clear subtask ticks either',
         !!t && t.done === true && !!t.checklist && t.checklist[0].done === true);
})();

// =========================================================================
// K5-C [GUARD] -- a DELIBERATE remote un-tick must still win. This is green in
// BOTH runs on purpose: it pins the behaviour the fix must not change, and it
// is the assertion that proves the new guard is narrow. uncompleteDaily deletes
// doneAt and bumps updatedAt, so neither new condition holds.
// =========================================================================
(function(){
  const local = doneToday();
  const base  = doneToday();
  const untick = doneToday({ done:false, updatedAt:9000 });
  delete untick.doneAt;                      // app.js:1819 -- retracts the completion-day claim
  const merged = Q.merge(subset([base]), subset([local]), subset([untick]),
                         NOW, NOW, 'devA', 'devB');
  const t = taskOut(merged, 'd1');
  assert('K5-C [GUARD]: a real remote un-tick (doneAt deleted, updatedAt bumped) still applies',
         !!t && t.done === false);
})();

// =========================================================================
// K5-D [GUARD] -- a genuinely STALE completion must still reset. Green in both
// runs: doneAt is yesterday, so this device HAS crossed the boundary and the
// reset is correct. Without this the fix would look like "never reset a daily".
// =========================================================================
(function(){
  const stale = { id:'d1', type:'daily', title:'d1', repeat:[1,1,1,1,1,1,1],
                  done:true, doneAt:YESTERDAY_MS, updatedAt:5000 };
  const merged = Q.merge(subset([Object.assign({}, stale)]),
                         subset([Object.assign({}, stale)]),
                         subset([Object.assign({}, stale, {done:false})]),
                         NOW, NOW, 'devA', 'devB');
  const t = taskOut(merged, 'd1');
  assert('K5-D [GUARD]: a completion from a previous local day still resets',
         !!t && t.done === false);
})();

// =========================================================================
// K5-E [GUARD] -- the guard is daily-only. A todo in the same shape is
// untouched by it. Green in both runs.
// =========================================================================
(function(){
  const todo = { id:'t1', type:'todo', title:'t1', done:true, doneAt:NOW, updatedAt:5000 };
  const merged = Q.merge(subset([Object.assign({}, todo)]),
                         subset([Object.assign({}, todo)]),
                         subset([Object.assign({}, todo, {done:false})]),
                         NOW, NOW, 'devA', 'devB');
  const t = taskOut(merged, 't1');
  assert('K5-E [GUARD]: a todo of the same shape is not caught by the daily guard',
         !!t && t.done === false);
})();

// =========================================================================
// K5-F [GUARD] -- convergence: on device B itself the reset must STAND. B's own
// day is ahead, its lastCron is ahead, and dayStampOf(doneAt) is behind it, so
// normalizeDailyResets resets and the new guard must not undo that. Green in
// both runs; it is the property that stops the fix becoming a ping-pong.
// =========================================================================
(function(){
  const t0 = { id:'d1', type:'daily', title:'d1', repeat:[1,1,1,1,1,1,1],
               done:true, doneAt:YESTERDAY_MS, updatedAt:5000 };
  const merged = Q.merge(subset([Object.assign({}, t0)], { lastCron: AHEAD }),
                         subset([Object.assign({}, t0)], { lastCron: AHEAD }),
                         subset([Object.assign({}, t0)], { lastCron: AHEAD }),
                         NOW, NOW, 'devB', 'devA');
  const t = taskOut(merged, 'd1');
  assert('K5-F [GUARD]: on the device that has crossed midnight the reset stands',
         !!t && t.done === false);
})();

if(failures){ console.error('\n' + failures + ' K5 cross-TZ echo test(s) failed.'); process.exit(1); }
console.log('\nAll K5 cross-TZ daily echo tests passed!');
