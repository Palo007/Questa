// cron-day-rewind.test.js -- regression tests for the 2026-09-18 review wave.
//
// Three bugs, all in the daily-rollover path, all fixed in the same edit:
//
//   R1  runCron gated on `S.lastCron === today`. dayStamp() returns a sortable
//       YYYYMMDD int precisely so "have we crossed this boundary?" is an ORDERING
//       question, and the device-local calendar day really can move BACKWARDS
//       (westward travel across a date line, a user correcting a wrong clock, a
//       pre-NTP boot clock that read ahead and then snapped back). With `===` the
//       rewind was "not equal", so the whole body ran: _resetDailies() cleared the
//       current day's real completions and checklist ticks, and S.lastCron was
//       written BACKWARDS -- so when the day returned, cron ran a second time for
//       it, applied miss damage and zeroed the streak. sync.js:1374-1390 hardened
//       mergedLastCron against exactly this hazard; runCron never was.
//
//   R2  The paused branch early-returned before the habit-counter loop, so the
//       "Today +/-" tallies (t.cUp/t.cDown) never cleared on their reset boundary
//       for the whole pause window. Pause is documented (and tested, see
//       pause-tracking.test.js) as freezing STREAKS and MISS DAMAGE only.
//
//   R3  uncompleteDaily decremented the streak while paused, although completeTask
//       gates the matching increment on !paused. Ticking and un-ticking a daily
//       during a pause therefore bled one streak day per cycle.
//
// Run: node tests/cron-day-rewind.test.js  (also run by node tests/run.js)

const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction, extractLine } = require('./_extract.js');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}
function assertEq(desc, got, want) {
  if (got === want) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc + ' -- got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; }
}

