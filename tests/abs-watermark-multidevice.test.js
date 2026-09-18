// abs-watermark-multidevice.test.js -- F1 (2026-09-19).
//
// The absorbed watermark (char.abs / task.cAbs) counted the wrong thing.
//
// Both maps are keyed by the device whose DOCUMENT was folded in, and each entry
// stores that document's WHOLE aggregate -- which already carries every peer that
// document had merged. The readers (_accBaseline / _cntBaseline, now _accCommon /
// _cntCommon) treated one entry as "what device k contributed" and used it as that
// ONE side's baseline. With two devices those two quantities coincide, which is why
// every pre-F1 test passed. With three they diverge, and the excess is re-added on
// every conflict retry and every plain failed upload.
//
// Measured on the real merge, pre-F1:
//   counters: base cUp 0, B+3, C+4, A+5 with A's upload failing, then B+2
//             -> A retried to 18, and stayed at 18. Truth: 14.
//   char:     base 160 total xp / 20 gold, A+50/+5, B+30/+3, C+40/+4, then B+20/+2
//             -> A retried to 340 xp / 38 gold. Truth: 300 / 34.
//   property: a randomised 3-device run with induced upload failures drifts up on
//             every seed; the same run with 2 devices is exact at every failure rate.
//
// W1-W4 are RED before the fix and GREEN after. W5-W8 are GUARDs -- green on both
// sides -- so nobody "fixes" the fix back into a bug.
//
// KNOWN RESIDUAL, asserted honestly in W9: a scalar-per-device watermark cannot
// express "L already contains R" when L reached that content by a different route
// through the remote chain (two documents with identical content but different
// lineage). The randomised run is therefore still not exactly conservative for 3+
// devices -- but it never LOSES a tap, and on W9's fixed seed set the summed
// over-count fell from 8057 (worst single run 1311) to 4 (worst single run 4).
// W9 pins both facts. Exactness needs a version vector, which collides with the
// signed-decrement rule (W6) and the cron-reset rule (W7); that is a separate
// change, not this one.
//
// Run: node tests/abs-watermark-multidevice.test.js   (tests/run.js picks it up too)

const fs = require('fs'), path = require('path'), vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* stripped */');
src = src.replace(/\bsyncInit\(\)\s*;?\s*$/, '');

const FIXED_NOW = Date.now();

// One sandbox per simulated device: syncDeviceId() falls through to uid(), so the
// device id the merge sees as LOCAL is whatever this sandbox's uid() returns.
function makeQ(deviceId){
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
    save: noop, uid: function(){ return deviceId; },
    idbOpen: function(){ return Promise.resolve(null); },
    now: function(){ return FIXED_NOW; }
  };
  sandbox.self = sandbox.window;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  try { vm.runInContext(src, sandbox); } catch(e){ console.error('sandbox error:', e && e.message); }
  return sandbox.window.QuestaSync;
}

const QA = makeQ('devA'), QB = makeQ('devB'), QC = makeQ('devC');
if(!QA || typeof QA.merge !== 'function' || typeof QA.mergeCollection !== 'function'
   || !QA.k3Helpers || typeof QA.k3Helpers.charTotalXp !== 'function'){
  console.error('FAIL: QuestaSync registry missing merge / mergeCollection / k3Helpers');
  process.exit(1);
}

let failures = 0;
function assert(desc, cond){
  if(cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}
function assertEq(desc, got, want){
  assert(desc + '  (got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) + ')',
         JSON.stringify(got) === JSON.stringify(want));
}

// local mirror of sync.js dayStampOf(), so the test does not depend on it being exported
function ds(ms){ const d = new Date(ms); return d.getFullYear()*10000 + (d.getMonth()+1)*100 + d.getDate(); }
const TODAY_STAMP = ds(FIXED_NOW);
function clone(o){ return o == null ? o : JSON.parse(JSON.stringify(o)); }

let clock = FIXED_NOW - 5000000;
function tick(){ return (clock += 1000); }

