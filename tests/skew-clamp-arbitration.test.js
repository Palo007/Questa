// skew-clamp-arbitration.test.js -- 2026-08-18 future-skew clamp coverage.
//
// _ua/_ca (sync.js ~690-691) already clamp a future timestamp beyond
// MAX_FUTURE_SKEW_MS to 0, but several arbitration comparisons still use the
// RAW (unclamped) timestamp, so a device with a fast/skewed clock can win a
// genuine conflict it has no business winning. This file pins the six sites
// that are expected to gain a `_clampFuture`-style clamp, plus five guard
// tests for sites that must NOT be touched (touching them would silently
// delete real data -- see the two-round subtask-survival test below).
//
// Written against the planned shape (not yet landed):
//   - resolveDailyConflict(l, r, localDeviceId, remoteDeviceId) -- ms
//     fallback (rule 3) clamps both sides, then on a clamped tie prefers the
//     record owned by the lexically GREATER device id.
//   - mergeCollection(..., tombstoneMap, remoteDeviceId) -- both-changed
//     tiebreak gets the same clamp + deviceId-tie treatment (local id via
//     syncDeviceId()).
//   - mergeChecklist -- clamped copies used ONLY at the text/done tiebreak
//     lines; the raw `lt`/`rt` and `Math.max(lt, rt)` that decide whether
//     touchedAt survives are left untouched.
//   - pause `at` -- clamped copies used only to pick which side's `paused`
//     flag survives; `Math.max(lAt, rAt)` for the stored `at` stays raw.
//   - char both-changed branch -- clamped compare, falls through to the
//     EXISTING deterministic deviceId tiebreak on a non-strict-win.
//
// Sections 1-2 (SKEW / TIE) are expected to be RED against the current
// pre-fix code, for the right reasons (raw-timestamp arbitration). Sections
// 3-5 (GUARD) are expected to be GREEN against the current code already,
// and must stay green after the fix lands -- they exist to catch someone
// clamping a site that must stay raw.
//
// Run: node tests/skew-clamp-arbitration.test.js   (do NOT run tests/run.js)

const fs = require('fs'), path = require('path'), vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* stripped */');
src = src.replace(/\bsyncInit\(\)\s*;?\s*$/, '');

// Build a fresh vm sandbox. `uidValue` fixes syncDeviceId()'s output (the
// sandbox's mocked localStorage.getItem always returns null, so syncCfg()
// never has a persisted deviceId and falls through to uid()) -- this lets
// the mergeCollection tie-convergence test simulate two DIFFERENT physical
// devices, each with its own stable identity, by loading sync.js twice.
// `now` pins _hlcNow() so every skew fixture is computed relative to one
// fixed instant, immune to real-clock drift during the test run.
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

// ---- fixed clock + skew fixtures (all relative to Date.now(), never a
// hardcoded calendar date -- see commit 6b93a82 for why that matters here) --
const FIXED_NOW = Date.now();
const MAX_FUTURE_SKEW_MS = 120000; // mirrors sync.js MAX_FUTURE_SKEW_MS
const SKEWED = FIXED_NOW + MAX_FUTURE_SKEW_MS + 60000; // well beyond tolerance -> clamps to 0
const NORMAL = FIXED_NOW - 5000;        // a real, recent, unskewed edit
const NORMAL_OLDER = FIXED_NOW - 9000;  // an earlier real edit / base snapshot

