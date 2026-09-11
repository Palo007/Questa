// hlc-future-lock.test.js -- 2026-09-11 (K2).
//
// The defect: app.js's hybrid logical clock (`lastIssued`, app.js:126-129) is
// monotonic-FORWARD ONLY and is persisted to S.__hlcLast. One forward clock
// excursion therefore cripples that device permanently:
//
//   Failure 1 -- arbitration lockout. Device A's clock briefly reads 2027.
//     now() sets lastIssued to 2027 and persists it. The user fixes the clock;
//     lastIssued stays at 2027 forever, so every stamp A mints is ~2027, and on
//     every normal peer _ua/_ca/_clampFuture zero it (>120s future). A loses every
//     arbitration, silently, with no UI signal, across reboots.
//
//   Failure 2 -- the clamp ceiling grows with state size. _hlcNow was bound to
//     now(), which is NOT a pure read: it advances lastIssued ~1ms per call and
//     persists it. _ua/_ca/_clampFuture call it once per comparison, so the
//     future-skew ceiling drifts further ahead the more records are merged --
//     the guard gets MORE permissive the bigger the user's state.
//
// The K2 fix has two halves that MUST ship together:
//   (a) the trust CEILING in _ua/_ca/_clampFuture becomes the PHYSICAL clock,
//       captured once per round (same shape as _skewDiagThreshold, J1 finding 4);
//   (b) now() HEALS: when lastIssued > Date.now() + HLC_RATCHET_TOLERANCE_MS it is
//       provably honoured by NO device in the fleet (ratchetHlc and
//       MAX_FUTURE_SKEW_MS both refuse above that boundary), so it is reset to the
//       physical clock.
// (b) is only safe BECAUSE of (a): every value in the dropped range reads as 0 on
// every device INCLUDING this one, so no already-issued stamp can out-compete a
// fresh post-reset stamp. (a) alone leaves the device pinned in the future forever;
// (b) alone lets the device lose to its own older records.
//
// Plus one site reclassified: mergeCollection GUARD 3 (sync.js ~845) compares ONE
// clamped operand against an unclamped scalar, so a 0 there makes the guard FAIL
// OPEN and propagates a stale local revert. It is a seventh inverted-polarity site
// and must read raw. See K2-D.
//
// Design note: .omo/plans/K2-hlc-future-lock.md
//
// RED/GREEN: every assertion below is RED on the pre-K2 code EXCEPT the ones marked
// GUARD, which are green on both sides and exist so nobody "fixes" the fix back into
// a bug. Prove RED by pointing this file at the pre-K2 backups:
//
//   K2_APP_SRC=archive/old-versions/app.js.bak-20260911-K2pre \
//   K2_SYNC_SRC=archive/old-versions/sync.js.bak-20260911-K2pre \
//   node tests/hlc-future-lock.test.js
//
// Run: node tests/hlc-future-lock.test.js   (tests/run.js picks it up too)

const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractLine } = require('./_extract.js');

// Source paths are overridable so the RED proof can run this exact file against the
// pre-K2 backups instead of asserting that it "would" fail.
const APP_SRC_PATH = process.env.K2_APP_SRC
  ? path.resolve(process.cwd(), process.env.K2_APP_SRC)
  : path.join(__dirname, '../app.js');
const SYNC_SRC_PATH = process.env.K2_SYNC_SRC
  ? path.resolve(process.cwd(), process.env.K2_SYNC_SRC)
  : path.join(__dirname, '../sync.js');

const appSrc = fs.readFileSync(APP_SRC_PATH, 'utf8');
let syncSrc = fs.readFileSync(SYNC_SRC_PATH, 'utf8');
syncSrc = syncSrc.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* stripped */');
syncSrc = syncSrc.replace(/\bsyncInit\(\)\s*;?\s*$/, '');

