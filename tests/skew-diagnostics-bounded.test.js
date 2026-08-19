// skew-diagnostics-bounded.test.js -- guards the PLANNED per-round diagnostic
// aggregation for the four INVERTED-POLARITY merge sites in sync.js, where
// clamping a future-skewed raw timestamp to 0 would DESTROY data instead of
// merely losing a tiebreak (so those sites stay unclamped; the future-skew
// condition is instead made observable via _qDiagPush). Sites:
//   1. sync.js:667-669  mergeChecklist survivor-vs-deletion (per-subtask loop)
//   2. sync.js:838-839 / 852-853,867  cleanDevices isJunk + mergeDevices score
//   3. sync.js:807      mergeCollection tombstone overlay (per-entity loop)
//   4. sync.js:995-1002 merge()'s one-sided char recency guard (once/round)
//
// window.__qDiag.errors (app.js:9, _qDiagPush) is a blind-FIFO 50-entry ring.
// Sites 1 and 3 sit inside per-record loops, so a naive PER-RECORD push would
// flood that ring on one skewed merge round and evict the crash records (and
// evtWatermarkRepaired) the ring exists for. The fix must therefore emit
// exactly ONE aggregate entry per site per round: module-level counters reset
// at the start of merge() (sync.js:921) and emitted just before merge()
// returns (sync.js:1043).
//
// Required diagnostic contract (production must match byte-for-byte):
//   kind strings : 'skewChecklistSurvivor' (site 1), 'skewDeviceMerge' (site 2),
//                  'skewTombstoneOverlay' (site 3), 'skewCharGuard' (site 4)
//   entry shape  : { t, kind, n, maxTs, worstId }
//     n        = count of raw-value-exceeds-tolerance detections this round
//     maxTs    = the largest raw (unclamped) skewed value seen this round
//     worstId  = id of the record that produced maxTs (subtask/device/task id;
//                may be null for the char guard, which has no id and fires at
//                most once per round)
//   guard idiom  : every emit wrapped in `typeof _qDiagPush === "function"`
//   detection expr: the SAME raw value already used at that site, compared as
//                  `rawTs > _hlcNow() + MAX_FUTURE_SKEW_MS` (sync.js:20, 120000)
//                  -- NOT clamped; the merge result must be unchanged.
//
// This file only exercises site 1 (mergeChecklist) for the aggregation/bound
// assertions (tests 1-3, 5) because it is the simplest site to flood in bulk.
// Tests 4a-4d separately pin BEHAVIOUR NEUTRALITY at all four sites using
// today's (already-unclamped) merge semantics -- those are the revert trigger
// if the eventual diagnostics patch ever accidentally starts clamping.
//
// Run: node tests/skew-diagnostics-bounded.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');

let SRC = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
SRC = SRC.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');

// ---- sandbox factory (pattern: convergence.test.js + evtpull-instrumentation
// .test.js:94-102 for the __qDiag/_qDiagPush wiring) -------------------------
function loadModule(withDiag){
  const noop = function(){};
  const diagEntries = [];
  const sandbox = {
    window: {}, navigator: { onLine: true },
    document: { addEventListener: noop, getElementById: function(){ return null; },
      createElement: function(){ return { style: {}, appendChild: noop, setAttribute: noop, click: noop }; },
      body: { appendChild: noop, removeChild: noop } },
    localStorage: { getItem: function(){ return null; }, setItem: noop, removeItem: noop,
      key: function(){ return null; }, length: 0 },
    indexedDB: { open: function(){ return {}; } },
    setTimeout: function(){ return 0; }, clearTimeout: noop,
    setInterval: function(){ return 0; }, clearInterval: noop,
    console: console, JSON: JSON, Math: Math, Date: Date,
    Map: Map, Set: Set, WeakSet: WeakSet,
    Array: Array, Object: Object, Number: Number, String: String,
    Boolean: Boolean, Promise: Promise,
    logEvent: noop, toast: noop, render: noop, esc: function(x){ return x; },
    save: noop, uid: function(){ return 'x'; },
    idbOpen: function(){ return Promise.resolve(null); }
  };
  if(withDiag){
    sandbox.window.__qDiag = { errors: diagEntries };
    // Exact copy of app.js:9's ring: push then cap-at-50 FIFO shift. Must be
    // the REAL bounded ring (not an unbounded array) or test 2 proves nothing.
    sandbox._qDiagPush = function(kind, data){
      try{
        sandbox.window.__qDiag.errors.push(Object.assign({ t: Date.now(), kind: kind }, data));
        if(sandbox.window.__qDiag.errors.length > 50) sandbox.window.__qDiag.errors.shift();
      }catch(e){}
    };
  }
  // else: leave both window.__qDiag and _qDiagPush entirely absent (test 5).
  sandbox.self = sandbox.window;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  try { vm.runInContext(SRC, sandbox); } catch(e) { /* QuestaSync assigned before any throwable boot code */ }
  const Q = sandbox.window.QuestaSync;
  if (!Q || typeof Q.merge !== 'function') {
    console.error('FAIL: QuestaSync.merge not found in sync.js');
    process.exit(1);
  }
  return { Q: Q, diagEntries: diagEntries };
}

