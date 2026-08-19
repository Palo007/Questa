// boot-gate-sync-callback.test.js -- todo 14 (D3): sync.js fires app.js's
// onQuestaFirstSyncRound() when the first sync round settles, so the boot
// day-rollover decision runs on POST-sync state.
//
// Site: the `setTimeout(() => syncNow(), 2000)` at the end of syncInit().
//
// syncNow() ALWAYS fulfils and never rejects: four early exits all return promises
// (offline -> Promise.resolve(); not configured -> Promise.resolve(); _syncInFlight
// -> the in-flight chain; and a .catch() that swallows failures into a normal
// resolution), plus two normal terminal returns (the navigator.locks branch and the
// plain `return _doSync();`). So the rollover proceeds after a FAILED round too --
// that is required, not incidental. Idempotence is app.js's _dayRolloverDone flag,
// not sync.js's job.
//
// The change is written defensively anyway: capture syncNow()'s return value in a
// try, attach the fire function as BOTH handlers if it is thenable, and fire
// immediately if it is not thenable or the call threw. A naive `.then()` on an
// `undefined` return would throw inside a timer callback and the day would never
// roll over.
//
// NEW STUB PLUMBING (there was no pattern to copy): every existing test touching
// syncInit stubs setTimeout to NEVER fire, on purpose. This file's stub CAPTURES
// every scheduled callback with its delay so the test can invoke the 2000 ms one
// by hand. Written once here and reused across all five cases below.
//
// END-TO-END SHAPE: sync.js runs in its own vm sandbox with the REAL
// onQuestaFirstSyncRound from app.js injected as a global (extracted into a second
// context, so the two files' top-level declarations cannot collide). The observable
// is therefore app.js's own S.lastCron advancing -- not "a function was called"
// (AGENTS.md S4).
//
// FIXTURE CONSTRAINT (plan revision 6 fix 3): startDay() reaches runCron() only on
// the missed.length === 0 branch, so every case uses a single
// {type:'daily', done:true} task. On a non-empty missed list S.lastCron correctly
// stays at yesterday until commitYesterCheck() runs, and asserting it would fail a
// CORRECT implementation.
//
// Run: node tests/boot-gate-sync-callback.test.js  (also run by node tests/run.js)

