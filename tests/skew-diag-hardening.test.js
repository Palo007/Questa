// skew-diag-hardening.test.js -- J1 (todo 18): four hardening fixes to the
// _skewDiag* region of sync.js. DIAGNOSTIC-ONLY: no merge result may change.
//
// Source: .omo/plans/REVIEW-CODE-D1D2D4-20260818.md findings 3, 4, 7 and 8.
//
//  F4  NON-MUTATING CLOCK. _skewDiagNote()'s threshold test called _hlcNow(),
//      which is bound to app.js's now() and is NOT a pure read: it does
//      lastIssued = Math.max(p, lastIssued+1) and persists S.__hlcLast. So every
//      noted record advanced the HLC and wrote it. Fix: capture the threshold ONCE
//      in _skewDiagReset() as Date.now() + MAX_FUTURE_SKEW_MS and compare against
//      that stored number. NOT a literal no-op -- the stored boundary is not the
//      same number as the ratcheting _hlcNow() one, so which records get noted
//      shifts slightly. Diagnostic-only and acceptable.
//      SCOPE WARNING: _hlcNow() has four call sites -- _ua, _ca, _clampFuture and
//      _skewDiagNote. ONLY THE LAST IS IN SCOPE. _ua/_ca run on every record of
//      every merge, so a whole-merge() HLC-purity assertion cannot pass in wave 2
//      and is deliberately NOT attempted here: everything below drives
//      _skewDiagReset/_skewDiagNote/_skewDiagFlush DIRECTLY, outside merge().
//      The other three are the inverted-polarity clamp operands the plan's Scope
//      forbids touching, because a 0 there DESTROYS data.
//
//  F3  CROSS-ROUND THROTTLE. There was none. merge() runs once per round and again
//      on a conflict retry, SYNC_DEBOUNCE_MS is 5000, and _qDiagPush is a 50-entry
//      ring with blind FIFO eviction -- so a peer more than 120 s fast flushed 4-8
//      entries per round and evicted every uncaught-error and evtWatermarkRepaired
//      record in roughly 7-13 rounds. Fix: mirror the _evtPullLastThrottleDiag
//      pattern with a PER-KIND last-pushed timestamp.
//
//  F7  skewDeviceMerge.n IS NOT A DEVICE COUNT. In cleanDevices the note sat AFTER
//      the `if(!prev){ ... return; }` early return, so it only ever observed
//      duplicate-id entries and a skewed device with a unique id was never
//      reported; meanwhile mergeDevices noted l and r per id and then called
//      cleanDevices(out), re-noting every survivor. The same aggregate
//      under-counted and double-counted at once.
//
//  F8  try/finally. If merge() threw between _skewDiagReset() and
//      _skewDiagFlush(), _skewDiag stayed non-null; cleanDevices is also reachable
//      from syncSubset()/syncApply() outside any merge round, so those calls then
//      wrote into the orphaned object and were misattributed to a later round.
//
// Run: node tests/skew-diag-hardening.test.js  (also run by node tests/run.js)

const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction } = require('./_extract');

let SRC = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
SRC = SRC.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

// ---------------------------------------------------------------------------
// Sandbox. Two injections that no existing sync.js test makes:
//   1. a MUTATING now() -- the real app.js HLC, ratcheting and persisting
//      S.__hlcLast -- so _hlcNow() binds to it and F4's mutation is observable.
//   2. a fake Date whose now() the test controls, so F3's throttle window can be
//      stepped deterministically instead of waited out.
// ---------------------------------------------------------------------------
const RealDate = Date;

