// char-tiebreak-convergence.test.js -- K4 (2026-09-11): the char deviceId tiebreak
// must fire ONLY on an exact updatedAt tie.
//
// Bug: sync.js's char block ran `if(_clampFuture(r.updatedAt) > _clampFuture(l.updatedAt))`
// and then fell straight into the deviceId tiebreak. "remote is not strictly newer"
// includes "LOCAL is strictly newer", so when local held the newer edit and remote held
// the lexically higher deviceId, the tiebreak handed the round to remote. Run it from the
// other device and the same rule handed that round back. The pair swapped
// name/face/cls/hp/maxHp/id forever and never converged.
//
// The other three tiebreak sites in sync.js all gate on an exact tie
// (resolveDailyConflict, mergeCollection's non-daily arm, mergeDevices). K4 makes the char
// site match them: `_lUa === _rUa && _rd != null && _ld !== _rd`.
//
// After K3 the earnings (xp/gold/mp) already sum via _charAccumulate, so this is a SCALAR
// convergence bug, not data loss -- but hp is a real scalar: a damaged device kept having
// its HP restored by a peer that took no damage.
//
// RED BASELINE. Every assertion tagged [K4-NEW] below is RED against the pre-K4 sync.js
// and GREEN against the current one. Prove it with:
//   K4_SYNC=archive/old-versions/sync.js.bak-20260911-K4pre node tests/char-tiebreak-convergence.test.js
// Assertions tagged [GUARD] are behaviour K4 must NOT change; they are green in both runs
// on purpose (they pin C7's local-bias fallback, the exact-tie tiebreak, and K3's sums).
//
// Run: node tests/char-tiebreak-convergence.test.js  (also run by node tests/run.js)

const fs = require('fs'), path = require('path'), vm = require('vm');

// K4_SYNC lets the same file run against an older sync.js to prove the RED baseline.
const SYNC_PATH = process.env.K4_SYNC
  ? path.resolve(process.cwd(), process.env.K4_SYNC)
  : path.join(__dirname, '../sync.js');

