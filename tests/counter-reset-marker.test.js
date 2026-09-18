// counter-reset-marker.test.js -- regression cover for the 2026-09-18 review.
//
// cUp/cDown are a habit's "Today +/-" tallies. They ACCUMULATE taps and are zeroed
// by runCron at each resetFreq boundary. mergeCollection picks a whole winner
// object, so _accumCounters overlays the counters separately or one device's taps
// would simply be discarded.
//
// _accumCounter used to infer "cron reset this side" from `value < base`:
//
//     const eff = (l < b && r < b) ? 0 : b;
//     return Math.max(eff + max(0,l-eff) + max(0,r-eff), l, r);
//
// Two defects in one line:
//
//  1. The test is JOINT. It only collapses the base when BOTH sides are below it.
//     In the ordinary STAGGERED case -- one device has crossed its local boundary
//     and reset, the other has not yet been opened -- the reset side contributes
//     max(0, l-b) = 0 and its entire post-reset count is thrown away. The trailing
//     Math.max(..., l, r) floor cannot rescue it either, because the other side is
//     >= b > l. This window exists every single period for every multi-device user.
//
//  2. "Below base" is not the same as "cron reset it". Lowering a tally on the edit
//     sheet also goes below base. With both sides lowered, eff collapsed to 0 and
//     the two REMAINDERS were summed: base 10, local 8, remote 7 came back as 15 --
//     the counter ROSE after the user removed five taps. And a single-sided
//     decrement could never propagate at all, because of the Math.max floor.
//
// The fix: app.js runCron stamps t.cResetOn (a local day stamp) when it zeroes the
// tallies, so the reset is observable PER SIDE, and the deltas are signed.
//
// Records whose base carries no cResetOn keep the old heuristic exactly -- see the
// L-series at the end.
//
// Run: node tests/counter-reset-marker.test.js  (also run by node tests/run.js)

const fs = require('fs'), path = require('path'), vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* stripped */');
src = src.replace(/\bsyncInit\(\)\s*;?\s*$/, '');

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
  save: noop, uid: function(){ return 'devA'; },
  idbOpen: function(){ return Promise.resolve(null); },
  now: function(){ return Date.now(); }, S: {}
};
sandbox.self = sandbox.window; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try { vm.runInContext(src, sandbox); } catch(e){}
const Q = sandbox.window.QuestaSync;
if (!Q || !Q.k3Helpers || typeof Q.k3Helpers.accumCounter !== 'function' || typeof Q.mergeCollection !== 'function') {
  console.error('FAIL: QuestaSync registry missing k3Helpers.accumCounter / mergeCollection');
  process.exit(1);
}
const accum = Q.k3Helpers.accumCounter;

let failures = 0;
function assertEq(desc, got, want) {
  if (got === want) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc + ' -- got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; }
}

// ===========================================================================
// C-series: _accumCounter directly, with explicit reset flags.
// ===========================================================================
console.log('--- C: the four reset shapes ---');

assertEq('C1 neither side reset, both added: base carries + both deltas',
  accum(10, 13, 12, false, false), 15);
assertEq('C2 BOTH sides reset: the base is gone, sum the new taps',
  accum(10, 3, 2, true, true), 5);
assertEq('C3 ONLY LOCAL reset: local\'s 3 new taps are KEPT (was 12, losing all 3)',
  accum(10, 3, 12, true, false), 5);
assertEq('C4 ONLY REMOTE reset: mirror of C3',
  accum(10, 12, 3, false, true), 5);

console.log('--- C: decrements ---');
assertEq('C5 both sides lowered: the counter goes DOWN (was 15, an increase)',
  accum(10, 8, 7, false, false), 5);
assertEq('C6 one side lowered: the decrement propagates (was 10, i.e. ignored)',
  accum(10, 8, 10, false, false), 8);
assertEq('C7 a decrement can never drive the counter negative',
  accum(10, 0, 0, false, false), 0);

console.log('--- C: no-op and first-period shapes ---');
assertEq('C8 nothing changed anywhere', accum(10, 10, 10, false, false), 10);
assertEq('C9 first period, both add from zero', accum(0, 5, 3, false, false), 8);
assertEq('C10 only local added', accum(4, 9, 4, false, false), 9);
assertEq('C11 a side that reset and then added nothing contributes nothing',
  accum(10, 0, 12, true, false), 2);

