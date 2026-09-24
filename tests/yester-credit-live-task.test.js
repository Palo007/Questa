// yester-credit-live-task.test.js -- regression test for the "missed yesterday"
// modal crediting a DETACHED/ORPHANED task object when a sync round replaces
// S.tasks while the modal is open.
//
// Bug (pre-existing, app.js): openYesterCheck() stores the exact object
// references returned by missedYesterdayDailies() (a filter over S.tasks --
// not a copy) into the module-level _yesterMissed array. If a sync round
// lands while the modal is open, sync.js deep-copies the incoming subset
// (JSON.parse(JSON.stringify(...))) and replaces S.tasks wholesale with the
// new objects. commitYesterCheck() then calls creditYesterday() on the STALE
// captured references -- objects that are no longer part of S.tasks -- so the
// credit is silently lost from the user's actual state.
//
// Fix under test: commitYesterCheck() re-resolves each ticked id against the
// live S.tasks (S.tasks.find(x=>x.id===t.id)) immediately before crediting,
// and skips cleanly (no throw) if the id has vanished from S.tasks entirely.
//
// Run: node tests/yester-credit-live-task.test.js

const fs = require('fs'), path = require('path'), vm = require('vm');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

const { extractFunction, extractLine } = require('./_extract');

const clampFn = extractFunction(appSrc, /^function clamp\(v,a,b\)\{/, 'clamp');
const valueDeltaFn = extractFunction(appSrc, /^function valueDelta\(value\)\{/, 'valueDelta');
const xpToLevelFn = extractFunction(appSrc, /^function xpToLevel\(lvl\)\{/, 'xpToLevel');
const completionRewardFn = extractFunction(appSrc, /^function completionReward\(task\)\{/, 'completionReward');
const gainXpFn = extractFunction(appSrc, /^function gainXp\(xp\)\{/, 'gainXp');
const isDailyDueOnFn = extractFunction(appSrc, /^function isDailyDueOn\(t, dow\)\{/, 'isDailyDueOn');
const dayStampFn = extractFunction(appSrc, /^function dayStamp\(d\)\{/, 'dayStamp');
const localDayFn = extractFunction(appSrc, /^function localDayDateAtOffset\(baseMs, dayOffset\)\{/, 'localDayDateAtOffset');
// K2 (2026-09-11): now() heals a future-poisoned HLC before stamping, so the slice
// needs _hlcHeal and the tolerance constant it reads. Lockstep with app.js (§4).
const nowFn = extractFunction(appSrc, /^function now\(\)\{/, 'now');
const hlcTolLine = extractLine(appSrc, /^const HLC_RATCHET_TOLERANCE_MS\s*=/, 'HLC_RATCHET_TOLERANCE_MS');
const hlcHealFn = extractFunction(appSrc, /^function _hlcHeal\(\)\{/, '_hlcHeal');
const logEventFn = extractFunction(appSrc, /^function logEvent\(ev\)\{/, 'logEvent');
const creditYesterdayFn = extractFunction(appSrc, /^function creditYesterday\(t\)\{/, 'creditYesterday');
const missedYesterdayDailiesFn = extractFunction(appSrc, /^function missedYesterdayDailies\(\)\{/, 'missedYesterdayDailies');
const openYesterCheckFn = extractFunction(appSrc, /^function openYesterCheck\(missed\)\{/, 'openYesterCheck');
const toggleYesterTickFn = extractFunction(appSrc, /^function toggleYesterTick\(id\)\{/, 'toggleYesterTick');
const commitYesterCheckFn = extractFunction(appSrc, /^function commitYesterCheck\(\)\{/, 'commitYesterCheck');

// Build test code. _yesterMissed/_yesterTick are declared here (they are
// plain module-level `let`s in app.js, immediately above openYesterCheck --
// NOT part of any extracted function body).
const code = [
  'const DIFF = { trivial:0.1, easy:1, medium:1.5, hard:2, log:0 };',
  'let _yesterMissed = [];',
  'let _yesterTick = {};',
  clampFn,
  valueDeltaFn,
  xpToLevelFn,
  completionRewardFn,
  gainXpFn,
  isDailyDueOnFn,
  dayStampFn,
  localDayFn,
  hlcTolLine,
  hlcHealFn,
  nowFn,
  logEventFn,
  creditYesterdayFn,
  missedYesterdayDailiesFn,
  openYesterCheckFn,
  toggleYesterTickFn,
  commitYesterCheckFn,
  'return { creditYesterday, missedYesterdayDailies, openYesterCheck, toggleYesterTick, commitYesterCheck };'
].join('\n');

// Stub S
const S = {
  prefs: { paused: false },
  tasks: [],
  char: { hp: 50, maxHp: 50, xp: 0, lvl: 1, gold: 0, mp: 0, name: 'Test', face: '🧙', cls: 'Wizard' },
  lastCron: 0
};

const noop = function () {};
const toasts = [];
const sandbox = {
  S: S,
  document: {
    getElementById: function (id) {
      return { classList: { add: noop, remove: noop }, innerHTML: '' };
    }
  },
  console: console, JSON: JSON, Math: Math, Date: Date,
  Object: Object, Array: Array, Number: Number, String: String, Boolean: Boolean, Promise: Promise,
  // toast captures instead of no-opping: J4 asserts the NUMBER the user is actually
  // shown, which is the observable boundary the bug crosses (AGENTS.md S4 -- assert on
  // what was recorded, not that a function was called).
  toast: function (m) { toasts.push(m); },
  render: noop, runCron: noop, drawYesterCheck: noop, levelFlash: noop,
  idbOpen: function () { return Promise.resolve(null); },
  lastIssued: 0
};
sandbox.globalThis = sandbox;

const fn = new vm.Script(
  '(function(S, document, console, JSON, Math, Date, Object, Array, Number, String, Boolean, Promise, toast, render){ "use strict";\n' +
  code + '\n})'
).runInNewContext(sandbox);

const api = fn(
  sandbox.S, sandbox.document, sandbox.console, sandbox.JSON, sandbox.Math, sandbox.Date,
  sandbox.Object, sandbox.Array, sandbox.Number, sandbox.String, sandbox.Boolean, sandbox.Promise,
  sandbox.toast, sandbox.render
);

const { creditYesterday, missedYesterdayDailies, openYesterCheck, toggleYesterTick, commitYesterCheck } = api;

function freshDaily(id) {
  return { id: id, type: 'daily', title: 'Daily ' + id, difficulty: 'medium', value: 0,
           streak: 3, done: false, checklist: [], repeat: [1, 1, 1, 1, 1, 1, 1], history: [] };
}
function freshChar() { return { hp: 50, maxHp: 50, xp: 0, lvl: 1, gold: 0, mp: 0, name: 'Test', face: '🧙', cls: 'Wizard' }; }

// =========================================================================
// T1. THE REGRESSION -- a sync round replaces S.tasks (deep-copied identities)
// while the modal is open. The credit must land on the object NOW SITTING IN
// S.tasks, not on the stale reference captured at modal-open time.
// =========================================================================
{
  S.prefs = { paused: false };
  S.lastCron = 0;
  const t = freshDaily('d-live-1');
  S.tasks = [t];
  S.char = freshChar();

  const missed = missedYesterdayDailies();
  assert('T1 setup: missedYesterdayDailies() finds the daily via live reference', missed.length === 1 && missed[0] === t);

  openYesterCheck(missed);
  toggleYesterTick(t.id);

  // Simulate a sync round landing while the modal is still open: S.tasks is
  // replaced wholesale with deep copies (mirrors sync.js's
  // `subset = JSON.parse(JSON.stringify(subset)); S.tasks = subset.tasks;`).
  // Object identity changes; `id` values are preserved.
  S.tasks = JSON.parse(JSON.stringify(S.tasks));

  commitYesterCheck();

  const live = S.tasks.find(function (x) { return x.id === 'd-live-1'; });
  assert('T1 REGRESSION: credit lands on the object now in S.tasks (done=true)', !!live && live.done === true);
  assert('T1 REGRESSION: credit lands on the object now in S.tasks (streak incremented)', !!live && live.streak === 4);
}

// =========================================================================
// T2. The detached orphan carries no credit under the fixed production shape
// (the fix resolves and mutates the LIVE object only; it never touches the
// object it was originally handed).
// =========================================================================
{
  S.prefs = { paused: false };
  S.lastCron = 0;
  const t = freshDaily('d-live-2');
  S.tasks = [t];
  S.char = freshChar();

  const missed = missedYesterdayDailies();
  openYesterCheck(missed);
  toggleYesterTick(t.id);
  S.tasks = JSON.parse(JSON.stringify(S.tasks));

  commitYesterCheck();

  assert('T2 orphan: detached object captured at modal-open time is left untouched',
    t.done === false && t.streak === 3);
}

// =========================================================================
// T3. VANISHED ID -- the ticked task is removed from S.tasks entirely before
// commit. Must complete without throwing (GREEN on HEAD too: HEAD mutates the
// stale reference directly and never touches S.tasks membership, so it also
// does not throw here -- this test guards the NEW live-lookup code path, not
// the orphaning defect itself).
// =========================================================================
{
  S.prefs = { paused: false };
  S.lastCron = 0;
  const t = freshDaily('d-live-3');
  S.tasks = [t];
  S.char = freshChar();

  const missed = missedYesterdayDailies();
  openYesterCheck(missed);
  toggleYesterTick(t.id);
  S.tasks = []; // task vanished entirely

  let threw = false;
  try { commitYesterCheck(); } catch (e) { threw = true; }
  assert('T3 vanished id: commitYesterCheck() does not throw', threw === false);
}

// =========================================================================
// T4. NORMAL PATH UNCHANGED -- no sync round intervenes. A ticked daily is
// still credited exactly as today (GREEN on HEAD, must stay green).
// =========================================================================
{
  S.prefs = { paused: false };
  S.lastCron = 0;
  const t = freshDaily('d-live-4');
  S.tasks = [t];
  S.char = freshChar();

  const missed = missedYesterdayDailies();
  openYesterCheck(missed);
  toggleYesterTick(t.id);
  commitYesterCheck();

  assert('T4 normal path: ticked daily credited (done=true)', t.done === true);
  assert('T4 normal path: streak incremented by exactly 1', t.streak === 4);
}

// =========================================================================
// T5. UNTICKED ITEMS ARE NOT CREDITED (GREEN on HEAD, must stay green).
// =========================================================================
{
  S.prefs = { paused: false };
  S.lastCron = 0;
  const t1 = freshDaily('d-live-5a');
  const t2 = freshDaily('d-live-5b');
  S.tasks = [t1, t2];
  S.char = freshChar();

  const missed = missedYesterdayDailies();
  assert('T5 setup: both dailies detected as missed', missed.length === 2);

  openYesterCheck(missed);
  toggleYesterTick(t1.id); // only tick t1
  commitYesterCheck();

  assert('T5 unticked: ticked item is credited', t1.done === true);
  assert('T5 unticked: unticked item receives nothing', t2.done === false && t2.streak === 3);
}

// =========================================================================
// T6-T8. ADDED 2026-08-19 by J4 (plan todo 21), review finding 9.
//
// The DATA outcome is already correct -- that is what T1-T3 above are for. What is
// wrong is the NUMBER the user is told. `credited` was
// `_yesterMissed.filter(t => _yesterTick[t.id]).length`, which counts the TICK, not
// the credit. A task that vanished mid-modal is still counted, so the toast says
// "Credited 2 dailies" when one was credited.
//
// A tick can fail to credit for three distinct reasons: the id no longer exists in
// live S.tasks (T3's path), creditYesterday() early-returns on `if(t.done) return;`,
// or the daily was not actually due yesterday. The fix counts credits where they
// happen -- creditYesterday() returns a boolean -- rather than re-deriving its three
// predicates at the call site.
//
// Asserted on the toast STRING the user sees and on creditYesterday()'s return value,
// never on a call count.
// =========================================================================
function creditedCountFromToast() {
  const m = toasts.filter(function (s) { return /^Credited /.test(String(s)); }).pop();
  if (!m) return null;
  const n = String(m).match(/^Credited (\d+) /);
  return n ? Number(n[1]) : null;
}

// ---- T6: two ticked, one vanished from S.tasks -> the count must be 1 ----
{
  toasts.length = 0;
  S.prefs = { paused: false };
  S.lastCron = 0;
  S.char = freshChar();
  const t1 = freshDaily('d-j4-a');
  const t2 = freshDaily('d-j4-b');
  S.tasks = [t1, t2];

  const missed = missedYesterdayDailies();
  openYesterCheck(missed);
  toggleYesterTick('d-j4-a');
  toggleYesterTick('d-j4-b');
  // A sync round removes d-j4-b from live S.tasks while the modal is open.
  S.tasks = [t1];
  commitYesterCheck();

  assert('T6 J4: the surviving daily really was credited', t1.done === true && t1.streak === 4);
  assert('T6 J4: the vanished daily was not credited (nothing to credit)', t2.done === false);
  assert('T6 J4: the toast counts 1, not 2 -- credits, not ticks', creditedCountFromToast() === 1);
}

// ---- T7: a ticked id whose live task is ALREADY done -> not counted ------
{
  toasts.length = 0;
  S.prefs = { paused: false };
  S.lastCron = 0;
  S.char = freshChar();
  const t1 = freshDaily('d-j4-c');
  const t2 = freshDaily('d-j4-d');
  S.tasks = [t1, t2];

  const missed = missedYesterdayDailies();
  assert('T7 J4 setup: both dailies detected as missed', missed.length === 2);
  openYesterCheck(missed);
  toggleYesterTick('d-j4-c');
  toggleYesterTick('d-j4-d');
  // A sync round brings in d-j4-d already completed on the other device.
  const t2done = Object.assign(freshDaily('d-j4-d'), { done: true, streak: 7 });
  S.tasks = [t1, t2done];
  commitYesterCheck();

  assert('T7 J4: the already-done daily keeps its streak (creditYesterday skipped it)',
    t2done.streak === 7);
  assert('T7 J4: the other daily was credited', t1.done === true && t1.streak === 4);
  assert('T7 J4: the toast counts 1, not 2 -- an already-done tick is not a credit',
    creditedCountFromToast() === 1);
}

// ---- T8: creditYesterday()'s return value is the single source of truth --
{
  S.prefs = { paused: false };
  S.char = freshChar();
  const ok = freshDaily('d-j4-e');
  S.tasks = [ok];
  assert('T8a creditYesterday() returns true when it actually credits',
    creditYesterday(ok) === true);
  assert('T8b ...and the credit landed', ok.done === true);
  assert('T8c creditYesterday() returns false on the `if(t.done) return` skip',
    creditYesterday(ok) === false);

  // A daily not due yesterday: repeat array false for yesterday's weekday.
  const notDue = freshDaily('d-j4-f');
  const yDow = (new Date().getDay() + 6) % 7;
  notDue.repeat = [1, 1, 1, 1, 1, 1, 1];
  notDue.repeat[yDow] = 0;
  S.tasks = [notDue];
  assert('T8d creditYesterday() returns false for a daily not due yesterday',
    creditYesterday(notDue) === false);
  assert('T8e ...and credited nothing', notDue.done === false && notDue.streak === 3);
}

// =========================================================================
// T9-T10. ADDED 2026-09-24 (morning-rollover todo 2): pin commit ordering and
// the sync boundary.
//
// commitYesterCheck() must persist BEFORE finalizing: `save()` runs before
// `runCron()` (app.js commit tail), because a sync round landing mid-modal
// merges lastCron up to today and runCron()'s first statement
// (`if(today <= S.lastCron) return;`, no save) would otherwise leave every
// credit (XP, gold, MP, value, streak, done, doneDay, history) in memory only.
//
// Asserted on the SERIALIZED snapshot save() persisted (observable state),
// not on helper call counts (AGENTS.md S4): the stub captures
// JSON.parse(JSON.stringify(...)) of live S at save time, and the ordering
// is pinned via a shared events log (save index < runCron index).
// =========================================================================
function localDayStamp(d) { return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }

// Install order-recording stubs for save()/runCron(). They resolve as vm
// globals (bare `save` / `runCron` references in commitYesterCheck), so
// assigning them on the sandbox object takes effect for all commits below.
// T1-T8 above already ran with the original noop/undefined pair.
const commitOrder = [];
let savedSnapshot = null;
let saveCalls = 0;
let runCronCalls = 0;
sandbox.save = function () {
  saveCalls++;
  commitOrder.push('save');
  // Serialized snapshot of LIVE state at save time -- this is the boundary
  // the persistence-loss bug crosses (what was recorded, not that save ran).
  savedSnapshot = JSON.parse(JSON.stringify({ tasks: S.tasks, char: S.char, lastCron: S.lastCron }));
};
sandbox.runCron = function () {
  runCronCalls++;
  commitOrder.push('runCron');
};
function resetCommitProbes() {
  commitOrder.length = 0;
  savedSnapshot = null;
  saveCalls = 0;
  runCronCalls = 0;
  toasts.length = 0;
}

// ---- T9 (happy): one ticked daily -> save snapshot holds the full credit,
// save precedes runCron, toast tells the truth ----
{
  resetCommitProbes();
  S.prefs = { paused: false };
  S.lastCron = 0;
  S.char = freshChar();
  const t = freshDaily('d-save-1');
  S.tasks = [t];

  const missed = missedYesterdayDailies();
  assert('T9 setup: daily detected as missed', missed.length === 1);
  openYesterCheck(missed);
  toggleYesterTick('d-save-1');
  const hpBefore = S.char.hp;
  commitYesterCheck();

  const yDay = localDayStamp(new Date(Date.now() - 86400000));
  assert('T9 ordering: save() ran before runCron()',
    saveCalls === 1 && runCronCalls === 1 &&
    commitOrder.length === 2 && commitOrder[0] === 'save' && commitOrder[1] === 'runCron');
  assert('T9 snapshot: a snapshot was persisted', !!savedSnapshot);
  const snapT = savedSnapshot && savedSnapshot.tasks.filter(function (x) { return x.id === 'd-save-1'; })[0];
  assert('T9 snapshot: credited daily present with done=true', !!snapT && snapT.done === true);
  assert('T9 snapshot: streak incremented', !!snapT && snapT.streak === 4);
  assert('T9 snapshot: doneDay frozen to yesterday', !!snapT && snapT.doneDay === yDay);
  assert('T9 snapshot: backdated completed history point present',
    !!snapT && Array.isArray(snapT.history) && snapT.history.some(function (h) { return h.completed === true; }));
  // medium difficulty at value 0: d=1, m=1.5 -> xp=round(10.5)=11, gold=1.8, mp=2.
  assert('T9 snapshot: XP persisted', !!savedSnapshot && savedSnapshot.char.xp === 11);
  assert('T9 snapshot: gold persisted', !!savedSnapshot && savedSnapshot.char.gold === 1.8);
  assert('T9 snapshot: MP persisted', !!savedSnapshot && savedSnapshot.char.mp === 2);
  assert('T9 live: credit also landed on live S.tasks', t.done === true && t.streak === 4);
  assert('T9 live: no miss damage from the commit path', S.char.hp === hpBefore && t.missedOn === undefined);
  assert('T9 toast: truthful count of 1', creditedCountFromToast() === 1);
}

// ---- T10 (failure/shape): sync advances lastCron to today AND removes one
// selected id mid-modal. Survivor credit must still be persisted once (save
// still precedes the runCron no-op), the removed id skipped, no double
// damage, toast counts the actual credit. ----
{
  resetCommitProbes();
  S.prefs = { paused: false };
  S.lastCron = 0;
  S.char = freshChar();
  const t1 = freshDaily('d-save-2a');
  const t2 = freshDaily('d-save-2b');
  S.tasks = [t1, t2];

  const missed = missedYesterdayDailies();
  assert('T10 setup: both dailies detected as missed', missed.length === 2);
  openYesterCheck(missed);
  toggleYesterTick('d-save-2a');
  toggleYesterTick('d-save-2b');
  // Sync round lands mid-modal, sync.js-shaped: deep-copied identities
  // (JSON.parse(JSON.stringify(...))), one selected id gone, lastCron merged
  // up to today -- so the stubbed runCron below (like the real one's
  // `if(today <= S.lastCron) return;` guard) must be a no-op for damage.
  const todayStamp = localDayStamp(new Date());
  const survivorCopy = JSON.parse(JSON.stringify(t1));
  S.tasks = [survivorCopy];
  S.lastCron = todayStamp;
  const hpBefore = S.char.hp;
  commitYesterCheck();

  const live = S.tasks.filter(function (x) { return x.id === 'd-save-2a'; })[0];
  const snapT = savedSnapshot && savedSnapshot.tasks.filter(function (x) { return x.id === 'd-save-2a'; })[0];
  assert('T10 ordering: save() still ran before runCron() even with lastCron==today',
    saveCalls === 1 && runCronCalls === 1 &&
    commitOrder.length === 2 && commitOrder[0] === 'save' && commitOrder[1] === 'runCron');
  assert('T10 survivor: credited on live S.tasks', !!live && live.done === true && live.streak === 4);
  assert('T10 survivor: credit persisted in the save snapshot (not memory-only)',
    !!snapT && snapT.done === true && snapT.streak === 4);
  assert('T10 survivor: snapshot carries doneDay + completed history',
    !!snapT && typeof snapT.doneDay === 'number' &&
    Array.isArray(snapT.history) && snapT.history.some(function (h) { return h.completed === true; }));
  assert('T10 survivor: snapshot carries the XP/gold/MP rewards',
    !!savedSnapshot && savedSnapshot.char.xp > 0 &&
    savedSnapshot.char.gold > 0 && savedSnapshot.char.mp > 0);
  assert('T10 removed: vanished selection skipped, never re-created',
    S.tasks.filter(function (x) { return x.id === 'd-save-2b'; }).length === 0 &&
    (!savedSnapshot || savedSnapshot.tasks.filter(function (x) { return x.id === 'd-save-2b'; }).length === 0));
  assert('T10 no double damage: HP untouched, no miss stamp, streak kept',
    S.char.hp === hpBefore && !!live && live.missedOn === undefined && live.streak === 4);
  assert('T10 toast: counts 1 actual credit, not 2 ticks', creditedCountFromToast() === 1);
}

// Summary
if (failures > 0) {
  console.error('\n' + failures + ' test(s) failed');
  process.exit(1);
} else {
  console.log('\nAll yester-credit-live-task tests passed!');
}
