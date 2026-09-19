// round3-charhistory-atomic.test.js
// Round-1 REVIEW-2026-09-18.md Part 2 finding 5: mergeDayArray folded every
// numeric field of a day row with an INDEPENDENT Math.max, so two devices'
// snapshots of the same local day were blended into a row that never existed on
// either device -- `lvl` from one paired with `xp` from another (a level/XP pair
// past that level's threshold), and a day on which the character LOST hp kept the
// pre-loss hp because max() preferred it.
//
// The rule now is ATOMIC: one whole row per day bucket wins, fields are never
// mixed. Winner order is progression first (`lvl`, then `xp`), then `date`. See
// the comment at mergeDayArray in sync.js for why progression outranks the clock.
//
// This file is the red gate for that change. Against pre-fix sync.js it fails.
//
// Run: node tests/round3-charhistory-atomic.test.js  (also run by tests/run.js)
const fs = require('fs'), path = require('path'), vm = require('vm');

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
if (!Q || typeof Q.mergeDayArray !== 'function') {
  console.error('FAIL: QuestaSync.mergeDayArray not found'); process.exit(1);
}

let failures = 0;
function assert(desc, cond){ if(cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }
function assertEq(desc, got, want){
  if(got === want) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc + ' -- got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; }
}
// The core invariant: a merged row must be byte-identical to one of the rows that
// went in. Anything else is a synthesised row. Key order is normalised because
// the fold clones with Object.assign and the two sides may list fields differently.
function canon(o){
  if(!o || typeof o !== 'object') return JSON.stringify(o);
  return JSON.stringify(Object.keys(o).sort().map(function(k){ return [k, o[k]]; }));
}
function assertIsOneOf(desc, got, candidates){
  const g = canon(got);
  const hit = candidates.some(function(c){ return canon(c) === g; });
  if(hit) console.log('[PASS] ' + desc);
  else {
    console.error('[FAIL] ' + desc + ' -- got ' + JSON.stringify(got) +
      ', want one of ' + JSON.stringify(candidates));
    failures++;
  }
}

// One local day, three instants inside it. Built with local Date parts so the
// bucket holds in every timezone (dayStampOf is LOCAL -- see daystamp.test.js K3).
const T08 = new Date(2026, 8, 11,  8, 0, 0).getTime();
const T09 = new Date(2026, 8, 11,  9, 0, 0).getTime();
const T22 = new Date(2026, 8, 11, 22, 0, 0).getTime();
const NEXT = new Date(2026, 8, 12,  9, 0, 0).getTime();

// =========================================================================
// W1 -- the reported HP loss. Same lvl and xp on both sides, so the tiebreak is
// the clock: the later snapshot is the one that saw the damage.
// =========================================================================
(function(){
  const a = [{date:T08, lvl:5, xp:90, hp:50, maxHp:50, mp:10, gold:100}];
  const b = [{date:T22, lvl:5, xp:90, hp:20, maxHp:50, mp:10, gold:100}];
  const r = Q.mergeDayArray(a, b);
  assertEq('W1a one day in, one row out', r.length, 1);
  assertEq('W1b the day HP loss survives (hp 20, not max 50)', r[0].hp, 20);
  assertIsOneOf('W1c the merged row is one of the two real rows', r[0], [a[0], b[0]]);
})();

// =========================================================================
// W2 -- the impossible character. A levelled up (lvl 6, xp reset to 10); B is
// still on lvl 5 with xp 95. max-per-field produced lvl 6 WITH xp 95.
// =========================================================================
(function(){
  const a = [{date:T08, lvl:6, xp:10, hp:60, maxHp:60, mp:12, gold:140}];
  const b = [{date:T22, lvl:5, xp:95, hp:40, maxHp:50, mp:10, gold:120}];
  const r = Q.mergeDayArray(a, b);
  assertEq('W2a one row out', r.length, 1);
  assertEq('W2b the higher level wins the whole row', r[0].lvl, 6);
  assertEq('W2c ...so xp is that row own 10, NOT the other row 95', r[0].xp, 10);
  assert('W2d ...and the lvl/xp pair is not a synthesised one',
    !(r[0].lvl === 6 && r[0].xp === 95));
  assertIsOneOf('W2e the merged row is one of the two real rows', r[0], [a[0], b[0]]);
})();

// =========================================================================
// W3 -- progression outranks the clock. B has the later stamp but A is further
// along; a device with a fast clock must not roll the character backwards.
// =========================================================================
(function(){
  const a = [{date:T08, lvl:7, xp:5,  hp:70, maxHp:70, mp:14, gold:200}];
  const b = [{date:T22, lvl:6, xp:99, hp:60, maxHp:60, mp:12, gold:190}];
  const r = Q.mergeDayArray(a, b);
  assertEq('W3a the further-along row wins despite the earlier stamp', r[0].lvl, 7);
  assertEq('W3b ...whole, so gold is 200', r[0].gold, 200);
  assertIsOneOf('W3c ...and it is a real row', r[0], [a[0], b[0]]);
})();

// =========================================================================
// W4 -- same level, xp decides, and it takes its own row with it.
// =========================================================================
(function(){
  const a = [{date:T22, lvl:5, xp:40, hp:50, maxHp:50, mp:10, gold:100}];
  const b = [{date:T08, lvl:5, xp:80, hp:30, maxHp:50, mp:10, gold:130}];
  const r = Q.mergeDayArray(a, b);
  assertEq('W4a higher xp wins at equal level', r[0].xp, 80);
  assertEq('W4b ...and brings its own hp', r[0].hp, 30);
  assertEq('W4c ...and its own gold, not the max', r[0].gold, 130);
})();

// =========================================================================
// W5 -- rows with no progression fields at all fall back to the clock.
// =========================================================================
(function(){
  const a = [{date:T08, gold:5,  streak:9}];
  const b = [{date:T09, gold:3,  streak:1}];
  const r = Q.mergeDayArray(a, b);
  assertEq('W5a later stamp wins when there is no lvl/xp to compare', r[0].gold, 3);
  assertEq('W5b ...whole, so streak is 1 and not the max 9', r[0].streak, 1);
  assertIsOneOf('W5c ...and it is a real row', r[0], [a[0], b[0]]);
})();

// =========================================================================
// W6 -- a partial row never donates a field to the winner. This is the specific
// shape that made blending tempting: one side simply records less.
// =========================================================================
(function(){
  const a = [{date:T22, lvl:5, xp:90}];
  const b = [{date:T08, lvl:5, xp:90, hp:33, maxHp:50, mp:10, gold:100}];
  const r = Q.mergeDayArray(a, b);
  assert('W6a the winner keeps exactly its own fields', r[0].hp === undefined);
  assertIsOneOf('W6b ...so the row is still one of the two real rows', r[0], [a[0], b[0]]);
})();

// =========================================================================
// W7 -- no regression: distinct local days still union and stay sorted.
// (daystamp M4 and earnings-accumulate K3-J cover the bucket rule itself.)
// =========================================================================
(function(){
  const a = [{date:T08, lvl:5, xp:10, gold:1}];
  const b = [{date:NEXT, lvl:5, xp:20, gold:2}];
  const r = Q.mergeDayArray(a, b);
  assertEq('W7a two local days -> two rows', r.length, 2);
  assert('W7b sorted by date ascending', r[0].date < r[1].date);
  assertEq('W7c day one keeps its own row', r[0].gold, 1);
  assertEq('W7d day two keeps its own row', r[1].gold, 2);
})();

// =========================================================================
// W8 -- no regression of round-2 R7b: malformed rows are skipped, not thrown on,
// and a malformed row must not be able to displace a good one.
// =========================================================================
(function(){
  let threw = null, r = null;
  try { r = Q.mergeDayArray([{date:T08, lvl:5, xp:10}, null, 'oops', 7], [undefined]); }
  catch(e){ threw = e; }
  assert('W8a malformed rows do not throw', threw === null);
  assertEq('W8b ...and the one good row survives alone', r && r.length, 1);
  assertEq('W8c ...intact', r && r[0] && r[0].xp, 10);
  assert('W8d null/undefined arrays still handled',
    Array.isArray(Q.mergeDayArray(null, null)));
})();

// =========================================================================
// W9 -- a full duplicate of the same row (the ordinary round-trip case) is a
// no-op and keeps the row exactly.
// =========================================================================
(function(){
  const row = {date:T09, lvl:5, xp:90, hp:50, maxHp:50, mp:10, gold:100};
  const r = Q.mergeDayArray([Object.assign({}, row)], [Object.assign({}, row)]);
  assertEq('W9a a round-tripped row collapses to one', r.length, 1);
  assertIsOneOf('W9b ...unchanged', r[0], [row]);
})();

console.log('\n--- round3-charhistory-atomic.test.js summary ---');
if (failures) { console.error(failures + ' assertion(s) FAILED'); process.exit(1); }
console.log('round3-charhistory-atomic.test.js: all assertions passed');
process.exit(0);
