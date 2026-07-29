// auto-backup-boundary.test.js -- direct unit tests for _bkNextBoundary(tierKey, lastTs).
//
// WHY THIS FILE EXISTS (2026-07-29):
//   Before this file, NOTHING in the repo asserted _bkNextBoundary's return value,
//   even though it is the sole gate on whether a backup tier ever fires (one call
//   site: sync.js:1552). That blind spot let a total scheduler failure ship green:
//   the daily/weekly/monthly branches built their boundary from `new Date()` instead
//   of from `lastTs`, so the boundary was future-by-construction relative to the
//   same instant the caller compares against, and those three tiers could NEVER
//   fire under any value of lastTs. See
//   .kilo/plans/1785344033093-dropbox-cycling-backups-review.md (P1 / P1c).
//
// Tests:
//   B1: never-fired (lastTs=0) => 0, i.e. due now, for all four tiers
//   B2: fourHour => lastTs + 4h exactly
//   B3: daily, lastTs = yesterday 09:00 local => due now, == local midnight after lastTs
//   B4: daily, lastTs = today 00:30 local => NOT due (boundary in the future)
//   B5: weekly => a Monday at local 00:00, strictly after lastTs
//   B6: monthly => 1st of the following month at local 00:00, incl. December year-roll
//   B7: unknown tier => Infinity
//   B8: no same-instant re-fire: boundary > lastTs for every tier
//
// Run: node tests/auto-backup-boundary.test.js   (also run by `node tests/run.js`)
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');

const noop = function(){};
const inMemStore = {};

const sandbox = {
  window: {}, navigator: { onLine: true },
  document: { addEventListener: noop, getElementById: function(){ return null; },
    createElement: function(){ return { style:{}, appendChild: noop, setAttribute: noop, click: noop }; },
    body: { appendChild: noop, removeChild: noop } },
  localStorage: {
    getItem: function(key){ return inMemStore[key] || null; },
    setItem: function(key, val){ inMemStore[key] = val; },
    removeItem: function(key){ delete inMemStore[key]; },
    key: function(){ return null; }, length: 0
  },
  indexedDB: { open: function(){ return {}; } },
  setTimeout: function(fn){ return fn; },
  clearTimeout: noop, setInterval: function(){ return 0; }, clearInterval: noop,
  console: console, JSON: JSON, Math: Math, Date: Date, Map: Map, Set: Set, WeakSet: WeakSet,
  Array: Array, Object: Object, Number: Number, String: String, Boolean: Boolean, Promise: Promise,
  Infinity: Infinity, isNaN: isNaN, parseInt: parseInt, RegExp: RegExp,
  logEvent: noop, toast: noop, render: noop, esc: function(x){ return x; }, save: noop,
  uid: function(){ return 'test-uid'; },
  idbOpen: function(){ return Promise.resolve(null); }
};
sandbox.self = sandbox.window; sandbox.globalThis = sandbox;
sandbox.S = { prefs: {}, tasks: [], rewards: [], tags: [], devices: [], history: [],
  charHistory: [], monthlyBackups: [], deletions: [], lastCron: 0,
  an: { views: [], metrics: [] }, char: { name: 'Test', lvl: 1, updatedAt: 1000 } };

vm.createContext(sandbox);
try { vm.runInContext(src, sandbox); } catch(e) {}

if (typeof sandbox._bkNextBoundary !== 'function') {
  console.error('FAIL: _bkNextBoundary not found in sandbox');
  process.exit(1);
}
// NOTE: BK_TIERS is a top-level `const` in sync.js, so it lives in the script's
// lexical scope and is NOT exposed as sandbox.BK_TIERS (unlike function
// declarations such as _bkNextBoundary, which do become global properties).
// The 4h cadence is therefore asserted against a literal here; if BK_TIERS.fourHour
// .cadenceMs ever changes, B2 is the test that should be updated to match.
const FOURHOUR_CADENCE_MS = 4 * 3600e3;

const B = sandbox._bkNextBoundary;
const TIERS = ['fourHour', 'daily', 'weekly', 'monthly'];
const HOUR = 3600e3, DAY = 24 * HOUR;

