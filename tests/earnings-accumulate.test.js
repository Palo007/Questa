// earnings-accumulate.test.js -- K3 (2026-09-11): earnings must ADD UP, not pick a winner.
//
// Covers P10c / docs/SYNC-MULTI-DEVICE-CASES.md row 4.28 (char was one indivisible
// last-write-wins record) and the habit-counter twin (cUp/cDown inside the task object).
// Design note, costed alternatives and the rejected event-log replay:
//   .omo/plans/K3-earnings-design.md
//
// Every K3-* assertion below is RED against archive/old-versions/sync.js.bak-20260911-optA
// and GREEN against sync.js. Prove it with:
//   K3_SYNC=archive/old-versions/sync.js.bak-20260911-optA node tests/earnings-accumulate.test.js
//
// Run: node tests/earnings-accumulate.test.js  (also run by node tests/run.js)

const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction } = require('./_extract');

// K3_SYNC lets the same file run against an older sync.js to prove the RED baseline.
const SYNC_PATH = process.env.K3_SYNC
  ? path.resolve(process.cwd(), process.env.K3_SYNC)
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
// NOTE: absent on any pre-K3 sync.js. Guarded so the RED run reports assertions
// instead of dying on a TypeError at the first helper call.
const K3 = (Q && Q.k3Helpers) || {};

let failures = 0;
function assert(d, c){ if(c) console.log('[PASS] ' + d); else { console.error('[FAIL] ' + d); failures++; } }
function assertEq(d, got, want){ assert(d + ' (got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) + ')', got === want); }
// Key-sorted serialization -- char.abs key order must not decide a deep comparison.
function stable(o){
  if(o === null || typeof o !== 'object') return JSON.stringify(o);
  if(Array.isArray(o)) return '[' + o.map(stable).join(',') + ']';
  return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}';
}
function sub(char, tasks){
  return {tasks: tasks || [], rewards:[], tags:[], devices:[], an:{views:[], metrics:[]},
    history:[], charHistory:[], monthlyBackups:[], lastCron:0, char: char || {}, deletions:[]};
}
// A canonical level-1 character with real progress (so untouched() does not fire).
function ch(over){
  return Object.assign({name:'Pali', face:'W', cls:'Warrior', lvl:1, xp:0,
    hp:50, maxHp:50, mp:0, gold:0, updatedAt:1000}, over || {});
}
const DEV_A = 'devA', DEV_B = 'devB';

// ---------------------------------------------------------------------------
// K3-A: two devices earn offline -> the merged character holds the SUM.
// The repro from the prompt: A completes three tasks (60xp/12gold), B completes
// two (40xp/8gold). The tasks all merge; the earnings used to not.
// ---------------------------------------------------------------------------
(function(){
  const b = ch();
  const l = ch({xp:60, gold:12, mp:3, updatedAt:2000});
  const r = ch({xp:40, gold:8,  mp:2, updatedAt:1500});
  const m = Q.merge(sub(b), sub(l), sub(r), 1500, 2000, DEV_A, DEV_B);
  assertEq('K3-A1 xp is the SUM, not one side', m.char.xp, 100);
  assertEq('K3-A2 gold is the SUM, not one side', m.char.gold, 20);
  assertEq('K3-A3 mp is the SUM, not one side', m.char.mp, 5);
  assertEq('K3-A4 still level 1 (100 < xpToLevel(1))', m.char.lvl, 1);
})();

// ---------------------------------------------------------------------------
// K3-B: the conflict-retry path must NOT double-count.
// _syncNowAttempt applies the merge BEFORE the push, so _pushWithConflictRetry
// re-merges with the already-merged state as `local` while `base` is unchanged.
// A plain base-delta gives 140 here; the absorbed watermark keeps it at 100.
// ---------------------------------------------------------------------------
(function(){
  const b = ch();
  const l = ch({xp:60, gold:12, mp:3, updatedAt:2000});
  const r = ch({xp:40, gold:8,  mp:2, updatedAt:1500});
  const m1 = Q.merge(sub(b), sub(l), sub(r), 1500, 2000, DEV_A, DEV_B);
  // retry: local is now the merged state, base is still the pre-round base,
  // remote is the same unchanged remote snapshot.
  const m2 = Q.merge(sub(b), sub(m1.char), sub(r), 1500, 2000, DEV_A, DEV_B);
  assertEq('K3-B1 retry does not double-count xp', m2.char.xp, 100);
  assertEq('K3-B2 retry does not double-count gold', m2.char.gold, 20);
  assertEq('K3-B3 retry does not double-count mp', m2.char.mp, 5);
  // and a third pass is still stable (idempotent, not merely once-safe)
  const m3 = Q.merge(sub(b), sub(m2.char), sub(r), 1500, 2000, DEV_A, DEV_B);
  assertEq('K3-B4 third pass is stable', m3.char.xp, 100);
})();

