

// daystamp.test.js -- tests for day-stamp merge logic (plan step #7)
// dayStamp / dayStampOf use LOCAL Date methods (getFullYear/getMonth/getDate) -> YYYYMMDD int.
// missedOn, lastCron are dayStamp ints (LOCAL calendar day).
// doneAt is a millisecond timestamp; dayStampOf(doneAt) converts to LOCAL day.
// Cross-TZ: same physical miss may get different YYYYMMDD -> cosmetic mismatch only,
// no data loss. These tests verify the merge logic handles divergent day inputs.
//
// runCron (app.js:1403) is NOT vm-loadable (DOM-dependent, C12 gap).
// Covered by code review + on-device travel-scenario checklist.
//
// Run: node tests/daystamp.test.js   (also run by `node tests/run.js`)
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
function assertEq(desc, got, want){ if(got === want) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc + ' -- got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; } }

// Helpers
function subset(tasks, overrides){
  return Object.assign({ tasks: tasks||[], rewards: [], tags: [], devices: [], an: {views:[],metrics:[]},
    history: [], charHistory: [], monthlyBackups: [], lastCron: 0, char: {}, deletions: [] }, overrides||{});
}
function daily(id, opts){
  return Object.assign({ id:id, type:'daily', title:id, updatedAt:1000, done:false, repeat:[1,1,1,1,1,1,1] }, opts||{});
}

// =========================================================================
// M1-M5: mergeDayArray tests
// K3 (2026-09-11): the day bucket changed from UTC floor(ms/86400000) to the LOCAL
// dayStampOf. None of the assertions below encoded the UTC bucket -- M3-M6 use one
// instant per bucket and M4's two instants are 24h apart, so they split in every
// timezone -- so they are unchanged. The new behaviour (two devices either side of
// LOCAL midnight keep two buckets) is pinned by tests/earnings-accumulate.test.js K3-J.
// =========================================================================

// M1: both empty -> empty
(function(){
  var r = Q.mergeDayArray([], []);
  assert('M1: both empty -> empty array', Array.isArray(r) && r.length === 0);
})();

// M2: one side empty, other has entries -> those entries survive
(function(){
  var a = [{date:1000, hp:10}];
  var r = Q.mergeDayArray(a, []);
  assertEq('M2a: local-only entry preserved', r.length, 1);
  assertEq('M2b: local-only hp field preserved', r[0].hp, 10);
  // And vice versa
  var r2 = Q.mergeDayArray([], a);
  assertEq('M2c: remote-only entry preserved', r2.length, 1);
  assertEq('M2d: remote-only hp field preserved', r2[0].hp, 10);
})();

// M3: same day -> ONE WHOLE ROW wins, fields are not mixed.
// CHANGED 2026-09-19 (round-1 finding 5). M3b used to assert `hp` took the max
// (10) while M3c asserted `xp` took the max (12) -- i.e. it pinned exactly the
// field-by-field blend that emitted rows no device ever held. The rule now is
// atomic: higher `xp` (there is no `lvl` here) carries its OWN row, so the 12-xp
// row wins and brings hp 7 with it. Full contract in
// tests/round3-charhistory-atomic.test.js.
(function(){
  var a = [{date:86400000, hp:10, xp:5}];
  var b = [{date:86400000, hp:7, xp:12}];
  var r = Q.mergeDayArray(a, b);
  assertEq('M3a: same day -> merged to single entry', r.length, 1);
  assertEq('M3b: the higher-xp row wins whole, so hp is ITS 7, not the max 10', r[0].hp, 7);
  assertEq('M3c: xp is 12', r[0].xp, 12);
  assertEq('M3d: date unchanged (both sides equal)', r[0].date, 86400000);
})();

// M4: different days -> union, sorted by date
(function(){
  var a = [{date:86400000, hp:10}];
  var b = [{date:172800000, hp:20}];
  var r = Q.mergeDayArray(a, b);
  assertEq('M4a: different days -> 2 entries', r.length, 2);
  assertEq('M4b: sorted by date ascending', r[0].date < r[1].date, true);
  assertEq('M4c: first entry has hp=10', r[0].hp, 10);
  assertEq('M4d: second entry has hp=20', r[1].hp, 20);
})();

// M5: array fields inside a day row are NOT unioned any more -- the whole row wins.
// CHANGED 2026-09-19 (round-1 finding 5). This block used to assert a per-id union
// of a `checklist` array inside a day row. That branch went with the field-by-field
// blend it belonged to. The only array-shaped subject it could ever have had is
// `S.history`, which app.js never populates (see the DEAD WORK note at the
// mergeDayArray call site); `charHistory` rows are flat numbers. Here both rows
// carry the same `date` and no `lvl`/`xp`, so the tiebreak is "keep the incumbent",
// and the incumbent is the local row -- taken WHOLE.
(function(){
  var a = [{date:86400000, checklist:[{id:'c1', text:'a', done:true}]}];
  var b = [{date:86400000, checklist:[{id:'c1', text:'b', done:false}, {id:'c2', text:'c', done:true}]}];
  var r = Q.mergeDayArray(a, b);
  assertEq('M5a: same day -> single entry', r.length, 1);
  assertEq('M5b: the winning row keeps its OWN checklist, unmerged', r[0].checklist.length, 1);
  var c1 = r[0].checklist.find(function(x){ return x.id === 'c1'; });
  assertEq('M5c: c1 text is the winner own', c1.text, 'a');
  assertEq('M5d: c1 done is the winner own', c1.done, true);
  var c2 = r[0].checklist.find(function(x){ return x.id === 'c2'; });
  assert('M5e: the loser c2 is NOT grafted onto the winner', c2 == null);
})();

// M6: an exact tie on date with nothing to order by keeps the incumbent, whole.
// CHANGED 2026-09-19 (round-1 finding 5). Used to assert gold took the max from one
// row (5.0) and streak the max from the other (2) -- a row that existed nowhere.
// Two rows with an identical millisecond `date` cannot arise from logCharSnapshot,
// which stamps Date.now() per device; the rule exists so the result never depends
// on which side was folded first.
(function(){
  var a = [{date:86400000, gold:3.5, streak:2}];
  var b = [{date:86400000, gold:5.0, streak:1}];
  var r = Q.mergeDayArray(a, b);
  assertEq('M6a: incumbent gold kept (3.5)', r[0].gold, 3.5);
  assertEq('M6b: ...and ITS streak (2), not a mix', r[0].streak, 2);
  // Order-independence: swapping the sides must not blend either.
  var r2 = Q.mergeDayArray(b, a);
  assertEq('M6c: swapped, gold is that incumbent own 5.0', r2[0].gold, 5.0);
  assertEq('M6d: ...and ITS streak (1), still not a mix', r2[0].streak, 1);
})();

// M7: null/undefined inputs handled
(function(){
  var r1 = Q.mergeDayArray(null, []);
  assertEq('M7a: null localArr -> handled', Array.isArray(r1), true);
  var r2 = Q.mergeDayArray([], null);
  assertEq('M7b: null remoteArr -> handled', Array.isArray(r2), true);
})();

// =========================================================================
// N1-N6: normalizeDailyResets tests
// =========================================================================

// N1: daily done=true, doneAt dayStamp < lastCron -> RESET
(function(){
  var ts_old = Date.UTC(2025, 0, 1, 12, 0, 0); // 2025-01-01
  var tasks = [daily('d1', { done:true, doneAt: ts_old })];
  var r = Q.normalizeDailyResets(tasks, 20260712);
  assertEq('N1: done daily with old doneAt dayStamp < lastCron -> reset to done=false', r[0].done, false);
})();

// N2: daily done=true, doneAt dayStamp >= lastCron -> KEEP
(function(){
  var ts_today = Date.UTC(2026, 6, 12, 12, 0, 0); // 2026-07-12
  var tasks = [daily('d2', { done:true, doneAt: ts_today })];
  var r = Q.normalizeDailyResets(tasks, 20260712);
  assertEq('N2: done daily with doneAt dayStamp >= lastCron -> kept done=true', r[0].done, true);
})();

// N3: daily done=false -> pass through unchanged
(function(){
  var tasks = [daily('d3', { done:false })];
  var r = Q.normalizeDailyResets(tasks, 20260712);
  assertEq('N3: undone daily -> unchanged', r[0].done, false);
})();

// N4: non-daily type -> pass through
(function(){
  var tasks = [{ id:'h1', type:'habit', title:'h1', updatedAt:1000, done:true }];
  var r = Q.normalizeDailyResets(tasks, 20260712);
  assertEq('N4: non-daily type -> unchanged', r[0].done, true);
})();

// N5: checklist reset when parent daily is reset
(function(){
  var ts_old = Date.UTC(2025, 0, 1, 12, 0, 0);
  var tasks = [daily('d5', { done:true, doneAt: ts_old, checklist:[{id:'c1',done:true},{id:'c2',done:true}] })];
  var r = Q.normalizeDailyResets(tasks, 20260712);
  assertEq('N5a: parent reset to done=false', r[0].done, false);
  assertEq('N5b: checklist[0] reset to done=false', r[0].checklist[0].done, false);
  assertEq('N5c: checklist[1] reset to done=false', r[0].checklist[1].done, false);
})();

// N6: null/undefined input -> returns as-is
(function(){
  assertEq('N6a: null input -> null', Q.normalizeDailyResets(null, 1), null);
  assertEq('N6b: undefined input -> undefined', Q.normalizeDailyResets(undefined, 1), undefined);
})();

// =========================================================================
// R1-R6: resolveDailyConflict tests
// =========================================================================

// R1: different event days -> newer wins
(function(){
  var l = daily('d1', { done:true, doneAt: Date.UTC(2026,6,10,12,0,0), missedOn:0, updatedAt:100 });
  var r = daily('d1', { done:false, doneAt:0, missedOn:20260711, updatedAt:200 });
  var w = Q.resolveDailyConflict(l, r);
  assertEq('R1: different event days -> later day (missedOn=20260711) wins', w.missedOn, 20260711);
})();

// R2: same event day, one done + other missed -> done wins
(function(){
  // Both event day = 20260711
  var l = daily('d2', { done:true, doneAt: Date.UTC(2026,6,11,12,0,0), missedOn:0, updatedAt:100 });
  var r = daily('d2', { done:false, doneAt:0, missedOn:20260711, updatedAt:200 });
  var w = Q.resolveDailyConflict(l, r);
  assertEq('R2: same event day, done beats miss -> local (done) wins', w.done, true);
})();

// R2b: same event day, remote done + local missed -> remote wins
(function(){
  var l = daily('d2b', { done:false, doneAt:0, missedOn:20260711, updatedAt:100 });
  var r = daily('d2b', { done:true, doneAt: Date.UTC(2026,6,11,12,0,0), missedOn:0, updatedAt:200 });
  var w = Q.resolveDailyConflict(l, r);
  assertEq('R2b: same event day, remote done + local miss -> remote (done) wins', w.done, true);
})();

// R3: same event day, both done -> updatedAt tiebreak
(function(){
  var l = daily('d3', { done:true, doneAt: Date.UTC(2026,6,11,12,0,0), missedOn:0, updatedAt:300 });
  var r = daily('d3', { done:true, doneAt: Date.UTC(2026,6,11,12,0,0), missedOn:0, updatedAt:200 });
  var w = Q.resolveDailyConflict(l, r);
  assertEq('R3: same event day, both done -> higher updatedAt wins', w.updatedAt, 300);
})();

// R4: same event day, both missed -> updatedAt tiebreak
(function(){
  var l = daily('d4', { done:false, doneAt:0, missedOn:20260711, updatedAt:100 });
  var r = daily('d4', { done:false, doneAt:0, missedOn:20260711, updatedAt:200 });
  var w = Q.resolveDailyConflict(l, r);
  assertEq('R4: same event day, both missed -> higher updatedAt wins', w.updatedAt, 200);
})();

// R5: neither done nor missed -> updatedAt tiebreak
(function(){
  var l = daily('d5', { done:false, doneAt:0, missedOn:0, updatedAt:300 });
  var r = daily('d5', { done:false, doneAt:0, missedOn:0, updatedAt:200 });
  var w = Q.resolveDailyConflict(l, r);
  assertEq('R5: no day signal -> higher updatedAt wins', w.updatedAt, 300);
})();

// =========================================================================
// T1-T4: Two-timezone simulation tests (cross-device merge scenarios)
// =========================================================================

// T1: Cross-TZ cron: same daily missed on both devices with different missedOn.
// Device A (UTC-5): local 2026-07-11 20:00 -> yesterdayStamp = dayStamp(2026-07-10) = 20260710
// Device B (UTC+9): local 2026-07-12 10:00 -> yesterdayStamp = dayStamp(2026-07-11) = 20260711
// Same daily is missed on both -> merged state picks the one with the later missedOn.
(function(){
  var base = subset([daily('t1', { done:false, doneAt:0, missedOn:0, updatedAt:500 })]);
  var local = subset([daily('t1', { done:false, doneAt:0, missedOn:20260710, updatedAt:500 })]);
  local.lastCron = 20260711; // Device A cron ran for 2026-07-11
  var remote = subset([daily('t1', { done:false, doneAt:0, missedOn:20260711, updatedAt:500 })]);
  remote.lastCron = 20260712; // Device B cron ran for 2026-07-12
  var m = Q.merge(base, local, remote, Date.now(), Date.now());
  var merged = m.tasks.find(function(t){ return t.id === 't1'; });
  assertEq('T1a: cross-TZ miss -> later missedOn (20260711) wins', merged.missedOn, 20260711);
  assertEq('T1b: cross-TZ lastCron -> max wins (20260712)', m.lastCron, 20260712);
  assertEq('T1c: daily stays undone (missed on both)', merged.done, false);
})();

// T2a: resolveDailyConflict directly: completion event day > miss event day -> completion wins
(function(){
  var l = daily('t2', { done:true, doneAt: Date.UTC(2026,6,12,8,0,0), missedOn:0, updatedAt:500 });
  var r = daily('t2', { done:false, doneAt:0, missedOn:20260710, updatedAt:500 });
  var w = Q.resolveDailyConflict(l, r);
  assertEq('T2a: completion (day 20260712) beats miss (day 20260710) in resolveDailyConflict', w.done, true);
})();

// T2b: full merge with normalizeDailyResets: completion from day 20260712 gets
// RESET because Device A already cronned for 20260713 (lastCron > doneAt dayStamp).
// This is CORRECT: the user got rewards on Device A (persisted in char stats),
// but the done state correctly resets because the merged timeline is past that day.
(function(){
  var base = subset([daily('t2b', { done:false, doneAt:0, missedOn:0, updatedAt:500 })]);
  var local = subset([daily('t2b', { done:true, doneAt: Date.UTC(2026,6,12,8,0,0), missedOn:0, updatedAt:500 })]);
  local.lastCron = 20260713; // Device A already cronned for 13th
  var remote = subset([daily('t2b', { done:false, doneAt:0, missedOn:20260710, updatedAt:500 })]);
  remote.lastCron = 20260711; // Device B still on 11th
  var m = Q.merge(base, local, remote, Date.now(), Date.now());
  var merged = m.tasks.find(function(t){ return t.id === 't2b'; });
  assertEq('T2b: completion from day 20260712 resets when merged lastCron=20260713 (correct behavior)', merged.done, false);
})();

// T3: Cross-TZ normalizeDailyResets: merged lastCron ahead of doneAt day.
// Device A completed a daily on 2026-07-11, Device B already cronned for 2026-07-12.
// After merge, lastCron=20260712, dayStampOf(doneAt)=20260711 < lastCron -> reset.
// This is CORRECT behavior: the daily was completed "yesterday" from B's perspective,
// and B's cron already transitioned to today.
(function(){
  var ts_20260711 = Date.UTC(2026, 6, 11, 12, 0, 0);
  var base = subset([daily('t3', { done:false, doneAt:0, missedOn:0, updatedAt:500 })]);
  var local = subset([daily('t3', { done:true, doneAt: ts_20260711, missedOn:0, updatedAt:500 })]);
  local.lastCron = 20260711;
  var remote = subset([daily('t3', { done:false, doneAt:0, missedOn:0, updatedAt:500 })]);
  remote.lastCron = 20260712; // B is ahead
  var m = Q.merge(base, local, remote, Date.now(), Date.now());
  var merged = m.tasks.find(function(t){ return t.id === 't3'; });
  assertEq('T3: cross-TZ normalizeDailyResets resets done daily when lastCron is ahead', merged.done, false);
})();

// T4: Same-TZ consistency: both devices on same day, completion preserved.
(function(){
  var ts_today = Date.now(); // whatever today is in test runner's TZ
  var base = subset([daily('t4', { done:false, doneAt:0, missedOn:0, updatedAt:500 })]);
  var local = subset([daily('t4', { done:true, doneAt: ts_today, missedOn:0, updatedAt:500 })]);
  local.lastCron = 20260712;
  var remote = subset([daily('t4', { done:false, doneAt:0, missedOn:0, updatedAt:500 })]);
  remote.lastCron = 20260712;
  var m = Q.merge(base, local, remote, Date.now(), Date.now());
  var merged = m.tasks.find(function(t){ return t.id === 't4'; });
  assertEq('T4: same-TZ completion preserved (doneAt dayStamp >= lastCron)', merged.done, true);
})();

// =========================================================================
// runCron gap documentation (C12 pattern from convergence.test.js)
// =========================================================================
// runCron (app.js:1403) depends on DOM: document.getElementById for toast,
// render(), save() -> localStorage, logCharSnapshot -> S.charHistory.
// It is NOT vm-loadable without a heavy jsdom harness.
// Coverage: code review (app.js:1403-1437) + on-device travel-scenario
// checklist. The merge-layer effects of runCron's outputs (missedOn, lastCron,
// done=false) are covered by the tests above (N1-N6, R1-R5, T1-T4).
console.log('[NOTE] runCron (app.js:1403) -- not vm-testable (DOM-dependent, C12 gap). Coverage via code review + merge tests above.');

if(failures > 0){ console.error(failures + ' daystamp test(s) failed.'); process.exit(1); }
console.log('All daystamp tests passed!');
process.exit(0);
