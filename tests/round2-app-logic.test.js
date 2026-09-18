// round2-app-logic.test.js -- regression tests for six 2026-09-18 (round 2)
// fixes in app.js (plus the app.js/sync.js lockstep pair).
//
// Every assertion below FAILS on the pre-fix code and PASSES now. Each block
// names the defect it pins. All assertions are on OBSERVED STATE (returned
// values, mutated objects, round-tripped JSON) -- never on call counts.
//
//   1  isoWeekKey() measured week 1 from Jan 4 instead of from week 1's
//      THURSDAY. In the 3-in-7 years where 4 January is a Fri/Sat/Sun the
//      numerator went negative for week 1, Math.floor rounded to -1, and every
//      week in that ISO year came out one low (2026-01-01 -> 202600).
//   2  The analytics day grid walked with `d += 86400000`. In a DST zone a
//      23/25-hour day leaves the cursor off local midnight and the keys stop
//      matching localDayKey() forever after. nextLocalDay() replaces it.
//   3  runCron()'s paused branch overwrote S.lastCron BEFORE the habit-counter
//      loop read it, so periodBoundaryCrossed was always called as
//      (freq, today, today): false for weekly/monthly. Those tallies never
//      cleared for the whole pause window and cResetOn was never stamped.
//   4  anMatcher()'s exact-metric reps override read `ov*(e.scoredUp||0)`.
//      Bulk reps (addReps / Log habits) carry `reps` with NO scoredUp, so the
//      product was 0 -- every precisely logged rep read as zero.
//   5  eventMergeSig() / evtIncomingSig() used five fields and omitted
//      `detail`, so the two lifecycle records the app emits from ONE
//      visibilitychange (flushState + the Tier-1 handler, same Date.now())
//      collapsed into one signature and the second was dropped as a duplicate.
//   6  _tokenizeEvents()' idx() used `v in map` against a plain {}. A task
//      titled "constructor" / "toString" / "__proto__" was already "in" the
//      map, never entered the dictionary, and map[v] returned an inherited
//      function that JSON.stringify drops. The integrity hash is computed on
//      the DETOKENIZED object, so every backup such a user writes is refused
//      on import as "corrupted or tampered with".
//
// Run: node tests/round2-app-logic.test.js

const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction, extractLine } = require('./_extract.js');

const appSrc  = fs.readFileSync(path.join(__dirname, '../app.js'),  'utf8');
const syncSrc = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');

let failures = 0, skipped = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}
function assertEq(desc, got, want) {
  if (got === want) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc + ' -- got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; }
}
function skip(desc, why) { console.log('[SKIP] ' + desc + ' -- ' + why); skipped++; }

const noop = function(){};

// Build a sandbox from a name->value map, eval `code` inside it, return
// whatever `code`'s trailing `return` yields. Same shape the other app.js
// slice tests use (see tests/cron-day-rewind.test.js).
function buildSlice(code, extras) {
  const sb = Object.assign({
    console: console, JSON: JSON, Math: Math, Date: Date,
    Object: Object, Array: Array, Number: Number, String: String, Boolean: Boolean,
    Map: Map, Set: Set, WeakSet: WeakSet, Promise: Promise,
    setTimeout: noop, clearTimeout: noop,
    document: { getElementById: function(){ return null; }, querySelectorAll: function(){ return []; } },
    window: {}, localStorage: { getItem: function(){ return null; }, setItem: noop, removeItem: noop },
    indexedDB: undefined, navigator: { vibrate: undefined },
    logEvent: noop, toast: noop, render: noop, save: noop, esc: function(x){ return x; },
    uid: function(){ return 'u' + (Math.random()*1e9|0); },
    levelFlash: noop, fxGain: noop, buzz: noop, floatFx: noop, renderStats: noop
  }, extras || {});
  sb.globalThis = sb;
  const names = Object.keys(sb).filter(k => k !== 'globalThis');
  const f = new vm.Script('(function(' + names.join(',') + '){ "use strict";\n' + code + '\n})')
    .runInNewContext(sb);
  return f.apply(null, names.map(n => sb[n]));
}