// ===========================================================================
// L-series: the legacy path (null flags) must behave EXACTLY as before, so data
// written by older builds is not silently re-interpreted.
// ===========================================================================
console.log('--- L: legacy records keep the old heuristic ---');
assertEq('L1 legacy neither below base', accum(10, 13, 12, null, null), 15);
assertEq('L2 legacy both below base (read as a double reset)', accum(10, 3, 2, null, null), 5);
assertEq('L3 legacy staggered still loses the reset side (documented old behaviour)',
  accum(10, 3, 12, null, null), 12);
assertEq('L4 legacy single decrement still cannot propagate (documented old behaviour)',
  accum(10, 8, 10, null, null), 10);

// ===========================================================================
// M-series: end to end through mergeCollection, which is what actually runs.
// ===========================================================================
console.log('--- M: through mergeCollection ---');

const T0 = Date.now() - 60000;
function habit(over){
  return Object.assign({ id:'h1', type:'habit', title:'Pushups', up:true, down:true,
                         cUp:0, cDown:0, updatedAt:T0 }, over||{});
}
// mergeCollection(baseArr, localArr, remoteArr, remoteSavedAt, localSavedAt, tombstones, remoteDeviceId)
function mergeOne(b, l, r){
  const out = Q.mergeCollection([b], [l], [r], null, null, {}, 'devB');
  return out.find(x => x && x.id === 'h1');
}

{
  // The staggered case, end to end. Base was written on day 20260917.
  // Device A crossed its boundary on 20260918 and tapped 3 times.
  // Device B has not been opened since, and tapped 2 more on top of the old total.
  const base = habit({ cUp:10, cResetOn:20260917 });
  const local = habit({ cUp:3,  cResetOn:20260918, updatedAt:T0+1000 });
  const remote= habit({ cUp:12, cResetOn:20260917, updatedAt:T0+2000 });
  const m = mergeOne(base, local, remote);
  assertEq('M1 the reset device\'s 3 taps survive the merge', m.cUp, 5);
  assertEq('M2 the merged record carries the newest reset stamp forward', m.cResetOn, 20260918);
}

{
  // Both devices crossed their own boundary.
  const base = habit({ cUp:10, cDown:4, cResetOn:20260917 });
  const local = habit({ cUp:3, cDown:1, cResetOn:20260918, updatedAt:T0+1000 });
  const remote= habit({ cUp:2, cDown:2, cResetOn:20260918, updatedAt:T0+2000 });
  const m = mergeOne(base, local, remote);
  assertEq('M3 both-reset sums cUp', m.cUp, 5);
  assertEq('M4 both-reset sums cDown', m.cDown, 3);
}

{
  // Neither crossed; both tapped. The classic additive case must be unchanged.
  const base = habit({ cUp:10, cResetOn:20260918 });
  const local = habit({ cUp:15, cResetOn:20260918, updatedAt:T0+1000 });
  const remote= habit({ cUp:13, cResetOn:20260918, updatedAt:T0+2000 });
  assertEq('M5 ordinary additive merge is unchanged', mergeOne(base, local, remote).cUp, 18);
}

{
  // A record from before the upgrade: no cResetOn anywhere. Must take the legacy
  // path, NOT be read as "both sides just reset" and summed in full.
  const base = habit({ cUp:10 });
  const local = habit({ cUp:13, updatedAt:T0+1000 });
  const remote= habit({ cUp:12, updatedAt:T0+2000 });
  const m = mergeOne(base, local, remote);
  assertEq('M6 a legacy record is not inflated by the new path', m.cUp, 15);
  assertEq('M7 ...and no reset stamp is invented', m.cResetOn, undefined);
}

{
  // First merge after ONE device upgrades and crons: base still has no marker.
  // The legacy heuristic must apply, so nothing is double-counted.
  const base = habit({ cUp:10 });
  const local = habit({ cUp:3, cResetOn:20260918, updatedAt:T0+1000 });
  const remote= habit({ cUp:12, updatedAt:T0+2000 });
  const m = mergeOne(base, local, remote);
  assertEq('M8 an unanchored base falls back to the legacy result', m.cUp, 12);
  assertEq('M9 ...but the marker is carried forward so the NEXT merge is anchored',
    m.cResetOn, 20260918);
}

