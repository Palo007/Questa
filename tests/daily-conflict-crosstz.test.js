// daily-conflict-crosstz.test.js -- regression cover for the 2026-09-18 review.
//
// resolveDailyConflict arbitrates a daily that BOTH devices changed: one marked it
// done, the other's cron judged it missed. Cron deliberately does not bump
// updatedAt, so the decision rides on two day-valued fields:
//
//   t.doneAt   -- ms timestamp of the completion
//   t.missedOn -- dayStamp() int, FROZEN by runCron in the recording device's TZ
//
// The bug: dailyEventDay() compared `dayStampOf(doneAt)` -- which re-derives the
// day in the MERGING device's timezone -- against `missedOn`, which is already
// frozen in the RECORDING device's. Two frames, one comparison. Two devices in
// different zones therefore read the SAME pair of records and returned OPPOSITE
// winners:
//
//   A = Berlin (UTC+2), B = New York (UTC-4).
//   User completes "Run" on A at Berlin 03:00 on day D  -> doneAt = T.
//   B is offline; its cron rolls into D+1 and records missedOn = D, streak = 0.
//   On A: dayStampOf_A(T) = D, so led == red -> rule 2 -> the completion wins.
//   On B: dayStampOf_B(T) = D-1 (T is 21:00 of D-1 in New York), so the miss's
//         day D is strictly greater -> rule 1 returns the MISS.
//   A keeps the completion; B keeps the miss, with the streak zeroed and the HP
//   damage charged. Each then uploads its own winner. Permanent ping-pong.
//
// The fix: completeTask/creditYesterday now FREEZE the completion day as
// t.doneDay, in the recording device's timezone, exactly as runCron freezes
// t.missedOn. Both operands of the comparison are now minted in the same frame,
// so the function is a pure function of (l, r) as its own comment claims.
//
// How the two timezones are modelled here: a single Node process has one
// timezone, so "device B sees this ms as the previous day" is modelled by giving
// the record a doneAt whose LOCAL day (in whatever TZ this test runs in) is D-1
// while doneDay still says D. That is precisely the pair of values B holds.
// Every day stamp below is derived from the real local clock, so the test is
// correct in any timezone.
//
// Run: node tests/daily-conflict-crosstz.test.js  (also run by node tests/run.js)

const fs = require('fs'), path = require('path'), vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* stripped */');
src = src.replace(/\bsyncInit\(\)\s*;?\s*$/, '');

const noop = function(){};
function makeQ(){
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
    save: noop, uid: function(){ return 'devLocal'; },
    idbOpen: function(){ return Promise.resolve(null); },
    now: function(){ return Date.now(); }, S: {}
  };
  sandbox.self = sandbox.window;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  try { vm.runInContext(src, sandbox); } catch(e){}
  return sandbox.window.QuestaSync;
}

const Q = makeQ();
if (!Q || typeof Q.resolveDailyConflict !== 'function' || typeof Q.normalizeDailyResets !== 'function') {
  console.error('FAIL: QuestaSync registry missing resolveDailyConflict/normalizeDailyResets');
  process.exit(1);
}

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

// ---- day helpers, all derived from the real local clock ---------------------
const ds = ms => { const d = new Date(ms); return d.getFullYear()*10000 + (d.getMonth()+1)*100 + d.getDate(); };
// Noon anchors: 26h back is always the previous local calendar day, in every
// timezone and across every DST transition.
const NOON_TODAY = (function(){ const d = new Date(); d.setHours(12,0,0,0); return d.getTime(); })();
const NOON_YDAY  = NOON_TODAY - 26*3600000;
const D    = ds(NOON_TODAY);
const Dm1  = ds(NOON_YDAY);

// Sanity: the anchors really are adjacent distinct local days.
assert('setup: the two anchors are different local days', D !== Dm1);

const T_BASE = Date.now() - 3600000;

// The completion, as the RECORDING device wrote it: doneDay frozen to D.
// `doneAt` carries a local day of D-1 in THIS process's timezone, which is exactly
// what the far-away peer computes from the same millisecond value.
function completionAsSeenByPeer(){
  return { id:'t1', type:'daily', title:'Run', done:true,
           doneAt: NOON_YDAY, doneDay: D, streak: 12, updatedAt: T_BASE };
}
// The same completion as the recording device itself sees it: doneAt's local day
// already equals D, so the old code agreed here too.
function completionAsSeenLocally(){
  return { id:'t1', type:'daily', title:'Run', done:true,
           doneAt: NOON_TODAY, doneDay: D, streak: 12, updatedAt: T_BASE };
}
// The miss, as runCron froze it on the other device.
function missRecord(){
  return { id:'t1', type:'daily', title:'Run', done:false,
           missedOn: D, streak: 0, updatedAt: T_BASE };
}

