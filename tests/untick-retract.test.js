// untick-retract.test.js -- CR-PWA-004 (RE-PWA-021 quirks a + b).
//
// An un-tick must retract the WHOLE completion record:
//
//   a) uncompleteTodo deletes t.completedAt. Before: the stamp survived, so the
//      analytics todo fallback `!any && t.completedAt` (anSourceEvents, source
//      'completed', app.js:4428) still counted a reverted todo.
//
//   b) unlogToday no longer gates on the point being dated the current UTC day
//      (floor(ms/86400000)). Before: an un-tick after 00:00 UTC -- while still the
//      SAME local day on a UTC+2 device (complete ~00:30 local = 22:30 UTC, un-tick
//      ~02:30 local = 00:30 UTC) -- left the point completed:true although
//      reverseGrant/streak/doneAt had already run; reachable cross-day un-ticks
//      (todos never reset) did the same. Pop-vs-keep is unchanged: only a point
//      THIS completion created (_histCreated, no scoredUp/scoredDown) is popped; a
//      merged point stays (completed:false, value restored, reward dropped).
//
// The next-day / cross-UTC-midnight / completedAt cases fail against the unfixed
// app.js and pass after the fix (red run captured in .cline/evidence/).
//
// Run: node tests/untick-retract.test.js   (also run by node tests/run.js)