// ---------------------------------------------------------------------------
// K3-C: order independence -- merge(b,L,R) and merge(b,R,L) give the SAME char.
// Equal updatedAt on both sides so the CARRIER choice is the deterministic
// deviceId tiebreak on both sides (a genuine F6 tie), isolating the accumulate.
// ---------------------------------------------------------------------------
(function(){
  const b = ch();
  const l = ch({xp:60, gold:12, mp:3, updatedAt:2000});
  const r = ch({xp:40, gold:8,  mp:2, updatedAt:2000});
  const fwd = Q.merge(sub(b), sub(l), sub(r), 2000, 2000, DEV_A, DEV_B);
  const rev = Q.merge(sub(b), sub(r), sub(l), 2000, 2000, DEV_B, DEV_A);
  assert('K3-C1 merge(b,L,R) char === merge(b,R,L) char', stable(fwd.char) === stable(rev.char));
  assertEq('K3-C2 and it is the sum either way', fwd.char.xp, 100);
})();

// ---------------------------------------------------------------------------
// K3-D: one device SPENDS gold while the other earns.
// gold is a spendable balance, so it must be free to fall. xp/mp get the
// earnings-only floor; gold never does.
// ---------------------------------------------------------------------------
(function(){
  const b = ch({gold:20});
  const l = ch({gold:30, xp:10, updatedAt:2000});  // earned 10 gold + 10 xp
  const r = ch({gold:5,  xp:0,  updatedAt:2000});  // spent 15 gold
  const m = Q.merge(sub(b), sub(l), sub(r), 2000, 2000, DEV_A, DEV_B);
  assertEq('K3-D1 earn + spend resolves to base+earn-spend', m.char.gold, 15);
  assertEq('K3-D2 the earning side keeps its xp', m.char.xp, 10);
})();

// ---------------------------------------------------------------------------
// K3-E: habit counters. cUp/cDown live inside the task object and were decided
// by the whole-object winner.
// ---------------------------------------------------------------------------
function habit(over){
  return Object.assign({id:'h1', type:'habit', title:'Pushups', value:0,
    difficulty:'easy', cUp:0, cDown:0, updatedAt:1000}, over || {});
}
(function(){
  const bt = [habit({cUp:10})];
  const lt = [habit({cUp:16, updatedAt:2000})]; // A tapped 6 times
  const rt = [habit({cUp:13, updatedAt:1500})]; // B tapped 3 times
  const m = Q.merge(sub(ch(), bt), sub(ch(), lt), sub(ch(), rt), 1500, 2000, DEV_A, DEV_B);
  assertEq('K3-E1 cUp from two devices sums (10 +6 +3)', m.tasks[0].cUp, 19);
})();
(function(){
  // Both devices crossed the resetFreq boundary, so runCron zeroed cUp on each
  // WITHOUT bumping updatedAt. A plain base delta would give 10-4-7 = -1.
  const bt = [habit({cUp:10})];
  const lt = [habit({cUp:6, updatedAt:2000})];
  const rt = [habit({cUp:3, updatedAt:1500})];
  const m = Q.merge(sub(ch(), bt), sub(ch(), lt), sub(ch(), rt), 1500, 2000, DEV_A, DEV_B);
  assertEq('K3-E2 both-sides reset sums the post-reset taps (6 +3)', m.tasks[0].cUp, 9);
})();
(function(){
  // cDown follows the same rule, and order independence holds for counters too.
  const bt = [habit({cDown:4})];
  const lt = [habit({cDown:9, updatedAt:2000})];
  const rt = [habit({cDown:6, updatedAt:2000})];
  const fwd = Q.merge(sub(ch(), bt), sub(ch(), lt), sub(ch(), rt), 2000, 2000, DEV_A, DEV_B);
  const rev = Q.merge(sub(ch(), bt), sub(ch(), rt), sub(ch(), lt), 2000, 2000, DEV_B, DEV_A);
  assertEq('K3-E3 cDown sums (4 +5 +2)', fwd.tasks[0].cDown, 11);
  assertEq('K3-E4 cDown is order independent', rev.tasks[0].cDown, fwd.tasks[0].cDown);
})();

// ---------------------------------------------------------------------------
// K3-F: missing / empty base (first-ever sync, or IDB lost while localStorage
// survived -- docs 1.3). Accumulating here would DOUBLE the character, so the
// reconcile must stand down and leave today's LWW in charge.
// ---------------------------------------------------------------------------
(function(){
  const l = ch({xp:60, gold:12, updatedAt:2000});
  const r = ch({xp:40, gold:8,  updatedAt:2000});
  const m = Q.merge(sub({}), sub(l), sub(r), 2000, 2000, DEV_A, DEV_B);
  // equal updatedAt -> deterministic deviceId tiebreak -> devB (remote) carries.
  assertEq('K3-F1 empty base -> one whole side, NOT the sum', m.char.xp, 40);
  assertEq('K3-F2 empty base -> gold from the same side', m.char.gold, 8);
  assert('K3-F3 empty base -> no earnings are zeroed', m.char.xp > 0 && m.char.gold > 0);
  assert('K3-F4 empty base -> no absorbed record is written', m.char.abs === undefined);
})();

