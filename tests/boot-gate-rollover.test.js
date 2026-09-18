// boot-gate-rollover.test.js -- todo 13 (D3): bootStartDay() gates ONLY the
// day-rollover decision, never the first paint, and routes BOTH boot branches
// through one once-only runner.
//
// Covers the plan's todo 11 acceptance criteria that need bootStartDay():
//   C1  ungated synchronous first paint (with sync configured)
//   C3  decision runs on post-sync state; runs exactly once even if both
//       triggers fire
//   C4  pre-reset t.done values survive -- a daily completed yesterday is NOT
//       reported missed (the regression test for the defect that blocked this
//       wave: it must FAIL against revision 4's reset-before-read ordering)
//   C5  the gate always ends -- on an UNCONFIGURED boot the cards are
//       interactive in the same synchronous task bootStartDay() returned in
// plus todo 13's own QA: the runner is the single entry point on BOTH branches,
// so a late onQuestaFirstSyncRound() after an unconfigured boot is a NO-OP.
//
// Why that last one matters (plan revision 6 fix 1): sync.js's boot gate calls
// syncInit() UNCONDITIONALLY, and syncInit() ends in setTimeout(syncNow, 2000)
// while syncNow() resolves immediately when not configured. So todo 14's callback
// fires ~2 s after EVERY boot, config or none. If the unconfigured branch called
// startDay() directly, _dayRolloverDone would stay false, the callback would run
// startDay() a SECOND time, openYesterCheck()'s `_yesterTick = {}` would wipe
// every tick the user made in those 2 seconds -- streak zeroed and HP damage on a
// daily the user actually completed. That is the F2 damage class this plan removes.
//
// FIXTURE CONSTRAINT (plan revision 6 fix 3): startDay() reaches runCron() only on
// the missed.length === 0 branch. Every S.lastCron assertion below therefore uses a
// fixture whose missed list is EMPTY ({type:'daily', done:true}). Where the missed
// list is deliberately non-empty, the observable is "openYesterCheck entered once"
// instead -- asserting S.lastCron there would fail a CORRECT implementation.
//
// Assertions are on observable state (S.lastCron, t.streak, t.done, captured
// events, _yesterTick, the paint order log), never on call counts (AGENTS.md S4).
//
// Run: node tests/boot-gate-rollover.test.js  (also run by node tests/run.js)

const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction, extractLine } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}
function grab(fn, label) {
  try { return fn(); }
  catch (e) { assert('extract ' + label + ' from app.js', false); return null; }
}