// A habit carrying a reset marker, so _accumCounters takes the marker branch rather
// than the legacy heuristic. cResetOn is TODAY on every side -> nobody reset.
function habit(cUp, ua){
  return { id:'h1', type:'habit', title:'Push-ups', cUp:cUp, cDown:0,
           cResetOn: TODAY_STAMP, updatedAt: ua, createdAt: FIXED_NOW - 9000000 };
}
// Run one device's merge of its own base+local against the remote document.
function mergeTask(Q, base, local, remote, remotePublisher){
  const out = Q.mergeCollection(base ? [base] : [], [local], [remote],
                                clock + 100000, clock + 100000, new Map(), remotePublisher);
  return out[0];
}
function republish(doc){ return clone(Object.assign({}, doc, { updatedAt: tick() })); }

// ---------------------------------------------------------------------------
// W1 -- three devices, one failed upload, then a retry. THE defect.
// ---------------------------------------------------------------------------
// base cUp 0 -> B taps 3 and pushes (no merge: remote had no record)
//            -> C taps 4, merges B's 3       => remote 7,  cAbs {devB:3, devC:4}
//            -> A taps 5, merges the 7       => local 12, BUT A'S UPLOAD FAILS
//            -> B taps 2 more, merges the 7  => remote 9,  published by devB
//            -> A retries against its STALE base 0
// A has already absorbed 7 (B's 3 + C's 4). The remote 9 is B's 5 + C's 4, of which
// only B's extra 2 is new to A. 12 + 2 = 14.
// Pre-F1 A measured the remote from cAbs[devB] = 3 -- B's own last contribution --
// so C's 4 was added a second time: 18.
console.log('--- W1: three devices, failed upload, retry ---');
const base0 = habit(0, tick());

const bPush1 = habit(3, tick());
let remote = clone(bPush1);                 // published by devB, no cAbs yet
const bBase = clone(bPush1);

const cMerged = mergeTask(QC, base0, habit(4, tick()), remote, 'devB');
assertEq('W1-a C folds B\'s 3 into its own 4', cMerged.cUp, 7);
assertEq('W1-b ...and records BOTH devices\' document values',
         [cMerged.cAbs.devB.cUp, cMerged.cAbs.devC.cUp], [3, 4]);
remote = republish(cMerged);                // published by devC, cUp 7

const aMerged = mergeTask(QA, base0, habit(5, tick()), remote, 'devC');
assertEq('W1-c A folds the 7 into its own 5', aMerged.cUp, 12);
const aLocal = republish(aMerged);
const aBase  = clone(base0);                // upload FAILED -> base never advanced

const bMerged = mergeTask(QB, bBase, republish(Object.assign({}, bBase, {cUp: 5})), remote, 'devC');
assertEq('W1-d B folds the 7 into its own 5 (its own 3 already inside it)', bMerged.cUp, 9);
remote = republish(bMerged);                // published by devB, cUp 9

const aRetry = mergeTask(QA, aBase, aLocal, remote, 'devB');
assertEq('W1-e RETRY: A adds only B\'s NEW 2, not C\'s 4 a second time', aRetry.cUp, 14);

// ---------------------------------------------------------------------------
// W2 -- retry idempotence for 1, 2, 3 and 4 rounds against the same stale base.
// ---------------------------------------------------------------------------
console.log('--- W2: retry idempotence, 1..4 rounds ---');
let spin = aLocal;
for(let round = 1; round <= 4; round++){
  spin = republish(mergeTask(QA, aBase, spin, remote, 'devB'));
  assertEq('W2-' + round + ' re-merging the applied result changes nothing (round ' + round + ')',
           spin.cUp, 14);
}