// ---------------------------------------------------------------------------
// Live-code slice. Anchored on declaration text (tests/_extract.js), not line
// numbers, so it survives insertions elsewhere in app.js -- see AGENTS.md §4.
// ---------------------------------------------------------------------------
const code = [
  'const DIFF = { trivial:0.1, easy:1, medium:1.5, hard:2, log:0 };',
  'var lastIssued = 0;',   // app.js module-level HLC cursor that now()/_hlcHeal read
  extractLine(appSrc, /^const HLC_RATCHET_TOLERANCE_MS\s*=/, 'HLC_RATCHET_TOLERANCE_MS'),
  extractFunction(appSrc, /^function _hlcHeal\(\)\{/, '_hlcHeal'),
  extractFunction(appSrc, /^function now\(\)\{/, 'now'),
  extractFunction(appSrc, /^function dayStamp\(d\)\{/, 'dayStamp'),
  extractFunction(appSrc, /^function localDayDateAtOffset\(baseMs, dayOffset\)\{/, 'localDayDateAtOffset'),
  extractFunction(appSrc, /^function clamp\(v,a,b\)\{/, 'clamp'),
  extractFunction(appSrc, /^function xpToLevel\(lvl\)\{/, 'xpToLevel'),
  extractFunction(appSrc, /^function valueDelta\(value\)\{/, 'valueDelta'),
  extractFunction(appSrc, /^function completionReward\(task\)\{/, 'completionReward'),
  extractFunction(appSrc, /^function missDamage\(task\)\{/, 'missDamage'),
  extractFunction(appSrc, /^function gainXp\(xp\)\{/, 'gainXp'),
  extractFunction(appSrc, /^function death\(\)\{/, 'death'),
  extractFunction(appSrc, /^function takeDamage\(amount\)\{/, 'takeDamage'),
  // 2026-09-18 (round 2): logHistory gained an optional third parameter, atMs, so
  // runCron can stamp yesterday's miss on yesterday instead of today. Anchor on the
  // first two parameters only, so an added optional argument does not break the
  // extraction again.
  extractFunction(appSrc, /^function logHistory\(t, patch/, 'logHistory'),
  extractFunction(appSrc, /^function logCharSnapshot\(\)\{/, 'logCharSnapshot'),
  extractFunction(appSrc, /^function isDailyDueOn\(t, dow\)\{/, 'isDailyDueOn'),
  extractFunction(appSrc, /^function periodBoundaryCrossed\(freq, lastStamp, now\)\{/, 'periodBoundaryCrossed'),
  extractFunction(appSrc, /^function _resetDailies\(\)\{/, '_resetDailies'),
  extractFunction(appSrc, /^function runCron\(\)\{/, 'runCron'),
  extractFunction(appSrc, /^function reverseGrant\(t\)\{/, 'reverseGrant'),
  extractFunction(appSrc, /^function unlogToday\(t\)\{/, 'unlogToday'),
  extractFunction(appSrc, /^function uncompleteDaily\(t\)\{/, 'uncompleteDaily'),
  extractFunction(appSrc, /^function missedYesterdayDailies\(\)\{/, 'missedYesterdayDailies'),
  'return { runCron, uncompleteDaily, missedYesterdayDailies, dayStamp, periodBoundaryCrossed, isDailyDueOn };'
].join('\n');

// Fixed noon so the local calendar day is unambiguous in every timezone.
const BASE = Date.UTC(2026, 8, 18, 12, 0, 0);
let fakeNow = BASE;
class FakeDate extends Date {
  constructor(...args){ if (args.length === 0) super(fakeNow); else super(...args); }
  static now(){ return fakeNow; }
}
const ds = ms => { const d = new Date(ms); return d.getFullYear()*10000 + (d.getMonth()+1)*100 + d.getDate(); };
const DAY_X   = ds(BASE);
const DAY_Xm1 = ds(BASE - 86400000);
const DAY_Xp1 = ds(BASE + 86400000);

const noop = function(){};
function build(S){
  const sb = {
    S: S, Date: FakeDate, console: console, JSON: JSON, Math: Math,
    Object: Object, Array: Array, Number: Number, String: String, Boolean: Boolean,
    Map: Map, Set: Set, WeakSet: WeakSet, Promise: Promise,
    setTimeout: noop, clearTimeout: noop,
    document: { getElementById: function(){ return null; }, querySelectorAll: function(){ return []; } },
    window: {}, localStorage: { getItem: function(){ return null; }, setItem: noop, removeItem: noop },
    indexedDB: undefined, navigator: { vibrate: undefined },
    logEvent: noop, toast: noop, render: noop, save: noop, esc: function(x){ return x; },
    uid: function(){ return 'u' + (Math.random()*1e9|0); },
    levelFlash: noop, fxGain: noop, buzz: noop, floatFx: noop, renderStats: noop
  };
  sb.globalThis = sb;
  const names = Object.keys(sb).filter(k => k !== 'globalThis');
  const f = new vm.Script('(function(' + names.join(',') + '){ "use strict";\n' + code + '\n})')
    .runInNewContext(sb);
  return f.apply(null, names.map(n => sb[n]));
}

function daily(id, over){
  return Object.assign({ id:id, type:'daily', title:'Daily '+id, difficulty:'medium',
    value:0, streak:5, done:false, checklist:[], repeat:[1,1,1,1,1,1,1], history:[] }, over||{});
}
function habit(id, over){
  return Object.assign({ id:id, type:'habit', title:'Habit '+id, difficulty:'easy',
    value:0, up:true, down:true, cUp:7, cDown:3, resetFreq:'daily', history:[] }, over||{});
}
function freshState(over){
  return Object.assign({
    prefs: { paused:false, pausedDays:[] },
    tasks: [], rewards: [], tags: [], devices: [],
    char: { hp:50, maxHp:50, xp:0, lvl:1, gold:0, mp:0 },
    lastCron: 0, history: [], charHistory: [], deletions: []
  }, over||{});
}

// ===========================================================================
// R1 -- the day-rewind guard
// ===========================================================================
console.log('--- R1: runCron must be a no-op when the local day moves backwards ---');

{
  // Today's work is DONE and the streak is live. The device's calendar day then
  // rewinds by one (flight west / clock correction).
  const t = daily('t1', { done:true, streak:12, checklist:[{id:'c1',text:'a',done:true}] });
  const S = freshState({ tasks:[t], lastCron: DAY_X });
  const api = build(S);

  fakeNow = BASE - 86400000;            // local day is now X-1, i.e. BEHIND lastCron
  assert('R1 setup: the rewound day really is lower than lastCron', ds(fakeNow) < S.lastCron);
  api.runCron();

  assertEq('R1a today\'s completion survives the rewind', t.done, true);
  assertEq('R1b the checklist tick survives the rewind', t.checklist[0].done, true);
  assertEq('R1c the streak is untouched', t.streak, 12);
  assertEq('R1d lastCron is NOT written backwards', S.lastCron, DAY_X);
  assertEq('R1e no miss damage was charged', S.char.hp, 50);
  assert('R1f missedOn was not stamped', t.missedOn === undefined);
}

{
  // The rewind must not arm a second, damaging run when the day returns.
  const t = daily('t2', { done:true, streak:9 });
  const S = freshState({ tasks:[t], lastCron: DAY_X });
  const api = build(S);

  fakeNow = BASE - 86400000; api.runCron();   // rewind: no-op after the fix
  fakeNow = BASE;            api.runCron();   // day returns: still the same day
  assertEq('R1g returning to the same day still credits nothing as missed', t.streak, 9);
  assertEq('R1h ...and the completion is still intact', t.done, true);
  assertEq('R1i ...and no HP was lost', S.char.hp, 50);
}

{
  // Control: a genuine FORWARD boundary must still do all of its work, or the
  // fix would have simply disabled the daily reset.
  const done = daily('t3', { done:true, streak:4 });
  const miss = daily('t4', { done:false, streak:6 });
  const S = freshState({ tasks:[done, miss], lastCron: DAY_X });
  const api = build(S);

  fakeNow = BASE + 86400000;  // local day X+1
  api.runCron();

  assertEq('R1j forward boundary still resets the completed daily', done.done, false);
  assertEq('R1k forward boundary still zeroes the missed daily\'s streak', miss.streak, 0);
  assert('R1l forward boundary still charges miss damage', S.char.hp < 50);
  assertEq('R1m forward boundary still advances lastCron', S.lastCron, DAY_Xp1);
}

{
  // Same-day re-entry must remain a no-op (the original `===` behaviour).
  const t = daily('t5', { done:true, streak:3 });
  const S = freshState({ tasks:[t], lastCron: DAY_X });
  const api = build(S);
  fakeNow = BASE;
  api.runCron();
  assertEq('R1n same-day re-entry is still a no-op', t.done, true);
  assertEq('R1o ...and leaves the streak alone', t.streak, 3);
}

{
  // missedYesterdayDailies mirrors runCron's gates, so it must not offer a
  // yester-check on a rewound day either.
  const t = daily('t6', { done:false });
  const S = freshState({ tasks:[t], lastCron: DAY_X });
  const api = build(S);
  fakeNow = BASE - 86400000;
  assertEq('R1p missedYesterdayDailies offers nothing on a rewound day',
    api.missedYesterdayDailies().length, 0);
}

// ===========================================================================
// R2 -- paused must still clear the habit +/- tallies on their boundary
// ===========================================================================
console.log('--- R2: the paused branch must still reset habit counters ---');

{
  const h = habit('h1', { cUp:7, cDown:3 });
  const d = daily('d1', { done:true, streak:11 });
  const S = freshState({ tasks:[h, d], lastCron: DAY_X, prefs:{ paused:true, pausedDays:[] } });
  const api = build(S);

  fakeNow = BASE + 86400000;  // a real forward boundary, while paused
  assert('R2 setup: the daily boundary really was crossed',
    api.periodBoundaryCrossed('daily', DAY_X, new FakeDate()) === true);
  api.runCron();

  assertEq('R2a paused still clears cUp on the boundary', h.cUp, 0);
  assertEq('R2b paused still clears cDown on the boundary', h.cDown, 0);
  assertEq('R2c paused still resets the daily', d.done, false);
  assertEq('R2d paused still freezes the streak (unchanged)', d.streak, 11);
  assertEq('R2e paused still charges no miss damage', S.char.hp, 50);
  assert('R2f paused day was recorded', S.prefs.pausedDays.indexOf(DAY_Xp1) >= 0);
}

{
  // A habit whose reset period has NOT elapsed must keep its tally while paused.
  const h = habit('h2', { cUp:4, cDown:1, resetFreq:'weekly' });
  const S = freshState({ tasks:[h], lastCron: DAY_X, prefs:{ paused:true, pausedDays:[] } });
  const api = build(S);
  fakeNow = BASE + 86400000;
  api.runCron();
  assertEq('R2g a weekly habit keeps cUp across a single paused day', h.cUp, 4);
  assertEq('R2h ...and keeps cDown', h.cDown, 1);
}

// ===========================================================================
// R3 -- un-ticking while paused must not bleed the streak
// ===========================================================================
console.log('--- R3: uncompleteDaily must freeze the streak while paused ---');

{
  const t = daily('p1', { done:true, streak:3, _gr:{ xp:0, gold:0, mp:0, delta:0 } });
  const S = freshState({ tasks:[t], lastCron: DAY_X, prefs:{ paused:true, pausedDays:[] } });
  const api = build(S);
  fakeNow = BASE;

  api.uncompleteDaily(t);
  assertEq('R3a un-ticking while paused leaves the streak alone', t.streak, 3);
  assertEq('R3b ...and still clears done', t.done, false);

  // Three more tick/un-tick cycles must not erode it either.
  t.done = true; t._gr = { xp:0, gold:0, mp:0, delta:0 }; api.uncompleteDaily(t);
  t.done = true; t._gr = { xp:0, gold:0, mp:0, delta:0 }; api.uncompleteDaily(t);
  t.done = true; t._gr = { xp:0, gold:0, mp:0, delta:0 }; api.uncompleteDaily(t);
  assertEq('R3c three more paused toggles still leave the streak at 3', t.streak, 3);
}

{
  // Control: when NOT paused, un-ticking must still decrement, or the fix would
  // have broken the ordinary undo path.
  const t = daily('p2', { done:true, streak:3, _gr:{ xp:0, gold:0, mp:0, delta:0 } });
  const S = freshState({ tasks:[t], lastCron: DAY_X, prefs:{ paused:false, pausedDays:[] } });
  const api = build(S);
  fakeNow = BASE;
  api.uncompleteDaily(t);
  assertEq('R3d un-ticking while NOT paused still decrements the streak', t.streak, 2);
}

// ===========================================================================
// T4 (morning-rollover todo 4) -- remaining local-day boundaries.
// All cases use the fixed BASE/FakeDate fixture above; nothing here reads the
// machine's current weekday. Product code is unchanged (characterization).
// ===========================================================================
console.log('--- T4: forward-once, same-day, rewind, pause-coverage, retention, due-equivalence ---');

{
  // Forward rollover resets exactly ONCE: a second runCron on the new day is a
  // same-day no-op (no extra damage, no extra history point).
  const done = daily('f1', { done:true, streak:4 });
  const miss = daily('f2', { done:false, streak:6 });
  const S = freshState({ tasks:[done, miss], lastCron: DAY_X });
  const api = build(S);
  fakeNow = BASE + 86400000;
  api.runCron();
  const hpAfterFirst = S.char.hp;
  const missHistAfterFirst = miss.history.length;
  assert('T4a forward run charged exactly one boundary of damage', hpAfterFirst < 50);
  api.runCron(); // same-day re-entry: must be a no-op
  assertEq('T4b forward resets once: second run adds no HP damage', S.char.hp, hpAfterFirst);
  assertEq('T4c forward resets once: second run adds no history point', miss.history.length, missHistAfterFirst);
  assertEq('T4d forward resets once: lastCron stays on the new day', S.lastCron, DAY_Xp1);
  assertEq('T4e forward resets once: completed daily stays reset', done.done, false);
}

{
  // Same-day re-entry preserves completions, checklist ticks, and history.
  const t = daily('f3', { done:true, streak:3, checklist:[{id:'c1',text:'a',done:true}], history:[{date:BASE,value:1,completed:true}] });
  const S = freshState({ tasks:[t], lastCron: DAY_X });
  const api = build(S);
  fakeNow = BASE;
  api.runCron();
  assertEq('T4f same-day re-entry preserves done', t.done, true);
  assertEq('T4g same-day re-entry preserves the checklist tick', t.checklist[0].done, true);
  assertEq('T4h same-day re-entry preserves history length', t.history.length, 1);
  assertEq('T4i same-day re-entry leaves lastCron alone', S.lastCron, DAY_X);
}

{
  // Clock rewind preserves completions AND history (no miss point stamped).
  const t = daily('f4', { done:true, streak:12, history:[{date:BASE,value:1,completed:true}] });
  const S = freshState({ tasks:[t], lastCron: DAY_X });
  const api = build(S);
  fakeNow = BASE - 86400000;
  api.runCron();
  assertEq('T4j rewind preserves done', t.done, true);
  assertEq('T4k rewind preserves the streak', t.streak, 12);
  assertEq('T4l rewind stamps no history point', t.history.length, 1);
  assertEq('T4m rewind leaves lastCron alone', S.lastCron, DAY_X);
}

{
  // Paused-day COVERAGE while not paused: yesterdayStamp is in pausedDays, so
  // the boundary still advances and resets done flags, but no miss damage is
  // charged, the streak is kept, and missedOn is not stamped.
  const miss = daily('f5', { done:false, streak:6 });
  const done = daily('f6', { done:true, streak:4 });
  const S = freshState({ tasks:[miss, done], lastCron: DAY_X, prefs:{ paused:false, pausedDays:[DAY_X] } });
  const api = build(S);
  fakeNow = BASE + 86400000; // today X+1, yesterday X is pause-covered
  api.runCron();
  assertEq('T4n pause coverage suppresses miss damage', S.char.hp, 50);
  assertEq('T4o pause coverage keeps the missed daily streak', miss.streak, 6);
  assert('T4p pause coverage stamps no missedOn', miss.missedOn === undefined);
  assertEq('T4q pause coverage still resets done flags', done.done, false);
  assertEq('T4r pause coverage still advances lastCron', S.lastCron, DAY_Xp1);
}

{
  // The modal gate mirrors the same coverage: yesterday pause-covered means no
  // yester-check is offered even though the day boundary is still uncrossed.
  const t = daily('f7', { done:false });
  const S = freshState({ tasks:[t], lastCron: DAY_X, prefs:{ paused:false, pausedDays:[DAY_X] } });
  const api = build(S);
  fakeNow = BASE + 86400000;
  assertEq('T4s pause coverage offers no yester-check', api.missedYesterdayDailies().length, 0);
}

{
  // Seven-entry pausedDays retention (documented compatibility limit): the
  // array is bounded to the NEWEST seven entries; older stamps fall off.
  // Fixed YYYYMMDD ints -- no dependence on the machine date.
  const seeded = [20260801,20260802,20260803,20260804,20260805,20260806,20260807,20260808];
  const S = freshState({ tasks:[], lastCron: DAY_Xm1, prefs:{ paused:true, pausedDays:seeded.slice() } });
  const api = build(S);
  fakeNow = BASE; // today X (20260918) > lastCron, so the paused branch records it
  api.runCron();
  assertEq('T4t retention keeps exactly seven entries', S.prefs.pausedDays.length, 7);
  assert('T4u retention evicts the oldest stamp', S.prefs.pausedDays.indexOf(20260801) < 0);
  assert('T4v retention keeps the newest seven only (oldest survivor is 20260803)',
    S.prefs.pausedDays[0] === 20260803);
  assert('T4w retention records today as the newest entry',
    S.prefs.pausedDays[S.prefs.pausedDays.length - 1] === DAY_X);
}

{
  // Under the bound the list is stable: six seeded + today fill exactly seven.
  const seeded = [20260801,20260802,20260803,20260804,20260805,20260806];
  const S = freshState({ tasks:[], lastCron: DAY_Xm1, prefs:{ paused:true, pausedDays:seeded.slice() } });
  const api = build(S);
  fakeNow = BASE;
  api.runCron();
  assertEq('T4x under-bound list grows to exactly seven', S.prefs.pausedDays.length, 7);
  assert('T4y under-bound list keeps the oldest seed', S.prefs.pausedDays.indexOf(20260801) >= 0);
}

{
  // Due-weekday equivalence: the modal's yesterday expression
  //   (!t.repeat || t.repeat[(dow+6)%7])
  // must agree with isDailyDueOn(t, yesterdayDow) for every weekday, using
  // fixed FakeDate days only. Toggling the repeat entry FOR yesterday flips
  // the answer -- the assertion catches divergence instead of masking it.
  const S = freshState({ tasks:[] });
  const api = build(S);
  const shapes = function(yDow){
    const allTrue = [1,1,1,1,1,1,1];
    const allFalse = [0,0,0,0,0,0,0];
    const onlyY = [0,0,0,0,0,0,0]; onlyY[yDow] = 1;
    const notY = [1,1,1,1,1,1,1]; notY[yDow] = 0;
    return [
      ['legacy-undefined', undefined],
      ['all-due', allTrue],
      ['none-due', allFalse],
      ['only-yesterday', onlyY],
      ['all-but-yesterday', notY]
    ];
  };
  for (let i = 0; i < 7; i++){
    fakeNow = BASE + i * 86400000;
    const dow = new FakeDate().getDay();
    const yDow = (dow + 6) % 7;
    shapes(yDow).forEach(function(pair){
      const name = pair[0], repeat = pair[1];
      const t = { repeat: repeat };
      const modalExpr = !t.repeat || !!t.repeat[yDow];
      assertEq('T4z due-equivalence ' + name + ' on fixed day +' + i + 'd',
        modalExpr, api.isDailyDueOn(t, yDow));
    });
  }
}

{
  // End-to-end: missedYesterdayDailies offers exactly the undone dailies that
  // were due yesterday (fixed FakeDate day; lastCron one stamp behind today).
  const S = freshState({ tasks:[], lastCron: 0, prefs:{ paused:false, pausedDays:[] } });
  const api = build(S);
  fakeNow = BASE + 3 * 86400000;
  const todayStamp = ds(fakeNow);
  S.lastCron = todayStamp - 1; // numerically behind today: boundary uncrossed
  const yDow = (new FakeDate().getDay() + 6) % 7;
  const dueUndone = daily('f8', { done:false, repeat:[1,1,1,1,1,1,1] });
  const notDueUndone = daily('f9', { done:false, repeat:[1,1,1,1,1,1,1] });
  notDueUndone.repeat[yDow] = 0; // toggled for yesterday: NOT due yesterday
  const dueDone = daily('f10', { done:true, repeat:[1,1,1,1,1,1,1] });
  S.tasks = [dueUndone, notDueUndone, dueDone];
  const missed = api.missedYesterdayDailies();
  assertEq('T4aa yester-check offers the due-and-unticked daily', missed.indexOf(dueUndone) >= 0, true);
  assertEq('T4ab yester-check skips the daily toggled off for yesterday', missed.indexOf(notDueUndone) >= 0, false);
  assertEq('T4ac yester-check skips the already-ticked daily', missed.indexOf(dueDone) >= 0, false);
}

// ===========================================================================
if (failures) { console.error('\n' + failures + ' cron-day-rewind assertion(s) FAILED'); process.exit(1); }
console.log('\nAll cron-day-rewind tests passed!');