let failures = 0;
function assert(desc, cond){
  if(cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}
function assertEq(desc, got, want){
  assert(desc + ' (got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) + ')', got === want);
}

// =====================================================================
// Harness 1 -- app.js's HLC, with a clock we control.
//
// now()/ratchetHlc live in app.js, which the sync harness does not load (it
// touches the DOM at import time and has no module.exports). Pull the three
// lines out by ANCHOR (AGENTS.md §4: prefer _extract.js over line ranges) and
// eval them against a fake Date whose now() we drive. The extracted code only
// ever reads Date.now(), so a plain { now } object is a faithful stand-in.
// =====================================================================
function hasLine(re){ return appSrc.split('\n').some(l => re.test(l)); }

function makeHlc(startClock, persistedHlcLast){
  const tolLine     = extractLine(appSrc, /^const HLC_RATCHET_TOLERANCE_MS\s*=/,  'app.js HLC_RATCHET_TOLERANCE_MS');
  const nowLine     = extractLine(appSrc, /^function now\(\)\s*\{/,                'app.js now()');
  const ratchetLine = extractLine(appSrc, /^function ratchetHlc\(/,                'app.js ratchetHlc()');
  // Pre-K2 app.js has neither of these; fall back to a stub so the RED proof reports
  // the MISSING BEHAVIOUR (K2-F/K2-G) instead of dying in extraction.
  const healLine = hasLine(/^function _hlcHeal\(\)/)
    ? extractLine(appSrc, /^function _hlcHeal\(\)/, 'app.js _hlcHeal()')
    : 'function _hlcHeal(){ return false; } /* absent pre-K2 */';
  const skewLine = hasLine(/^function hlcSkewMs\(\)/)
    ? extractLine(appSrc, /^function hlcSkewMs\(\)/, 'app.js hlcSkewMs()')
    : 'function hlcSkewMs(){ return lastIssued - Date.now(); } /* absent pre-K2 */';

  const sb = {
    clock: startClock,
    events: [],
    Math: Math, JSON: JSON, Number: Number, String: String, Boolean: Boolean,
    S: { __hlcLast: persistedHlcLast || 0 },
    console: console
  };
  sb.Date = { now: function(){ return sb.clock; } };
  sb.logEvent = function(e){ sb.events.push(e); };
  sb.globalThis = sb;
  vm.createContext(sb);
  // `var lastIssued`, the S.__hlcLast restore and the boot heal mirror app.js:126-129.
  // The boot heal matters: the poison ARRIVES from S.__hlcLast, so healing it there is
  // what makes hlcSkewMs() honest on the first render instead of staying stale until
  // the user's next edit.
  vm.runInContext(
    tolLine + '\n' +
    'var lastIssued = 0;\n' +
    'lastIssued = (S && S.__hlcLast) || 0;\n' +
    '_hlcHeal();\n' +
    healLine + '\n' +
    skewLine + '\n' +
    nowLine + '\n' +
    ratchetLine + '\n' +
    'function _peekLastIssued(){ return lastIssued; }\n' +
    'function _peekTolerance(){ return HLC_RATCHET_TOLERANCE_MS; }\n',
    sb
  );
  return sb;
}

// =====================================================================
// Harness 2 -- sync.js in a vm sandbox.
//
// `nowMock` is optional ON PURPOSE. Omit it to model a NORMAL PEER: _hlcNow (pre-K2)
// then falls back to Date.now(), which is the same physical ceiling K2 makes
// unconditional -- so a peer behaves identically before and after the fix, and any
// RED below comes from the poisoned device's own stamps, not from the harness.
// Pass a RATCHETING mock (K2-C) to model the poisoned device's own merge round.
// =====================================================================
function makeQ(uidValue, nowMock){
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
    idbOpen: function(){ return Promise.resolve(null); }
  };
  if(nowMock) sandbox.now = nowMock;
  sandbox.self = sandbox.window;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  try { vm.runInContext(syncSrc, sandbox); } catch(e){}
  return sandbox;
}

// ---- fixtures. Relative to the real clock, never a hardcoded calendar date
// (commit 6b93a82) -- the clamp compares against Date.now(), so a frozen date
// would silently stop exercising anything. ------------------------------------
const FIXED_NOW = Date.now();
const TOLERANCE = 120000;                 // mirrors app.js HLC_RATCHET_TOLERANCE_MS
const EXCURSION_MS = 400 * 86400000;      // ~13 months: the "wrong year" case

function state(tasks, overrides){
  const s = { tasks: tasks || [], rewards:[], tags:[], devices:[], an:{views:[],metrics:[]},
    history:[], charHistory:[], monthlyBackups:[], lastCron:0, char:{}, deletions:[] };
  if(overrides) Object.keys(overrides).forEach(k => { s[k] = overrides[k]; });
  return s;
}

const sbBoot = makeQ('devPeer');
const QBoot = sbBoot.window && sbBoot.window.QuestaSync;
if(!QBoot || typeof QBoot.merge !== 'function' || typeof QBoot.mergeCollection !== 'function'){
  console.error('FAIL: QuestaSync registry missing merge/mergeCollection');
  process.exit(1);
}
assertEq('K2-0 sanity: tolerance constant agrees between app.js and this test',
  makeHlc(FIXED_NOW, 0)._peekTolerance(), TOLERANCE);

// =====================================================================
// K2-A -- THE HEADLINE. Excursion, then correction, then the device must be
// able to win a later, genuinely newer arbitration against a normal peer.
//
// This composes both halves of Failure 1: app.js mints the stamp, and a normal
// peer's merge arbitrates on it. RED pre-K2 because now() stays pinned at ~2027,
// so the peer's physical clamp zeroes the stamp and the stale remote wins.
// =====================================================================
(function(){
  // 1. Normal operation. A stamps a few records honestly.
  const hlc = makeHlc(FIXED_NOW, 0);
  hlc.now(); hlc.now();

  // 2. The clock jumps ~13 months forward (manual change / bad NTP / dead RTC).
  hlc.clock = FIXED_NOW + EXCURSION_MS;
  const poisoned = hlc.now();
  assert('K2-A1 setup: during the excursion the stamp really is ~13 months out',
    poisoned >= FIXED_NOW + EXCURSION_MS);

  // 3. The user fixes the clock. A minute of real time has passed.
  hlc.clock = FIXED_NOW + 60000;
  const healedStamp = hlc.now();

  // 4. A edits a task. That edit is GENUINELY newer than the peer's copy.
  const peerStamp = hlc.clock - 30000;   // peer edited 30s before A
  const base   = [{ id:'t1', type:'todo', title:'ancestor', updatedAt: peerStamp - 10000 }];
  const local  = [{ id:'t1', type:'todo', title:'A-EDIT',   updatedAt: healedStamp }];
  const remote = [{ id:'t1', type:'todo', title:'peer-old', updatedAt: peerStamp }];

  // Merge as seen BY THE PEER (device B, honest clock, no `now` injected):
  // local = B's copy of A's pushed state, remote = B's own older copy.
  const Q = makeQ('devPeer').window.QuestaSync;
  const m = Q.merge(state(base), state(local), state(remote), FIXED_NOW, FIXED_NOW, 'devPeer', 'devA');
  const merged = m.tasks.find(t => t.id === 't1');

  assertEq('K2-A2 after a clock correction the device wins a genuinely newer arbitration',
    merged && merged.title, 'A-EDIT');
  assert('K2-A3 the healed stamp is inside the tolerance every peer honours',
    healedStamp <= hlc.clock + TOLERANCE);
})();

// =====================================================================
// K2-B -- the monotonicity contract, stated correctly.
//
// NOT "never issue a lower number" -- the whole point of the heal is that it
// issues a lower number. The invariant that matters is: never issue a stamp below
// one that is STILL HONOURED BY THE FLEET (i.e. was <= its own physical clock +
// tolerance when issued). Values above that boundary are read as 0 by every
// device, so they cannot out-compete the new stamp and there is nothing to break.
// =====================================================================
(function(){
  const hlc = makeHlc(FIXED_NOW, 0);
  const honoured = [];                      // stamps a peer would still accept
  const unhonoured = [];                    // stamps no peer will ever accept

  for(let i = 0; i < 3; i++){ honoured.push(hlc.now()); }

  hlc.clock = FIXED_NOW + EXCURSION_MS;
  for(let i = 0; i < 3; i++){ unhonoured.push(hlc.now()); }

  hlc.clock = FIXED_NOW + 60000;            // clock corrected
  const after = hlc.now();

  const maxHonoured = Math.max.apply(null, honoured);
  assert('K2-B1 no issued stamp is below a still-honoured earlier stamp',
    after > maxHonoured);
  assert('K2-B2 GUARD: the dropped range really is unhonourable (all > clock + tolerance)',
    unhonoured.every(v => v > hlc.clock + TOLERANCE));
  assert('K2-B3 the clock came back inside tolerance after the correction',
    after <= hlc.clock + TOLERANCE);
  assert('K2-B4 the heal is persisted, so it survives a reboot',
    hlc.S.__hlcLast === after);

  // And it stays healed: a reboot that restores the persisted value must not
  // re-poison the clock.
  const rebooted = makeHlc(FIXED_NOW + 120000, hlc.S.__hlcLast);
  const afterReboot = rebooted.now();
  assert('K2-B5 after a reboot the restored clock is still inside tolerance',
    afterReboot <= rebooted.clock + TOLERANCE);

  // A reboot that restores a POISONED value must heal at boot, before anything reads it.
  const rebootedPoison = makeHlc(FIXED_NOW, FIXED_NOW + EXCURSION_MS);
  assert('K2-B6 a reboot with a poisoned persisted clock heals at boot',
    rebootedPoison._peekLastIssued() <= rebootedPoison.clock + TOLERANCE);
  assert('K2-B6b ...and the next stamp is immediately usable',
    rebootedPoison.now() <= rebootedPoison.clock + TOLERANCE);

  assert('K2-B7 successive stamps are still strictly increasing in normal operation',
    (function(){ const h = makeHlc(FIXED_NOW, 0); const a = h.now(), b = h.now(); return b > a; })());
})();

// =====================================================================
// K2-C -- Failure 2, asserted on the MERGE RESULT, not on call counts (§4).
//
// The remote side of all 500 records carries a stamp 300ms beyond the physical
// ceiling, so it MUST clamp to 0 and lose every record. Pre-K2 the ceiling is the
// ratcheting HLC, which advances ~1ms per comparison, so after ~150 records the
// ceiling climbs past the probe and the skewed remote starts WINNING. The observable
// effect is which title survives, for all 500 ids.
// =====================================================================
(function(){
  const N = 500;
  const PROBE = FIXED_NOW + TOLERANCE + 300;   // just beyond a constant physical ceiling

  // A faithful stand-in for app.js now(): ratchets and never goes down.
  let hlcVal = FIXED_NOW;
  const ratchetingNow = function(){ hlcVal = Math.max(FIXED_NOW, hlcVal + 1); return hlcVal; };

  const base = [], local = [], remote = [];
  for(let i = 0; i < N; i++){
    base.push(  { id:'t'+i, type:'todo', title:'base'+i,   updatedAt: FIXED_NOW - 20000 });
    local.push( { id:'t'+i, type:'todo', title:'local'+i,  updatedAt: FIXED_NOW - 5000  });
    remote.push({ id:'t'+i, type:'todo', title:'remote'+i, updatedAt: PROBE            });
  }

  const Q = makeQ('devSelf', ratchetingNow).window.QuestaSync;
  const m = Q.merge(state(base), state(local), state(remote), FIXED_NOW, FIXED_NOW, 'devSelf', 'devOther');

  let localWins = 0;
  m.tasks.forEach(t => { if(String(t.title).indexOf('local') === 0) localWins++; });
  assertEq('K2-C1 the clamp ceiling does not grow while merging 500 records', localWins, N);

  // Same fixture, 5 records: pre-K2 this passes (too few calls to drift the ceiling),
  // which is exactly why the 500-record case is the one that matters.
  const b5 = base.slice(0,5), l5 = local.slice(0,5), r5 = remote.slice(0,5);
  const Q5 = makeQ('devSelf', function(){ return FIXED_NOW; }).window.QuestaSync;
  const m5 = Q5.merge(state(b5), state(l5), state(r5), FIXED_NOW, FIXED_NOW, 'devSelf', 'devOther');
  let localWins5 = 0;
  m5.tasks.forEach(t => { if(String(t.title).indexOf('local') === 0) localWins5++; });
  assertEq('K2-C2 GUARD: the same fixture at 5 records clamps the skewed remote', localWins5, 5);
})();

// =====================================================================
// K2-D -- mergeCollection GUARD 3 is a SEVENTH inverted-polarity site.
//
// sync.js ~845:  staleLocal = localHad ? (_ua(b) >= localSavedAt) : (_ca(b) >= localSavedAt)
//
// The operand is BASE -- the agreed ancestor, not a competitor. A 0 here does not
// lose a tiebreak: it makes staleLocal FALSE, the guard FAILS OPEN, and the stale
// local revert (the Android localStorage-revert case, plan 2026-07-11 §1) is kept
// AND uploaded. Both operands must read RAW.
// =====================================================================
(function(){
  const SKEWED = FIXED_NOW + TOLERANCE + 60000;   // base was stamped by a fast device
  const Q = makeQ('devPeer').window.QuestaSync;

  // localHad == true -> the _ua(b) branch. RED pre-K2.
  const base   = [{ id:'t1', type:'todo', title:'GOOD',           updatedAt: SKEWED }];
  const local  = [{ id:'t1', type:'todo', title:'LOCAL-REVERTED', updatedAt: FIXED_NOW - 50000 }];
  const remote = [{ id:'t1', type:'todo', title:'GOOD',           updatedAt: SKEWED }];
  const out = Q.mergeCollection(base, local, remote, FIXED_NOW, FIXED_NOW - 1000, null, 'devA');
  const got = out.find(x => x.id === 't1');
  assertEq('K2-D1 GUARD 3 still fires when base carries a future-skewed stamp',
    got && got.title, 'GOOD');

  // GUARD (green both sides): with localHad == false the _ca(b) branch and the
  // tombstone-model fallback below it both keep base, so a 0 there is not
  // observable today. Pinned so that stays true if either branch is reworked.
  const base2   = [{ id:'t2', type:'todo', title:'GOOD2', createdAt: SKEWED, updatedAt: SKEWED }];
  const remote2 = [{ id:'t2', type:'todo', title:'GOOD2', createdAt: SKEWED, updatedAt: SKEWED }];
  const out2 = Q.mergeCollection(base2, [], remote2, FIXED_NOW, FIXED_NOW - 1000, null, 'devA');
  const got2 = out2.find(x => x.id === 't2');
  assertEq('K2-D2 GUARD: local absence is not a deletion signal, base survives',
    got2 && got2.title, 'GOOD2');

  // GUARD (green both sides): an HONEST base newer than localSavedAt must still
  // suppress the stale local. Going raw must not weaken the ordinary case.
  const base3   = [{ id:'t3', type:'todo', title:'GOOD3',           updatedAt: FIXED_NOW - 500 }];
  const local3  = [{ id:'t3', type:'todo', title:'LOCAL-REVERTED3', updatedAt: FIXED_NOW - 50000 }];
  const remote3 = [{ id:'t3', type:'todo', title:'GOOD3',           updatedAt: FIXED_NOW - 500 }];
  const out3 = Q.mergeCollection(base3, local3, remote3, FIXED_NOW, FIXED_NOW - 1000, null, 'devA');
  const got3 = out3.find(x => x.id === 't3');
  assertEq('K2-D3 GUARD: GUARD 3 unchanged for an honest base newer than localSavedAt',
    got3 && got3.title, 'GOOD3');

  // GUARD (green both sides): a base OLDER than localSavedAt means local really did
  // know about it, so a genuine local edit must still win.
  const base4   = [{ id:'t4', type:'todo', title:'ancestor',  updatedAt: FIXED_NOW - 90000 }];
  const local4  = [{ id:'t4', type:'todo', title:'REAL-EDIT', updatedAt: FIXED_NOW - 2000 }];
  const remote4 = [{ id:'t4', type:'todo', title:'ancestor',  updatedAt: FIXED_NOW - 90000 }];
  const out4 = Q.mergeCollection(base4, local4, remote4, FIXED_NOW, FIXED_NOW - 1000, null, 'devA');
  const got4 = out4.find(x => x.id === 't4');
  assertEq('K2-D4 GUARD: a genuine local edit over an older base still propagates',
    got4 && got4.title, 'REAL-EDIT');
})();

// =====================================================================
// K2-E -- GUARD (green both sides): the heal must NOT touch the legitimate
// ratchet band. A peer that is genuinely 100s fast is INSIDE tolerance and is
// trusted; ratchetHlc follows it and this device must keep issuing above it,
// or its own new edits would lose to that peer's old records.
// =====================================================================
(function(){
  const hlc = makeHlc(FIXED_NOW, 0);
  hlc.ratchetHlc(FIXED_NOW + 100000);          // inside the 120s tolerance
  assertEq('K2-E1 GUARD: ratchetHlc still follows a peer inside tolerance',
    hlc._peekLastIssued(), FIXED_NOW + 100000);

  const stamp = hlc.now();
  assert('K2-E2 GUARD: the heal does not undo a legitimate ratchet',
    stamp > FIXED_NOW + 100000);

  // And it still REFUSES a peer beyond tolerance, logging clockSkew.
  const hlc2 = makeHlc(FIXED_NOW, 0);
  hlc2.ratchetHlc(FIXED_NOW + TOLERANCE + 60000);
  assertEq('K2-E3 GUARD: ratchetHlc still refuses a peer beyond tolerance',
    hlc2._peekLastIssued(), 0);
  assert('K2-E4 GUARD: the refusal still logs clockSkew',
    hlc2.events.some(e => e && e.kind === 'clockSkew'));
})();

// =====================================================================
// K2-F -- the user (and a future debugger) can actually SEE it happen.
// Today the device is silently demoted to read-only in every conflict, which is
// why Failure 1 went unnoticed. The heal must emit a diagnostic, and that kind
// must be registered in DIAGNOSTIC_KINDS so it reaches the diagnostics feed
// filter and the full-diag export (AGENTS.md §7).
// =====================================================================
(function(){
  const hlc = makeHlc(FIXED_NOW, FIXED_NOW + EXCURSION_MS);   // boots poisoned
  hlc.now();
  const ev = hlc.events.filter(e => e && e.kind === 'hlcReset');
  assertEq('K2-F1 the heal emits exactly one hlcReset event', ev.length, 1);
  assert('K2-F2 the hlcReset event carries the drift it corrected',
    ev[0] && Number(ev[0].driftMs) >= EXCURSION_MS);

  const kinds = extractLine(appSrc, /^var DIAGNOSTIC_KINDS\s*=\s*\[/, 'app.js DIAGNOSTIC_KINDS');
  assert('K2-F3 hlcReset is registered in DIAGNOSTIC_KINDS', kinds.indexOf("'hlcReset'") >= 0);

  // A healthy clock must stay silent -- the ring buffer is 50 entries with blind
  // FIFO eviction (_qDiagPush, app.js:9), so a chatty diagnostic evicts the
  // uncaught-error records the buffer exists for.
  const healthy = makeHlc(FIXED_NOW, 0);
  for(let i = 0; i < 50; i++) healthy.now();
  assertEq('K2-F4 a healthy clock emits no hlcReset at all',
    healthy.events.filter(e => e && e.kind === 'hlcReset').length, 0);

  // One excursion must not emit one event per stamp.
  const once = makeHlc(FIXED_NOW, FIXED_NOW + EXCURSION_MS);
  for(let i = 0; i < 20; i++) once.now();
  assertEq('K2-F5 one excursion emits one hlcReset, not one per stamp',
    once.events.filter(e => e && e.kind === 'hlcReset').length, 1);
})();

// =====================================================================
// K2-G -- the two gating predicates, tested on their OWN return values, not
// only through a caller (AGENTS.md §4 corollary: a function that alone gates
// whether a feature runs deserves a direct unit test).
// =====================================================================
(function(){
  // _hlcHeal() reports whether it actually healed.
  const poisoned = makeHlc(FIXED_NOW, 0);
  poisoned.clock = FIXED_NOW;
  poisoned.ratchetHlc(FIXED_NOW + 100000);              // inside tolerance
  assertEq('K2-G1 _hlcHeal() returns false inside the tolerance band',
    poisoned._hlcHeal(), false);
  assertEq('K2-G2 ...and leaves the clock alone',
    poisoned._peekLastIssued(), FIXED_NOW + 100000);

  const boot = makeHlc(FIXED_NOW, FIXED_NOW + EXCURSION_MS);   // heals at boot
  assertEq('K2-G3 _hlcHeal() returns false on a second call (nothing left to heal)',
    boot._hlcHeal(), false);

  // The boundary itself: exactly AT tolerance is still honoured, one ms past is not.
  const atEdge = makeHlc(FIXED_NOW, FIXED_NOW + TOLERANCE);
  assertEq('K2-G4 a clock exactly at the tolerance boundary is NOT healed',
    atEdge._peekLastIssued(), FIXED_NOW + TOLERANCE);
  const pastEdge = makeHlc(FIXED_NOW, FIXED_NOW + TOLERANCE + 1);
  assertEq('K2-G5 one ms past the boundary IS healed', pastEdge._peekLastIssued(), FIXED_NOW);

  // hlcSkewMs() is what the Settings warning renders on. A fresh install has
  // lastIssued === 0, so the skew is hugely NEGATIVE -- behind is harmless, and what
  // matters is that it never trips the warning.
  const fresh = makeHlc(FIXED_NOW, 0);
  assert('K2-G6 hlcSkewMs() does not trip the warning on a fresh install',
    fresh.hlcSkewMs() <= TOLERANCE);
  fresh.now();
  assert('K2-G6b ...and is ~0 once the clock has issued a stamp',
    Math.abs(fresh.hlcSkewMs()) <= 1);
  const live = makeHlc(FIXED_NOW, 0);
  live.clock = FIXED_NOW + EXCURSION_MS; live.now();   // excursion in progress
  live.clock = FIXED_NOW;                             // read while still wrong
  assert('K2-G7 hlcSkewMs() reports the drift during a live excursion',
    live.hlcSkewMs() > TOLERANCE);
  assert('K2-G8 the Settings warning is wired to that predicate',
    /hlcSkewMs\(\)\s*>\s*HLC_RATCHET_TOLERANCE_MS/.test(appSrc));
})();

// =====================================================================
// K2-H -- tools/join_exports.py must not transplant a poisoned clock.
//
// __hlcLast is NOT in sync.js syncSubset(), so a poisoned clock never spreads over
// Dropbox. But join_exports.py folded it with a plain max() across inputs, so joining
// a poisoned export into a healthy one carried the poison over -- the one remaining
// path by which it spreads between devices. Shells out to the real tool (same pattern
// as tests/join-daily-reset.test.js) and reuses that test's fixture.
// =====================================================================
(function(){
  const { execFileSync } = require('child_process');
  const os = require('os');
  const root = path.join(__dirname, '..');
  const joinPy = path.join(root, 'tools', 'join_exports.py');
  const basePath = path.join(__dirname, 'fixtures', 'join-daily-reset-base.json');
  if(!fs.existsSync(joinPy) || !fs.existsSync(basePath)){
    console.error('[FAIL] K2-H setup: join_exports.py or the shared fixture is missing');
    failures++;
    return;
  }
  const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k2-hlc-join-'));

  function join(inputs){
    const paths = inputs.map((o, i) => {
      const p = path.join(dir, 'in' + i + '.json');
      fs.writeFileSync(p, JSON.stringify(o), 'utf8');
      return p;
    });
    const outPath = path.join(dir, 'out.json');
    execFileSync('python', [joinPy, outPath].concat(paths), { encoding: 'utf8' });
    return JSON.parse(fs.readFileSync(outPath, 'utf8'));
  }

  const healthy = JSON.parse(JSON.stringify(base));
  healthy.__hlcLast = FIXED_NOW - 10000;
  const poisoned = JSON.parse(JSON.stringify(base));
  poisoned.__hlcLast = FIXED_NOW + EXCURSION_MS;

  const joined = join([healthy, poisoned]);
  assert('K2-H1 a poisoned __hlcLast is not transplanted into the join',
    Number(joined.__hlcLast) <= FIXED_NOW + TOLERANCE + 5000);
  assertEq('K2-H2 ...and the healthy input\'s value is what survives',
    Number(joined.__hlcLast), FIXED_NOW - 10000);

  // GUARD: two healthy inputs must keep the plain max, so ordinary archive joins
  // are completely unaffected.
  const h2 = JSON.parse(JSON.stringify(base));
  h2.__hlcLast = FIXED_NOW - 3000;
  const joined2 = join([healthy, h2]);
  assertEq('K2-H3 GUARD: two honest inputs still fold with a plain max',
    Number(joined2.__hlcLast), FIXED_NOW - 3000);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch(e){}
})();

// =====================================================================
// Report
// =====================================================================
if(failures){
  console.error('\n' + failures + ' hlc-future-lock assertion(s) FAILED');
  console.error('  app.js  <- ' + APP_SRC_PATH);
  console.error('  sync.js <- ' + SYNC_SRC_PATH);
  process.exit(1);
}
console.log('\nAll hlc-future-lock tests passed!');