// ---------------------------------------------------------------------------
// K3-G: level boundary and death.
// ---------------------------------------------------------------------------
(function(){
  const b = ch();
  const l = ch({xp:100, updatedAt:2000});
  const r = ch({xp:80,  updatedAt:2000});
  const m = Q.merge(sub(b), sub(l), sub(r), 2000, 2000, DEV_A, DEV_B);
  // 180 total, xpToLevel(1) === 150 -> level 2 with 30 left over.
  assertEq('K3-G1 a summed total that crosses the curve levels up', m.char.lvl, 2);
  assertEq('K3-G2 and keeps the correct residual xp', m.char.xp, 30);
})();
(function(){
  // A died (gold *0.75, xp 0); B earned 20 gold + 10 xp meanwhile.
  // The death's loss must survive -- the peer must not resurrect the gold.
  const b = ch({xp:100, gold:100});
  const l = ch({xp:0,   gold:75,  updatedAt:2000});
  const r = ch({xp:110, gold:120, updatedAt:2000});
  const m = Q.merge(sub(b), sub(l), sub(r), 2000, 2000, DEV_A, DEV_B);
  assertEq('K3-G3 a death on one device does not resurrect gold', m.char.gold, 95);
  assertEq('K3-G4 the death xp loss survives too', m.char.xp, 10);
})();

// ---------------------------------------------------------------------------
// K3-H: the level curve copied into sync.js must match app.js's xpToLevel, and
// total<->(lvl,xp) must round-trip on gainXp's own boundary.
// ---------------------------------------------------------------------------
(function(){
  const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  const xpFn = extractFunction(appSrc, /^function xpToLevel\(lvl\)\{/, 'xpToLevel');
  const box = {}; vm.createContext(box); vm.runInContext(xpFn, box);
  if(typeof K3.xpNeed !== 'function'){ assert('K3-H1 sync.js exposes the level curve', false); return; }
  let same = true;
  for(let lv = 1; lv <= 60; lv++){ if(box.xpToLevel(lv) !== K3.xpNeed(lv)) same = false; }
  assert('K3-H1 sync.js level curve matches app.js xpToLevel for levels 1-60', same);
  let trip = true;
  [0, 1, 149, 150, 151, 999, 5000, 50000].forEach(function(t){
    const c = K3.charFromTotalXp(t);
    if(K3.charTotalXp(c) !== t) trip = false;
    if(c.xp >= K3.xpNeed(c.lvl)) trip = false; // must land canonical, like gainXp
  });
  assert('K3-H2 total <-> (lvl,xp) round-trips and lands canonical', trip);
})();

// ---------------------------------------------------------------------------
// K3-I: a non-canonical character (an imported total sitting in .xp) must be
// left on LWW rather than silently re-levelled.
// ---------------------------------------------------------------------------
(function(){
  const b = ch({lvl:14, xp:8300, gold:540});   // Habitica-imported shape: xp >> xpToLevel(14)
  const l = ch({lvl:14, xp:8360, gold:552, updatedAt:2000});
  const r = ch({lvl:14, xp:8340, gold:548, updatedAt:2000});
  const m = Q.merge(sub(b), sub(l), sub(r), 2000, 2000, DEV_A, DEV_B);
  assertEq('K3-I1 non-canonical char keeps its level', m.char.lvl, 14);
  assert('K3-I2 non-canonical char is not re-levelled or summed',
    (m.char.xp === 8360 || m.char.xp === 8340) && m.char.abs === undefined);
})();

// ---------------------------------------------------------------------------
// K3-J: charHistory day bucket is the LOCAL day (dayStampOf), not a UTC day.
// Two devices either side of local midnight used to fold two real days into one
// bucket and lose one. Uses local Date construction so it holds in any zone.
// ---------------------------------------------------------------------------
(function(){
  if(typeof Q.mergeDayArray !== 'function'){ assert('K3-J1 mergeDayArray exposed', false); return; }
  const late  = new Date(2026, 8, 11, 23, 30, 0).getTime(); // 2026-09-11 23:30 local
  const early = new Date(2026, 8, 12, 0, 30, 0).getTime();  // 2026-09-12 00:30 local
  const out = Q.mergeDayArray([{date: late, gold: 5}], [{date: early, gold: 9}]);
  assertEq('K3-J1 local midnight splits into two day buckets', out.length, 2);
  assert('K3-J2 both days keep their own numbers',
    out[0].gold === 5 && out[1].gold === 9);
})();

if(failures){ console.error(failures + ' earnings-accumulate assertion(s) FAILED'); process.exit(1); }
console.log('earnings-accumulate.test.js: all assertions passed');
