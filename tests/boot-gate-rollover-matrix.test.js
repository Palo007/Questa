// boot-gate-rollover-matrix.test.js -- morning-rollover todo 3: the complete
// boot/sync trigger matrix with quick-log drain coverage.
//
// Covers configured/unconfigured boot x fast sync, failed/throwing sync,
// non-thenable return, and a reconcile promise that never settles. Asserts
// first paint is synchronous, the app 8-second fallback and sync 2-second
// callback can both fire, _runDayRollover() runs at most once,
// _dayRolloverDone latches, _bootRolloverPending/bootSyncing always clear,
// and _drainPendingQuickLog() runs after startDay() exactly once. Structural
// assertions pin that every boot branch reaches _runDayRollover() and no boot
// branch calls startDay() directly.
//
// Method: real app.js functions via tests/_extract.js anchors (no line-range
// grabs); sync.js's 2-second timer body is replicated verbatim (fire +
// thenable-check + both-handlers attach) and its shape is pinned structurally
// against the real sync.js source. Fake timers capture callbacks -- no real
// 8-second wait. Observables are order/state/HTML/class, never call counts
// alone (AGENTS.md: assert on observable effects).
//
// FIXTURE CONSTRAINT (same as boot-gate-rollover.test.js): startDay() reaches
// runCron() only on the missed.length === 0 branch, so every lastCron case
// uses {type:'daily', done:true}. Non-empty-missed cases assert on
// openYesterCheck entry instead.
//
// Run: node tests/boot-gate-rollover-matrix.test.js (also run by tests/run.js)

const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction, extractLine } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const syncSrcRaw = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}
function grab(fn, label) {
  try { return fn(); }
  catch (e) { assert('extract ' + label + ' from app.js [' + (e && e.message) + ']', false); return null; }
}