let failures = 0;
function assert(desc, cond){
  if(cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

// Local-midnight helper mirroring the production intent: the first local midnight
// strictly after `ts`. Deliberately uses the same new Date(y,m,d) construction as
// sync.js so DST days behave identically in test and production.
function nextLocalMidnight(ts){
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
}

// =====================================================================
// B1: never-fired state is due immediately, for every tier.
// This encodes the 2026-07-29 decision to seed slot 0 on first enable
// rather than withhold backups until the next calendar boundary (the
// rejected `lastTs || Date.now()` variant would fail this for
// daily/weekly/monthly). See the plan doc, Resolved Question 1.
// =====================================================================
TIERS.forEach(function(t){
  assert('B1 (' + t + '): lastTs=0 is due now (boundary <= Date.now())', B(t, 0) <= Date.now());
});
assert('B1a: daily lastTs=0 returns exactly 0', B('daily', 0) === 0);
assert('B1b: weekly lastTs=0 returns exactly 0', B('weekly', 0) === 0);
assert('B1c: monthly lastTs=0 returns exactly 0', B('monthly', 0) === 0);

// =====================================================================
// B2: fourHour is pure arithmetic on lastTs (this branch was always correct).
// =====================================================================
{
  const T = Date.now() - 30 * 60000; // 30 min ago
  assert('B2: fourHour boundary == lastTs + 4h cadence',
    B('fourHour', T) === T + FOURHOUR_CADENCE_MS);
  assert('B2a: fourHour cadence is 4h', FOURHOUR_CADENCE_MS === 4 * HOUR);
  assert('B2b: fourHour 30min ago is NOT due', B('fourHour', T) > Date.now());
  const T2 = Date.now() - 5 * HOUR;
  assert('B2c: fourHour 5h ago IS due', B('fourHour', T2) <= Date.now());
}

// =====================================================================
// B3: daily, last fired yesterday morning -> due, and the boundary is the
// midnight that followed lastTs (NOT a midnight computed from "now").
// FAILS against the pre-fix sync.js, which returned tomorrow's midnight.
// =====================================================================
{
  const y = new Date();
  y.setDate(y.getDate() - 1);
  y.setHours(9, 0, 0, 0);
  const T = y.getTime();
  const got = B('daily', T);
  assert('B3: daily with lastTs=yesterday 09:00 IS due', got <= Date.now());
  assert('B3a: daily boundary == first local midnight after lastTs', got === nextLocalMidnight(T));
}

// =====================================================================
// B4: daily, already fired after today's midnight -> not due until tomorrow.
// Guards against the opposite failure mode (firing on every sync).
// =====================================================================
{
  const t = new Date();
  t.setHours(0, 30, 0, 0);
  const T = t.getTime();
  const got = B('daily', T);
  assert('B4: daily with lastTs=today 00:30 is NOT due', got > Date.now());
  assert('B4a: daily boundary is tomorrow local midnight', got === nextLocalMidnight(T));
}

// =====================================================================
// B5: weekly always lands on a Monday at local 00:00, strictly after lastTs.
// Checked across all 7 weekdays so the Monday-advance loop is exercised from
// every starting day (including a lastTs that is itself a Monday).
// =====================================================================
{
  const base = new Date(2026, 6, 1, 13, 0, 0, 0); // Wed 2026-07-01 13:00 local
  for(let i = 0; i < 7; i++){
    const T = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, 13, 0, 0, 0);
    const got = B('weekly', T.getTime());
    const d = new Date(got);
    assert('B5 (' + T.toDateString() + '): weekly boundary is a Monday',
      d.getDay() === 1);
    assert('B5a (' + T.toDateString() + '): weekly boundary is local 00:00',
      d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0);
    assert('B5b (' + T.toDateString() + '): weekly boundary is strictly after lastTs',
      got > T.getTime());
    assert('B5c (' + T.toDateString() + '): weekly boundary is within 7 days of lastTs',
      got - T.getTime() <= 7 * DAY + HOUR);
  }
}

// =====================================================================
// B6: monthly lands on the 1st of the FOLLOWING month at local 00:00,
// including the December -> January year roll (new Date(y, 12, 1) normalizes).
// =====================================================================
{
  const T = new Date(2026, 6, 15, 10, 0, 0, 0).getTime(); // 2026-07-15
  const got = new Date(B('monthly', T));
  assert('B6: monthly boundary is day 1', got.getDate() === 1);
  assert('B6a: monthly boundary is next month (Aug)', got.getMonth() === 7);
  assert('B6b: monthly boundary year unchanged mid-year', got.getFullYear() === 2026);
  assert('B6c: monthly boundary is local 00:00',
    got.getHours() === 0 && got.getMinutes() === 0 && got.getSeconds() === 0);

  const D = new Date(2026, 11, 20, 10, 0, 0, 0).getTime(); // 2026-12-20
  const rolled = new Date(B('monthly', D));
  assert('B6d: December lastTs rolls to January', rolled.getMonth() === 0);
  assert('B6e: December lastTs rolls the year to 2027', rolled.getFullYear() === 2027);
  assert('B6f: rolled boundary is day 1 at 00:00',
    rolled.getDate() === 1 && rolled.getHours() === 0);

  const old = new Date(2026, 0, 5, 10, 0, 0, 0).getTime(); // long past
  assert('B6g: monthly with a long-past lastTs IS due', B('monthly', old) <= Date.now());
}

// =====================================================================
// B7: unknown tier key must be un-schedulable, never accidentally due --
// including for lastTs=0, which is why the unknown-tier check must precede the
// never-fired short-circuit in _bkNextBoundary.
// =====================================================================
assert('B7: unknown tier returns Infinity', B('nonesuch', Date.now() - DAY) === Infinity);
assert('B7a: unknown tier returns Infinity even for lastTs=0', B('nonesuch', 0) === Infinity);

// =====================================================================
// B8: no same-instant re-fire. _bkFire persists lastTs = now (sync.js:1516);
// the boundary computed from that value must be strictly in the future, or the
// scheduler would re-fire on every subsequent sync in the same window.
// =====================================================================
{
  const now = Date.now();
  TIERS.forEach(function(t){
    assert('B8 (' + t + '): boundary from a just-fired lastTs is strictly later', B(t, now) > now);
  });
}

if(failures){
  console.error(failures + ' auto-backup-boundary assertion(s) FAILED');
  process.exit(1);
}
console.log('auto-backup-boundary.test.js: all assertions passed');
