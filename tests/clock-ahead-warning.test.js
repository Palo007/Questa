// clock-ahead-warning.test.js -- PWA-23 (design_D7_warnings.md): warn the user when
// THIS device's clock is ahead of Dropbox's by more than the clamp window.
//
// Why it matters: sync.js clamps any stamp more than HLC_RATCHET_TOLERANCE_MS in the
// future (_clampFuture). A device whose clock runs fast writes stamps its peers clamp,
// so its edits can lose to OLDER edits from the other devices. sync.js is kept
// byte-identical (owner rule: keep legacy sync logic, add app-side warnings only), so
// app.js observes dbxUpload's return value (files/upload metadata, server_modified)
// through a pass-through wrapper installed after sync.js has loaded.
//
//   T1  _clockAheadMs is a LOWER bound (t0 - server - 1000); the warn threshold is
//       exactly HLC_RATCHET_TOLERANCE_MS; unparseable input -> null, no warning
//   T2  wrapper returns the SAME object, alerts once with the minutes figure, and the
//       24 h throttle stops a second alert (idempotent across conflict retries)
//   T3  a rejection passes through as the IDENTICAL error object (instanceof kept),
//       no alert; installing twice leaves exactly one wrapper; `this` and args kept
//   T4  clock 30 s ahead -> no alert, no _qDiagPush('clockAhead')
//   T5  a throwing localStorage still throttles (in-memory fallback)
//   T6  the probe does not call now() (the now()-slice trap) and HLC constant is not
//       redeclared as a second literal
//
// The coupling to sync.js itself is guarded separately in
// tests/clock-upload-coupling-guard.test.js.
//
// Run: node tests/clock-ahead-warning.test.js  (also run by node tests/run.js)
const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction, extractLine } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