function loadModule() {
  const noop = function () {};
  const diag = [];
  const hlc = { lastIssued: 0, calls: 0 };
  const clock = { t: 1700000000000 };            // fixed, test-controlled

  const FakeDate = function (a, b, c, d, e, f, g) {
    if (!(this instanceof FakeDate)) return RealDate(a);
    switch (arguments.length) {
      case 0: return new RealDate(clock.t);
      case 1: return new RealDate(a);
      case 2: return new RealDate(a, b);
      case 3: return new RealDate(a, b, c);
      default: return new RealDate(a, b, c, d, e, f, g);
    }
  };
  FakeDate.now = () => clock.t;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.prototype = RealDate.prototype;

  const S = { __hlcLast: 0 };

  const sandbox = {
    window: { addEventListener: noop }, navigator: { onLine: true },
    document: { addEventListener: noop, getElementById: () => null,
      createElement: () => ({ style: {}, appendChild: noop, setAttribute: noop, click: noop }),
      body: { appendChild: noop, removeChild: noop } },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop, key: () => null, length: 0 },
    indexedDB: { open: () => ({}) },
    setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    console, JSON, Math, Date: FakeDate, Map, Set, WeakSet,
    Array, Object, Number, String, Boolean, Promise,
    S,
    logEvent: noop, toast: noop, render: noop, esc: x => x, save: noop, uid: () => 'x',
    idbOpen: () => Promise.resolve(null),
    // The REAL app.js HLC shape: ratchets and persists. _hlcNow() binds to this
    // (sync.js: `var _hlcNow = (typeof now==='function') ? now : ...`).
    now: function () {
      hlc.calls++;
      const p = FakeDate.now();
      hlc.lastIssued = Math.max(p, hlc.lastIssued + 1);
      S.__hlcLast = hlc.lastIssued;
      return hlc.lastIssued;
    },
  };
  sandbox.window.__qDiag = { errors: diag };
  sandbox._qDiagPush = function (kind, data) {
    try {
      diag.push(Object.assign({ t: FakeDate.now(), kind: kind }, data));
      if (diag.length > 50) diag.shift();
    } catch (e) {}
  };
  sandbox.self = sandbox.window;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  try { vm.runInContext(SRC, sandbox); } catch (e) { /* QuestaSync assigned before any throwable boot code */ }
  const Q = sandbox.window.QuestaSync;
  if (!Q || typeof Q.merge !== 'function') {
    console.error('FAIL: QuestaSync.merge not found in sync.js');
    process.exit(1);
  }
  return { Q, sandbox, diag, hlc, clock, S };
}

const countKind = (arr, k) => arr.filter(e => e && e.kind === k).length;
const ofKind = (arr, k) => arr.filter(e => e && e.kind === k);

// A timestamp comfortably beyond the 120 s tolerance from the fixed clock.
const SKEWED = 1700000000000 + 10 * 60 * 1000;