// ---------------------------------------------------------------------------
// W3 -- the same shape on char xp / gold.
// ---------------------------------------------------------------------------
console.log('--- W3: three devices on char xp and gold ---');
const K3 = QA.k3Helpers;
function charAt(totalXp, gold, ua){
  const f = K3.charFromTotalXp(totalXp);
  return { lvl: f.lvl, xp: f.xp, gold: gold, mp: 0, hp: 50, maxHp: 50, cls: 'w', updatedAt: ua };
}
function totalXp(c){ return K3.charTotalXp(c); }
function mkState(over){
  return Object.assign({ tasks: [], rewards: [], tags: [], devices: [],
    an: {views: [], metrics: []}, history: [], charHistory: [], monthlyBackups: [],
    lastCron: 0, char: {}, deletions: [], pause: {} }, over);
}
function mergeChar(Q, base, local, rem, localDev, remoteDev){
  return Q.merge(mkState({char: base}), mkState({char: local}), mkState({char: rem}),
                 clock + 100000, clock + 100000, localDev, remoteDev).char;
}

const cBase = charAt(160, 20, tick());
let rChar = charAt(190, 23, tick());                 // B +30 xp / +3 gold, plain push
const bCharBase = clone(rChar);

const cChar = mergeChar(QC, cBase, charAt(200, 24, tick()), rChar, 'devC', 'devB');
assertEq('W3-a C folds B in', [totalXp(cChar), cChar.gold], [230, 27]);
rChar = republish(cChar);                            // published by devC

const aChar = mergeChar(QA, cBase, charAt(210, 25, tick()), rChar, 'devA', 'devC');
assertEq('W3-b A folds the 230 in', [totalXp(aChar), aChar.gold], [280, 32]);
const aCharLocal = republish(aChar);                 // upload FAILS

const bChar2 = charAt(totalXp(bCharBase) + 20, bCharBase.gold + 2, tick());
const bCharM = mergeChar(QB, bCharBase, bChar2, rChar, 'devB', 'devC');
assertEq('W3-c B folds the 230 in', [totalXp(bCharM), bCharM.gold], [250, 29]);
rChar = republish(bCharM);                           // published by devB

const aCharRetry = mergeChar(QA, cBase, aCharLocal, rChar, 'devA', 'devB');
assertEq('W3-d RETRY: C\'s 40 xp / 4 gold are not added twice',
         [totalXp(aCharRetry), aCharRetry.gold], [300, 34]);

console.log('--- W4: char retry idempotence, 1..4 rounds ---');
let cSpin = aCharLocal;
for(let round = 1; round <= 4; round++){
  cSpin = republish(mergeChar(QA, cBase, cSpin, rChar, 'devA', 'devB'));
  assertEq('W4-' + round + ' char re-merge changes nothing (round ' + round + ')',
           [totalXp(cSpin), cSpin.gold], [300, 34]);
}

// ---------------------------------------------------------------------------
// W5 -- GUARD: convergence. merge(b,L,R) and merge(b,R,L) must agree, including
// the absorbed map, or the two devices ping-pong forever.
// ---------------------------------------------------------------------------
console.log('--- W5: GUARD convergence, both orderings ---');
{
  const bse = habit(0, tick());
  const lDoc = clone(aLocal);                       // devA's doc: cUp 12, carries cAbs
  const rDoc = clone(remote);                       // devB's doc: cUp 9,  carries cAbs
  const onA = mergeTask(QA, bse, lDoc, rDoc, 'devB');   // local=devA, remote=devB
  const onB = mergeTask(QB, bse, rDoc, lDoc, 'devA');   // local=devB, remote=devA
  assertEq('W5-a both orderings agree on the counter', onA.cUp, onB.cUp);
  assertEq('W5-b both orderings build an identical absorbed map',
           JSON.stringify(onA.cAbs), JSON.stringify(onB.cAbs));

  const cb = charAt(160, 20, tick());
  const lc = clone(aCharLocal), rc = clone(rChar);
  const cOnA = mergeChar(QA, cb, lc, rc, 'devA', 'devB');
  const cOnB = mergeChar(QB, cb, rc, lc, 'devB', 'devA');
  assertEq('W5-c both orderings agree on char totals',
           [totalXp(cOnA), cOnA.gold, cOnA.mp], [totalXp(cOnB), cOnB.gold, cOnB.mp]);
  assertEq('W5-d both orderings build an identical char absorbed map',
           JSON.stringify(cOnA.abs), JSON.stringify(cOnB.abs));
}