let src = fs.readFileSync(SYNC_PATH, 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* stripped */');
const noop = function(){};
const sandbox = {window:{}, navigator:{onLine:true},
  document:{addEventListener:noop, getElementById:function(){return null;},
    createElement:function(){return {style:{}, appendChild:noop, setAttribute:noop, click:noop};},
    body:{appendChild:noop, removeChild:noop}},
  localStorage:{getItem:function(){return null;}, setItem:noop, removeItem:noop, key:function(){return null;}, length:0},
  indexedDB:{open:function(){return {};}},
  setTimeout:function(){return 0;}, clearTimeout:noop, setInterval:function(){return 0;}, clearInterval:noop,
  console:console, JSON:JSON, Math:Math, Date:Date, Map:Map, Set:Set, WeakSet:WeakSet,
  Array:Array, Object:Object, Number:Number, String:String, Boolean:Boolean, Promise:Promise,
  logEvent:noop, toast:noop, render:noop, esc:function(x){return x;}, save:noop,
  uid:function(){return 'x';}, idbOpen:function(){return Promise.resolve(null);}};
sandbox.self = sandbox.window; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try{ vm.runInContext(src, sandbox); }catch(e){ console.error('sync.js eval failed: ' + e.message); }
const Q = sandbox.window.QuestaSync;
if(!Q || typeof Q.merge !== 'function'){ console.error('FAIL: QuestaSync.merge not found'); process.exit(1); }

let failures = 0;
function assert(d, c){ if(c) console.log('[PASS] ' + d); else { console.error('[FAIL] ' + d); failures++; } }
function assertEq(d, got, want){ assert(d + ' (got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) + ')', got === want); }

function sub(char){
  return {tasks: [], rewards:[], tags:[], devices:[], an:{views:[], metrics:[]},
    history:[], charHistory:[], monthlyBackups:[], lastCron:0, char: char || {}, deletions:[]};
}
// A canonical level-1 character with real progress, so untouched() never fires and every
// case below lands in the both-changed arbitration this file is about.
function ch(over){
  return Object.assign({name:'Pali', face:'W', cls:'Warrior', lvl:1, xp:0,
    hp:50, maxHp:50, mp:0, gold:0, updatedAt:1000}, over || {});
}
// The scalars the arbitration carries -- these are exactly what was ping-ponging.
function scalars(c){
  return [c.name, c.face, c.cls, c.hp, c.maxHp, c.updatedAt].join('|');
}

// 'devA' < 'devB' lexically, so devB always wins the deviceId tiebreak. Every case below
// deliberately puts the higher id on the side that must LOSE on recency, so a tiebreak
// that fires when it must not is immediately visible.
const DEV_A = 'devA', DEV_B = 'devB';

// ---------------------------------------------------------------------------
// K4-A: LOCAL strictly newer, REMOTE holds the higher deviceId.
// The headline repro. Local edited last (2000 vs 1500) but remote is devB, so the
// ungated tiebreak handed the round to remote's scalars -- and the mirror merge handed
// them back. Both directions must now keep LOCAL's scalars, i.e. the same answer.
// ---------------------------------------------------------------------------
(function(){
  const b = ch({});
  const L = ch({name:'NEWER-local', face:'R', cls:'Rogue',   hp:20, xp:60, gold:12, mp:3, updatedAt:2000});
  const R = ch({name:'older-remote', face:'W', cls:'Warrior', hp:50, xp:40, gold:8,  mp:2, updatedAt:1500});

  const fwd = Q.merge(sub(b), sub(L), sub(R), 1500, 2000, DEV_A, DEV_B); // devA's view
  const rev = Q.merge(sub(b), sub(R), sub(L), 2000, 1500, DEV_B, DEV_A); // devB's view

  assertEq('[K4-NEW] K4-A1 fwd keeps the strictly-newer local name', fwd.char.name, 'NEWER-local');
  assertEq('[K4-NEW] K4-A2 rev agrees on the same name', rev.char.name, 'NEWER-local');
  assertEq('[K4-NEW] K4-A3 fwd keeps the damaged hp (not restored by the peer)', fwd.char.hp, 20);
  assertEq('[K4-NEW] K4-A4 rev keeps the same hp', rev.char.hp, 20);
  assertEq('[K4-NEW] K4-A5 fwd carries the newer face', fwd.char.face, 'R');
  assertEq('[K4-NEW] K4-A6 fwd carries the newer cls', fwd.char.cls, 'Rogue');
  assertEq('[K4-NEW] K4-A7 fwd carries the newer updatedAt', fwd.char.updatedAt, 2000);
  assert('[K4-NEW] K4-A8 CONVERGENT: both directions agree on every carried scalar',
    scalars(fwd.char) === scalars(rev.char));
  // K3 must not regress: 60 + 40 = 100 regardless of who carries the scalars.
  assertEq('[GUARD] K4-A9 fwd earnings still SUM (xp)',  fwd.char.xp, 100);
  assertEq('[GUARD] K4-A10 rev earnings still SUM (xp)', rev.char.xp, 100);
  assertEq('[GUARD] K4-A11 fwd gold still SUMs',  fwd.char.gold, 20);
  assertEq('[GUARD] K4-A12 rev gold still SUMs',  rev.char.gold, 20);
  assertEq('[GUARD] K4-A13 fwd mp still SUMs',    fwd.char.mp, 5);
  assertEq('[GUARD] K4-A14 rev mp still SUMs',    rev.char.mp, 5);
})();

// ---------------------------------------------------------------------------
// K4-B: the mirror. REMOTE strictly newer, LOCAL holds the higher deviceId.
// The strictly-newer-remote branch already handled the forward direction correctly, so
// only the REVERSE merge was broken: there the newer side sits in `local`, the old code
// fell through and the tiebreak gave the round away again.
// ---------------------------------------------------------------------------
(function(){
  const b = ch({});
  const L = ch({name:'older-local',  face:'W', cls:'Warrior', hp:45, xp:40, gold:8,  mp:2, updatedAt:1500});
  const R = ch({name:'NEWER-remote', face:'M', cls:'Mage',    hp:15, xp:60, gold:12, mp:3, updatedAt:2000});

  const fwd = Q.merge(sub(b), sub(L), sub(R), 2000, 1500, DEV_B, DEV_A); // local is devB (higher id)
  const rev = Q.merge(sub(b), sub(R), sub(L), 1500, 2000, DEV_A, DEV_B); // the same pair, mirrored

  assertEq('[K4-NEW] K4-B1 fwd takes the strictly-newer remote name', fwd.char.name, 'NEWER-remote');
  assertEq('[K4-NEW] K4-B2 rev agrees on the same name', rev.char.name, 'NEWER-remote');
  assertEq('[K4-NEW] K4-B3 fwd takes the newer hp', fwd.char.hp, 15);
  assertEq('[K4-NEW] K4-B4 rev takes the same hp',  rev.char.hp, 15);
  assertEq('[K4-NEW] K4-B5 fwd carries the newer cls', fwd.char.cls, 'Mage');
  assert('[K4-NEW] K4-B6 CONVERGENT: both directions agree on every carried scalar',
    scalars(fwd.char) === scalars(rev.char));
  assertEq('[GUARD] K4-B7 fwd earnings still SUM (xp)',  fwd.char.xp, 100);
  assertEq('[GUARD] K4-B8 rev earnings still SUM (xp)',  rev.char.xp, 100);
  assertEq('[GUARD] K4-B9 fwd gold still SUMs',  fwd.char.gold, 20);
  assertEq('[GUARD] K4-B10 rev gold still SUMs', rev.char.gold, 20);
})();

// ---------------------------------------------------------------------------
// K4-C: EXACT updatedAt tie -- the deviceId tiebreak is still the decider.
// This is the case the tiebreak was written for and K4 must leave it alone.
// devB > devA, so Bob's scalars win from both sides.
// ---------------------------------------------------------------------------
(function(){
  const b = ch({});
  const L = ch({name:'Alice', face:'W', cls:'Wizard', hp:80,  xp:60, gold:12, mp:3, updatedAt:1000});
  const R = ch({name:'Bob',   face:'R', cls:'Rogue',  hp:120, xp:40, gold:8,  mp:2, updatedAt:1000});

  const fwd = Q.merge(sub(b), sub(L), sub(R), 1000, 1000, DEV_A, DEV_B); // remote is devB -> Bob
  const rev = Q.merge(sub(b), sub(R), sub(L), 1000, 1000, DEV_B, DEV_A); // local is devB -> Bob

  assertEq('[GUARD] K4-C1 exact tie: higher deviceId (devB/Bob) wins fwd', fwd.char.name, 'Bob');
  assertEq('[GUARD] K4-C2 exact tie: higher deviceId (devB/Bob) wins rev', rev.char.name, 'Bob');
  assertEq('[GUARD] K4-C3 exact tie carries Bob hp fwd', fwd.char.hp, 120);
  assertEq('[GUARD] K4-C4 exact tie carries Bob hp rev', rev.char.hp, 120);
  assert('[GUARD] K4-C5 exact tie CONVERGENT on every carried scalar',
    scalars(fwd.char) === scalars(rev.char));
  assertEq('[GUARD] K4-C6 exact tie earnings still SUM (xp)',   fwd.char.xp, 100);
  assertEq('[GUARD] K4-C7 exact tie earnings still SUM (gold)', fwd.char.gold, 20);
})();

// ---------------------------------------------------------------------------
// K4-D: NO remote device id -> the F2 local bias still applies.
// This is char-merge.test.js C7's shape asserted directly. _rd is null, so the tiebreak
// cannot fire and local is kept. NOTE: _charAccumulate precondition 3 needs TWO distinct
// device ids, so _acc is null here by design and the earnings deliberately do NOT sum --
// the merge is exactly pre-K3 LWW. Asserted so a future change to precondition 3 is loud.
// ---------------------------------------------------------------------------
(function(){
  const b = ch({});
  const L = ch({name:'local-keeps',  face:'W', cls:'Warrior', hp:30, xp:60, gold:12, mp:3, updatedAt:5000});
  const R = ch({name:'remote-loses', face:'R', cls:'Rogue',   hp:90, xp:40, gold:8,  mp:2, updatedAt:5000});

  const m = Q.merge(sub(b), sub(L), sub(R), 5000, 5000, null, null);
  assertEq('[GUARD] K4-D1 no device ids + exact tie -> local kept (F2 bias)', m.char.name, 'local-keeps');
  assertEq('[GUARD] K4-D2 no device ids -> local hp kept', m.char.hp, 30);
  assertEq('[GUARD] K4-D3 no device ids -> _acc is null, so xp is local-only (pre-K3 LWW)', m.char.xp, 60);

  // Same shape, but local is strictly NEWER and there is still no remote id. K4 routes
  // this through the recency fall-through instead of the tiebreak; the answer is local
  // either way, which is why this one is a GUARD and not a K4-NEW.
  const L2 = ch({name:'local-newer', hp:30, xp:60, gold:12, mp:3, updatedAt:7000});
  const m2 = Q.merge(sub(b), sub(L2), sub(R), 5000, 7000, null, null);
  assertEq('[GUARD] K4-D4 no device ids + local newer -> local kept', m2.char.name, 'local-newer');
})();

// ---------------------------------------------------------------------------
// K4-E: two-round ping-pong. Feed each device's round-1 result back in as round 2's
// local (and its peer's result as round 2's remote, with the agreed result as the new
// base) and assert the scalars STOP MOVING. On the pre-K4 sync.js the two devices never
// reach a common base, so round 2 keeps swapping.
// ---------------------------------------------------------------------------
(function(){
  const b = ch({});
  const L = ch({name:'NEWER-local', face:'R', cls:'Rogue',   hp:20, xp:60, gold:12, mp:3, updatedAt:2000});
  const R = ch({name:'older-remote', face:'W', cls:'Warrior', hp:50, xp:40, gold:8,  mp:2, updatedAt:1500});

  // Round 1, both devices.
  const a1 = Q.merge(sub(b), sub(L), sub(R), 1500, 2000, DEV_A, DEV_B).char;
  const b1 = Q.merge(sub(b), sub(R), sub(L), 2000, 1500, DEV_B, DEV_A).char;
  assert('[K4-NEW] K4-E1 round 1 already agrees on the carried scalars',
    scalars(a1) === scalars(b1));

  // Round 2: devA's own result is local, devB's is remote, and the agreed round-1 result
  // is the new common base -- which is what a real second sync round looks like.
  const a2 = Q.merge(sub(a1), sub(a1), sub(b1), 3000, 3000, DEV_A, DEV_B).char;
  const b2 = Q.merge(sub(b1), sub(b1), sub(a1), 3000, 3000, DEV_B, DEV_A).char;

  assert('[K4-NEW] K4-E2 round 2 scalars STOP MOVING on devA', scalars(a2) === scalars(a1));
  assert('[K4-NEW] K4-E3 round 2 scalars STOP MOVING on devB', scalars(b2) === scalars(b1));
  assert('[K4-NEW] K4-E4 round 2 still convergent across devices', scalars(a2) === scalars(b2));
  assertEq('[GUARD] K4-E5 round 2 does NOT double-count xp', a2.xp, 100);
  assertEq('[GUARD] K4-E6 round 2 does NOT double-count gold', a2.gold, 20);
  assertEq('[GUARD] K4-E7 round 2 does NOT double-count xp on devB', b2.xp, 100);
})();

if(failures){console.error(failures + ' char-tiebreak-convergence assertion(s) FAILED'); process.exit(1);}
console.log('char-tiebreak-convergence.test.js: all assertions passed');