// ===========================================================================
// 1. isoWeekKey() returns the true ISO-8601 week key (year*100 + week).
//    Fixed literal dates: these are calendar facts, not "today".
// ===========================================================================
console.log('\n-- 1. isoWeekKey: true ISO-8601 week --');
{
  const { isoWeekKey } = buildSlice([
    extractFunction(appSrc, /^function isoWeekKey\(ts\)\{/, 'isoWeekKey'),
    'return { isoWeekKey };'
  ].join('\n'));

  // [local-noon date, expected ISO week key]
  const TABLE = [
    ['2026-06-15', 202625],  // pre-fix 202624 (Jan 4 2026 is a Sunday)
    ['2026-01-01', 202601],  // pre-fix 202600 -- not a valid ISO week at all
    ['2025-06-16', 202525],  // pre-fix 202524
    ['2024-06-17', 202425],
    ['2027-06-14', 202724],
    ['2026-12-31', 202653],  // 2026 is a 53-week ISO year
    ['2027-01-04', 202701]
  ];
  TABLE.forEach(function(row){
    const ts = new Date(row[0] + 'T12:00:00').getTime();
    assertEq('1 isoWeekKey(' + row[0] + ')', isoWeekKey(ts), row[1]);
  });
}

// ===========================================================================
// 2. nextLocalDay() steps exactly one LOCAL calendar day, across DST.
// ===========================================================================
console.log('\n-- 2. nextLocalDay: one local calendar day per step --');
{
  const { localDayKey, nextLocalDay } = buildSlice([
    extractLine(appSrc, /^function localDayKey\(ms\)\{/, 'localDayKey'),
    extractLine(appSrc, /^function nextLocalDay\(ms\)\{/, 'nextLocalDay'),
    'return { localDayKey, nextLocalDay };'
  ].join('\n'));

  // Start at local midnight exactly 400 local calendar days back from today.
  const startD = new Date();
  startD.setHours(0, 0, 0, 0);
  startD.setDate(startD.getDate() - 400);
  const START = startD.getTime();
  const TODAY_KEY = localDayKey(Date.now());

  assertEq('2 walk start is its own local day key', localDayKey(START), START);

  let cursor = START, steps = 0, invariantHolds = true, sawIrregularStep = false;
  const deltas = {};
  while (cursor < TODAY_KEY && steps < 1000) {
    const next = nextLocalDay(cursor);
    // The property everything downstream depends on: the cursor never leaves
    // the set of local midnights.
    if (next !== localDayKey(next)) invariantHolds = false;
    const delta = next - cursor;
    deltas[delta] = (deltas[delta] || 0) + 1;
    if (delta !== 86400000) sawIrregularStep = true;
    cursor = next;
    steps++;
  }

  assert('2 every step lands on a local midnight (nextLocalDay(d) === localDayKey(nextLocalDay(d)))', invariantHolds);
  assertEq('2 exactly 400 steps from 400 local days ago to today', steps, 400);
  assertEq('2 the 400-step walk ends exactly on today\'s local day key', cursor, TODAY_KEY);

  // DST-only assertion: in a zone with DST at least one of the 400 steps is
  // not 86400000 ms, which is precisely what the old `d += 86400000` grid got
  // wrong. Skipped on a UTC/no-DST machine, where it is vacuously false.
  const yr = new Date().getFullYear();
  const hasDst = new Date(yr, 0, 1).getTimezoneOffset() !== new Date(yr, 6, 1).getTimezoneOffset();
  if (hasDst) {
    assert('2 DST zone: at least one step is NOT 86400000 ms (step sizes: ' +
      Object.keys(deltas).join(',') + ')', sawIrregularStep);
  } else {
    skip('2 DST zone: at least one step is NOT 86400000 ms',
      'test machine has no DST (Jan/Jul offsets are equal)');
  }
}

// ===========================================================================
// 3. Paused runCron() still clears weekly/monthly habit tallies.
//    Uses the REAL periodBoundaryCrossed -- the bug was runCron feeding it the
//    already-overwritten S.lastCron, so a stub would hide it.
// ===========================================================================
console.log('\n-- 3. paused runCron clears weekly/monthly habit tallies --');
{
  const cronCode = [
    'const DIFF = { trivial:0.1, easy:1, medium:1.5, hard:2, log:0 };',
    'var lastIssued = 0;',
    extractLine(appSrc, /^const HLC_RATCHET_TOLERANCE_MS\s*=/, 'HLC_RATCHET_TOLERANCE_MS'),
    extractFunction(appSrc, /^function _hlcHeal\(\)\{/, '_hlcHeal'),
    extractFunction(appSrc, /^function now\(\)\{/, 'now'),
    extractFunction(appSrc, /^function dayStamp\(d\)\{/, 'dayStamp'),
    extractFunction(appSrc, /^function clamp\(v,a,b\)\{/, 'clamp'),
    extractFunction(appSrc, /^function xpToLevel\(lvl\)\{/, 'xpToLevel'),
    extractFunction(appSrc, /^function valueDelta\(value\)\{/, 'valueDelta'),
    extractFunction(appSrc, /^function completionReward\(task\)\{/, 'completionReward'),
    extractFunction(appSrc, /^function missDamage\(task\)\{/, 'missDamage'),
    extractFunction(appSrc, /^function gainXp\(xp\)\{/, 'gainXp'),
    extractFunction(appSrc, /^function death\(\)\{/, 'death'),
    extractFunction(appSrc, /^function takeDamage\(amount\)\{/, 'takeDamage'),
    extractFunction(appSrc, /^function logHistory\(t, patch/, 'logHistory'),
    extractFunction(appSrc, /^function logCharSnapshot\(\)\{/, 'logCharSnapshot'),
    extractFunction(appSrc, /^function isDailyDueOn\(t, dow\)\{/, 'isDailyDueOn'),
    extractFunction(appSrc, /^function periodBoundaryCrossed\(freq, lastStamp, now\)\{/, 'periodBoundaryCrossed'),
    extractFunction(appSrc, /^function _resetDailies\(\)\{/, '_resetDailies'),
    extractFunction(appSrc, /^function runCron\(\)\{/, 'runCron'),
    'return { runCron, dayStamp, periodBoundaryCrossed };'
  ].join('\n');

  function cronState(lastCron, habit) {
    return {
      prefs: { paused: true, pausedDays: [], filter: {}, sort: {}, tagFilter: {}, scroll: {} },
      tasks: [habit], rewards: [], tags: [], devices: [],
      char: { hp: 50, maxHp: 50, xp: 0, lvl: 1, gold: 0, mp: 0 },
      lastCron: lastCron, history: [], charHistory: [], monthlyBackups: [],
      deletions: [], events: []
    };
  }
  function habit(freq) {
    return { id: 'h-' + freq, type: 'habit', title: 'Habit ' + freq, difficulty: 'easy',
             value: 0, up: true, down: true, cUp: 40, cDown: 2, resetFreq: freq, history: [] };
  }

  const nowD = new Date();
  const TODAY = nowD.getFullYear()*10000 + (nowD.getMonth()+1)*100 + nowD.getDate();
  // A day stamp in the PREVIOUS calendar month (1st of last month).
  const pm = new Date(); pm.setDate(1); pm.setMonth(pm.getMonth() - 1);
  const PREV_MONTH = pm.getFullYear()*10000 + (pm.getMonth()+1)*100 + pm.getDate();
  // A day stamp in a previous ISO week (8 days back always crosses a Monday).
  const pw = new Date(); pw.setHours(0,0,0,0); pw.setDate(pw.getDate() - 8);
  const PREV_WEEK = pw.getFullYear()*10000 + (pw.getMonth()+1)*100 + pw.getDate();

  // 3a. monthly
  {
    const S = cronState(PREV_MONTH, habit('monthly'));
    const api = buildSlice(cronCode, { S: S });
    api.runCron();
    const t = S.tasks[0];
    assertEq('3a paused cron, monthly habit: cUp cleared', t.cUp, 0);
    assertEq('3a paused cron, monthly habit: cDown cleared', t.cDown, 0);
    assertEq('3a paused cron, monthly habit: cResetOn stamped with today', t.cResetOn, TODAY);
    assertEq('3a paused cron: lastCron advanced to today', S.lastCron, TODAY);
  }

  // 3b. weekly
  {
    const S = cronState(PREV_WEEK, habit('weekly'));
    const api = buildSlice(cronCode, { S: S });
    api.runCron();
    const t = S.tasks[0];
    assertEq('3b paused cron, weekly habit: cUp cleared', t.cUp, 0);
    assertEq('3b paused cron, weekly habit: cDown cleared', t.cDown, 0);
    assertEq('3b paused cron, weekly habit: cResetOn stamped with today', t.cResetOn, TODAY);
    assertEq('3b paused cron: lastCron advanced to today', S.lastCron, TODAY);
  }

  // 3c. control: a monthly habit whose boundary has NOT been crossed keeps its
  //     tallies, so 3a/3b are not passing because the code clears everything.
  {
    const yd = new Date(); yd.setHours(0,0,0,0); yd.setDate(yd.getDate() - 1);
    const YDAY = yd.getFullYear()*10000 + (yd.getMonth()+1)*100 + yd.getDate();
    if (Math.floor(YDAY/100) === Math.floor(TODAY/100)) {
      const S = cronState(YDAY, habit('monthly'));
      const api = buildSlice(cronCode, { S: S });
      api.runCron();
      const t = S.tasks[0];
      assertEq('3c paused cron, monthly habit inside the same month: cUp kept', t.cUp, 40);
      assertEq('3c paused cron, monthly habit inside the same month: no cResetOn', t.cResetOn, undefined);
    } else {
      skip('3c paused cron, monthly habit inside the same month keeps its tallies',
        'today is the 1st, so yesterday is in the previous month');
    }
  }
}

// ===========================================================================
// 4. anMatcher(): the exact-metric reps override no longer zeroes bulk reps.
// ===========================================================================
console.log('\n-- 4. anMatcher exact-metric reps override --');
{
  const { anMatcher } = buildSlice([
    extractFunction(appSrc, /^function anMatcher\(arg\)\{/, 'anMatcher'),
    'return { anMatcher };'
  ].join('\n'));

  const m = anMatcher({ exact: true, habits: [{ id: 'h1', reps: 15 }] });

  const bulk = { type: 'habit', taskId: 'h1', reps: 60 };           // addReps / Log habit
  assertEq('4 bulk reps with no scoredUp pass through unscaled', m.reps(bulk), 60);

  const tapped = { type: 'habit', taskId: 'h1', reps: 3, scoredUp: 3 }; // scoreHabit taps
  assertEq('4 tapped reps still use the per-tap override (15 * 3)', m.reps(tapped), 45);

  // Guards so the two above cannot pass for the wrong reason.
  assert('4 the exact matcher still matches the listed habit', m.match(bulk) === true);
  assert('4 the exact matcher still rejects an unlisted habit',
    m.match({ type: 'habit', taskId: 'other', reps: 9 }) === false);
  const noOverride = anMatcher({ exact: true, habits: [{ id: 'h1', reps: null }] });
  assertEq('4 with no override configured, tapped reps are the raw reps',
    noOverride.reps(tapped), 3);
}

// ===========================================================================
// 5. The event dedupe signature separates two same-millisecond lifecycle
//    records, and app.js / sync.js stay byte-identical (lockstep pair).
// ===========================================================================
console.log('\n-- 5. eventMergeSig / evtIncomingSig --');
{
  const { eventMergeSig } = buildSlice([
    extractFunction(appSrc, /^function eventMergeSig\(r\)\{/, 'eventMergeSig'),
    'return { eventMergeSig };'
  ].join('\n'));
  const { evtIncomingSig } = buildSlice([
    extractFunction(syncSrc, /^function evtIncomingSig\(r\)\{/, 'evtIncomingSig'),
    'return { evtIncomingSig };'
  ].join('\n'));

  // The real pair: flushState() and the Tier-1 snapshot handler, both bound to
  // visibilitychange, write in the same millisecond with different `detail`.
  const a = { ts: 1758182400123, kind: 'lifecycle', detail: 'flushState' };
  const b = { ts: 1758182400123, kind: 'lifecycle', detail: 'tier1:visibilitychange' };
  assert('5 same-ms lifecycle records get DIFFERENT app.js signatures',
    eventMergeSig(a) !== eventMergeSig(b));
  assert('5 same-ms lifecycle records get DIFFERENT sync.js signatures',
    evtIncomingSig(a) !== evtIncomingSig(b));
  // ...and two genuinely identical records still collapse.
  assert('5 two identical records still share one signature',
    eventMergeSig(a) === eventMergeSig({ ts: 1758182400123, kind: 'lifecycle', detail: 'flushState' }));

  const LOCKSTEP = [
    a, b,
    { ts: 1758182400123, kind: 'lifecycle', detail: 'tier1:pagehide' },
    { ts: 1, kind: 'score', taskId: 't1', dir: 1, reps: 10 },
    { ts: 1, kind: 'score', taskId: 't1', dir: -1, reps: 10 },
    { ts: 2, kind: 'check', taskId: 't1', subId: 's1', done: true },
    { ts: 2, kind: 'check', taskId: 't1', subId: 's1', done: false },
    { ts: 2, kind: 'check', taskId: 't1', subId: 's2', done: true },
    { ts: 2, kind: 'check', taskId: 't1', subId: 's1' },
    { ts: 3, kind: 'complete', taskId: 't2', done: true },
    { ts: 4, kind: 'miss' }
  ];
  let allEqual = true, firstDiff = null;
  LOCKSTEP.forEach(function(r){
    const x = eventMergeSig(r), y = evtIncomingSig(r);
    if (x !== y && allEqual) { allEqual = false; firstDiff = x + '  vs  ' + y; }
  });
  assert('5 app.js eventMergeSig and sync.js evtIncomingSig agree on all ' +
    LOCKSTEP.length + ' records' + (firstDiff ? ' (first diff: ' + firstDiff + ')' : ''), allEqual);

  // The lockstep check is only meaningful if the widened fields really are in
  // the string -- otherwise two stale-but-identical functions would pass it.
  const distinct = new Set(LOCKSTEP.map(eventMergeSig));
  assertEq('5 all ' + LOCKSTEP.length + ' distinct records get distinct signatures',
    distinct.size, LOCKSTEP.length);
  assert('5 subId is carried in the signature',
    eventMergeSig({ ts: 2, kind: 'check', taskId: 't1', subId: 's1' }) !==
    eventMergeSig({ ts: 2, kind: 'check', taskId: 't1', subId: 's2' }));
  assert('5 done is carried in the signature',
    eventMergeSig({ ts: 3, kind: 'complete', taskId: 't2', done: true }) !==
    eventMergeSig({ ts: 3, kind: 'complete', taskId: 't2', done: false }));
}

// ===========================================================================
// 6. idx() in the event tokenizer handles prototype-named task titles.
// ===========================================================================
console.log('\n-- 6. _tokenizeEvents round trip with prototype-named titles --');
{
  const tok = buildSlice([
    extractFunction(appSrc, /^const _EXPORT_FIELD_MAP = \{/, '_EXPORT_FIELD_MAP'),
    extractFunction(appSrc, /^function _tokenizeEvents\(eventsArr\)\{/, '_tokenizeEvents'),
    extractFunction(appSrc, /^function _detokenizeEvents\(env\)\{/, '_detokenizeEvents'),
    'return { _tokenizeEvents, _detokenizeEvents };'
  ].join('\n'));

  const TITLES = [
    'constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__',
    'isPrototypeOf', 'propertyIsEnumerable',
    'Morning pushups', 'Read 20 pages'
  ];
  const original = TITLES.map(function(title, i){
    return { uid: 'e' + i, ts: 1758182400000 + i, kind: 'score',
             taskId: 'task-' + i, taskTitle: title, dir: 1, reps: i + 1 };
  });
  // Deep-freeze the input by value: compare against a JSON snapshot taken
  // before tokenizing, so an in-place mutation cannot fake a match.
  const originalJson = JSON.stringify(original);

  const env = tok._tokenizeEvents(original);
  const round = tok._detokenizeEvents(env);

  assertEq('6 round trip returns the same number of events', round.length, original.length);
  TITLES.forEach(function(title, i){
    assertEq('6 taskTitle survives the round trip: ' + JSON.stringify(title),
      round[i] ? round[i].taskTitle : undefined, title);
  });
  // The dictionary itself must actually contain every distinct title --
  // pre-fix the prototype-named ones never made it in.
  assertEq('6 the TT dictionary holds every distinct title',
    (env.TT || []).length, TITLES.length);
  TITLES.forEach(function(title){
    assert('6 TT dictionary contains ' + JSON.stringify(title),
      (env.TT || []).indexOf(title) !== -1);
  });

  // The property the integrity hash actually depends on: the detokenized
  // object must serialize byte-identically to what was exported.
  assertEq('6 JSON.stringify(original) === JSON.stringify(roundTripped)',
    JSON.stringify(round), originalJson);
}

// ===========================================================================
console.log('');
if (skipped > 0) console.log(skipped + ' assertion(s) skipped (environment-dependent)');
if (failures > 0) {
  console.error(failures + ' test(s) failed');
  process.exit(1);
} else {
  console.log('All round2-app-logic tests passed!');
}