// ---------------------------------------------------------------------------
// W6 -- GUARD: a user decrement still propagates (the deltas stay SIGNED).
// ---------------------------------------------------------------------------
console.log('--- W6: GUARD signed deltas ---');
{
  const accum = QA.k3Helpers.accumCounter;
  assertEq('W6-a base 10, local 8, remote 10 -> 8 (one side lowered)',
           accum(10, 8, 10, false, false), 8);
  assertEq('W6-b base 10, local 8, remote 7 -> 5, never inflated',
           accum(10, 8, 7, false, false), 5);
  assertEq('W6-c base 10, both raised -> 15', accum(10, 13, 12, false, false), 15);
  assertEq('W6-d legacy branch unchanged (no reset markers)',
           accum(10, 13, 12, null, null), 15);
}

// ---------------------------------------------------------------------------
// W7 -- GUARD: a cron reset still zeroes; the side that reset contributes its
// whole post-reset count and the old period's total is dropped.
// ---------------------------------------------------------------------------
console.log('--- W7: GUARD cron reset ---');
{
  const accum = QA.k3Helpers.accumCounter;
  assertEq('W7-a both sides reset -> only the new taps', accum(10, 3, 2, true, true), 5);
  assertEq('W7-b local reset only',  accum(10, 3, 12, true, false), 5);
  assertEq('W7-c remote reset only', accum(10, 12, 3, false, true), 5);

  // ...and through the real merge, with the reset marker moving on one side.
  const bse = habit(10, tick());
  const lDoc = Object.assign(habit(4, tick()), { cResetOn: TODAY_STAMP });
  const rDoc = Object.assign(habit(13, tick()), { cResetOn: TODAY_STAMP - 1 });
  const bs2  = Object.assign(clone(bse), { cResetOn: TODAY_STAMP - 1 });
  const out  = mergeTask(QA, bs2, lDoc, rDoc, 'devB');
  assertEq('W7-d the side that reset contributes its whole post-reset count', out.cUp, 7);
}

// ---------------------------------------------------------------------------
// W8 -- GUARD: two devices are untouched. Same retry shape as W1 but with only
// A and B, where the old rule was already correct.
// ---------------------------------------------------------------------------
console.log('--- W8: GUARD two-device retry unchanged ---');
{
  const bse = habit(0, tick());
  let rem = habit(3, tick());                                  // devB pushes 3
  const m1 = mergeTask(QA, bse, habit(5, tick()), rem, 'devB');
  assertEq('W8-a A folds B\'s 3 into its own 5', m1.cUp, 8);
  const aL = republish(m1);                                    // A's upload FAILS
  rem = republish(Object.assign({}, rem, { cUp: 5 }));         // devB taps 2 more, pushes 5
  const m2 = mergeTask(QA, bse, aL, rem, 'devB');
  assertEq('W8-b RETRY adds only B\'s new 2', m2.cUp, 10);
  const m3 = mergeTask(QA, bse, republish(m2), rem, 'devB');
  assertEq('W8-c and is idempotent', m3.cUp, 10);
}

