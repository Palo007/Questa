// merge-polarity-k1.test.js -- 2026-09-11 (K1).
//
// Regression cover for four merge-engine data-loss paths found in the
// 2026-09-11 sync audit. Every assertion below is RED on the pre-K1 code and
// GREEN after, EXCEPT the ones marked GUARD, which are green on both sides and
// exist so nobody "fixes" the fix back into a bug.
//
//   #1  mergedLastCron was a plain max(). max() never decreases, so ONE device
//       with a wrong date pinned the shared lastCron in the future forever, and
//       normalizeDailyResets then force-unchecked every daily -- and cleared
//       every subtask tick -- on EVERY device on EVERY round.  (K1-A)
//   #2  The same shape one day wide: a peer that has already crossed local
//       midnight wiped this device's still-current completion + checklist. (K1-B)
//   #3  The tombstone overlay clamped its ENTITY operand through _ua(). A task
//       re-created after a delete, by a device >120s fast, clamped to 0 on every
//       slower device, so `ts >= 0` deleted it there. Permanent ping-pong. (K1-D)
//   #4  mergeCollection GUARD 1 clamped remote's updatedAt in the branch where
//       remote holds the ONLY real edit -- so that edit was dropped AND the
//       stale local copy was pushed back over it. (K1-E)
//
// Run: node tests/merge-polarity-k1.test.js   (tests/run.js picks it up too)

const fs = require('fs'), path = require('path'), vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* stripped */');
src = src.replace(/\bsyncInit\(\)\s*;?\s*$/, '');

function makeQ(uidValue){
  const noop = function(){};
  const sandbox = {
    window: {}, navigator: {onLine: true},
    document: {addEventListener: noop, getElementById: function(){ return null; },
      createElement: function(){ return {style:{},appendChild:noop,setAttribute:noop,click:noop}; },
      body: {appendChild:noop, removeChild:noop}},
    localStorage: {getItem: function(){ return null; }, setItem: noop, removeItem: noop,
      key: function(){ return null; }, length: 0},
    indexedDB: {open: function(){ return {}; }},
    setTimeout: function(){ return 0; }, clearTimeout: noop,
    setInterval: function(){ return 0; }, clearInterval: noop,
    console: console, JSON: JSON, Math: Math, Date: Date,
    Map: Map, Set: Set, WeakSet: WeakSet,
    Array: Array, Object: Object, Number: Number, String: String,
    Boolean: Boolean, Promise: Promise,
    logEvent: noop, toast: noop, render: noop, esc: function(x){ return x; },
    save: noop, uid: function(){ return uidValue; },
    idbOpen: function(){ return Promise.resolve(null); },
    now: function(){ return FIXED_NOW; }
  };
  sandbox.self = sandbox.window;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  try { vm.runInContext(src, sandbox); } catch(e){}
  return sandbox.window.QuestaSync;
}

// All fixtures are relative to the real clock, never a hardcoded calendar date
// (commit 6b93a82): mergedLastCron's new rule compares against TODAY, so a
// frozen date would silently stop exercising the fix.
const FIXED_NOW = Date.now();
const MAX_FUTURE_SKEW_MS = 120000;                      // mirrors sync.js
const SKEWED = FIXED_NOW + MAX_FUTURE_SKEW_MS + 60000;  // beyond tolerance -> _ua clamps to 0
const NORMAL = FIXED_NOW - 5000;
const NORMAL_OLDER = FIXED_NOW - 9000;

// local mirror of sync.js dayStampOf(), so the test does not depend on it being exported
function ds(ms){ const d = new Date(ms); return d.getFullYear()*10000 + (d.getMonth()+1)*100 + d.getDate(); }
const TODAY_STAMP    = ds(FIXED_NOW);
const TOMORROW_STAMP = ds(FIXED_NOW + 86400000);
const FAR_FUTURE_STAMP = ds(FIXED_NOW + 400 * 86400000); // ~13 months out: the "wrong clock" case

const Q = makeQ('devA');
if (!Q || typeof Q.merge !== 'function' || typeof Q.mergeCollection !== 'function') {
  console.error('FAIL: QuestaSync registry missing merge/mergeCollection');
  process.exit(1);
}

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