// ===========================================================================
// F4 -- the diagnostic is a PURE READ. Driven DIRECTLY, outside merge().
// ===========================================================================
{
  const m = loadModule();
  const hlcBefore = m.hlc.lastIssued, storedBefore = m.S.__hlcLast, callsBefore = m.hlc.calls;

  m.sandbox._skewDiagReset();
  for (let i = 0; i < 25; i++) m.sandbox._skewDiagNote('skewCharGuard', SKEWED + i, 'c' + i);
  m.sandbox._skewDiagFlush();

  assert('F4a 25 notes leave the HLC lastIssued unchanged', m.hlc.lastIssued === hlcBefore);
  assert('F4b 25 notes leave S.__hlcLast unchanged (nothing persisted)', m.S.__hlcLast === storedBefore);
  assert('F4c the diagnostic never called the mutating now() at all', m.hlc.calls === callsBefore);
  // The diagnostic must still WORK -- purity is not achieved by noting nothing.
  const rec = ofKind(m.diag, 'skewCharGuard');
  assert('F4d the round still emitted one skewCharGuard record', rec.length === 1);
  assert('F4e ...counting all 25 skewed notes', rec.length === 1 && rec[0].n === 25);
  assert('F4f ...with the largest raw ts as maxTs', rec.length === 1 && rec[0].maxTs === SKEWED + 24);
  // Below the threshold nothing is noted.
  m.sandbox._skewDiagReset();
  m.sandbox._skewDiagNote('skewCharGuard', m.clock.t + 1000, 'near');
  m.sandbox._skewDiagFlush();
  assert('F4g an unskewed ts is still not noted', countKind(m.diag, 'skewCharGuard') === 1);
}
{
  // Acceptance, stated as a grep in the plan: no _hlcNow() inside _skewDiagNote.
  const noteSrc = extractFunction(SRC, /^function _skewDiagNote\(/, '_skewDiagNote');
  assert('F4h _skewDiagNote() contains no _hlcNow() call', !/_hlcNow\(/.test(noteSrc));
  const resetSrc = extractFunction(SRC, /^function _skewDiagReset\(\)\{/, '_skewDiagReset');
  assert('F4i the threshold is stamped in _skewDiagReset(), per ROUND', /MAX_FUTURE_SKEW_MS/.test(resetSrc));
  // QA failure mode from the plan: captured at module load instead of per round
  // means a long-lived tab compares against a stale boundary. Proven by stepping
  // the clock a day forward and checking the boundary moved with it.
  const m = loadModule();
  m.clock.t += 86400000;
  m.sandbox._skewDiagReset();
  m.sandbox._skewDiagNote('skewCharGuard', SKEWED, 'stale-boundary-probe');
  m.sandbox._skewDiagFlush();
  assert('F4j the threshold follows the clock -- a day-old skewed ts is NOT noted now',
    countKind(m.diag, 'skewCharGuard') === 0);
}

// ===========================================================================
// F3 -- cross-round throttle, keyed PER KIND. Assert on the RECORDS WRITTEN,
// not on a call count.
// ===========================================================================
{
  const m = loadModule();
  const ROUNDS = 20;
  for (let r = 0; r < ROUNDS; r++) {
    m.sandbox._skewDiagReset();
    m.sandbox._skewDiagNote('skewChecklistSurvivor', SKEWED, 's1');
    m.sandbox._skewDiagNote('skewDeviceMerge', SKEWED, 'd1');
    m.sandbox._skewDiagFlush();
  }
  assert('F3a 20 rounds inside one window write ONE skewChecklistSurvivor record',
    countKind(m.diag, 'skewChecklistSurvivor') === 1);
  assert('F3b keyed PER KIND: skewDeviceMerge is not suppressed by the other kind',
    countKind(m.diag, 'skewDeviceMerge') === 1);
  assert('F3c total records bounded by kinds x windows (2), not rounds (20)', m.diag.length === 2);

  // Step past the window: it is a throttle, not a permanent block.
  m.clock.t += 60001;
  m.sandbox._skewDiagReset();
  m.sandbox._skewDiagNote('skewChecklistSurvivor', m.clock.t + 10 * 60 * 1000, 's2');
  m.sandbox._skewDiagFlush();
  assert('F3d a new window emits again (throttle, not a permanent block)',
    countKind(m.diag, 'skewChecklistSurvivor') === 2);

  // And immediately after that, suppressed again.
  m.sandbox._skewDiagReset();
  m.sandbox._skewDiagNote('skewChecklistSurvivor', m.clock.t + 10 * 60 * 1000, 's3');
  m.sandbox._skewDiagFlush();
  assert('F3e the reopened window closes again', countKind(m.diag, 'skewChecklistSurvivor') === 2);
}

// ===========================================================================
// F7 -- skewDeviceMerge.n is a DEVICE COUNT. Merge results must be bit-for-bit
// unchanged; only the count moves.
// ===========================================================================
function subState(o) {
  return Object.assign({
    tasks: [], rewards: [], tags: [], devices: [],
    an: { views: [], metrics: [] },
    history: [], charHistory: [], monthlyBackups: [],
    char: { id: 'c', name: 'H', xp: 0, gold: 0, mp: 0, hp: 50, lvl: 1, updatedAt: 1 },
    deletions: [], lastCron: 0, prefs: {},
  }, o || {});
}
{
  // A: exactly ONE skewed device with a UNIQUE id (remote-only, absent from base).
  // Today it is reported as 0 -- the note sits after cleanDevices' early return
  // and mergeDevices' l-side note sees null.
  const m = loadModule();
  const base = subState({ devices: [] });
  const local = subState({ devices: [] });
  const remote = subState({ devices: [{ id: 'devX', name: 'Phone', updatedAt: SKEWED }] });
  const merged = m.Q.merge(base, local, remote, m.clock.t, m.clock.t, 'devLocal', 'devRemote');
  const rec = ofKind(m.diag, 'skewDeviceMerge');
  assert('F7a one skewed unique-id device is reported at all', rec.length === 1);
  assert('F7b ...with n === 1 (a true device count)', rec.length === 1 && rec[0].n === 1);
  assert('F7c ...and worstId names the device', rec.length === 1 && rec[0].worstId === 'devX');
  assert('F7d merge result unchanged: the skewed device still survives',
    merged.devices.length === 1 && merged.devices[0].id === 'devX');
  assert('F7e ...and keeps its raw unclamped updatedAt (never clamped to 0)',
    merged.devices[0].updatedAt === SKEWED);
}
{
  // B: the SAME skewed device id on both sides -- today double-counted (l and r
  // both noted for one id). Must report 1.
  const m = loadModule();
  const base = subState({ devices: [{ id: 'devY', name: 'Old', updatedAt: 5 }] });
  const local = subState({ devices: [{ id: 'devY', name: 'Laptop', updatedAt: SKEWED }] });
  const remote = subState({ devices: [{ id: 'devY', name: 'Tablet', updatedAt: SKEWED + 1 }] });
  const merged = m.Q.merge(base, local, remote, m.clock.t, m.clock.t, 'devLocal', 'devRemote');
  const rec = ofKind(m.diag, 'skewDeviceMerge');
  assert('F7f a skewed id present on both sides is reported once', rec.length === 1);
  assert('F7g ...with n === 1, not 2 (no double-count)', rec.length === 1 && rec[0].n === 1);
  assert('F7h merge result unchanged: exactly one devY survives', merged.devices.length === 1);
  assert('F7i ...and the higher updatedAt still wins (arbitration untouched)',
    merged.devices[0].name === 'Tablet');
}
{
  // C: two distinct skewed devices -> n === 2. Proves it counts devices, not sides.
  const m = loadModule();
  const base = subState({ devices: [] });
  const local = subState({ devices: [{ id: 'devA', name: 'A', updatedAt: SKEWED }] });
  const remote = subState({ devices: [{ id: 'devB', name: 'B', updatedAt: SKEWED + 5 }] });
  const merged = m.Q.merge(base, local, remote, m.clock.t, m.clock.t, 'devLocal', 'devRemote');
  const rec = ofKind(m.diag, 'skewDeviceMerge');
  assert('F7j two distinct skewed devices report n === 2', rec.length === 1 && rec[0].n === 2);
  assert('F7k merge result unchanged: both survive', merged.devices.length === 2);
}
{
  // D: an UNSKEWED device is never noted.
  const m = loadModule();
  const base = subState({ devices: [] });
  const local = subState({ devices: [] });
  const remote = subState({ devices: [{ id: 'devZ', name: 'Fine', updatedAt: 1699999999000 }] });
  m.Q.merge(base, local, remote, m.clock.t, m.clock.t, 'devLocal', 'devRemote');
  assert('F7l an unskewed device produces no skewDeviceMerge record',
    countKind(m.diag, 'skewDeviceMerge') === 0);
}

// ===========================================================================
// F8 -- the flush runs in a finally. `finally`, never `catch`: swallowing the
// exception would change the caller's error handling.
// ===========================================================================
{
  const m = loadModule();
  // mergeCollection is a top-level declaration, so it is a sandbox global and can
  // be replaced to force a throw from inside merge()'s body.
  m.sandbox.mergeCollection = function () { throw new Error('forced merge failure'); };
  let threw = false, msg = '';
  try {
    m.Q.merge(subState(), subState(), subState(), m.clock.t, m.clock.t, 'dL', 'dR');
  } catch (e) { threw = true; msg = String(e && e.message); }
  assert('F8a the throw still PROPAGATES to the caller (finally, not catch)', threw === true);
  assert('F8b ...unchanged', /forced merge failure/.test(msg));
  assert('F8c _skewDiag is null again after the throwing round', m.sandbox._skewDiag === null);
  // The orphan is gone, so a later out-of-round note accumulates nothing and
  // cannot be misattributed to the next round's flush.
  const diagBefore = m.diag.length;
  m.sandbox._skewDiagNote('skewDeviceMerge', SKEWED, 'orphan');
  m.sandbox._skewDiagFlush();
  assert('F8d an out-of-round note after the throw accumulates nothing', m.diag.length === diagBefore);
}
{
  // F8, the real-world route: cleanDevices() is reachable from syncSubset() and
  // syncApply() outside any merge round. After a throwing merge it must not write
  // into an orphaned _skewDiag.
  const m = loadModule();
  m.sandbox.mergeCollection = function () { throw new Error('boom'); };
  try { m.Q.merge(subState(), subState(), subState(), m.clock.t, m.clock.t, 'dL', 'dR'); } catch (e) {}
  const before = m.diag.length;
  m.sandbox.cleanDevices([{ id: 'devQ', name: 'Q', updatedAt: SKEWED }]);
  assert('F8e a post-throw cleanDevices() call notes nothing (no orphan)', m.diag.length === before);
  assert('F8f ...and _skewDiag is still null', m.sandbox._skewDiag === null);
}

// ===========================================================================
if (failures) {
  console.error('\nFAILED: ' + failures + ' assertion(s)');
  process.exit(1);
}
console.log('\nALL SKEW-DIAG-HARDENING TESTS PASSED');
process.exit(0);