// ---------------------------------------------------------------------------
// W9 -- randomised multi-device conservation with induced upload failures.
//
// Ground truth is the total number of taps. Every device keeps its own `base`
// (last SUCCESSFUL upload) and `local`; a failed upload advances local and leaves
// base stale, which is the exact shape _pushWithConflictRetry hands the next round.
//
// Asserted:
//   - two devices: EXACT at every failure rate, at every seed;
//   - three, four and five devices: never an UNDER-count (a tap is never lost), and
//     the summed over-count across the whole fixed seed set is at or below the pin.
// The pin is a regression lock on the known residual described at the top of this
// file, not a claim of exactness. Pre-F1 the same seed set over-counts by ~100x it.
// ---------------------------------------------------------------------------
console.log('--- W9: randomised conservation, fixed seeds ---');
function rng(seed){ let s = seed >>> 0; return function(){ s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function simulate(nDev, failRate, rounds, seed){
  const rnd = rng(seed);
  // Private clock per run, anchored in the PAST and bounded so it can never reach
  // now: a stamp in this device's future is clamped by _clampFuture and the run
  // would stop measuring what it says it measures. ~2000 ticks max, 1s apart.
  let t = FIXED_NOW - 4000000;
  const step = function(){ return (t += 1000); };
  const stamp = function(doc){ return clone(Object.assign({}, doc, { updatedAt: step() })); };
  const ids = []; for(let i = 0; i < nDev; i++) ids.push('dev' + String.fromCharCode(65 + i));
  const Qs = {}; ids.forEach(function(id){ Qs[id] = makeQ(id); });
  const start = { id:'h1', type:'habit', title:'Push-ups', cUp:0, cDown:0,
                  cResetOn: TODAY_STAMP, updatedAt: step(), createdAt: FIXED_NOW - 9000000 };
  const dev = {}; ids.forEach(function(id){ dev[id] = { base: clone(start), local: clone(start) }; });
  let rem = clone(start), publisher = null, taps = 0;

  function syncOne(id, mayFail){
    const d = dev[id];
    // the remote file records its publisher; when that is US the merge sees
    // localDeviceId === remoteDeviceId and degrades to the shared base
    const rd = (publisher && publisher !== id) ? publisher : null;
    const out = Qs[id].mergeCollection([d.base], [d.local], [rem], t + 100000, t + 100000, new Map(), rd);
    const merged = stamp(out[0]);
    d.local = merged;
    if(mayFail && rnd() < failRate) return;      // upload failed: base stays stale
    rem = clone(merged); publisher = id; d.base = clone(merged);
  }
  for(let i = 0; i < rounds; i++){
    const id = ids[Math.floor(rnd() * nDev)];
    const k = 1 + Math.floor(rnd() * 4);
    taps += k;
    dev[id].local = stamp(Object.assign({}, dev[id].local, { cUp: dev[id].local.cUp + k }));
    syncOne(id, true);
  }
  for(let pass = 0; pass < 5; pass++) ids.forEach(function(id){ syncOne(id, false); });
  if(t >= FIXED_NOW){ console.error('[FAIL] W9 fixture clock ran into the future'); failures++; }
  return rem.cUp - taps;
}

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const RATES = [0.25, 0.5];
const ROUNDS = 60;

let twoDevWrong = 0, multiUnder = 0, multiOver = 0, multiWorst = 0;
RATES.forEach(function(f){
  SEEDS.forEach(function(s){
    const d2 = simulate(2, f, ROUNDS, s * 7919);
    if(d2 !== 0) twoDevWrong++;
    [3, 4, 5].forEach(function(n){
      const d = simulate(n, f, ROUNDS, s * 7919 + n);
      if(d < 0) multiUnder++;
      if(d > 0){ multiOver += d; if(d > multiWorst) multiWorst = d; }
    });
  });
});

assertEq('W9-a two devices are EXACT at every failure rate and seed', twoDevWrong, 0);
assertEq('W9-b three, four and five devices never LOSE a tap', multiUnder, 0);
// Pin measured 2026-09-19 on the fixed seed set above. Pre-F1 the same set scores
// in the thousands; post-F1 it is the residual documented at the top of this file.
const OVER_PIN = 10;
assert('W9-c summed over-count across the fixed seed set stays at or below the pin'
       + '  (got ' + multiOver + ', pin ' + OVER_PIN + ', worst single run ' + multiWorst + ')',
       multiOver <= OVER_PIN);

console.log('');
if(failures){ console.error(failures + ' assertion(s) FAILED'); process.exit(1); }
console.log('All abs-watermark-multidevice tests passed!');