const P = {
  timeoutConst:  grab(() => extractLine(appSrc, /^var BOOT_ROLLOVER_TIMEOUT_MS\s*=/, 'BOOT_ROLLOVER_TIMEOUT_MS'), 'BOOT_ROLLOVER_TIMEOUT_MS'),
  bootState:     grab(() => extractLine(appSrc, /^var _bootRolloverT0\s*=/, '_bootRolloverT0/_dayRolloverDone'), '_bootRolloverT0 declaration'),
  pendingDecl:   grab(() => extractLine(appSrc, /^var _bootRolloverPending\s*=/, '_bootRolloverPending'), '_bootRolloverPending'),
  blocksInput:   grab(() => extractFunction(appSrc, /^function bootGateBlocksInput\(\)\{/, 'bootGateBlocksInput'), 'bootGateBlocksInput'),
  banner:        grab(() => extractFunction(appSrc, /^function _bootGateBanner\(\)\{/, '_bootGateBanner'), '_bootGateBanner'),
  cfgForBoot:    grab(() => extractFunction(appSrc, /^function _syncConfiguredForBoot\(\)\{/, '_syncConfiguredForBoot'), '_syncConfiguredForBoot'),
  shouldDefer:   grab(() => extractFunction(appSrc, /^function shouldDeferDayRollover\(/, 'shouldDeferDayRollover'), 'shouldDeferDayRollover'),
  runner:        grab(() => extractFunction(appSrc, /^function _runDayRollover\(\)\{/, '_runDayRollover'), '_runDayRollover'),
  firstRound:    grab(() => extractFunction(appSrc, /^function onQuestaFirstSyncRound\(\)\{/, 'onQuestaFirstSyncRound'), 'onQuestaFirstSyncRound'),
  bootStartDay:  grab(() => extractFunction(appSrc, /^function bootStartDay\(\)\{/, 'bootStartDay'), 'bootStartDay'),
  startDay:      grab(() => extractFunction(appSrc, /^function startDay\(\)\{/, 'startDay'), 'startDay'),
  resetDailies:  grab(() => extractFunction(appSrc, /^function _resetDailies\(\)\{/, '_resetDailies'), '_resetDailies'),
  runCron:       grab(() => extractFunction(appSrc, /^function runCron\(\)\{/, 'runCron'), 'runCron'),
  missed:        grab(() => extractFunction(appSrc, /^function missedYesterdayDailies\(\)\{/, 'missedYesterdayDailies'), 'missedYesterdayDailies'),
  dueOn:         grab(() => extractLine(appSrc, /^function isDailyDueOn\(/, 'isDailyDueOn'), 'isDailyDueOn'),
  dueToday:      grab(() => extractLine(appSrc, /^function isDailyDueToday\(/, 'isDailyDueToday'), 'isDailyDueToday'),
};

if (Object.keys(P).some(k => P[k] === null)) {
  console.error('\nFAILED: ' + failures + ' assertion(s) -- todo 13 symbols missing from app.js');
  process.exit(1);
}

const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// boot(opts) -- run bootStartDay() in a fresh sandbox.
//   configured : whether localStorage carries a usable questa.sync.v1
//   tasks      : fixture task list
//   cfgThrows  : make _syncConfiguredForBoot() throw, to prove the defensive
//                try/catch still rolls the day over
// setTimeout CAPTURES the callback instead of firing it, so the test controls
// when the fallback runs and can prove the paint happened before it.
// ---------------------------------------------------------------------------
function boot(opts) {
  opts = opts || {};
  const events = [];
  const bodyClasses = new Set();
  const order = [];          // paint / rollover ordering log
  const view = { innerHTML: '' };
  let timerFn = null, timerMs = null;
  let yesterOpened = 0;

  const S = {
    tasks: JSON.parse(JSON.stringify(opts.tasks || [
      { id: 'd1', type: 'daily', title: 'Meditate', done: true, streak: 9, value: 3,
        difficulty: 'medium', checklist: [], history: [] },
    ])),
    prefs: { paused: false, pausedDays: [] },
    char: { hp: 50, xp: 0, gold: 0, mp: 0, lvl: 1, updatedAt: 500 },
    lastCron: opts.lastCron || YESTERDAY,
  };

  const sb = {
    S, console, JSON, Math, Date, Number, String, Boolean, Array, Object,
    localStorage: { getItem: () => (opts.configured ? JSON.stringify({ enabled: true, refreshToken: 'r' }) : null) },
    setTimeout: (fn, ms) => { timerFn = fn; timerMs = ms; return 1; },
    clearTimeout: () => {},
    dayStamp: d => new Date(d).toISOString().slice(0, 10),
    document: { body: { classList: {
        toggle: (c, on) => { if (on) bodyClasses.add(c); else bodyClasses.delete(c); },
        add: c => bodyClasses.add(c), remove: c => bodyClasses.delete(c), contains: c => bodyClasses.has(c) } } },
    save: () => {}, toast: () => {}, takeDamage: d => { S.char.hp -= d; },
    logCharSnapshot: () => {}, logHistory: () => {},
    logEvent: e => { events.push(e); },
    missDamage: () => 1, valueDelta: () => 1,
    clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
    periodBoundaryCrossed: () => false,
    _yesterTick: {}, _yesterMissed: [],
    // Real render() is exercised in boot-gate-inert-cards.test.js; here it only
    // needs to log ordering and apply layer 2 the way render() does.
    render: () => {
      order.push('paint');
      view.innerHTML = sb._banner() + '<div class="task">card</div>';
      bodyClasses[sb._pending() ? 'add' : 'delete']('bootSyncing');
    },
    // Stubbed so the observable for a NON-EMPTY missed list is "entered once",
    // and so the tick-destruction the plan warns about stays visible: the real
    // openYesterCheck() does `_yesterTick = {}`.
    openYesterCheck: missed => { yesterOpened++; order.push('yesterCheck'); sb._yesterTick = {}; sb._yesterMissed = missed; },
  };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);

  let code = [
    P.pendingDecl, P.timeoutConst, P.bootState, P.blocksInput, P.banner,
    P.cfgForBoot, P.shouldDefer, P.dueOn, P.dueToday,
    P.missed, P.resetDailies, P.runCron, P.startDay,
    P.runner, P.firstRound, P.bootStartDay,
  ].join('\n');
  if (opts.cfgThrows) {
    code += '\n_syncConfiguredForBoot = function(){ throw new Error("boom"); };';
  }
  code += [
    '', 'this._pending=function(){ return _bootRolloverPending; };',
    'this._blocks=bootGateBlocksInput; this._banner=_bootGateBanner;',
    'this._bootStartDay=bootStartDay; this._firstRound=onQuestaFirstSyncRound;',
    'this._runner=_runDayRollover;',
    'this._done=function(){ return _dayRolloverDone; };',
  ].join('\n');
  vm.runInContext(code, sb);

  // _syncConfiguredForBoot is a function declaration, so the reassignment above
  // has to run before bootStartDay() -- it does; the call is here.
  sb._bootStartDay();

  return {
    S, sb, events, bodyClasses, order, view,
    fireTimer: () => { if (timerFn) timerFn(); },
    timerScheduled: () => timerFn !== null,
    timerMs: () => timerMs,
    yesterOpened: () => yesterOpened,
  };
}

// ---------------------------------------------------------------------------
// C1 -- ungated synchronous first paint, with sync configured.
// ---------------------------------------------------------------------------
{
  const b = boot({ configured: true });
  assert('C1a paint happened inside bootStartDay(), synchronously', b.order[0] === 'paint');
  assert('C1b #view is non-empty when bootStartDay() returned', /class="task"/.test(b.view.innerHTML));
  assert('C1c no rollover ran before the captured callback',
    b.order.indexOf('yesterCheck') === -1 && b.S.lastCron === YESTERDAY);
  assert('C1d the fallback timer WAS scheduled in the configured branch', b.timerScheduled());
  assert('C1e the fallback uses BOOT_ROLLOVER_TIMEOUT_MS (8000)', b.timerMs() === 8000);
  assert('C1f cards are inert during the gate', b.sb._blocks() === true && b.bodyClasses.has('bootSyncing'));
  assert('C1g the syncGate strip is painted', /class="syncGate"/.test(b.view.innerHTML));
}

// ---------------------------------------------------------------------------
// C3 -- the decision waits for a trigger, then runs EXACTLY ONCE even if both
// triggers fire. Empty-missed-list fixture, so S.lastCron is the observable.
// ---------------------------------------------------------------------------
{
  const b = boot({ configured: true });
  assert('C3a S.lastCron has NOT advanced while the gate is open', b.S.lastCron === YESTERDAY);
  b.sb._firstRound();                       // trigger 1: sync said the round settled
  assert('C3b S.lastCron advanced once the gate resolved', b.S.lastCron === TODAY);
  assert('C3c the gate cleared', b.sb._blocks() === false && !b.bodyClasses.has('bootSyncing'));
  const cronAfterFirst = b.S.lastCron;
  b.S.lastCron = YESTERDAY;                 // would advance again if the runner re-ran
  b.fireTimer();                            // trigger 2: the fallback timer
  assert('C3d second trigger is a no-op -- runCron did not run again', b.S.lastCron === YESTERDAY);
  b.sb._firstRound();
  assert('C3e third invocation is a no-op too', b.S.lastCron === YESTERDAY);
  assert('C3f (sanity) the first resolution really did advance the day', cronAfterFirst === TODAY);
}
{
  // Reverse trigger order: timer first, callback second.
  const b = boot({ configured: true });
  b.fireTimer();
  assert('C3g timer-first: S.lastCron advanced', b.S.lastCron === TODAY);
  b.S.lastCron = YESTERDAY;
  b.sb._firstRound();
  assert('C3h timer-first: the later callback is a no-op', b.S.lastCron === YESTERDAY);
}

// ---------------------------------------------------------------------------
// C4 -- REGRESSION for the defect that blocked this wave. A daily completed
// yesterday must NOT come back as missed. This is the test that fails against
// revision 4's ordering (_resetDailies() before missedYesterdayDailies() -> the
// missed list has length 1 -> HP damage, streak 0, a `miss` event and a push).
//
// The fixture daily has NO repeat array on purpose: isDailyDueOn is
// `!t.repeat || !!t.repeat[dow]`, so it is due EVERY day, which is what makes the
// yesterday-scheduled test fire regardless of what weekday the suite runs on.
// Do not "simplify" it away.
// ---------------------------------------------------------------------------
{
  const b = boot({
    configured: true,
    lastCron: YESTERDAY,
    tasks: [{ id: 'd1', type: 'daily', title: 'Meditate', done: true, streak: 9, value: 3,
              difficulty: 'medium', checklist: [], history: [] }],
  });
  b.sb._firstRound();
  const t = b.S.tasks[0];
  assert('C4a missed list was EMPTY -- openYesterCheck never opened', b.yesterOpened() === 0);
  assert('C4b streak preserved at 9', t.streak === 9);
  assert('C4c no `miss` event emitted', !b.events.some(e => e && e.kind === 'miss'));
  assert('C4d no HP damage taken', b.S.char.hp === 50);
  assert('C4e t.missedOn was not stamped', t.missedOn === undefined);
  assert('C4f the day rolled over (S.lastCron === today)', b.S.lastCron === TODAY);
  assert('C4g _resetDailies() ran BEHIND the gate -- done cleared for today', t.done === false);
}
{
  // Direction proof: the same fixture under revision 4's ordering DOES report the
  // completed daily as missed. Run the extracted functions with the reset moved in
  // front of the read, exactly as revision 4 mandated, and show length 1.
  const sb = {
    S: { tasks: [{ id: 'd1', type: 'daily', title: 'Meditate', done: true, streak: 9,
                   value: 3, difficulty: 'medium', checklist: [], history: [] }],
         prefs: { paused: false, pausedDays: [] }, char: {}, lastCron: YESTERDAY },
    console, JSON, Math, Date, Number, String, Boolean, Array, Object,
    dayStamp: d => new Date(d).toISOString().slice(0, 10),
  };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext([P.dueOn, P.dueToday, P.missed, P.resetDailies,
    'this._missedAfterReset=function(){ _resetDailies(); return missedYesterdayDailies().length; };',
    'this._missedBeforeReset=function(){ return missedYesterdayDailies().length; };'].join('\n'), sb);
  assert('C4h direction proof: missed list is 0 with direction C\'s ordering (read first)',
    sb._missedBeforeReset() === 0);
  assert('C4i direction proof: missed list is 1 with revision 4\'s ordering (reset first) -- the defect',
    sb._missedAfterReset() === 1);
}

// ---------------------------------------------------------------------------
// C5 -- THE GATE ALWAYS ENDS. Unconfigured boot: all three observables must be
// clear in the same synchronous task bootStartDay() returned in. This is the
// criterion that catches cards which never become interactive again.
// ---------------------------------------------------------------------------
{
  const b = boot({ configured: false });
  assert('C5a bootGateBlocksInput() is false right after bootStartDay() returned', b.sb._blocks() === false);
  assert('C5b body.classList has no bootSyncing', !b.bodyClasses.has('bootSyncing'));
  assert('C5c the rendered view has no class="syncGate"', !/class="syncGate"/.test(b.view.innerHTML));
  assert('C5d the day rolled over synchronously (S.lastCron advanced)', b.S.lastCron === TODAY);
  assert('C5e no fallback timer was scheduled on the unconfigured branch', !b.timerScheduled());
  assert('C5f the view is populated', /class="task"/.test(b.view.innerHTML));
}
{
  // C5, second half: same three observables after the CONFIGURED gate resolves.
  const b = boot({ configured: true });
  b.sb._firstRound();
  assert('C5g configured boot, gate resolved: bootGateBlocksInput() false', b.sb._blocks() === false);
  assert('C5h configured boot, gate resolved: no bootSyncing class', !b.bodyClasses.has('bootSyncing'));
  assert('C5i configured boot, gate resolved: no syncGate strip', !/class="syncGate"/.test(b.view.innerHTML));
}

// ---------------------------------------------------------------------------
// R1 -- THE RUNNER IS THE SINGLE ENTRY POINT ON BOTH BRANCHES (revision 6 fix 1).
// After an UNCONFIGURED boot, sync.js still fires todo 14's callback ~2 s later.
// It must be a NO-OP: _dayRolloverDone was already set by the synchronous path.
// Observable: _yesterTick is not wiped and openYesterCheck is not re-entered.
// ---------------------------------------------------------------------------
{
  // Non-empty missed list -> the morning modal opens once. S.lastCron correctly
  // stays at yesterday until commitYesterCheck() runs, so it is NOT the observable
  // here (plan revision 6 fix 3).
  const b = boot({
    configured: false,
    lastCron: YESTERDAY,
    tasks: [{ id: 'd1', type: 'daily', title: 'Meditate', done: false, streak: 12, value: 5,
              difficulty: 'medium', checklist: [], history: [] }],
  });
  assert('R1a unconfigured boot with a real miss: openYesterCheck entered exactly once', b.yesterOpened() === 1);
  assert('R1b _dayRolloverDone was set by the synchronous path', b.sb._done() === true);
  assert('R1c S.lastCron correctly still at yesterday (modal open, commit pending)', b.S.lastCron === YESTERDAY);

  // The user now ticks the daily in the modal.
  b.sb._yesterTick = { d1: true };
  // ~2 s later sync.js fires the callback anyway (syncInit runs unconditionally).
  b.sb._firstRound();
  assert('R1d late callback is a NO-OP: openYesterCheck NOT re-entered', b.yesterOpened() === 1);
  assert('R1e late callback did NOT wipe _yesterTick -- the user\'s tick survives',
    b.sb._yesterTick && b.sb._yesterTick.d1 === true);
  assert('R1f _bootRolloverPending is false on the unconfigured path', b.sb._pending() === false);
}

// ---------------------------------------------------------------------------
// R2 -- defensive: if _syncConfiguredForBoot() ever throws, the day must STILL
// roll over. Treating a throw as "not configured" is what guarantees it; without
// the try/catch neither trigger fires and the day never rolls over -- the worst
// failure mode in the plan.
// ---------------------------------------------------------------------------
{
  const b = boot({ configured: true, cfgThrows: true });
  assert('R2a a throwing _syncConfiguredForBoot() still rolls the day over', b.S.lastCron === TODAY);
  assert('R2b and leaves no stuck gate', b.sb._blocks() === false && !b.bodyClasses.has('bootSyncing'));
}

// ---------------------------------------------------------------------------
// S1 -- the two IMPORT call sites of startDay() must stay untouched, and the boot
// call must be bootStartDay(). Asserted on app.js's source: exactly one
// top-level `bootStartDay();` and the import sites still call startDay().
// ---------------------------------------------------------------------------
{
  // Strip line comments before counting: the new code's own prose mentions
  // "startDay()" repeatedly, and a comment is not a call site.
  const stripComments = s => s.replace(/\/\/[^\n\r]*/g, '');
  const bare = stripComments(appSrc);
  assert('S1a exactly one top-level bootStartDay(); boot call',
    (bare.match(/^bootStartDay\(\);/gm) || []).length === 1);
  assert('S1b no top-level startDay(); boot call remains',
    (bare.match(/^startDay\(\);/gm) || []).length === 0);
  // The two import-flow call sites sit at 12 spaces of indentation inside the
  // import callbacks. They must stay byte-identical -- only the boot call changed.
  // 2026-09-18 (granular import): this used to pin the two import-flow sites by
  // their INDENTATION (`^ {12}startDay\(\);`). The granular export/import work
  // lifted that code out of the nested confirmDialog closure inside importData()
  // and into a top-level `applyImportSections()`, so both sites are now at 4
  // spaces. The indentation was always a proxy for "these two calls still exist
  // on the import path"; assert that directly instead, which is what S1c is
  // actually protecting and what survives the next refactor too.
  assert('S1c the two import-flow startDay() call sites survive untouched',
    (stripComments(extractFunction(appSrc, /^async function applyImportSections\(data, keys, mode\)\{/, 'applyImportSections'))
      .match(/(?<![A-Za-z_$])startDay\(\)/g) || []).length === 2);
  // Total startDay() call sites: 2 imports + exactly 1 from the runner.
  // Excludes the `function startDay(){` declaration itself.
  assert('S1d exactly three startDay() call sites in total (2 import + 1 runner)',
    (bare.match(/(?<!function )(?<![A-Za-z_$])startDay\(\)/g) || []).length === 3);
  assert('S1e bootStartDay() never calls startDay() directly -- only via the runner',
    !/(?<![A-Za-z_$])startDay\(\)/.test(stripComments(P.bootStartDay)));
  assert('S1f the runner calls startDay()', /(?<![A-Za-z_$])startDay\(\)/.test(stripComments(P.runner)));
  // 2026-09-18 (round 2): this used to pin the literal count at 2 (defer-branch
  // timer + synchronous fallback). bootStartDay now has a THIRD path: when sync is
  // not configured it still waits for reconcileDurableState() before rolling over,
  // because _runDayRollover -> startDay -> runCron ends in save(), and a save() that
  // lands before reconcile rewrites the IDB mirror and destroys the newer copy the
  // mirror exists to rescue. A raw count was always a proxy; what matters is that
  // every exit path goes through the runner and none calls startDay() directly
  // (S1e/S1f), so assert the floor and check each path explicitly.
  {
    const bs = stripComments(P.bootStartDay);
    assert('S1g bootStartDay() reaches the runner on every branch',
      (bs.match(/_runDayRollover/g) || []).length >= 3);
    assert('S1g-i the deferred branch still schedules the guaranteed timer',
      /setTimeout\(_runDayRollover,\s*BOOT_ROLLOVER_TIMEOUT_MS\)/.test(bs));
    assert('S1g-ii the not-configured branch waits for reconcileDurableState',
      /reconcileDurableState\(\)\.then\(_runDayRollover,\s*_runDayRollover\)/.test(bs));
    assert('S1g-iii a final unconditional fallback still exists',
      /\n\s*_runDayRollover\(\);\s*\n\}/.test(P.bootStartDay));
  }
  assert('S1h BOOT_ROLLOVER_TIMEOUT_MS is a named constant, not a bare literal',
    /^var BOOT_ROLLOVER_TIMEOUT_MS\s*=\s*8000\s*;/.test(stripComments(P.timeoutConst).trim()));
}

// ---------------------------------------------------------------------------
if (failures) {
  console.error('\nFAILED: ' + failures + ' assertion(s)');
  process.exit(1);
}
console.log('\nALL BOOT-GATE-ROLLOVER TESTS PASSED');
process.exit(0);