function mk(overrides) {
  return Object.assign({
    tasks: [], rewards: [], tags: [], devices: [],
    an: {views: [], metrics: []},
    history: [], charHistory: [], monthlyBackups: [],
    lastCron: 0, char: {}, deletions: [], pause: {}
  }, overrides);
}
function findById(arr, id) { return (arr || []).find(function(x){ return x && x.id === id; }); }

// A daily completed TODAY, with two of its subtasks ticked.
// 2026-09-19: "an hour ago" is not the same thing as "earlier TODAY". Between
// local midnight and 01:00, FIXED_NOW - 3600000 lands on YESTERDAY, so
// dayStampOf(doneAt) < TODAY_STAMP, normalizeDailyResets correctly resets the
// daily, and K1-A/K1-B both failed -- for one hour, every night. Verified: the
// same four assertions fail at 00:00 on the pre-2026-09-18 code too, so this is
// a fixture defect, not a regression. Clamp to today's local midnight so the
// fixture means what its name says at every hour of the day.
function _startOfLocalToday(ms){ const d = new Date(ms); d.setHours(0,0,0,0); return d.getTime(); }
function doneToday(id){
  return { id: id, type: 'daily', title: 'Stretch', done: true,
           doneAt: Math.max(FIXED_NOW - 3600000, _startOfLocalToday(FIXED_NOW)),
           missedOn: 0, updatedAt: NORMAL, streak: 4,
           checklist: [ {id:'c1', text:'left',  done:true,  touchedAt: NORMAL},
                        {id:'c2', text:'right', done:true,  touchedAt: NORMAL},
                        {id:'c3', text:'back',  done:false, touchedAt: 0} ] };
}
function ticked(t){ return ((t && t.checklist) || []).filter(function(c){ return c.done; }).length; }

// =========================================================================
// K1-A -- bug #1: a far-future remote lastCron must not poison the fleet.
// =========================================================================
(function(){
  const task = doneToday('a1');
  const base   = mk({ tasks: [task], lastCron: TODAY_STAMP });
  const local  = mk({ tasks: [task], lastCron: TODAY_STAMP });
  const remote = mk({ tasks: [task], lastCron: FAR_FUTURE_STAMP }); // peer's clock is ~13 months out
  const m = Q.merge(base, local, remote, NORMAL, NORMAL, 'devA', 'devB');

  assert('[K1-A] a far-future remote lastCron never becomes the merged lastCron',
    m.lastCron === TODAY_STAMP);
  const out = findById(m.tasks, 'a1');
  assert('[K1-A] ...so today\'s completed daily is NOT force-unchecked',
    !!out && out.done === true);
  assert('[K1-A] ...and its two subtask ticks survive',
    ticked(out) === 2);
})();

// =========================================================================
// K1-B -- bug #2: a peer one calendar day ahead (real cross-timezone case)
// must not wipe this device's still-current completion.
// NOTE: this deliberately narrows tests/daystamp.test.js T3, which documents
// "merged lastCron ahead of doneAt -> reset" as CORRECT. That stays correct
// for a cron day at or behind THIS device's today (T3 uses July 2026 stamps,
// so it is unaffected). What changed: a cron day in this device's FUTURE now
// carries no authority over this device's own day boundary, because the reset
// it triggered destroyed same-day work that no other channel could restore.
// =========================================================================
(function(){
  const task = doneToday('b1');
  const base   = mk({ tasks: [task], lastCron: TODAY_STAMP });
  const local  = mk({ tasks: [task], lastCron: TODAY_STAMP });
  const remote = mk({ tasks: [task], lastCron: TOMORROW_STAMP }); // UTC+13 peer already rolled over
  const m = Q.merge(base, local, remote, NORMAL, NORMAL, 'devA', 'devB');

  assert('[K1-B] a peer one day ahead does not drag this device\'s cron day forward',
    m.lastCron === TODAY_STAMP);
  const out = findById(m.tasks, 'b1');
  assert('[K1-B] ...today\'s completion survives the cross-timezone round',
    !!out && out.done === true);
  assert('[K1-B] ...and the subtask ticks are not cleared',
    ticked(out) === 2);
})();