const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction, extractLine } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const syncSrcRaw = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// A. The app side: a real onQuestaFirstSyncRound() over the real runner /
//    startDay() / runCron() / _resetDailies(), in its own context.
// ---------------------------------------------------------------------------
function makeAppSide() {
  const S = {
    tasks: [{ id: 'd1', type: 'daily', title: 'Meditate', done: true, streak: 9, value: 3,
              difficulty: 'medium', checklist: [], history: [] }],
    prefs: { paused: false, pausedDays: [] },
    char: { hp: 50, xp: 0, gold: 0, mp: 0, lvl: 1 },
    lastCron: YESTERDAY,
  };
  const events = [];
  const bodyClasses = new Set();
  let timerFn = null;
  const sb = {
    S, console, JSON, Math, Date, Number, String, Boolean, Array, Object,
    localStorage: { getItem: () => JSON.stringify({ enabled: true, refreshToken: 'r' }) },
    setTimeout: fn => { timerFn = fn; return 1; }, clearTimeout: () => {},
    dayStamp: d => new Date(d).toISOString().slice(0, 10),
    document: { body: { classList: {
      toggle: (c, on) => { if (on) bodyClasses.add(c); else bodyClasses.delete(c); },
      add: c => bodyClasses.add(c), remove: c => bodyClasses.delete(c), contains: c => bodyClasses.has(c) } } },
    save: () => {}, toast: () => {}, takeDamage: d => { S.char.hp -= d; },
    logCharSnapshot: () => {}, logHistory: () => {}, logEvent: e => events.push(e),
    missDamage: () => 1, valueDelta: () => 1,
    clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
    periodBoundaryCrossed: () => false,
    render: () => {}, openYesterCheck: () => {},
  };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  const code = [
    extractLine(appSrc, /^var _bootRolloverPending\s*=/, '_bootRolloverPending'),
    extractLine(appSrc, /^var BOOT_ROLLOVER_TIMEOUT_MS\s*=/, 'BOOT_ROLLOVER_TIMEOUT_MS'),
    extractLine(appSrc, /^var _bootRolloverT0\s*=/, '_bootRolloverT0'),
    extractFunction(appSrc, /^function bootGateBlocksInput\(\)\{/, 'bootGateBlocksInput'),
    extractFunction(appSrc, /^function _bootGateBanner\(\)\{/, '_bootGateBanner'),
    extractFunction(appSrc, /^function _syncConfiguredForBoot\(\)\{/, '_syncConfiguredForBoot'),
    extractFunction(appSrc, /^function shouldDeferDayRollover\(/, 'shouldDeferDayRollover'),
    extractLine(appSrc, /^function isDailyDueOn\(/, 'isDailyDueOn'),
    extractLine(appSrc, /^function isDailyDueToday\(/, 'isDailyDueToday'),
    extractFunction(appSrc, /^function missedYesterdayDailies\(\)\{/, 'missedYesterdayDailies'),
    extractFunction(appSrc, /^function _resetDailies\(\)\{/, '_resetDailies'),
    extractFunction(appSrc, /^function runCron\(\)\{/, 'runCron'),
    extractFunction(appSrc, /^function startDay\(\)\{/, 'startDay'),
    extractFunction(appSrc, /^function _runDayRollover\(\)\{/, '_runDayRollover'),
    extractFunction(appSrc, /^function onQuestaFirstSyncRound\(\)\{/, 'onQuestaFirstSyncRound'),
    extractFunction(appSrc, /^function bootStartDay\(\)\{/, 'bootStartDay'),
    'this._firstRound=onQuestaFirstSyncRound; this._bootStartDay=bootStartDay;',
    'this._pending=function(){ return _bootRolloverPending; };',
  ].join('\n');
  vm.runInContext(code, sb);
  sb._bootStartDay();           // configured boot -> the gate is now open
  return { S, sb, events, bodyClasses, appTimer: () => timerFn };
}

// ---------------------------------------------------------------------------
// B. The sync side. setTimeout CAPTURES every callback with its delay.
// ---------------------------------------------------------------------------
let syncSrc = syncSrcRaw.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');

function makeSyncSide(opts) {
  const noop = function () {};
  const timers = [];                     // [{fn, ms}] -- capture, never auto-fire
  const store = {
    'questa.sync.v1': JSON.stringify({
      enabled: true, appKey: 'k', refreshToken: 'rt', accessToken: 'at',
      accessExpiresAt: Date.now() + 3600000, deviceId: 'dev-1',
      evtLastUploadTs: 0, evtFileRevs: {}, evtLastPullAt: 0,
    }),
  };
  const sandbox = {
    window: { addEventListener: noop, removeEventListener: noop },
    navigator: { onLine: opts.online !== false },
    document: {
      addEventListener: noop, getElementById: () => null,
      createElement: () => ({ style: {}, appendChild: noop, setAttribute: noop, click: noop }),
      body: { appendChild: noop, removeChild: noop },
      visibilityState: 'visible',
    },
    location: { search: '' },
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
      removeItem: k => { delete store[k]; },
      key: () => null, length: 0,
    },
    indexedDB: { open: () => ({}) },
    setTimeout: (fn, ms) => { timers.push({ fn: fn, ms: ms }); return timers.length; },
    clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    console, JSON, Math, Date, Map, Set, WeakSet, Promise,
    Array, Object, Number, String, Boolean,
    logEvent: noop, toast: noop, render: noop, esc: x => x, save: noop,
    uid: () => 'test-uid',
    idbOpen: () => new Promise(() => {}),        // never settles -- irrelevant here
    fetch: () => new Promise(() => {}),
    onQuestaFirstSyncRound: opts.callback,       // <-- the real app.js function
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(syncSrc, sandbox);
  // Top-level `function syncNow(){...}` is a global property of the sandbox, so
  // the timer callback's `syncNow()` lookup resolves to this override.
  sandbox.syncNow = opts.syncNow;
  sandbox.syncInit();
  const boot = timers.filter(t => t.ms === 2000);
  return { sandbox, timers, bootTimers: boot };
}

// ---------------------------------------------------------------------------
// Shared driver: boot the app (gate open), boot sync, fire the 2000 ms timer.
// ---------------------------------------------------------------------------
function runCase(label, syncNowImpl, opts) {
  opts = opts || {};
  const app = makeAppSide();
  const before = app.S.lastCron;
  const sync = makeSyncSide({ callback: app.sb._firstRound, syncNow: syncNowImpl, online: opts.online });
  return { app, sync, before };
}

// Every case's assertions are the same three observables, so drive them together.
function expectRollover(label, c, thenable) {
  assert(label + ': gate was OPEN before the round settled (S.lastCron at yesterday)',
    c.before === YESTERDAY);
  assert(label + ': exactly one 2000 ms boot timer was scheduled by syncInit()',
    c.sync.bootTimers.length === 1);
  if (c.sync.bootTimers.length !== 1) return;
  c.sync.bootTimers[0].fn();
  if (thenable) {
    // The fire is attached as a promise handler, so let the microtask queue drain.
    return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve()).then(() => {
      assert(label + ': S.lastCron advanced to today -- the day rolled over', c.app.S.lastCron === TODAY);
      assert(label + ': the inert-card gate was released', c.app.sb._pending() === false);
      assert(label + ': streak preserved at 9 (no phantom miss)', c.app.S.tasks[0].streak === 9);
      assert(label + ': no `miss` event emitted', !c.app.events.some(e => e && e.kind === 'miss'));
    });
  }
  assert(label + ': S.lastCron advanced to today SYNCHRONOUSLY (non-thenable path)', c.app.S.lastCron === TODAY);
  assert(label + ': the inert-card gate was released', c.app.sb._pending() === false);
  assert(label + ': streak preserved at 9 (no phantom miss)', c.app.S.tasks[0].streak === 9);
  return Promise.resolve();
}

// ---------------------------------------------------------------------------
(async function main() {
  // T1 -- SUCCESS: syncNow() fulfils normally.
  await expectRollover('T1 success', runCase('T1', () => Promise.resolve()), true);

  // T2 -- INTERNAL FAILURE: the real syncNow() swallows failures into a normal
  // resolution, but the fire is attached as BOTH handlers so even a hypothetical
  // rejection still rolls the day over. This is the assertion that pins that.
  await expectRollover('T2 internal failure (rejected promise)',
    runCase('T2', () => Promise.reject(new Error('round failed'))), true);

  // T3 -- OFFLINE: syncNow()'s offline early exit returns Promise.resolve().
  await expectRollover('T3 offline', runCase('T3', () => Promise.resolve(), { online: false }), true);

  // T4 -- syncNow() returns a NON-THENABLE (undefined). A naive `.then()` would
  // throw inside the timer callback and the day would never roll over.
  await expectRollover('T4 non-thenable return (undefined)', runCase('T4', () => undefined), false);

  // T5 -- syncNow() THROWS synchronously. Must still fire.
  await expectRollover('T5 syncNow() throws', runCase('T5', () => { throw new Error('boom'); }), false);

  // T6 -- a throw inside onQuestaFirstSyncRound() must not escape syncInit()'s
  // timer (AGENTS.md S1: a broken app.js must never break sync.js).
  {
    const sync = makeSyncSide({
      callback: () => { throw new Error('app.js exploded'); },
      syncNow: () => Promise.resolve(),
    });
    assert('T6: one 2000 ms boot timer scheduled', sync.bootTimers.length === 1);
    let threw = false;
    try { sync.bootTimers[0].fn(); } catch (e) { threw = true; }
    await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
    assert('T6: a throwing callback does not escape the timer', threw === false);
  }

  // T7 -- IDEMPOTENCE is app.js's job, not sync.js's: firing the boot timer twice
  // must not roll the day over twice.
  {
    const c = runCase('T7', () => Promise.resolve());
    c.sync.bootTimers[0].fn();
    await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
    assert('T7: first fire rolled the day over', c.app.S.lastCron === TODAY);
    c.app.S.lastCron = YESTERDAY;            // would advance again if the runner re-ran
    c.sync.bootTimers[0].fn();
    await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
    assert('T7: a second fire is a no-op (_dayRolloverDone)', c.app.S.lastCron === YESTERDAY);
  }

  // T8 -- the guard shape itself: sync.js must not reference the callback
  // unguarded, or a build without app.js's function would throw.
  {
    assert('T8a sync.js guards the callback with typeof',
      /typeof\s+onQuestaFirstSyncRound\s*===\s*["']function["']/.test(syncSrcRaw));
    assert('T8b sync.js attaches the fire as BOTH promise handlers',
      /\.then\(\s*fire\s*,\s*fire\s*\)/.test(syncSrcRaw));
  }

  if (failures) {
    console.error('\nFAILED: ' + failures + ' assertion(s)');
    process.exit(1);
  }
  console.log('\nALL BOOT-GATE-SYNC-CALLBACK TESTS PASSED');
  process.exit(0);
})().catch(e => {
  console.error('\nERROR: ' + (e && e.stack || e));
  process.exit(1);
});