let failures = 0;
function assert(desc, cond){ if(cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }

// Full QuestaSync state object with overrides (mirrors convergence.test.js's mk()).
function subState(overrides){
  return Object.assign({
    tasks: [], rewards: [], tags: [], devices: [],
    an: { views: [], metrics: [] },
    history: [], charHistory: [], monthlyBackups: [],
    lastCron: 0, char: {}, deletions: []
  }, overrides);
}

function countKind(arr, kind){ return arr.filter(function(e){ return e && e.kind === kind; }).length; }
function has(arr, id){ return (arr || []).some(function(t){ return t.id === id; }); }
function delHas(arr, id){ return (arr || []).some(function(d){ return d.id === id; }); }

// All fixture timestamps are relative to Date.now() so this file cannot rot.
const NOW = Date.now();
const MAX_FUTURE_SKEW_MS = 120000; // must match sync.js:20
const SKEW = NOW + MAX_FUTURE_SKEW_MS + 3600000; // ~1h past the 120s tolerance -- unambiguously skewed
const OLD = NOW - 500000;
const MID = NOW - 400000;
const NEWER = NOW - 300000;
const N_SUBTASKS = 60; // > the 50-slot ring; a per-record push would overflow it

// One task, N_SUBTASKS skewed subtasks present ONLY on the local side (remote
// dropped its whole checklist). Task titles differ on both sides from base so
// mergeCollection's "both changed" branch fires and splices mergeChecklist in
// -- hitting site 1's per-subtask loop (sync.js:616/667-669) N_SUBTASKS times
// in ONE round.
function buildChecklistFixture(n){
  const baseSubs = [], localSubs = [];
  for(let i = 0; i < n; i++){
    const id = 's' + i;
    baseSubs.push({ id: id, text: 'orig', done: false, touchedAt: OLD });
    localSubs.push({ id: id, text: 'local-edit-' + i, done: false, touchedAt: SKEW });
  }
  const baseTask = { id: 't1', type: 'todo', title: 'orig', updatedAt: OLD, checklist: baseSubs };
  const localTask = { id: 't1', type: 'todo', title: 'local-title', updatedAt: MID, checklist: localSubs };
  const remoteTask = { id: 't1', type: 'todo', title: 'remote-title', updatedAt: NEWER, checklist: [] };
  return {
    base: subState({ tasks: [baseTask] }),
    local: subState({ tasks: [localTask] }),
    remote: subState({ tasks: [remoteTask] })
  };
}

// ===========================================================================
// Shared sandbox for tests 1-4 (module-level counters reset per merge() call,
// so reusing one loaded module across rounds is exactly the "per-round"
// semantics under test).
// ===========================================================================
const M = loadModule(true);
const Q = M.Q, diagEntries = M.diagEntries;

// ===========================================================================
// TEST 1 -- THE BOUND (RED on HEAD: today's merge emits nothing at all, so
// "grew by 0" must also fail -- we require at least one entry for skewed input).
// ===========================================================================
(function(){
  const fx = buildChecklistFixture(N_SUBTASKS);
  const before = diagEntries.length;
  const m = Q.merge(fx.base, fx.local, fx.remote, NOW, NOW);
  const after = diagEntries.length;
  const grew = after - before;

  assert('T1 merge of ' + N_SUBTASKS + ' skewed subtasks grows the diag ring by >=1 entry (not 0)', grew >= 1);
  assert('T1 diag ring growth is bounded by the site cap (<=4), not per-record', grew <= 4);
  assert('T1 diag ring growth is NOT the record count (' + N_SUBTASKS + ')', grew !== N_SUBTASKS);

  const task = (m.tasks || []).find(function(t){ return t.id === 't1'; });
  const newEntries = diagEntries.slice(before);
  const site1 = newEntries.filter(function(e){ return e.kind === 'skewChecklistSurvivor'; });
  assert('T1 exactly one skewChecklistSurvivor entry emitted for this round', site1.length === 1);
  assert('T1 skewChecklistSurvivor entry.n equals the skewed-subtask count (' + N_SUBTASKS + ')',
    site1[0] && site1[0].n === N_SUBTASKS);
  assert('T1 skewChecklistSurvivor entry carries a numeric maxTs',
    site1[0] && typeof site1[0].maxTs === 'number' && site1[0].maxTs >= SKEW);
  assert('T1 skewChecklistSurvivor entry carries a worstId among the skewed subtasks',
    site1[0] && typeof site1[0].worstId === 'string' && /^s\d+$/.test(site1[0].worstId));
  assert('T1 sanity: all ' + N_SUBTASKS + ' skewed subtasks actually survived in the merge result',
    task && (task.checklist || []).length === N_SUBTASKS);
})();

// ===========================================================================
// TEST 2 -- RING SURVIVAL (GREEN on HEAD by design: 0 growth cannot evict
// anything either; this proves the AGGREGATE growth, once it exists, still
// cannot evict the crash-record sentinels the ring exists for).
// ===========================================================================
(function(){
  const SENTINEL_KIND = 'sentinelCrash'; // stands in for a real uncaught-error record
  const sentinels = [];
  for(let i = 0; i < 5; i++){
    const e = { t: Date.now(), kind: SENTINEL_KIND, marker: i };
    diagEntries.push(e);
    sentinels.push(e);
  }
  const fx = buildChecklistFixture(N_SUBTASKS);
  Q.merge(fx.base, fx.local, fx.remote, NOW, NOW);

  const survivorsPresent = sentinels.every(function(s){
    return diagEntries.some(function(e){ return e.kind === SENTINEL_KIND && e.marker === s.marker; });
  });
  assert('T2 all 5 pre-existing sentinel entries survive a many-skewed-record merge', survivorsPresent);
  assert('T2 sentinel count unchanged (still exactly 5)', countKind(diagEntries, SENTINEL_KIND) === 5);
})();

// ===========================================================================
// TEST 3 -- AT MOST ONE ENTRY PER KIND PER THROTTLE WINDOW, ACROSS ROUNDS.
//
// CHANGED 2026-08-19 by J1 finding 3 (plan todo 18). This test previously asserted
// "+1 entry per ROUND": round 1 adds one, round 2 adds one more. That was the
// correct contract before J1 and it is deliberately no longer true.
//
// Why it changed: there was no cross-round throttle. merge() runs once per round
// and again on a conflict retry, SYNC_DEBOUNCE_MS is 5000, and _qDiagPush is a
// 50-entry ring with blind FIFO eviction -- so a peer more than 120 s fast (far
// likelier since todo 17 tightened the ratchet tolerance from 1 h to 2 min) flushed
// 4-8 entries per ROUND and evicted every uncaught-error and evtWatermarkRepaired
// record the ring exists for in roughly 7-13 rounds. sync.js now carries a per-kind
// last-pushed timestamp (SKEW_DIAG_MIN_INTERVAL_MS, 60000) mirroring
// _evtPullLastThrottleDiag, so repeat rounds inside one window emit nothing.
//
// The original per-round-not-per-record property is NOT lost: it is pinned by T1's
// `entry.n === N_SUBTASKS` plus `site1.length === 1` assertions above, which prove a
// single aggregate record carries the whole round's count instead of one record per
// record. What T3 now pins is the throttle itself.
//
// This file shares one real (unsteppable) clock across all of its tests, and T1/T2
// already emitted this kind's one record for the current window, so both rounds
// below must add ZERO. The window-reopens-again half of the contract needs a
// steppable clock and lives in tests/skew-diag-hardening.test.js (F3d/F3e).
// ===========================================================================
(function(){
  const before = countKind(diagEntries, 'skewChecklistSurvivor');
  const ringBefore = diagEntries.length;

  const fx1 = buildChecklistFixture(N_SUBTASKS);
  Q.merge(fx1.base, fx1.local, fx1.remote, NOW, NOW); // round 1
  const afterRound1 = countKind(diagEntries, 'skewChecklistSurvivor');

  const fx2 = buildChecklistFixture(N_SUBTASKS);
  Q.merge(fx2.base, fx2.local, fx2.remote, NOW, NOW); // round 2
  const afterRound2 = countKind(diagEntries, 'skewChecklistSurvivor');

  assert('T3 the window already holds this kind\'s one record (emitted by T1)', before >= 1);
  assert('T3 round 1 inside the same throttle window adds NO further entry',
    (afterRound1 - before) === 0);
  assert('T3 round 2 inside the same throttle window adds NO further entry',
    (afterRound2 - afterRound1) === 0);
  assert('T3 two more skewed rounds grew the ring by 0, not by ' + (2 * 4) + ' -- the ring is protected',
    (diagEntries.length - ringBefore) === 0);
})();

// ===========================================================================
// TEST 4 -- BEHAVIOUR NEUTRALITY (GREEN on HEAD AND after the diagnostics
// patch lands -- these are the revert trigger: if any of a-d ever flips,
// the diagnostics change accidentally started clamping).
// ===========================================================================

// 4a: site 3 (tombstone overlay) -- a future-skewed tombstone `at` still DELETES.
(function(){
  const t1 = { id: 't1', type: 'todo', title: 't1', updatedAt: OLD };
  const base = subState({ tasks: [Object.assign({}, t1)] });
  const local = subState({ tasks: [Object.assign({}, t1)], deletions: [{ id: 't1', at: SKEW }] });
  const remote = subState({ tasks: [Object.assign({}, t1)] });
  const m = Q.merge(base, local, remote, NOW, NOW);
  assert('T4a future-skewed tombstone still deletes the task', !has(m.tasks, 't1'));
  assert('T4a tombstone propagates into merged.deletions', delHas(m.deletions, 't1'));
})();

// 4b: site 2 (mergeDevices score / cleanDevices isJunk) -- a deliberate clear
// made on a skewed clock still WINS over the stale old name.
(function(){
  const baseDev = { id: 'd1', name: 'OldName', updatedAt: OLD };
  const localDev = { id: 'd1', name: '', updatedAt: SKEW }; // deliberate clear, skewed clock
  const remoteDev = { id: 'd1', name: 'OldName', updatedAt: OLD }; // unchanged
  const m = Q.merge(subState({ devices: [baseDev] }), subState({ devices: [localDev] }), subState({ devices: [remoteDev] }), NOW, NOW);
  const dev = (m.devices || []).find(function(d){ return d.id === 'd1'; });
  assert('T4b skewed deliberate name-clear still wins over the stale old name', dev && dev.name === '');
})();

// 4c: site 1 (mergeChecklist survivor-vs-deletion) -- a skewed-but-real
// subtask edit still SURVIVES (is not deleted).
(function(){
  const fx = buildChecklistFixture(N_SUBTASKS);
  const m = Q.merge(fx.base, fx.local, fx.remote, NOW, NOW);
  const task = (m.tasks || []).find(function(t){ return t.id === 't1'; });
  assert('T4c all skewed-but-real subtask edits survive (none deleted)',
    task && (task.checklist || []).length === N_SUBTASKS);
})();

// 4d: site 4 (one-sided char guard) -- local deep-equals base, only remote
// changed -> a future-skewed r.updatedAt still WINS so remote's real
// XP/gold/level is kept.
let diagTaskResult; // captured for test 5's cross-sandbox comparison
(function(){
  const baseChar = { name: 'Hero', face: 'W', cls: 'Wizard', lvl: 5, xp: 50, hp: 80, maxHp: 80, mp: 20, gold: 10, updatedAt: OLD };
  const localChar = Object.assign({}, baseChar); // identical to base -> localChanged=false
  const remoteChar = { name: 'Hero', face: 'W', cls: 'Wizard', lvl: 50, xp: 999, hp: 200, maxHp: 200, mp: 100, gold: 500, updatedAt: SKEW };
  const m = Q.merge(subState({ char: baseChar }), subState({ char: localChar }), subState({ char: remoteChar }), NOW, NOW);
  assert('T4d skewed-but-real remote char update still wins (xp kept)', m.char && m.char.xp === 999);
  assert('T4d skewed-but-real remote char update still wins (lvl kept)', m.char && m.char.lvl === 50);
})();

// Capture a diag-enabled reference result for test 5's cross-sandbox check.
(function(){
  const fx = buildChecklistFixture(N_SUBTASKS);
  const m = Q.merge(fx.base, fx.local, fx.remote, NOW, NOW);
  diagTaskResult = (m.tasks || []).find(function(t){ return t.id === 't1'; });
})();

// ===========================================================================
// TEST 5 -- GUARD PRESENT (GREEN on HEAD AND after the patch: with _qDiagPush
// and window.__qDiag ABSENT from the sandbox entirely, the merge must still
// complete and return the identical result -- proving every emit site is
// wrapped in `typeof _qDiagPush === "function"` and a missing app.js global
// never breaks the merge, per AGENTS.md Section 1).
// ===========================================================================
(function(){
  const M2 = loadModule(false); // no window.__qDiag, no _qDiagPush at all
  const fx = buildChecklistFixture(N_SUBTASKS);
  let threw = false, m;
  try { m = M2.Q.merge(fx.base, fx.local, fx.remote, NOW, NOW); }
  catch(e){ threw = true; }
  assert('T5 merge completes without throwing when _qDiagPush is entirely absent', !threw);
  const task = m && (m.tasks || []).find(function(t){ return t.id === 't1'; });
  assert('T5 merge result is identical to the diag-enabled run (same surviving task)',
    task && diagTaskResult && JSON.stringify(task) === JSON.stringify(diagTaskResult));
})();

// ---- summary ----
console.log('\n--- skew-diagnostics-bounded.test.js summary ---');
if (failures) {
  console.error(failures + ' assertion(s) FAILED');
  process.exit(1);
}
console.log('skew-diagnostics-bounded.test.js: all assertions passed');
process.exit(0);