const P = {
  timeoutConst:  grab(() => extractLine(appSrc, /^var BOOT_ROLLOVER_TIMEOUT_MS\s*=/, 'BOOT_ROLLOVER_TIMEOUT_MS'), 'BOOT_ROLLOVER_TIMEOUT_MS'),
  bootState:     grab(() => extractLine(appSrc, /^var _bootRolloverT0\s*=/, '_bootRolloverT0/_dayRolloverDone'), '_bootRolloverT0 declaration'),
  pendingDecl:   grab(() => extractLine(appSrc, /^var _bootRolloverPending\s*=/, '_bootRolloverPending'), '_bootRolloverPending'),
  quickPendDecl: grab(() => extractLine(appSrc, /^var _pendingQuickLog\s*=/, '_pendingQuickLog'), '_pendingQuickLog'),
  drainFn:       grab(() => extractFunction(appSrc, /^function _drainPendingQuickLog\(\)\{/, '_drainPendingQuickLog'), '_drainPendingQuickLog'),
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
  localDay:      grab(() => extractFunction(appSrc, /^function localDayDateAtOffset\(/, 'localDayDateAtOffset'), 'localDayDateAtOffset'),
};

if (Object.keys(P).some(k => P[k] === null)) {
  console.error('\nFAILED: ' + failures + ' assertion(s) -- todo 3 symbols missing from app.js');
  process.exit(1);
}

const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const tick = () => Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve()).then(() => Promise.resolve());

// ---------------------------------------------------------------------------
// bootEnv(opts) -- boot bootStartDay() in a fresh sandbox with fake timers.
//
// opts.configured  : localStorage carries usable questa.sync.v1
// opts.tasks        : fixture task list (default: single done daily)
// opts.lastCron     : initial S.lastCron (default YESTERDAY)
// opts.reconcile    : 'resolve' | 'never' | 'reject' | 'throw' | 'absent'
// opts.syncNowImpl  : function installed as syncNow() for the 2s timer
// opts.online       : unused by app side, kept for parity labelling
//
// Both the app 8s fallback and the sync 2s callback land in timers[] with
// their delays; nothing auto-fires. The sync timer body replicates sync.js
// verbatim (typeof-guarded fire, try/catch around syncNow(), thenable check,
// .then(fire, fire) both-handlers attach, immediate fire otherwise).
// ---------------------------------------------------------------------------
function bootEnv(opts) {
  opts = opts || {};
  const events = [];
  const bodyClasses = new Set();
  const order = [];
  const view = { innerHTML: '' };
  const timers = [];
  let yesterOpened = 0;
  let startDayCount = 0;
  let drainCount = 0;
  const scoreCalls = [];
  let reconcileCalls = 0;
  let reconcileResolve = null;
  const reconMode = opts.reconcile || 'resolve';

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
    S, console, JSON, Math, Date, Number, String, Boolean, Array, Object, Promise,
    localStorage: { getItem: () => (opts.configured ? JSON.stringify({ enabled: true, refreshToken: 'r' }) : null) },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
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
    applyQuickIntent: (p) => { scoreCalls.push(p); order.push('score'); return true; },
    render: () => {
      order.push('paint');
      view.innerHTML = sb._banner() + '<div class="task">card</div>';
      bodyClasses[sb._pending() ? 'add' : 'delete']('bootSyncing');
    },
    openYesterCheck: missed => { yesterOpened++; order.push('yesterCheck'); sb._yesterTick = {}; sb._yesterMissed = missed; },
  };
  // reconcileDurableState per mode. 'absent' leaves it undefined so the final
  // synchronous fallback path is exercised.
  if (reconMode === 'resolve') {
    sb.reconcileDurableState = () => { reconcileCalls++; return Promise.resolve(); };
  } else if (reconMode === 'never') {
    sb.reconcileDurableState = () => { reconcileCalls++; return new Promise(() => {}); };
  } else if (reconMode === 'reject') {
    sb.reconcileDurableState = () => { reconcileCalls++; return Promise.reject(new Error('reconcile failed')); };
  } else if (reconMode === 'throw') {
    sb.reconcileDurableState = () => { reconcileCalls++; throw new Error('reconcile threw'); };
  } else if (reconMode === 'manual') {
    sb.reconcileDurableState = () => { reconcileCalls++; return new Promise(res => { reconcileResolve = res; }); };
  }
  sb.window = sb; sb.globalThis = sb;
  // Shared observability globals: the wrappers below run in-context and must
  // reach the same array/counters the outer stubs use. vm shares object
  // references across the boundary (same pattern as S/events in existing
  // boot-gate tests), so alias them here before contextifying.
  sb.__order = order;
  sb.__sc = { n: 0 };
  sb.__dc = { n: 0 };
  vm.createContext(sb);

  const code = [
    P.pendingDecl, P.timeoutConst, P.bootState, P.quickPendDecl, P.drainFn,
    P.blocksInput, P.banner, P.cfgForBoot, P.shouldDefer, P.dueOn, P.dueToday,
    P.localDay, P.missed, P.resetDailies, P.runCron, P.startDay, P.runner, P.firstRound, P.bootStartDay,
  ].join('\n');
  vm.runInContext(code, sb);
  // Wrap by-name callees so the once-only runner's calls land in __order and
  // the counters, while still executing the real extracted bodies.
  vm.runInContext([
    'var _origStartDayFn = startDay;',
    'startDay = function(){ __sc.n++; __order.push("startDay"); return _origStartDayFn(); };',
    'var _origDrainFn = _drainPendingQuickLog;',
    '_drainPendingQuickLog = function(){ __dc.n++; var r = _origDrainFn(); __order.push("drain"); return r; };',
  ].join('\n'), sb);
  // (Necessary note: wrappers must live in-context because _runDayRollover
  // resolves startDay/_drainPendingQuickLog by sandbox-global name at call
  // time; an outer closure cannot intercept that lookup.)
  vm.runInContext([
    'this._pending=function(){ return _bootRolloverPending; };',
    'this._blocks=bootGateBlocksInput; this._banner=_bootGateBanner;',
    'this._bootStartDay=bootStartDay; this._firstRound=onQuestaFirstSyncRound;',
    'this._runner=_runDayRollover;',
    'this._done=function(){ return _dayRolloverDone; };',
    'this._stashQuick=function(){ _pendingQuickLog = { kind: "habit", id: "h1", dir: 1 }; };',
    'this._manualDrain=function(){ return _drainPendingQuickLog(); };',
  ].join('\n'), sb);

  sb._bootStartDay();

  const appTimers = () => timers.filter(t => t.ms === 8000);
  // syncNow impl for the 2s callback; default fast resolve.
  const syncNowImpl = opts.syncNowImpl || (() => Promise.resolve());
  function fireSyncCallback() {
    // Verbatim sync.js 2s-timer shape: guarded fire, try/catch, thenable check.
    const fire = function() {
      try { if (typeof sb._firstRound === 'function') sb._firstRound(); } catch (e) {}
    };
    let p;
    try { p = syncNowImpl(); } catch (e) { fire(); return; }
    if (p && typeof p.then === 'function') return p.then(fire, fire);
    fire();
  }
  function scheduleSyncTimer() { timers.push({ fn: fireSyncCallback, ms: 2000 }); }

  return {
    S, sb, events, bodyClasses, order, view, timers,
    appTimers, scheduleSyncTimer, fireSyncCallback,
    fireAppTimer: () => { appTimers().forEach(t => t.fn()); },
    yesterOpened: () => yesterOpened,
    startDayCount: () => sb.__sc.n,
    drainCount: () => sb.__dc.n,
    scoreCalls, reconcileCalls: () => reconcileCalls,
    resolveReconcile: () => { if (reconcileResolve) reconcileResolve(); },
  };
}