const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction } = require('./_extract.js');

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
// Live-code slice (anchor-based, tests/_extract.js -- survives line shifts).
// ---------------------------------------------------------------------------
const code = [
  extractFunction(appSrc, /^function clamp\(v,a,b\)\{/, 'clamp'),
  extractFunction(appSrc, /^function valueDelta\(value\)\{/, 'valueDelta'),
  extractFunction(appSrc, /^function reverseGrant\(t\)\{/, 'reverseGrant'),
  extractFunction(appSrc, /^function unlogToday\(t\)\{/, 'unlogToday'),
  extractFunction(appSrc, /^function uncompleteDaily\(t\)\{/, 'uncompleteDaily'),
  extractFunction(appSrc, /^function uncompleteTodo\(t\)\{/, 'uncompleteTodo'),
  extractFunction(appSrc, /^function anViewItems\(v\)\{/, 'anViewItems'),
  extractFunction(appSrc, /^function anSourceEvents\(v\)\{/, 'anSourceEvents'),
  'return { unlogToday, uncompleteDaily, uncompleteTodo, anSourceEvents };'
].join('\n');

// Controllable clock: FakeDate answers Date.now()/new Date() with fakeNow.
let fakeNow = 0;
class FakeDate extends Date {
  constructor(...args){ if (args.length === 0) super(fakeNow); else super(...args); }
  static now(){ return fakeNow; }
}
const noop = function(){};

function build(S, capEvents) {
  const sb = {
    S: S, Date: FakeDate, console: console, JSON: JSON, Math: Math,
    Object: Object, Array: Array, Number: Number, String: String, Boolean: Boolean,
    setTimeout: noop, clearTimeout: noop,
    document: { getElementById: function(){ return null; }, querySelectorAll: function(){ return []; } },
    window: {}, localStorage: { getItem: function(){ return null; }, setItem: noop, removeItem: noop },
    indexedDB: undefined, navigator: { vibrate: undefined },
    logEvent: function(e){ capEvents.push(e); },
    toast: noop, render: noop, save: noop,
    now: function(){ return fakeNow; }
  };
  sb.globalThis = sb;
  const names = Object.keys(sb).filter(function(k){ return k !== 'globalThis'; });
  const f = new vm.Script('(function(' + names.join(',') + '){ "use strict";\n' + code + '\n})')
    .runInNewContext(sb);
  return f.apply(null, names.map(function(n){ return sb[n]; }));
}

// Fixed local-noon base: the calendar day is unambiguous in every timezone.
const BASE = new Date(2026, 9, 16, 12, 0, 0).getTime(); // 2026-10-16 12:00 LOCAL
const DAY = 86400000;
const ALL7 = [1,1,1,1,1,1,1];
const ds = function(ms){ const d = new Date(ms); return d.getFullYear()*10000 + (d.getMonth()+1)*100 + d.getDate(); };

function freshState() {
  return { prefs: { paused:false, pausedDays:[] }, tasks: [],
           char: { xp:100, gold:50, mp:5, hp:50, maxHp:50, lvl:2 } };
}
function todo(id, over) {
  return Object.assign({ id:id, type:'todo', title:'Todo '+id, difficulty:'easy', value:0, done:false, history:[] }, over || {});
}
function daily(id, over) {
  return Object.assign({ id:id, type:'daily', title:'Daily '+id, difficulty:'medium', value:0, streak:0, done:false, checklist:[], repeat:ALL7.slice(), history:[] }, over || {});
}

// ===========================================================================
// T1 -- same-day todo un-tick: completedAt must go (quirk a); the point is kept
// (todos never stamp _histCreated), completed:false, value restored, reward gone.
// ===========================================================================
console.log('--- T1: same-day todo un-tick retracts completedAt ---');
{
  fakeNow = BASE;
  const t = todo('td1', { done:true, value:7, completedAt:BASE, doneAt:BASE, doneDay:ds(BASE),
    _gr:{ xp:10, gold:2, mp:1, delta:2 },
    history:[{ date:BASE, value:7, completed:true, reward:{ xp:10, gold:2, mp:1 } }] });
  const S = freshState();
  S.tasks = [t];
  const cap = [];
  const api = build(S, cap);
  api.uncompleteTodo(t);
  assert('T1a completedAt is removed (quirk a)', !('completedAt' in t));
  assertEq('T1b done cleared', t.done, false);
  assert('T1c doneAt retracted', !('doneAt' in t));
  assert('T1d doneDay retracted', !('doneDay' in t));
  assertEq('T1e todo points are never popped (no _histCreated)', t.history.length, 1);
  assertEq('T1f point completed=false', t.history[0].completed, false);
  assert('T1g reward dropped from the kept point', !('reward' in t.history[0]));
  assertEq('T1h point value restored to the clawed-back task value', t.history[0].value, 5);
  assertEq('T1i xp clawed back', S.char.xp, 90);
  assertEq('T1j uncomplete event logged', cap.length, 1);
  assertEq('T1k event carries the clawback', cap[0] && cap[0].clawback && cap[0].clawback.xp, 10);
  assertEq('T1l updatedAt stamped', t.updatedAt, fakeNow);
}

// ===========================================================================
// T2 -- NEXT-DAY todo un-tick (quirk b): the point retracts too. Todos never
// reset at day rollover, so this path is reachable in the wild.
// ===========================================================================
console.log('--- T2: next-day todo un-tick retracts point + completedAt ---');
{
  fakeNow = BASE;
  const t = todo('td2', { done:true, value:7, completedAt:BASE, doneAt:BASE, doneDay:ds(BASE),
    _gr:{ xp:10, gold:2, mp:1, delta:2 },
    history:[{ date:BASE, value:7, completed:true, reward:{ xp:10, gold:2, mp:1 } }] });
  const S = freshState();
  S.tasks = [t];
  const api = build(S, []);
  fakeNow = BASE + DAY + 300000; // the NEXT day, 5 minutes in
  api.uncompleteTodo(t);
  assertEq('T2a cross-day un-tick still clears done', t.done, false);
  assert('T2b cross-day un-tick removes completedAt', !('completedAt' in t));
  assertEq('T2c point retracted to completed:false on the NEXT day', t.history[0].completed, false);
  assert('T2d reward dropped', !('reward' in t.history[0]));
  assertEq('T2e xp still clawed back cross-day', S.char.xp, 90);
  assertEq('T2f point value restored cross-day', t.history[0].value, 5);
}

// ===========================================================================
// T3 -- NEXT-DAY daily whose completion CREATED the point: popped, _histCreated
// cleared, streak decremented, done gone. (CR-KT-020 fixture case 10 was the
// broken shape: it left everything in place.)
// ===========================================================================
console.log('--- T3: next-day daily un-tick pops a point this completion created ---');
{
  fakeNow = BASE;
  const t = daily('dl1', { done:true, value:3, streak:4, doneAt:BASE, doneDay:ds(BASE),
    _histCreated:true, _gr:{ xp:4, gold:1, mp:0, delta:1 },
    history:[{ date:BASE, value:4, completed:true, isDue:true, repeat:ALL7.slice(), reward:{ xp:4, gold:1, mp:0 } }] });
  const S = freshState();
  S.tasks = [t];
  const api = build(S, []);
  fakeNow = BASE + DAY;
  api.uncompleteDaily(t);
  assertEq('T3a the fresh point is popped on a next-day un-tick', t.history.length, 0);
  assert('T3b _histCreated cleared', t._histCreated === undefined);
  assertEq('T3c streak decremented', t.streak, 3);
  assertEq('T3d done cleared', t.done, false);
  assert('T3e doneAt/doneDay retracted', !('doneAt' in t) && !('doneDay' in t));
}

// ===========================================================================
// T4 -- NEXT-DAY daily over a MERGED point (cron miss base): the point is KEPT
// but the mark retracts -- completed:false, value restored, reward dropped --
// and _histCreated is cleared.
// ===========================================================================
console.log('--- T4: next-day un-tick keeps a merged point, retracts the mark ---');
{
  fakeNow = BASE;
  const t = daily('dl2', { done:true, value:2, streak:2, doneAt:BASE, doneDay:ds(BASE),
    _histCreated:false,
    _gr:{ xp:3, gold:0, mp:0, delta:1 },
    history:[{ date:BASE, value:2, completed:true, isDue:true, repeat:ALL7.slice(), reward:{ xp:3, gold:0, mp:0 } }] });
  const S = freshState();
  S.tasks = [t];
  const api = build(S, []);
  fakeNow = BASE + DAY + 300000;
  api.uncompleteDaily(t);
  assertEq('T4a the merged point is kept', t.history.length, 1);
  assertEq('T4b merged point completed=false', t.history[0].completed, false);
  assertEq('T4c merged point value restored to the clawed-back task value', t.history[0].value, 1);
  assert('T4d reward dropped from the kept point', !('reward' in t.history[0]));
  assert('T4e _histCreated cleared', t._histCreated === undefined);
}

// ===========================================================================
// T5 -- same-day pop REGRESSION guard: unchanged behaviour still pops the point
// this completion created, and clears _histCreated.
// ===========================================================================
console.log('--- T5: same-day daily un-tick still pops the fresh point ---');
{
  fakeNow = BASE;
  const t = daily('dl3', { done:true, value:3, streak:1, doneAt:BASE, doneDay:ds(BASE),
    _histCreated:true, _gr:{ xp:2, gold:0, mp:0, delta:1 },
    history:[{ date:BASE, value:4, completed:true, isDue:true, reward:{ xp:2, gold:0, mp:0 } }] });
  const S = freshState();
  S.tasks = [t];
  const api = build(S, []);
  api.uncompleteDaily(t);
  assertEq('T5a same-day pop still happens', t.history.length, 0);
  assert('T5b _histCreated still cleared', t._histCreated === undefined);
}

// ===========================================================================
// T6 -- the reported regression: un-tick across 00:00 UTC while still the SAME
// local day (UTC+2: complete 00:30 local = 22:30 UTC, un-tick 02:30 local =
// 00:30 UTC). The old UTC buckets differed, so the point stayed completed:true
// even though reverseGrant had already run. Deterministic in any machine TZ:
// the old code compared the two UTC days; the fixed code does no day math.
// ===========================================================================
console.log('--- T6: same LOCAL day across UTC midnight must retract ---');
{
  const ms1 = Date.UTC(2026, 9, 15, 22, 30, 0); // = 00:30 on Oct 16 in UTC+2
  const ms2 = Date.UTC(2026, 9, 16, 0, 30, 0);  // = 02:30 local, still Oct 16
  fakeNow = ms1;
  const t = todo('td3', { done:true, value:7, completedAt:ms1, doneAt:ms1, doneDay:ds(ms1),
    _gr:{ xp:10, gold:0, mp:0, delta:2 },
    history:[{ date:ms1, value:7, completed:true, reward:{ xp:10, gold:0, mp:0 } }] });
  const S = freshState();
  S.tasks = [t];
  const api = build(S, []);
  fakeNow = ms2;
  api.uncompleteTodo(t);
  assertEq('T6a the point is retracted (was: stuck completed:true past 00:00 UTC)', t.history[0].completed, false);
  assert('T6b completedAt is gone', !('completedAt' in t));
}

// ===========================================================================
// T7 -- end-to-end through the REAL analytics source (anSourceEvents):
// a reverted todo contributes no 'completed' events; a genuinely completed todo
// still contributes exactly one (its point).
// ===========================================================================
console.log('--- T7: a reverted todo stops counting in Analytics ---');
{
  fakeNow = BASE;
  const reverted = todo('td4', { done:true, value:2, completedAt:BASE, doneAt:BASE, doneDay:ds(BASE),
    _gr:{ xp:1, gold:0, mp:0, delta:1 },
    history:[{ date:BASE, value:2, completed:true, reward:{ xp:1, gold:0, mp:0 } }] });
  const genuine = todo('td5', { done:true, value:1, completedAt:BASE, doneAt:BASE,
    history:[{ date:BASE, value:1, completed:true, reward:{ xp:1, gold:0, mp:0 } }] });
  const S = freshState();
  S.tasks = [reverted, genuine];
  const api = build(S, []);
  assertEq('T7a sanity: both todos count before the un-tick', api.anSourceEvents({ source:'completed' }).length, 2);
  api.uncompleteTodo(reverted);
  const evs = api.anSourceEvents({ source:'completed' });
  assertEq('T7b after the un-tick only the genuine completion counts', evs.length, 1);
  assert('T7c ...and it is the genuine one', !!evs[0] && evs[0].item === genuine);
}

// ===========================================================================
// T8 -- no-history un-tick is safe: no throw; completedAt still retracted.
// ===========================================================================
console.log('--- T8: un-tick with no history is safe ---');
{
  fakeNow = BASE;
  const t = todo('td6', { done:true, completedAt:BASE, _gr:{ xp:0, gold:0, mp:0, delta:0 } });
  const S = freshState();
  S.tasks = [t];
  const api = build(S, []);
  let threw = false;
  try { api.uncompleteTodo(t); } catch(e){ threw = true; console.error('  un-tick threw: ' + e.message); }
  assert('T8a no-history un-tick does not throw', !threw);
  assert('T8b completedAt still retracted', !('completedAt' in t));
  assertEq('T8c done cleared', t.done, false);
}

// ===========================================================================
if (failures) { console.error('\n' + failures + ' untick-retract assertion(s) FAILED'); process.exit(1); }
console.log('\nAll untick-retract tests passed!');