// =========================================================================
// K1-C -- GUARD: a plausible (past or today) remote lastCron must STILL win
// the max, or a device that is legitimately behind never rolls over.
// =========================================================================
(function(){
  const local  = mk({ lastCron: 0 });
  const remote = mk({ lastCron: TODAY_STAMP });
  const m = Q.merge(mk({}), local, remote, NORMAL, NORMAL, 'devA', 'devB');
  assert('[K1-C GUARD] a remote lastCron at or behind today still wins the plain max',
    m.lastCron === TODAY_STAMP);
})();
(function(){
  const local  = mk({ lastCron: TODAY_STAMP });
  const remote = mk({ lastCron: FAR_FUTURE_STAMP });
  const m = Q.merge(mk({}), local, remote, NORMAL, NORMAL, 'devA', 'devB');
  assert('[K1-C GUARD] a local lastCron is never LOWERED by the new rule',
    m.lastCron === TODAY_STAMP);
})();

// =========================================================================
// K1-D -- bug #3: tombstone overlay, ENTITY operand must stay raw.
// Device B deleted the task at NORMAL_OLDER; device A re-created/edited it
// afterwards while its clock ran fast. The re-creation is the later act and
// must win on BOTH devices.
// =========================================================================
(function(){
  const task = { id: 'd1', type: 'todo', title: 'Recreated', updatedAt: SKEWED };
  const tomb = new Map([['d1', NORMAL_OLDER]]);
  const out = Q.mergeCollection([], [task], [], NORMAL, NORMAL, tomb);
  assert('[K1-D] a task re-created after the delete survives even when its stamp is future-skewed',
    !!findById(out, 'd1'));
})();
(function(){
  // GUARD: the ordinary case must still delete -- a tombstone newer than the entity wins.
  const task = { id: 'd2', type: 'todo', title: 'Really deleted', updatedAt: NORMAL_OLDER };
  const tomb = new Map([['d2', NORMAL]]);
  const out = Q.mergeCollection([], [task], [], NORMAL, NORMAL, tomb);
  assert('[K1-D GUARD] a tombstone newer than the entity still deletes it',
    !findById(out, 'd2'));
})();

// =========================================================================
// K1-E -- bug #4: GUARD 1 fires only when local did NOT change, so remote
// holds the only real edit. A future-skewed stamp must not erase it.
// =========================================================================
(function(){
  const b = { id: 'e1', type: 'todo', title: 'Old title', updatedAt: NORMAL_OLDER };
  const l = { id: 'e1', type: 'todo', title: 'Old title', updatedAt: NORMAL_OLDER }; // deep-equal to base
  const r = { id: 'e1', type: 'todo', title: 'New title', updatedAt: SKEWED };       // the only real edit
  const out = Q.mergeCollection([b], [l], [r], NORMAL, NORMAL, null, 'devB');
  const got = findById(out, 'e1');
  assert('[K1-E] a remote-only edit with a future-skewed stamp is kept, not discarded',
    !!got && got.title === 'New title');
})();
(function(){
  // GUARD: GUARD 1's real job -- a poisoned base must not let an OLDER remote
  // overwrite a newer local. Unchanged by K1.
  const b = { id: 'e2', type: 'todo', title: 'Fresh local', updatedAt: NORMAL };
  const l = { id: 'e2', type: 'todo', title: 'Fresh local', updatedAt: NORMAL };
  const r = { id: 'e2', type: 'todo', title: 'Stale remote', updatedAt: NORMAL_OLDER };
  const out = Q.mergeCollection([b], [l], [r], NORMAL, NORMAL, null, 'devB');
  const got = findById(out, 'e2');
  assert('[K1-E GUARD] GUARD 1 still blocks an older remote from overwriting a newer local',
    !!got && got.title === 'Fresh local');
})();

// ---- summary ----
console.log('\n--- merge-polarity-k1.test.js summary ---');
if (failures) {
  console.error(failures + ' assertion(s) FAILED');
  process.exit(1);
}
console.log('merge-polarity-k1.test.js: all assertions passed');
process.exit(0);