function gateClear(env) {
  return env.sb._pending() === false && !env.bodyClasses.has('bootSyncing') &&
    !/class="syncGate"/.test(env.view.innerHTML) && env.sb._blocks() === false;
}

(async function main() {
  // -- Happy: configured fast sync -----------------------------------------
  {
    const env = bootEnv({ configured: true, syncNowImpl: () => Promise.resolve() });
    assert('H1 configured: first paint synchronous (order[0] paint)', env.order[0] === 'paint');
    assert('H1 configured: view populated at paint', /class="task"/.test(env.view.innerHTML));
    assert('H1 configured: gate open before triggers (lastCron yesterday)', env.S.lastCron === YESTERDAY);
    assert('H1 configured: 8s fallback scheduled', env.appTimers().length === 1 && env.appTimers()[0].ms === 8000);
    assert('H1 configured: cards inert + gate strip while pending',
      env.sb._blocks() === true && env.bodyClasses.has('bootSyncing') && /class="syncGate"/.test(env.view.innerHTML));
    env.scheduleSyncTimer();
    assert('H1 configured: both triggers scheduled (8s app + 2s sync)',
      env.timers.some(t => t.ms === 8000) && env.timers.some(t => t.ms === 2000));
    await env.fireSyncCallback(); await tick(); // callback-first
    assert('H1 configured: callback-first lastCron advanced once', env.S.lastCron === TODAY);
    assert('H1 configured: paint precedes rollover', env.order.indexOf('paint') < env.order.indexOf('startDay'));
    assert('H1 configured: drain ran after startDay exactly once',
      env.drainCount() === 1 && env.order.indexOf('startDay') < env.order.indexOf('drain'));
    assert('H1 configured: runner once (startDay x1)', env.startDayCount() === 1);
    assert('H1 configured: done latched + gate clear', env.sb._done() === true && gateClear(env));
    assert('H1 configured: streak preserved, no miss event',
      env.S.tasks[0].streak === 9 && !env.events.some(e => e && e.kind === 'miss'));
  }
  // -- Happy: configured timer-first ordering --------------------------------
  {
    const env = bootEnv({ configured: true, syncNowImpl: () => Promise.resolve() });
    env.scheduleSyncTimer();
    env.fireAppTimer(); await tick(); // timer-first
    assert('H2 timer-first: lastCron advanced', env.S.lastCron === TODAY);
    assert('H2 timer-first: paint precedes rollover', env.order.indexOf('paint') < env.order.indexOf('startDay'));
    env.S.lastCron = YESTERDAY;
    await env.fireSyncCallback(); await tick();
    assert('H2 timer-first: later sync callback is a no-op', env.S.lastCron === YESTERDAY && env.startDayCount() === 1);
    assert('H2 timer-first: gate stays clear', gateClear(env));
  }
  // -- Happy: unconfigured resolving reconcile --------------------------------
  {
    const env = bootEnv({ configured: false, reconcile: 'resolve' });
    assert('H3 unconfigured: first paint synchronous', env.order[0] === 'paint');
    assert('H3 unconfigured: 8s fallback still scheduled', env.appTimers().length === 1);
    await tick(); // reconcile resolves -> runner
    assert('H3 unconfigured: resolving reconcile rolls over (lastCron today)', env.S.lastCron === TODAY);
    assert('H3 unconfigured: paint precedes rollover', env.order.indexOf('paint') < env.order.indexOf('startDay'));
    assert('H3 unconfigured: gate clears', gateClear(env) && env.sb._done() === true);
    assert('H3 unconfigured: runner once', env.startDayCount() === 1);
    env.S.lastCron = YESTERDAY;
    env.fireAppTimer(); await tick();
    assert('H3 unconfigured: later 8s timer is a no-op', env.S.lastCron === YESTERDAY && env.startDayCount() === 1);
  }
  // -- Failure: never-settling reconcile -> 8s fallback releases ---------------
  {
    const env = bootEnv({ configured: false, reconcile: 'never' });
    await tick();
    assert('F1 hung reconcile: gate still open (lastCron yesterday)', env.S.lastCron === YESTERDAY && env.sb._pending() === true);
    env.fireAppTimer(); await tick();
    assert('F1 hung reconcile: 8s fallback releases the gate', env.S.lastCron === TODAY && gateClear(env));
    assert('F1 hung reconcile: runner once, drain once', env.startDayCount() === 1 && env.drainCount() === 1);
    env.S.lastCron = YESTERDAY;
    env.sb._firstRound(); await tick(); // late sync callback after fallback
    assert('F1 hung reconcile: late callback is a no-op', env.S.lastCron === YESTERDAY && env.startDayCount() === 1);
    assert('F1 hung reconcile: no stuck bootSyncing', !env.bodyClasses.has('bootSyncing') && env.sb._pending() === false);
  }
  // -- Failure: throwing syncNow + second callback -----------------------------
  {
    const env = bootEnv({ configured: true, syncNowImpl: () => { throw new Error('boom'); } });
    env.scheduleSyncTimer();
    await env.fireSyncCallback(); await tick();
    assert('F2 throwing syncNow: gate still releases (lastCron today)', env.S.lastCron === TODAY && gateClear(env));
    assert('F2 throwing syncNow: runner once', env.startDayCount() === 1);
    env.S.lastCron = YESTERDAY;
    await env.fireSyncCallback(); await tick();
    assert('F2 throwing syncNow: second callback is a no-op', env.S.lastCron === YESTERDAY && env.startDayCount() === 1);
  }
  // -- Failure: rejected syncNow (both-handlers attach) -------------------------
  {
    const env = bootEnv({ configured: true, syncNowImpl: () => Promise.reject(new Error('round failed')) });
    env.scheduleSyncTimer();
    await env.fireSyncCallback(); await tick();
    assert('F3 rejected syncNow: both-handlers still roll over', env.S.lastCron === TODAY && gateClear(env));
    assert('F3 rejected syncNow: streak preserved, no miss', env.S.tasks[0].streak === 9);
  }
  // -- Failure: non-thenable syncNow return ------------------------------------
  {
    const env = bootEnv({ configured: true, syncNowImpl: () => undefined });
    env.scheduleSyncTimer();
    await env.fireSyncCallback(); await tick();
    assert('F4 non-thenable syncNow: synchronous release (lastCron today)', env.S.lastCron === TODAY && gateClear(env));
    assert('F4 non-thenable syncNow: runner once', env.startDayCount() === 1);
  }
  // -- Idempotence: duplicate triple-fire --------------------------------------
  {
    const env = bootEnv({ configured: true, syncNowImpl: () => Promise.resolve() });
    env.scheduleSyncTimer();
    await env.fireSyncCallback(); await tick();
    env.fireAppTimer(); await tick();
    await env.fireSyncCallback(); await tick();
    assert('I1 triple-fire: lastCron advanced by first trigger only', env.S.lastCron === TODAY);
    assert('I1 triple-fire: startDay ran at most once', env.startDayCount() === 1);
    assert('I1 triple-fire: drain ran at most once', env.drainCount() === 1);
    assert('I1 triple-fire: done latched + gate clear', env.sb._done() === true && gateClear(env));
  }
  // -- Drain-once: stashed quick-log scores once, no duplicate ------------------
  {
    const env = bootEnv({ configured: true, syncNowImpl: () => Promise.resolve() });
    env.sb._stashQuick(); // deep-link arrives while the gate holds
    assert('D1 drain: nothing scored while gate pending', env.scoreCalls.length === 0);
    env.scheduleSyncTimer();
    await env.fireSyncCallback(); await tick();
    assert('D1 drain: stashed intent scored exactly once after startDay', env.scoreCalls.length === 1);
    assert('D1 drain: drain after startDay in order log',
      env.order.indexOf('startDay') !== -1 && env.order.indexOf('startDay') < env.order.indexOf('drain'));
    const again = env.sb._manualDrain();
    assert('D1 drain: second manual drain is a no-op (null, no duplicate score)',
      again === null && env.scoreCalls.length === 1);
    assert('D1 drain: drain wrapper ran but applied once (no duplicate quick-log score)',
      env.drainCount() === 2 && env.scoreCalls.length === 1);
  }
  // -- Structural: every boot branch reaches the runner; none calls startDay ----
  {
    const strip = s => s.replace(/\/\/[^\n\r]*/g, '');
    const bare = strip(appSrc);
    const bs = strip(P.bootStartDay);
    const rn = strip(P.runner);
    assert('S1 every boot branch reaches _runDayRollover (>=3 sites)', (bs.match(/_runDayRollover/g) || []).length >= 3);
    assert('S1 deferred branch schedules the guaranteed 8s timer',
      /setTimeout\(_runDayRollover,\s*BOOT_ROLLOVER_TIMEOUT_MS\)/.test(bs));
    assert('S1 not-configured branch waits for reconcileDurableState',
      /reconcileDurableState\(\)\.then\(_runDayRollover,\s*_runDayRollover\)/.test(bs));
    assert('S1 final unconditional fallback exists', /\n\s*_runDayRollover\(\);\s*\n\}/.test(P.bootStartDay));
    assert('S1 no boot branch calls startDay() directly', !/(?<![A-Za-z_$])startDay\(\)/.test(bs));
    assert('S1 runner calls startDay() before the guarded quick-log drain',
      rn.indexOf('startDay()') !== -1 && rn.indexOf('startDay()') < rn.indexOf('_drainPendingQuickLog'));
    assert('S1 production timeout unchanged (8000)',
      /^var BOOT_ROLLOVER_TIMEOUT_MS\s*=\s*8000\s*;/.test(strip(P.timeoutConst).trim()));
    assert('S1 predicate signature keeps three args',
      /^function shouldDeferDayRollover\(cfgConnected,\s*elapsedMs,\s*timeoutMs\)\{/.test(P.shouldDefer.trim()));
    assert('S1 sync.js keeps the guarded 2s callback with both handlers',
      /typeof\s+onQuestaFirstSyncRound\s*===\s*["']function["']/.test(syncSrcRaw) &&
      /\.then\(\s*fire\s*,\s*fire\s*\)/.test(syncSrcRaw) && /, 2000\)/.test(syncSrcRaw));
    assert('S1 no second rollover entry point (single _runDayRollover def)',
      (bare.match(/function _runDayRollover\(\)\{/g) || []).length === 1);
  }

  if (failures) {
    console.error('\nFAILED: ' + failures + ' assertion(s)');
    process.exit(1);
  }
  console.log('\nALL BOOT-GATE-ROLLOVER-MATRIX TESTS PASSED');
  process.exit(0);
})().catch(e => {
  console.error('\nERROR: ' + (e && e.stack || e));
  process.exit(1);
});