// ===========================================================================
// X1 -- both devices must pick the SAME winner, and it must be the completion
// ===========================================================================
console.log('--- X1: cross-timezone convergence ---');
{
  // Device A: the recording device's own view.
  const aWin = Q.resolveDailyConflict(completionAsSeenLocally(), missRecord(), 'devA', 'devB');
  assert('X1a the recording device keeps the completion', aWin.done === true);
  assert('X1b ...with the streak intact', aWin.streak === 12);

  // Device B: the peer, which derives a DIFFERENT day from the same doneAt.
  // Here the completion is the REMOTE side and the miss is local, mirroring B.
  const bWin = Q.resolveDailyConflict(missRecord(), completionAsSeenByPeer(), 'devB', 'devA');
  assert('X1c the peer device also keeps the completion', bWin.done === true);
  assert('X1d ...with the streak intact, not zeroed', bWin.streak === 12);

  assert('X1e both devices agree (converged)', aWin.done === bWin.done);
}

// ===========================================================================
// X2 -- argument order must not change the answer on either device
// ===========================================================================
console.log('--- X2: the decision is order-independent ---');
{
  const w1 = Q.resolveDailyConflict(completionAsSeenByPeer(), missRecord(), 'devB', 'devA');
  const w2 = Q.resolveDailyConflict(missRecord(), completionAsSeenByPeer(), 'devB', 'devA');
  assert('X2a completion wins as the local side', w1.done === true);
  assert('X2b completion wins as the remote side', w2.done === true);
}

// ===========================================================================
// X3 -- a genuinely older completion must still lose to a newer miss
// ===========================================================================
console.log('--- X3: a real day difference still decides ---');
{
  // Completed on D-1, missed on D. The miss is genuinely the newer event.
  const oldDone = { id:'t1', type:'daily', title:'Run', done:true,
                    doneAt: NOON_YDAY, doneDay: Dm1, streak: 3, updatedAt: T_BASE };
  const newMiss = { id:'t1', type:'daily', title:'Run', done:false,
                    missedOn: D, streak: 0, updatedAt: T_BASE };
  const w = Q.resolveDailyConflict(oldDone, newMiss, 'devA', 'devB');
  assert('X3a a miss recorded for a LATER day still beats an older completion', w.done === false);

  // And the mirror: a completion on D beats a miss recorded for D-1.
  const newDone = { id:'t1', type:'daily', title:'Run', done:true,
                    doneAt: NOON_TODAY, doneDay: D, streak: 5, updatedAt: T_BASE };
  const oldMiss = { id:'t1', type:'daily', title:'Run', done:false,
                    missedOn: Dm1, streak: 0, updatedAt: T_BASE };
  const w2 = Q.resolveDailyConflict(newDone, oldMiss, 'devA', 'devB');
  assert('X3b a completion on a LATER day still beats an older miss', w2.done === true);
}

// ===========================================================================
// X4 -- records from older builds (no doneDay) keep the old derivation
// ===========================================================================
console.log('--- X4: legacy records still work ---');
{
  const legacyDone = { id:'t1', type:'daily', title:'Run', done:true,
                       doneAt: NOON_TODAY, streak: 7, updatedAt: T_BASE };  // no doneDay
  const miss = missRecord();
  const w = Q.resolveDailyConflict(legacyDone, miss, 'devA', 'devB');
  assert('X4a a legacy completion on the same local day still beats the miss', w.done === true);
  assert('X4b ...and keeps its streak', w.streak === 7);
}

// ===========================================================================
// X5 -- normalizeDailyResets uses the frozen day too
// ===========================================================================
console.log('--- X5: the reset overlay reads the frozen day ---');
{
  // A completion frozen to TODAY must survive a mergedLastCron of TODAY, even
  // though its doneAt's local day (in this process) reads as YESTERDAY -- which
  // is exactly the peer's view of a completion made just over the date line.
  const t = { id:'t1', type:'daily', done:true, doneAt: NOON_YDAY, doneDay: D,
              checklist:[{id:'c1', text:'a', done:true}] };
  const out = Q.normalizeDailyResets([t], D);
  assert('X5a a completion frozen to the current cron day is NOT reset', out[0].done === true);
  assert('X5b ...and its checklist ticks survive', out[0].checklist[0].done === true);

  // A genuinely stale completion must still be reset.
  const stale = { id:'t2', type:'daily', done:true, doneAt: NOON_YDAY, doneDay: Dm1,
                  checklist:[{id:'c1', text:'a', done:true}] };
  const out2 = Q.normalizeDailyResets([stale], D);
  assert('X5c a completion from a previous day IS still reset', out2[0].done === false);
  assert('X5d ...and its checklist is cleared', out2[0].checklist[0].done === false);

  // Legacy record with no doneDay: falls back to dayStampOf(doneAt).
  const legacy = { id:'t3', type:'daily', done:true, doneAt: NOON_TODAY };
  assert('X5e a legacy completion on the cron day is not reset',
    Q.normalizeDailyResets([legacy], D)[0].done === true);
}

// ===========================================================================
if (failures) { console.error('\n' + failures + ' daily-conflict-crosstz assertion(s) FAILED'); process.exit(1); }
console.log('\nAll daily-conflict-crosstz tests passed!');
