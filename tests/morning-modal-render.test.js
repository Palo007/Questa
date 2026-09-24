// morning-modal-render.test.js -- characterization of the existing "missed
// yesterday" modal render path (morning-rollover todo 1).
//
// Pins CURRENT behavior of the real seams in app.js -- openYesterCheck(),
// drawYesterCheck(), toggleYesterTick(), commitYesterCheck() -- extracted by
// ANCHOR (tests/_extract.js), never by hardcoded line numbers:
//   - modal opens with the missed count and one row per missed daily
//   - a title containing HTML metacharacters renders escaped
//   - toggling flips only that row's state/note
//   - commit restores the scrim (removes 'show', clears html) and closes
//   - there is no undo action anywhere on this surface
//
// Characterization only: green against UNCHANGED product code. If any new
// assertion needs a product fix, this test must go BLOCKED, not edit app.js.
//
// Run: node tests/morning-modal-render.test.js  (also run by node tests/run.js)

const fs = require('fs'), path = require('path'), vm = require('vm');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

const { extractFunction, extractLine } = require('./_extract');

// ---- anchor extraction (every seam pinned by declaration text) ----
const clampFn = extractFunction(appSrc, /^function clamp\(v,a,b\)\{/, 'clamp');
const valueDeltaFn = extractFunction(appSrc, /^function valueDelta\(value\)\{/, 'valueDelta');
const xpToLevelFn = extractFunction(appSrc, /^function xpToLevel\(lvl\)\{/, 'xpToLevel');
const completionRewardFn = extractFunction(appSrc, /^function completionReward\(task\)\{/, 'completionReward');
const gainXpFn = extractFunction(appSrc, /^function gainXp\(xp\)\{/, 'gainXp');
const escFnSrc = extractFunction(appSrc, /^function esc\(s\)\{/, 'esc');
const isDailyDueOnFn = extractFunction(appSrc, /^function isDailyDueOn\(t, dow\)\{/, 'isDailyDueOn');
const dayStampFn = extractFunction(appSrc, /^function dayStamp\(d\)\{/, 'dayStamp');
const localDayFn = extractFunction(appSrc, /^function localDayDateAtOffset\(baseMs, dayOffset\)\{/, 'localDayDateAtOffset');
const nowFn = extractFunction(appSrc, /^function now\(\)\{/, 'now');
const hlcTolLine = extractLine(appSrc, /^const HLC_RATCHET_TOLERANCE_MS\s*=/, 'HLC_RATCHET_TOLERANCE_MS');
const hlcHealFn = extractFunction(appSrc, /^function _hlcHeal\(\)\{/, '_hlcHeal');
const logEventFn = extractFunction(appSrc, /^function logEvent\(ev\)\{/, 'logEvent');
const creditYesterdayFn = extractFunction(appSrc, /^function creditYesterday\(t\)\{/, 'creditYesterday');
const missedYesterdayDailiesFn = extractFunction(appSrc, /^function missedYesterdayDailies\(\)\{/, 'missedYesterdayDailies');
const openYesterCheckFn = extractFunction(appSrc, /^function openYesterCheck\(missed\)\{/, 'openYesterCheck');
const toggleYesterTickFn = extractFunction(appSrc, /^function toggleYesterTick\(id\)\{/, 'toggleYesterTick');
const drawYesterCheckFn = extractFunction(appSrc, /^function drawYesterCheck\(\)\{/, 'drawYesterCheck');
const commitYesterCheckFn = extractFunction(appSrc, /^function commitYesterCheck\(\)\{/, 'commitYesterCheck');

assert('extraction: openYesterCheck seam extracted (assigns _yesterMissed, shows scrim)',
  openYesterCheckFn.indexOf('_yesterMissed = missed') !== -1 &&
  openYesterCheckFn.indexOf("getElementById('yScrim')") !== -1);
assert('extraction: drawYesterCheck seam extracted (builds ySheet, escapes titles)',
  drawYesterCheckFn.indexOf('ySheet') !== -1 &&
  drawYesterCheckFn.indexOf('esc(t.title)') !== -1);
assert('extraction: toggleYesterTick seam extracted (flips tick, redraws)',
  toggleYesterTickFn.indexOf('_yesterTick[id]') !== -1 &&
  toggleYesterTickFn.indexOf('drawYesterCheck()') !== -1);
assert('extraction: commitYesterCheck seam extracted (re-resolves live, restores scrim)',
  commitYesterCheckFn.indexOf('S.tasks.find') !== -1 &&
  commitYesterCheckFn.indexOf("classList.remove('show')") !== -1);

// ---- build the sandbox: real extracted code, small DOM stub ----
const code = [
  'const DIFF = { trivial:0.1, easy:1, medium:1.5, hard:2, log:0 };',
  'let _yesterMissed = [];',
  'let _yesterTick = {};',
  clampFn,
  valueDeltaFn,
  xpToLevelFn,
  completionRewardFn,
  gainXpFn,
  escFnSrc,
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
  drawYesterCheckFn,
  commitYesterCheckFn,
  'return { missedYesterdayDailies, openYesterCheck, toggleYesterTick, drawYesterCheck, commitYesterCheck, esc };'
].join('\n');

const S = {
  prefs: { paused: false },
  tasks: [],
  char: { hp: 50, maxHp: 50, xp: 0, lvl: 1, gold: 0, mp: 0, name: 'Test', face: '🧙', cls: 'Wizard' },
  lastCron: 0
};

const noop = function () {};
const toasts = [];
let saved = 0, croned = 0, rendered = 0, flashed = 0;

// Minimal yScrim element: classList show-tracking + settable innerHTML.
function makeClassList() {
  const set = [];
  return {
    add(c) { if (set.indexOf(c) < 0) set.push(c); },
    remove(c) { const i = set.indexOf(c); if (i >= 0) set.splice(i, 1); },
    contains(c) { return set.indexOf(c) >= 0; }
  };
}
const yScrim = { classList: makeClassList(), innerHTML: '' };
const sandbox = {
  S: S,
  document: {
    getElementById: function (id) {
      if (id === 'yScrim') return yScrim;
      return { classList: makeClassList(), innerHTML: '' };
    },
    // drawYesterCheck preserves .ySheet scrollTop across redraws; the stub
    // takes the truthy branch when a sheet is actually rendered.
    querySelector: function (sel) {
      if (sel === '.ySheet' && yScrim.innerHTML.indexOf('ySheet') !== -1) return { scrollTop: 0 };
      return null;
    }
  },
  console: console, JSON: JSON, Math: Math, Date: Date,
  Object: Object, Array: Array, Number: Number, String: String, Boolean: Boolean, Promise: Promise,
  toast: function (m) { toasts.push(String(m)); },
  render: function () { rendered++; },
  runCron: function () { croned++; },
  save: function () { saved++; },
  levelFlash: function () { flashed++; },
  idbOpen: function () { return Promise.resolve(null); },
  lastIssued: 0
};
sandbox.globalThis = sandbox;

const fn = new vm.Script(
  '(function(S, document, console, JSON, Math, Date, Object, Array, Number, String, Boolean, Promise, toast, render, runCron, save){ "use strict";\n' +
  code + '\n})'
).runInNewContext(sandbox);

const api = fn(
  sandbox.S, sandbox.document, sandbox.console, sandbox.JSON, sandbox.Math, sandbox.Date,
  sandbox.Object, sandbox.Array, sandbox.Number, sandbox.String, sandbox.Boolean, sandbox.Promise,
  sandbox.toast, sandbox.render, sandbox.runCron, sandbox.save
);

const { missedYesterdayDailies, openYesterCheck, toggleYesterTick, commitYesterCheck, esc } = api;

function freshDaily(id, title) {
  return { id: id, type: 'daily', title: title || ('Daily ' + id), difficulty: 'medium', value: 0,
           streak: 3, done: false, checklist: [], repeat: [1, 1, 1, 1, 1, 1, 1], history: [] };
}
function freshChar() { return { hp: 50, maxHp: 50, xp: 0, lvl: 1, gold: 0, mp: 0, name: 'Test', face: '🧙', cls: 'Wizard' }; }
function resetState() {
  S.prefs = { paused: false };
  S.lastCron = 0;
  S.char = freshChar();
  toasts.length = 0; saved = 0; croned = 0; rendered = 0;
  yScrim.classList.remove('show');
  yScrim.innerHTML = '';
}
function rowCount() { return yScrim.innerHTML.split('class="yItem').length - 1; }
function creditedCountFromToast() {
  const m = toasts.filter(function (s) { return /^Credited /.test(s); }).pop();
  if (!m) return null;
  const n = m.match(/^Credited (\d+) /);
  return n ? Number(n[1]) : null;
}

// =========================================================================
// Happy QA: two-daily fixture -- both rows + count present, toggle touches
// only its own note, commit closes the scrim.
// =========================================================================
{
  resetState();
  const t1 = freshDaily('m-a', 'Brush teeth');
  const t2 = freshDaily('m-b', 'Read pages');
  S.tasks = [t1, t2];

  const missed = missedYesterdayDailies();
  assert('happy setup: both dailies detected as missed', missed.length === 2);

  openYesterCheck(missed);
  assert('missed-count/row rendering: scrim shown on open', yScrim.classList.contains('show'));
  assert('missed-count/row rendering: count line names 2 dailies',
    yScrim.innerHTML.indexOf('You had 2 dailies') !== -1);
  assert('missed-count/row rendering: one row per missed daily', rowCount() === 2);
  assert('missed-count/row rendering: both titles present',
    yScrim.innerHTML.indexOf('Brush teeth') !== -1 && yScrim.innerHTML.indexOf('Read pages') !== -1);
  assert('missed-count/row rendering: commit affordance is "Start my day"',
    yScrim.innerHTML.indexOf('Start my day') !== -1);

  toggleYesterTick('m-a');
  const onNotes = yScrim.innerHTML.split('Will restore streak').length - 1;
  const offNotes = yScrim.innerHTML.split('Leave unticked').length - 1;
  assert('toggle state: exactly one row flipped on', onNotes === 1 && offNotes === 1);
  assert('toggle state: flipped row carries the tick mark',
    yScrim.innerHTML.indexOf('yItem on') !== -1 && yScrim.innerHTML.indexOf('✓') !== -1);
  assert('toggle state: unticked row keeps the miss note', offNotes === 1);

  toggleYesterTick('m-a'); // flip back
  assert('toggle state: second toggle restores the unticked note',
    (yScrim.innerHTML.split('Will restore streak').length - 1) === 0 &&
    (yScrim.innerHTML.split('Leave unticked').length - 1) === 2);

  toggleYesterTick('m-a');
  commitYesterCheck();
  assert('scrim lifecycle: scrim hidden after commit', !yScrim.classList.contains('show'));
  assert('scrim lifecycle: scrim html cleared after commit', yScrim.innerHTML === '');
  assert('happy commit: ticked daily credited, unticked untouched',
    t1.done === true && t1.streak === 4 && t2.done === false && t2.streak === 3);
  assert('happy commit: toast counts the actual credit (1)', creditedCountFromToast() === 1);
}

// =========================================================================
// Title escaping: a title with HTML metacharacters renders escaped.
// =========================================================================
{
  resetState();
  const nasty = 'X <b>"Q" & tail';
  const t = freshDaily('m-x', nasty);
  S.tasks = [t];

  openYesterCheck(missedYesterdayDailies());
  const expected = esc(nasty);
  assert('title escaping: escaped title present', yScrim.innerHTML.indexOf(expected) !== -1);
  assert('title escaping: raw metacharacters absent (no live <b>)',
    yScrim.innerHTML.indexOf('<b>') === -1 && yScrim.innerHTML.indexOf(nasty) === -1);
  assert('title escaping: single-daily count grammar ("1 daily ... isn\'t")',
    yScrim.innerHTML.indexOf('You had 1 daily') !== -1);
}

// =========================================================================
// Failure QA: vanished selected id + a not-due-yesterday daily -- no
// exception, vanished not credited, toast count equals actual credits.
// Fixed fixtures throughout (no Date.now dependence in test logic).
// =========================================================================
{
  resetState();
  const keep = freshDaily('f-keep', 'Keep me');
  const vanish = freshDaily('f-gone', 'Gone me');
  const notDue = freshDaily('f-notdue', 'Not due me');
  const yDow = (new Date().getDay() + 6) % 7; // yesterday's repeat column
  notDue.repeat = [1, 1, 1, 1, 1, 1, 1];
  notDue.repeat[yDow] = 0; // scheduled every day EXCEPT yesterday
  S.tasks = [keep, vanish, notDue];

  // Bypass the missed filter for the not-due daily (the filter would exclude
  // it); the modal must still survive it when ticked, per creditYesterday's
  // defense-in-depth skip.
  openYesterCheck([keep, vanish, notDue]);
  assert('failure setup: three rows rendered', rowCount() === 3);
  toggleYesterTick('f-keep');
  toggleYesterTick('f-gone');
  toggleYesterTick('f-notdue');

  S.tasks = [keep, notDue]; // f-gone vanishes (sync removal) while open

  let threw = false;
  try { commitYesterCheck(); } catch (e) { threw = true; }
  assert('failure QA: commit does not throw with a vanished ticked id', threw === false);
  assert('failure QA: surviving ticked daily credited', keep.done === true && keep.streak === 4);
  assert('failure QA: vanished id left untouched, never credited',
    vanish.done === false && vanish.streak === 3);
  assert('failure QA: not-due-yesterday tick is skipped, not credited',
    notDue.done === false && notDue.streak === 3);
  assert('failure QA: toast count equals actual credits (1, not 3)',
    creditedCountFromToast() === 1);
  assert('failure QA: scrim restored even on the partial-credit path',
    !yScrim.classList.contains('show') && yScrim.innerHTML === '');
}

// =========================================================================
// No-undo: this surface offers no undo action -- neither the modal markup
// nor any commit toast carries one (the yester flow is intentionally
// one-way; see quick-log's toastAction Undo for the surface that DOES).
// =========================================================================
{
  resetState();
  const t1 = freshDaily('u-a', 'Alpha');
  const t2 = freshDaily('u-b', 'Beta');
  S.tasks = [t1, t2];
  openYesterCheck(missedYesterdayDailies());
  const modalHtml = yScrim.innerHTML;
  toggleYesterTick('u-a');
  commitYesterCheck();
  assert('no-undo: modal markup carries no undo affordance',
    modalHtml.toLowerCase().indexOf('undo') === -1);
  assert('no-undo: no commit toast carries an undo affordance',
    toasts.every(function (m) { return m.toLowerCase().indexOf('undo') === -1; }));
  assert('no-undo: modal has no extra action buttons beyond Start my day',
    (modalHtml.match(/<button/g) || []).length === 1);
}

// Summary
if (failures > 0) {
  console.error('\n' + failures + ' test(s) failed');
  process.exit(1);
} else {
  console.log('\nAll morning-modal-render tests passed!');
}