// ===========================================================================
// R-series: the 409 conflict retry.
//
// _syncNowAttempt applies the merge to S BEFORE the upload succeeds, so on a 409
// the retry in _pushWithConflictRetry re-reads syncSubset() -- a local that has
// ALREADY absorbed the peer's taps -- while re-using the same pristine base. The
// peer's contribution was therefore added again on every attempt: 5+3 came back
// as 8, then 11, then 14 across SYNC_CONFLICT_RETRY_LIMIT. The same shape occurs
// with no 409 at all, because an upload that simply fails leaves local advanced
// and the base stale for the next ordinary round.
//
// This models the retry exactly: merge once, then feed the RESULT back as `local`
// against the same base and the same remote, and assert the number stops moving.
// ===========================================================================
console.log('--- R: a conflict retry must not re-add the peer\'s taps ---');

{
  const base = habit({ cUp:0, cResetOn:20260918 });
  const local = habit({ cUp:5, cResetOn:20260918, updatedAt:T0+1000 });
  const remote= habit({ cUp:3, cResetOn:20260918, updatedAt:T0+2000 });

  const round1 = mergeOne(base, local, remote);
  assertEq('R1 first round merges 5 + 3', round1.cUp, 8);

  // Retry 1: local is now the applied merge; base and remote are unchanged.
  const retry1 = mergeOne(base, round1, remote);
  assertEq('R2 retry does NOT re-add remote\'s 3 (was 11)', retry1.cUp, 8);

  // Retry 2 and 3: still stable, up to the retry limit.
  const retry2 = mergeOne(base, retry1, remote);
  assertEq('R3 second retry is still 8 (was 14)', retry2.cUp, 8);
  const retry3 = mergeOne(base, retry2, remote);
  assertEq('R4 third retry is still 8 (was 17)', retry3.cUp, 8);
}

{
  // The peer really does add more between attempts: that IS a new contribution
  // and must still land, or the guard would have swung from over- to under-counting.
  const base = habit({ cUp:0, cResetOn:20260918 });
  const local = habit({ cUp:5, cResetOn:20260918, updatedAt:T0+1000 });
  const remote= habit({ cUp:3, cResetOn:20260918, updatedAt:T0+2000 });

  const round1 = mergeOne(base, local, remote);
  assertEq('R5 first round merges 5 + 3', round1.cUp, 8);

  const remote2 = habit({ cUp:6, cResetOn:20260918, updatedAt:T0+5000 }); // peer tapped 3 more
  const retry = mergeOne(base, round1, remote2);
  assertEq('R6 the peer\'s 3 NEW taps do land on the retry', retry.cUp, 11);
}

{
  // The local user taps during the retry window: that must land too.
  const base = habit({ cUp:0, cResetOn:20260918 });
  const local = habit({ cUp:5, cResetOn:20260918, updatedAt:T0+1000 });
  const remote= habit({ cUp:3, cResetOn:20260918, updatedAt:T0+2000 });

  const round1 = mergeOne(base, local, remote);
  const localAfterTap = Object.assign({}, round1, { cUp: round1.cUp + 2, updatedAt: T0+6000 });
  const retry = mergeOne(base, localAfterTap, remote);
  assertEq('R7 a local tap made during the retry window still lands', retry.cUp, 10);
}

{
  // cDown travels the same path.
  const base = habit({ cDown:0, cResetOn:20260918 });
  const local = habit({ cDown:4, cResetOn:20260918, updatedAt:T0+1000 });
  const remote= habit({ cDown:2, cResetOn:20260918, updatedAt:T0+2000 });
  const round1 = mergeOne(base, local, remote);
  assertEq('R8 cDown merges 4 + 2', round1.cDown, 6);
  assertEq('R9 cDown does not re-add on retry', mergeOne(base, round1, remote).cDown, 6);
}

{
  // The absorbed record must actually be written, or the guard silently degrades
  // to the old behaviour without any test noticing.
  const base = habit({ cUp:0, cResetOn:20260918 });
  const local = habit({ cUp:5, cResetOn:20260918, updatedAt:T0+1000 });
  const remote= habit({ cUp:3, cResetOn:20260918, updatedAt:T0+2000 });
  const m = mergeOne(base, local, remote);
  assertEq('R10 the merged record carries a cAbs map', typeof m.cAbs, 'object');
  assertEq('R11 ...with the peer\'s absorbed count', m.cAbs['devB'].cUp, 3);
  assertEq('R12 ...stamped at the peer\'s RAW updatedAt', m.cAbs['devB'].ua, T0+2000);
}

// ===========================================================================
if (failures) { console.error('\n' + failures + ' counter-reset-marker assertion(s) FAILED'); process.exit(1); }
console.log('\nAll counter-reset-marker tests passed!');