const Q = makeQ('x');
if (!Q || typeof Q.merge !== 'function' || typeof Q.mergeCollection !== 'function' ||
    typeof Q.resolveDailyConflict !== 'function' || typeof Q.mergeChecklist !== 'function') {
  console.error('FAIL: QuestaSync registry missing merge/mergeCollection/resolveDailyConflict/mergeChecklist');
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

function findById(arr, id) {
  return (arr || []).find(function(x){ return x && x.id === id; });
}

// =========================================================================
// SECTION 1 -- six clamp sites: skewed side must LOSE. RED on current code
// (raw timestamps let the skewed side win).
// =========================================================================

// 1a. resolveDailyConflict ms fallback (rule 3).
(function(){
  var l = {id:'d1', type:'daily', title:'local', done:false, doneAt:0, missedOn:0, updatedAt: SKEWED};
  var r = {id:'d1', type:'daily', title:'remote', done:false, doneAt:0, missedOn:0, updatedAt: NORMAL};
  var w = Q.resolveDailyConflict(l, r);
  assert('[SKEW 1a] resolveDailyConflict ms fallback: skewed local loses to real remote',
    w && w.title === 'remote');
})();

// 1b. mergeCollection both-changed tiebreak (non-daily type).
(function(){
  var b = {id:'t1', type:'todo', title:'base', updatedAt: NORMAL_OLDER};
  var l = {id:'t1', type:'todo', title:'local', updatedAt: SKEWED};
  var r = {id:'t1', type:'todo', title:'remote', updatedAt: NORMAL};
  var out = Q.mergeCollection([b], [l], [r], NORMAL, NORMAL, null);
  var winner = findById(out, 't1');
  assert('[SKEW 1b] mergeCollection tasks tiebreak: skewed local loses to real remote',
    winner && winner.title === 'remote');
})();

// 1c. mergeChecklist text (genuine two-sided conflict).
(function(){
  var b = {id:'s1', text:'base', done:false, touchedAt: NORMAL_OLDER};
  var l = {id:'s1', text:'local-edit', done:false, touchedAt: SKEWED};
  var r = {id:'s1', text:'remote-edit', done:false, touchedAt: NORMAL};
  var out = Q.mergeChecklist([b], [l], [r], false);
  var item = findById(out, 's1');
  assert('[SKEW 1c] mergeChecklist text: skewed local edit loses to real remote edit',
    item && item.text === 'remote-edit');
})();

// 1d. mergeChecklist done (genuine two-sided conflict; base absent so both
// sides count as "changed" -- see block comment above resolveDailyConflict
// tests re: the only way a boolean genuinely disagrees on both sides).
(function(){
  var l = {id:'s2', text:'same', done:true, touchedAt: SKEWED};
  var r = {id:'s2', text:'same', done:false, touchedAt: NORMAL};
  var out = Q.mergeChecklist([], [l], [r], false);
  var item = findById(out, 's2');
  assert('[SKEW 1d] mergeChecklist done: skewed local done=true loses to real remote done=false',
    item && item.done === false);
})();

// 1e. pause `at` comparison (which side's `paused` flag survives).
(function(){
  var localP = {paused: true, pausedDays: [], at: SKEWED};
  var remoteP = {paused: false, pausedDays: [], at: NORMAL};
  var out = Q.merge(mk({pause: {}}), mk({pause: localP}), mk({pause: remoteP}), NORMAL, NORMAL);
  assert('[SKEW 1e] pause at: skewed local pause state loses to real remote pause state',
    out.pause && out.pause.paused === false);
})();

// 1f. char both-changed branch. Local is the real/normal side; remote is
// the skewed side. Explicit deviceIds (local > remote lexically) pin the
// post-fix fallthrough to the EXISTING deterministic tiebreak so the
// expected winner is unambiguous once the raw compare no longer lets the
// skewed remote win outright.
(function(){
  var REALCHAR = {name:'Pali', face:'W', cls:'Warrior', hp:120, maxHp:120, mp:0};
  var l = Object.assign({}, REALCHAR, {lvl:14, xp:8300, gold:540, updatedAt: NORMAL});
  var r = Object.assign({}, REALCHAR, {lvl:20, xp:9000, gold:600, updatedAt: SKEWED});
  var out = Q.merge(mk({char:{}}), mk({char:l}), mk({char:r}), NORMAL, NORMAL, 'devZ', 'devA');
  assert('[SKEW 1f] char both-changed: skewed remote edit loses (falls through to devZ>devA tiebreak)',
    out.char && out.char.lvl === 14);
})();

// =========================================================================
// SECTION 2 -- tie convergence: BOTH sides skewed past tolerance so both
// clamp to 0 and tie. The two perspectives (which record is "local" vs
// "remote") must agree on the SAME winner. RED on current code: with no
// clamp, an exact raw tie already exists (both sides use the identical
// SKEWED value), and the plain `luc > ruc ? l : r` fallback always favors
// whichever record is passed as `r` -- so each device concludes the OTHER
// device's copy won (split-brain), never converging.
// =========================================================================

// 2a. resolveDailyConflict.
(function(){
  var A = {id:'d1', type:'daily', title:'A', done:false, doneAt:0, missedOn:0, updatedAt: SKEWED};
  var B = {id:'d1', type:'daily', title:'B', done:false, doneAt:0, missedOn:0, updatedAt: SKEWED};
  var fromA = Q.resolveDailyConflict(A, B, 'devA', 'devB'); // device A's view: own=A(local), other=B(remote)
  var fromB = Q.resolveDailyConflict(B, A, 'devB', 'devA'); // device B's view: own=B(local), other=A(remote)
  assert('[TIE 2a] resolveDailyConflict: both-skewed tie converges to the same record from both perspectives',
    fromA && fromB && fromA.title === fromB.title);
})();

// 2b. mergeCollection -- two separate device sandboxes so syncDeviceId()
// genuinely differs per perspective (it is not a parameter; it comes from
// syncDeviceId() internally per the planned signature).
(function(){
  var Qa = makeQ('devA');
  var Qb = makeQ('devB');
  var b = {id:'t1', type:'todo', title:'base', updatedAt: NORMAL_OLDER};
  var A = {id:'t1', type:'todo', title:'A', updatedAt: SKEWED};
  var B = {id:'t1', type:'todo', title:'B', updatedAt: SKEWED};
  var fromA = Qa.mergeCollection([b], [A], [B], NORMAL, NORMAL, null, 'devB'); // device A: local=A, remote=B
  var fromB = Qb.mergeCollection([b], [B], [A], NORMAL, NORMAL, null, 'devA'); // device B: local=B, remote=A
  var wa = findById(fromA, 't1');
  var wb = findById(fromB, 't1');
  assert('[TIE 2b] mergeCollection: both-skewed tie converges to the same record from both device perspectives',
    wa && wb && wa.title === wb.title);
})();

// =========================================================================
// SECTION 3/4 -- mergeChecklist touchedAt survival. GREEN on current code
// already (mergeChecklist is entirely untouched today). Must STAY green
// after the fix: clamped copies belong ONLY at the text/done tiebreak
// lines, never at the `lt`/`rt` declaration or the `Math.max(lt, rt)` that
// decides whether touchedAt is kept or deleted.
// =========================================================================

var r1Base = {id:'s1', text:'orig', done:false, touchedAt: NORMAL_OLDER};
var r1Local = {id:'s1', text:'local-edit', done:false, touchedAt: SKEWED};
var r1Remote = {id:'s1', text:'remote-edit', done:true, touchedAt: SKEWED};
var round1 = Q.mergeChecklist([r1Base], [r1Local], [r1Remote], true)[0];

// 3. touchedAt SURVIVES a future-skewed merge (GREEN on HEAD by design --
// this is NOT the regression; it's a baseline sanity check).
assert('[GUARD touchedAt] merged.touchedAt survives a future-skewed checklist merge (GREEN on HEAD by design)',
  round1 && !!round1.touchedAt);

// 4. TWO-ROUND SUBTASK SURVIVAL -- the most important test in this file.
// Feed round1's merged item back as `local`, absent from `remote`, against
// a `base` that has a real (unskewed) touchedAt for the same id. The
// subtask must survive: its touchedAt (from round1) is strictly newer than
// base's, so the "edit wins over deletion" rule at sync.js keeps it.
// GREEN on current code AND must stay green after the correct fix --
// it fails ONLY if someone wrongly clamps the raw `lt`/`rt` declaration
// (which would zero the Math.max and delete merged.touchedAt in round 1,
// making round1.touchedAt undefined here, so `survivorTouchedAt > baseTouchedAt`
// would be false and the subtask would be silently dropped).
(function(){
  var r2Base = [{id:'s1', text: round1.text, done: round1.done, touchedAt: NORMAL_OLDER}];
  var r2Local = [round1];
  var r2Remote = [];
  var out = Q.mergeChecklist(r2Base, r2Local, r2Remote, true);
  assert('[GUARD 2-round] subtask survives a second round absent from remote (fails only if the raw lt/rt line is wrongly clamped)',
    !!findById(out, 's1'));
})();

// =========================================================================
// SECTION 5 -- forbidden-site guards. Both GREEN on current code already
// and must stay green after the fix -- they exist to catch someone
// clamping a site the plan explicitly says must stay raw.
// =========================================================================

// 5a. Tombstone overlay: a future-skewed tombstone `ts` must still delete.
(function(){
  var task = {id:'t1', type:'todo', title:'X', updatedAt: NORMAL};
  var tomb = new Map([['t1', SKEWED]]); // future-skewed delete timestamp, deliberately unclamped
  var out = Q.mergeCollection([], [task], [], NORMAL, NORMAL, tomb);
  assert('[GUARD tombstone] a future-skewed tombstone timestamp still deletes the task (GREEN on HEAD by design)',
    !findById(out, 't1'));
})();

// 5b. One-sided char guard: local unchanged vs base, only remote changed --
// a future-skewed r.updatedAt must still WIN so remote's real stats survive.
(function(){
  var REALCHAR = {name:'Pali', face:'W', cls:'Warrior', hp:120, maxHp:120, mp:0,
    lvl:14, xp:8300, gold:540, updatedAt: NORMAL_OLDER};
  var baseChar = REALCHAR;
  var localChar = Object.assign({}, REALCHAR); // deep-equal to base -> local unchanged
  var remoteChar = Object.assign({}, REALCHAR, {lvl:20, xp:9500, gold:700, updatedAt: SKEWED});
  var out = Q.merge(mk({char: baseChar}), mk({char: localChar}), mk({char: remoteChar}), NORMAL, NORMAL);
  assert('[GUARD one-sided char] future-skewed remote-only edit still wins, keeping real XP/gold/level (GREEN on HEAD by design)',
    out.char && out.char.lvl === 20 && out.char.gold === 700);
})();

// ---- summary ----
console.log('\n--- skew-clamp-arbitration.test.js summary ---');
if (failures) {
  console.error(failures + ' assertion(s) FAILED');
  process.exit(1);
}
console.log('skew-clamp-arbitration.test.js: all assertions passed');
process.exit(0);