const tolLine = extractLine(appSrc, /^const HLC_RATCHET_TOLERANCE_MS = /, 'HLC_RATCHET_TOLERANCE_MS');
const keyLine = extractLine(appSrc, /^const CLOCK_AHEAD_WARN_KEY = /, 'CLOCK_AHEAD_WARN_KEY');
const everyLine = extractLine(appSrc, /^const CLOCK_AHEAD_WARN_EVERY_MS = /, 'CLOCK_AHEAD_WARN_EVERY_MS');
const memLine = extractLine(appSrc, /^var _clockAheadWarnedMem = /, '_clockAheadWarnedMem');
const aheadFn = extractFunction(appSrc, /^function _clockAheadMs\(t0Local, serverModifiedIso\)\{/, '_clockAheadMs');
const noteFn = extractFunction(appSrc, /^function _noteClockSample\(t0Local, serverModifiedIso\)\{/, '_noteClockSample');
const installFn = extractFunction(appSrc, /^function _installClockProbe\(\)\{/, '_installClockProbe');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

const SERVER_ISO = '2026-09-26T10:00:00Z';
const SERVER_MS = Date.parse(SERVER_ISO);

function makeCtx(opts) {
  opts = opts || {};
  const calls = { alert: [], diag: [], orig: [] };
  const store = {};
  const clock = { t: opts.now != null ? opts.now : SERVER_MS };
  const sandbox = {
    console: console,
    Date: (function () {
      function D() { return new (Function.prototype.bind.apply(Date, [null].concat([].slice.call(arguments))))(); }
      D.now = function () { return clock.t; };
      D.parse = Date.parse; D.UTC = Date.UTC; D.prototype = Date.prototype;
      return D;
    })(),
    alertDialog: function (title, text) { calls.alert.push({ title: title, text: text }); return Promise.resolve(); },
    _qDiagPush: function (kind, data) { calls.diag.push({ kind: kind, data: data }); },
    localStorage: opts.throwingStorage
      ? { getItem: function () { throw new Error('blocked'); }, setItem: function () { throw new Error('blocked'); } }
      : { getItem: function (k) { return k in store ? store[k] : null; }, setItem: function (k, v) { store[k] = String(v); } },
    now: function () { throw new Error('probe must not call now()'); },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext('class ConflictError extends Error{ constructor(m){ super(m); this.name="ConflictError"; } }\n' +
                  'globalThis.ConflictError = ConflictError;', sandbox);
  const orig = opts.orig || function (p, w, rev) {
    calls.orig.push({ self: this, args: [].slice.call(arguments) });
    return Promise.resolve('result' in opts ? opts.result : { rev: 'r1', server_modified: SERVER_ISO });
  };
  sandbox.dbxUpload = orig;
  vm.runInContext([tolLine, keyLine, everyLine, memLine, aheadFn, noteFn, installFn].join('\n'), sandbox);
  return { sandbox: sandbox, calls: calls, clock: clock, store: store, orig: orig };
}

async function main() {
  // ---------------- T1: the pure lower-bound function + threshold ----------------
  {
    const c = makeCtx();
    const f = c.sandbox._clockAheadMs;
    const TOL = vm.runInContext('HLC_RATCHET_TOLERANCE_MS', c.sandbox);
    assert('T1a: tolerance read from HLC_RATCHET_TOLERANCE_MS (120000)', TOL === 120000);
    assert('T1b: t0 = server + 5 min -> >= 299000', f(SERVER_MS + 300000, SERVER_ISO) >= 299000);
    assert('T1c: result is exactly t0 - server - 1000 (lower bound for the 1 s truncation)',
      f(SERVER_MS + 300000, SERVER_ISO) === 299000);
    assert('T1d: unparseable ISO -> null', f(SERVER_MS, 'not a date') === null);
    assert('T1e: missing ISO -> null', f(SERVER_MS, undefined) === null);
    assert('T1f: non-finite t0 -> null', f(NaN, SERVER_ISO) === null);
    assert('T1g: clock behind -> negative', f(SERVER_MS - 60000, SERVER_ISO) < 0);

    function warns(delta) {
      const k = makeCtx({ now: SERVER_MS + delta });
      k.sandbox._noteClockSample(SERVER_MS + delta, SERVER_ISO);
      return k.calls.alert.length === 1;
    }
    assert('T1h: t0 - server = 5 min warns', warns(300000));
    assert('T1i: t0 - server = 60 s does not warn', !warns(60000));
    assert('T1j: boundary 121500 (lower bound 120500) warns', warns(121500));
    assert('T1k: boundary 120900 (lower bound 119900) does not warn', !warns(120900));
    assert('T1l: exactly 121000 (lower bound == tolerance) does not warn (strict >)', !warns(121000));
    assert('T1m: bad ISO never warns', (function () {
      const k = makeCtx({ now: SERVER_MS + 3600000 });
      k.sandbox._noteClockSample(SERVER_MS + 3600000, 'garbage');
      return k.calls.alert.length === 0 && k.calls.diag.length === 0;
    })());
  }

  // ---------------- T2: integration through the installed wrapper ----------------
  {
    const result = { rev: 'r1', server_modified: SERVER_ISO };
    const c = makeCtx({ now: SERVER_MS + 5 * 60000, result: result });
    const installed = c.sandbox._installClockProbe();
    assert('T2a: install reports true', installed === true);
    assert('T2b: global dbxUpload replaced by a marked wrapper',
      c.sandbox.dbxUpload !== c.orig && c.sandbox.dbxUpload.__clockProbe === true);
    const r = await c.sandbox.dbxUpload('/state.json', { a: 1 }, 'rev0');
    assert('T2c: wrapper resolves with the SAME object', r === result);
    assert('T2d: original called once with the same args',
      c.calls.orig.length === 1 && c.calls.orig[0].args[0] === '/state.json' && c.calls.orig[0].args[2] === 'rev0');
    assert('T2e: alertDialog called once', c.calls.alert.length === 1);
    assert('T2f: text says the clock is about 5 minutes ahead',
      c.calls.alert.length === 1 && /clock is about 5 minutes ahead/.test(c.calls.alert[0].text));
    assert('T2g: title is "Clock ahead"', c.calls.alert.length === 1 && c.calls.alert[0].title === 'Clock ahead');
    assert('T2h: one _qDiagPush("clockAhead") with aheadMs',
      c.calls.diag.length === 1 && c.calls.diag[0].kind === 'clockAhead' && c.calls.diag[0].data.aheadMs === 299000);
    assert('T2i: warned-at stored under questa.clockAheadWarnedAt',
      c.store['questa.clockAheadWarnedAt'] === String(SERVER_MS + 5 * 60000));
    // A conflict retry / second round in the same period: no second alert.
    await c.sandbox.dbxUpload('/state.json', { a: 2 }, 'r1');
    c.clock.t += 60 * 60000; // one hour later, still inside 24 h
    await c.sandbox.dbxUpload('/state.json', { a: 3 }, 'r1');
    assert('T2j: throttled -- still exactly one alert and one diag entry',
      c.calls.alert.length === 1 && c.calls.diag.length === 1);
    c.clock.t += 24 * 3600000; // a day later
    await c.sandbox.dbxUpload('/state.json', { a: 4 }, 'r1');
    assert('T2k: after 24 h it may warn again', c.calls.alert.length === 2);
  }

  // ---------------- T3: pass-through of errors, this, double install ----------------
  {
    let thrown = null;
    const c = makeCtx({
      now: SERVER_MS + 10 * 60000,
      orig: function () { thrown = new c.sandbox.ConflictError('upload conflict: rev'); return Promise.reject(thrown); },
    });
    c.sandbox._installClockProbe();
    const first = c.sandbox.dbxUpload;
    assert('T3a: second install is a no-op (returns false)', c.sandbox._installClockProbe() === false);
    assert('T3b: exactly one wrapper (global unchanged by the second install)', c.sandbox.dbxUpload === first);
    let caught = null;
    try { await c.sandbox.dbxUpload('/state.json', {}, 'r0'); } catch (e) { caught = e; }
    assert('T3c: rejects with the IDENTICAL error object', caught !== null && caught === thrown);
    assert('T3d: instanceof ConflictError preserved', caught instanceof c.sandbox.ConflictError);
    assert('T3e: no alert on failure', c.calls.alert.length === 0);

    const c2 = makeCtx();
    c2.sandbox._installClockProbe();
    const self = { tag: 'me' };
    await c2.sandbox.dbxUpload.call(self, 'p', 'w', 'r', true, 'tok');
    assert('T3f: `this` and all five args passed through',
      c2.calls.orig[0].self === self && c2.calls.orig[0].args.length === 5 && c2.calls.orig[0].args[4] === 'tok');

    const c3 = makeCtx();
    delete c3.sandbox.dbxUpload;
    vm.runInContext('var dbxUpload = undefined;', c3.sandbox);
    assert('T3g: missing dbxUpload -> install does nothing, no throw', c3.sandbox._installClockProbe() === false);

    const c4 = makeCtx({ now: SERVER_MS + 10 * 60000, result: null });
    c4.sandbox._installClockProbe();
    const r4 = await c4.sandbox.dbxUpload('p', 'w', 'r');
    assert('T3h: a null result passes through untouched, no alert', r4 === null && c4.calls.alert.length === 0);

    const c5 = makeCtx({ now: SERVER_MS + 10 * 60000 });
    c5.sandbox.alertDialog = function () { throw new Error('dialog broke'); };
    c5.sandbox._installClockProbe();
    let r5 = null, e5 = null;
    try { r5 = await c5.sandbox.dbxUpload('p', 'w', 'r'); } catch (e) { e5 = e; }
    assert('T3i: a throwing alertDialog never throws into sync', e5 === null && r5 && r5.rev === 'r1');
  }

  // ---------------- T4: clock in sync -> nothing ----------------
  {
    const c = makeCtx({ now: SERVER_MS + 30000 });
    c.sandbox._installClockProbe();
    await c.sandbox.dbxUpload('p', 'w', 'r');
    assert('T4a: 30 s ahead -> no alert', c.calls.alert.length === 0);
    assert('T4b: 30 s ahead -> no _qDiagPush("clockAhead")', c.calls.diag.length === 0);
    assert('T4c: nothing stored', !('questa.clockAheadWarnedAt' in c.store));
  }

  // ---------------- T5: blocked storage still throttles ----------------
  {
    const c = makeCtx({ now: SERVER_MS + 10 * 60000, throwingStorage: true });
    c.sandbox._installClockProbe();
    await c.sandbox.dbxUpload('p', 'w', 'r');
    await c.sandbox.dbxUpload('p', 'w', 'r');
    assert('T5a: throwing localStorage -> one alert only (in-memory throttle)', c.calls.alert.length === 1);
  }

  // ---------------- T6: static traps ----------------
  {
    const probeSrc = [aheadFn, noteFn, installFn].join('\n').replace(/\/\/.*$/gm, '');
    assert('T6a: probe code never calls now() (now()-slice trap)', !/(^|[^.\w])now\s*\(/.test(probeSrc));
    assert('T6b: probe compares against HLC_RATCHET_TOLERANCE_MS, no second 120000 literal',
      /HLC_RATCHET_TOLERANCE_MS/.test(noteFn) && !/120000|120e3|12e4/.test(probeSrc));
  }

  if (failures) {
    console.error('\n' + failures + ' clock-ahead-warning assertion(s) FAILED');
    process.exit(1);
  }
  console.log('\nALL CLOCK-AHEAD-WARNING TESTS PASSED');
  process.exit(0);
}

main().catch(function (e) {
  console.error('Unhandled:', e && e.stack || e);
  process.exit(1);
});
