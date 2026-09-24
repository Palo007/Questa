// inbox-apply.test.js -- TDD red gate for applyInboxLog() (contract:
// .omo/plans/android-inbox-step1.md, 2026-09-24 spec) and the scoreHabit()
// 4th-arg (meta.evt / meta.atMs) extension it depends on.
//
// applyInboxLog does not exist in app.js yet (it belongs inside the
// BEGIN_QUICKLOG_HELPERS/END_QUICKLOG_HELPERS block, which currently ends at
// quickLogDedupe/friends -- the web quick log, removed 2026-09-24). scoreHabit(id,dir,ev)
// is still 3-arg. This file is expected to FAIL every applyInboxLog-shaped
// case below, for that reason -- not a syntax/setup error. The lone
// regression-guard case (3-arg scoreHabit emits no uid override) exercises
// only code that already exists and is expected to PASS today, proving the
// harness itself is sound.
//
// Run: node tests/inbox-apply.test.js

const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction, extractLine } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

let failures = 0;
function assert(desc, cond) { if (cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }

// ---------------------------------------------------------------------------
// Extraction. applyInboxLog is expected to be MISSING; every other symbol
// here already exists in app.js today. A missing anchor becomes a labelled
// [FAIL], never a process crash (pattern: tests/boot-gate-inert-cards.test.js).
// ---------------------------------------------------------------------------
function grab(fn, label) {
  try { return fn(); }
  catch (e) { assert('extract ' + label + ' from app.js', false); return null; }
}

const parts = {
  quickLogTargetOk: grab(() => extractFunction(appSrc, /^function quickLogTargetOk\(t, dir\)\{/, 'quickLogTargetOk'), 'quickLogTargetOk()'),
  localDayKey: grab(() => extractFunction(appSrc, /^function localDayKey\(ms\)\{/, 'localDayKey'), 'localDayKey()'),
  logHistory: grab(() => extractFunction(appSrc, /^function logHistory\(t, patch, atMs\)\{/, 'logHistory'), 'logHistory()'),
  scoreHabit: grab(() => extractFunction(appSrc, /^function scoreHabit\(/, 'scoreHabit'), 'scoreHabit()'),
  applyInboxLog: grab(() => extractFunction(appSrc, /^function applyInboxLog\(rec, nowMs\)\{/, 'applyInboxLog'), 'applyInboxLog()'),
};

assert('applyInboxLog() exists in app.js', parts.applyInboxLog !== null);

// applyInboxLog is required for every case below except the regression guard.
// Rather than hard-exit (which would hide the still-useful regression-guard
// result), each applyInboxLog-dependent case checks parts.applyInboxLog
// itself and reports a labelled [FAIL] if it's missing.

// ---------------------------------------------------------------------------
// Sandbox: real quickLogTargetOk/localDayKey/logHistory/scoreHabit (+
// applyInboxLog once it exists), everything scoreHabit reaches for stubbed.
// ---------------------------------------------------------------------------
function makeSandbox() {
  const events = [];
  const toasts = [];
  const S = {
    tasks: [
      { id: 'h1', type: 'habit', title: 'Water', difficulty: 'medium', value: 0, cUp: 0, cDown: 0, history: [] },
      { id: 'hlog', type: 'habit', title: 'Steps', difficulty: 'log', value: 0, cUp: 0, cDown: 0, history: [] },
    ],
    char: { hp: 50, maxHp: 50, xp: 0, lvl: 1, gold: 0, mp: 0 },
  };

  const sb = {
    S, console, JSON, Math, Date, Number, String, Boolean, Array, Object,
    document: { getElementById: () => null },
    _suppressHabitClick: null,
    bootGateBlocksInput: () => false,
    repsPerTap: () => 1,
    completionReward: () => ({ xp: 1, gold: 1, mp: 1 }),
    gainXp: () => {},
    clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
    valueDelta: () => 1,
    bumpAvatar: () => {},
    buzz: () => false,
    floatFx: () => {},
    fxGain: () => 'gain',
    missDamage: () => 5,
    takeDamage: () => {},
    now: () => Date.now(),
    save: () => {},
    render: () => {},
    toast: m => { toasts.push(m); },
    logEvent: e => { events.push(e); },
  };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);

  const code = [
    parts.quickLogTargetOk,
    parts.localDayKey,
    parts.logHistory,
    parts.scoreHabit,
    parts.applyInboxLog || '/* applyInboxLog missing */',
    'this._quickLogTargetOk=quickLogTargetOk; this._localDayKey=localDayKey; this._logHistory=logHistory;',
    'this._scoreHabit=scoreHabit;',
    (parts.applyInboxLog ? 'this._applyInboxLog=applyInboxLog;' : ''),
  ].join('\n');
  vm.runInContext(code, sb);
  return { sb, S, events, toasts };
}

function rec(over) {
  return Object.assign({ v: 1, id: 'aaaaaaaa-1111-2222-3333-444444444444', kind: 'habit',
    habitId: 'h1', dir: 1, ts: Date.now(), tzOffsetMin: 0, src: 'android-shortcut' }, over || {});
}

// ===========================================================================
// Regression guard -- 3-arg scoreHabit() emits events WITHOUT a uid override.
// This exercises only code that exists today; it should PASS, proving the
// harness (extraction + sandbox) is itself correctly wired.
// ===========================================================================
(function regressionGuard() {
  const { sb, S, events } = makeSandbox();
  const t = S.tasks.find(x => x.id === 'h1');
  const before = (t.cUp || 0) + (t.cDown || 0);
  sb._scoreHabit('h1', 1, null);
  assert('regression: 3-arg scoreHabit still scores the habit', ((t.cUp || 0) + (t.cDown || 0)) > before);
  assert('regression: 3-arg scoreHabit logs exactly one event', events.length === 1);
  assert('regression: 3-arg scoreHabit event payload has no uid key', events.length === 1 && !('uid' in events[0]));
})();

// ===========================================================================
// 2a' -- same-day apply: logEvent got uid 'inbox-<id>' and ts=tap ts, history
// point date = tap ts, cUp 1, returns 'applied'.
// ===========================================================================
(function case2aPrime() {
  if (!parts.applyInboxLog) { assert("2a': applyInboxLog missing, cannot run same-day-apply case", false); return; }
  const { sb, S, events } = makeSandbox();
  const t = S.tasks.find(x => x.id === 'h1');
  const tapTs = Date.now();
  let result;
  try { result = sb._applyInboxLog(rec({ ts: tapTs }), tapTs); }
  catch (e) { assert("2a': applyInboxLog threw: " + (e && e.message || e), false); return; }
  assert("2a': applyInboxLog returns 'applied' for a same-day tap", result === 'applied');
  assert("2a': habit cUp incremented to 1", t.cUp === 1);
  assert("2a': logEvent carries uid 'inbox-<id>'", events.length === 1 && events[0].uid === 'inbox-aaaaaaaa-1111-2222-3333-444444444444');
  assert("2a': logEvent carries ts = tap ts", events.length === 1 && events[0].ts === tapTs);
  const last = t.history[t.history.length - 1];
  assert("2a': history point date = tap ts", last && last.date === tapTs);
})();

// ===========================================================================
// 2e -- tap at 23:50 day D, nowMs 08:00 day D+1: 'eventOnly', cUp unchanged,
// exactly one logEvent with late:true + uid + ts, toast mentions the late-log
// message, never credited to "today".
// ===========================================================================
(function case2e() {
  if (!parts.applyInboxLog) { assert('2e: applyInboxLog missing, cannot run late-tap case', false); return; }
  const { sb, S, events, toasts } = makeSandbox();
  const t = S.tasks.find(x => x.id === 'h1');
  const dayD = new Date(2026, 8, 20, 23, 50, 0).getTime();   // day D, 23:50 local
  const dayD1 = new Date(2026, 8, 21, 8, 0, 0).getTime();    // day D+1, 08:00 local
  let result;
  try { result = sb._applyInboxLog(rec({ ts: dayD }), dayD1); }
  catch (e) { assert('2e: applyInboxLog threw: ' + (e && e.message || e), false); return; }
  assert("2e: late cross-day tap returns 'eventOnly'", result === 'eventOnly');
  assert('2e: cUp is NOT incremented (not credited to today)', t.cUp === 0);
  assert('2e: exactly one logEvent emitted', events.length === 1);
  assert('2e: logEvent has late:true', events.length === 1 && events[0].late === true);
  assert('2e: logEvent has scored:false', events.length === 1 && events[0].scored === false);
  assert("2e: logEvent carries uid 'inbox-<id>'", events.length === 1 && events[0].uid === 'inbox-aaaaaaaa-1111-2222-3333-444444444444');
  assert('2e: logEvent carries ts = original tap ts (day D)', events.length === 1 && events[0].ts === dayD);
  assert('2e: scoreHabit was NOT invoked (no history point recorded)', t.history.length === 0);
  assert('2e: a toast mentions the late-log message', toasts.some(m => String(m).indexOf('Late log saved to history') !== -1));
})();

// ===========================================================================
// Unknown habit -> 'unknown'.
// ===========================================================================
(function caseUnknown() {
  if (!parts.applyInboxLog) { assert("unknown-habit: applyInboxLog missing, cannot run", false); return; }
  const { sb, events } = makeSandbox();
  let result;
  try { result = sb._applyInboxLog(rec({ habitId: 'no-such-habit' }), Date.now()); }
  catch (e) { assert('unknown-habit: applyInboxLog threw: ' + (e && e.message || e), false); return; }
  assert("unknown-habit: applyInboxLog returns 'unknown'", result === 'unknown');
  assert('unknown-habit: no logEvent emitted', events.length === 0);
})();

// ===========================================================================
// Gated -> 'gated' with no logEvent.
// ===========================================================================
(function caseGated() {
  if (!parts.applyInboxLog) { assert("gated: applyInboxLog missing, cannot run", false); return; }
  const { sb, events } = makeSandbox();
  sb.bootGateBlocksInput = () => true;
  let result;
  try { result = sb._applyInboxLog(rec(), Date.now()); }
  catch (e) { assert('gated: applyInboxLog threw: ' + (e && e.message || e), false); return; }
  assert("gated: applyInboxLog returns 'gated' when bootGateBlocksInput() is true", result === 'gated');
  assert('gated: no logEvent emitted while gated', events.length === 0);
})();

// ===========================================================================
// Log-difficulty habit, same-day tap: uid/ts still propagate.
// ===========================================================================
(function caseLogHabit() {
  if (!parts.applyInboxLog) { assert('log-habit: applyInboxLog missing, cannot run', false); return; }
  const { sb, S, events } = makeSandbox();
  const t = S.tasks.find(x => x.id === 'hlog');
  const tapTs = Date.now();
  let result;
  try { result = sb._applyInboxLog(rec({ habitId: 'hlog', ts: tapTs }), tapTs); }
  catch (e) { assert('log-habit: applyInboxLog threw: ' + (e && e.message || e), false); return; }
  assert("log-habit: same-day tap on a 'log' habit returns 'applied'", result === 'applied');
  assert('log-habit: cUp incremented via the log-tally path', t.cUp === 1);
  assert("log-habit: logEvent carries uid 'inbox-<id>'", events.length === 1 && events[0].uid === 'inbox-aaaaaaaa-1111-2222-3333-444444444444');
  assert('log-habit: logEvent carries ts = tap ts', events.length === 1 && events[0].ts === tapTs);
})();

console.log(failures ? ('\nFAILED: ' + failures + ' assertion(s)') : '\nALL PASSED');
process.exit(failures ? 1 : 0);
